#!/usr/bin/env python3
"""One of the app's exports on the v3 sections pool; Edit's server runs it
(`apps/server/src/modal_exports.ts`), one process per export, several at once.

    export_v3.py JOB.json

JOB is `{"id", "project", "options", "output", "host", "cancel"}`: an id
(`[a-z0-9-]`), the edit (every medium it uses has a cloud original), the
house options, the file to write, the server's pid and a file whose
appearing cancels it. Each original is read
by Modal from R2 through a presigned URL; the finished file is checked in
the cloud (every frame decoded), published to R2, copied here and SHA-256
checked against the cloud's, then removed from R2. Unchanged sections, the
sound and the sources stay in the app's volume, so exporting again after a
small change renders only what it touched.

Prints one JSON object a line: `{"phase", "progress"}` as it goes, then
`{"done": true, ...}` or `{"error": "..."}`. Stops (cancelling its Modal
work) on SIGTERM, the cancel file or when the server is gone. Needs R2_* in its environment
(Repack's process-only injection) and Modal signed in on this machine.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time

import boto3
from botocore.config import Config
import httpx
import modal

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps/worker"))
from build import build_id  # noqa: E402
from runtime import Stop, plain, stage  # noqa: E402
from sections_runtime import LocalControl  # noqa: E402

APP = "edit-exports-v3"
VOLUME = "edit-exports-sections-v3-live"
ENVIRONMENT = "dev"
SECTIONS = 8
PARTS = 512  # 32 MiB each: the 16 GiB output limit (sections_runtime.MAX_OUTPUT).
STATE = Path.home() / ".edit" / "modal"
# Where each phase the coordinator reports puts the export's progress.
PHASES = {"staged": .10, "planned": .12, "picture_finished": .74, "assembled": .78, "verified": .86, "uploaded": .90}


class Stopped(Exception):
    pass


def say(**fields):
    print(json.dumps(fields), flush=True)


def main():
    job = json.loads(Path(sys.argv[1]).read_text())
    if job.get("review"):
        return review(job)
    name, project, output, host = job["id"], job["project"], Path(job["output"]), int(job["host"])
    # Kept in the cloud at `key` (the export's own place there), not copied to this Mac.
    stays = job.get("deliver") is False and isinstance(job.get("key"), str)
    asked_to_stop = Path(job["cancel"]) if job.get("cancel") else None
    if not re.fullmatch(r"[a-z0-9-]{1,100}", name):
        raise ValueError("Invalid export id")
    for key in ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]:
        if not os.environ.get(key):
            raise RuntimeError("R2 settings are missing (run through Repack's environment injection)")
    halt = Stop()

    def stop(*_):
        halt.set()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    def check():
        try:
            os.kill(host, 0)
        except ProcessLookupError:
            halt.set()
        except PermissionError:
            pass
        if asked_to_stop is not None and asked_to_stop.exists():
            halt.set()
        if halt.is_set():
            raise Stopped("cancelled")

    bucket = os.environ["R2_BUCKET"]
    s3 = boto3.client("s3", endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
                      aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"], aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
                      region_name="auto", config=Config(signature_version="s3v4", retries={"max_attempts": 2}))
    started = time.monotonic()
    shown = 0.0

    def progress(phase, value):
        nonlocal shown
        shown = max(shown, value)
        say(phase=phase, progress=round(shown, 4))

    assets = []
    for media in project["media"]:
        key = (media.get("cloud") or {}).get("original")
        if not key:
            raise RuntimeError(f"{media.get('name', media['id'])} isn't in the cloud")
        head = s3.head_object(Bucket=bucket, Key=key)
        assets.append({"media": media["id"], "etag": head["ETag"], "size": head["ContentLength"], "key": key,
                       "url": s3.generate_presigned_url("get_object", Params={"Bucket": bucket, "Key": key}, ExpiresIn=6 * 3600)})
        media["path"] = "asset:" + media["id"]
    key = job["key"] if stays else f"edit/exports/v3/{name}.mp4"
    upload = {"Bucket": bucket, "Key": key, "UploadId": s3.create_multipart_upload(Bucket=bucket, Key=key, ContentType="video/mp4")["UploadId"]}
    published = False
    call = None
    finished = False
    folder = output.parent / f".{output.name}.{name}.partial"
    try:
        urls = [s3.generate_presigned_url("upload_part", Params={**upload, "PartNumber": i}, ExpiresIn=6 * 3600)
                for i in range(1, PARTS + 1)]
        build = build_id()
        deploy(build, check, progress)
        check()
        coordinate = modal.Function.from_name(APP, "coordinate", environment_name=ENVIRONMENT)
        phases = modal.Dict.from_name(APP + "-progress", environment_name=ENVIRONMENT, create_if_missing=True)
        call = coordinate.spawn({"id": name, "project": project, "assets": assets, "upload_urls": urls,
                                 "sections": SECTIONS, "options": job["options"]})
        progress("queued", .03)
        asked = 0.0
        while True:
            check()
            try:
                receipt = call.get(timeout=1)
                break
            except TimeoutError:
                pass
            if time.monotonic() - asked >= 2:
                asked = time.monotonic()
                try:
                    state = phases.get(name)
                except Exception:
                    state = None
                if state:
                    phase = state.get("phase")
                    if phase in PHASES:
                        progress(phase, PHASES[phase])
                    elif phase == "section" and state.get("sections"):
                        done = state.get("cached", 0) + state.get("rendered", 0)
                        progress("rendering", PHASES["planned"] + (PHASES["picture_finished"] - PHASES["planned"]) * done / state["sections"])
        finished = True
        if receipt.get("build") != build:
            raise RuntimeError("The cloud exporter changed while this export ran; export again")
        s3.complete_multipart_upload(**upload, MultipartUpload={"Parts": receipt["upload"]["parts"]})
        published = True
        head = s3.head_object(Bucket=bucket, Key=key)
        if head["ContentLength"] != receipt["upload"]["size"]:
            raise RuntimeError("The published file's length doesn't match the checked one")
        if stays:
            rendered = [s for s in receipt["sections"] if not s.get("cached")]
            say(done=True, progress=1, bytes=head["ContentLength"], sha256=receipt["sha256"], key=key, seconds=time.monotonic() - started,
                sections=len(receipt["sections"]), rendered=len(rendered), sound_cached=receipt.get("sound_cached"),
                sources_cached=receipt.get("input_cache", {}).get("hits"))
            return
        progress("delivering", .92)
        check()
        shutil.rmtree(folder, ignore_errors=True)
        folder.mkdir(parents=True)
        url = s3.generate_presigned_url("get_object", Params={"Bucket": bucket, "Key": key}, ExpiresIn=3600)
        control = LocalControl("delivery", 1800)
        control.stop = halt
        with httpx.Client(follow_redirects=False) as client:
            paths = stage([{"media": "output", "url": url, "etag": head["ETag"], "size": head["ContentLength"]}],
                          folder, client, control, retries=2)
        copy = Path(paths["output"])
        with copy.open("rb") as stream:
            checksum = hashlib.file_digest(stream, "sha256").hexdigest()
        if copy.stat().st_size != receipt["upload"]["size"] or checksum != receipt["sha256"]:
            raise RuntimeError("The copy here doesn't match the file checked in the cloud")
        copy.replace(output)
        rendered = [s for s in receipt["sections"] if not s.get("cached")]
        say(done=True, progress=1, bytes=output.stat().st_size, sha256=checksum, seconds=time.monotonic() - started,
            sections=len(receipt["sections"]), rendered=len(rendered), sound_cached=receipt.get("sound_cached"),
            sources_cached=receipt.get("input_cache", {}).get("hits"))
    finally:
        if call is not None and not finished:
            try:
                call.cancel(terminate_containers=True)
            except Exception:
                pass
        if not published:
            try:
                s3.abort_multipart_upload(**upload)
            except Exception:
                pass
        elif not stays:
            try:
                s3.delete_object(Bucket=bucket, Key=key)
            except Exception:
                pass
        shutil.rmtree(folder, ignore_errors=True)
        if call is not None:
            try:
                modal.Function.from_name(APP, "cleanup", environment_name=ENVIRONMENT).spawn(name)
            except Exception:
                pass


def review(job):
    """A review copy made in the cloud from an export kept there: its pieces on
    GPUs at once (review_runtime.py), the copy, poster and waveform put
    straight into R2, and the export itself copied to the review's own key
    there. Prints the files' details and the waveform."""
    for key in ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]:
        if not os.environ.get(key):
            raise RuntimeError("R2 settings are missing (run through Repack's environment injection)")
    name = job["id"]
    if not re.fullmatch(r"[a-z0-9-]{1,100}", name):
        raise ValueError("Invalid review id")
    bucket = os.environ["R2_BUCKET"]
    s3 = boto3.client("s3", endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
                      aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"], aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
                      region_name="auto", config=Config(signature_version="s3v4", retries={"max_attempts": 2}))
    started = time.monotonic()
    halt = Stop()

    def check():
        if halt.is_set():
            raise Stopped("cancelled")

    def progress(phase, value):
        say(phase=phase, progress=round(value, 4))

    deploy(build_id(), check, progress)
    sign = lambda method, key, hours=6: s3.generate_presigned_url(method, Params={"Bucket": bucket, "Key": key}, ExpiresIn=hours * 3600)
    fps, frames = float(job["fps"]), int(job["frames"])
    # Pieces of about three minutes, at most 24 (one GPU each).
    count = max(1, min(24, round(frames / fps / 180)))
    step = -(-frames // count)
    temp = f"edit/reviews/tmp/{name}"
    pieces = [{"start": at / fps, "frames": min(step, frames - at), "put": sign("put_object", f"{temp}/{i:03d}.mp4"),
               "get": sign("get_object", f"{temp}/{i:03d}.mp4")} for i, at in enumerate(range(0, frames, step))]
    progress("reviewing", .1)
    make = modal.Function.from_name(APP, "review", environment_name=ENVIRONMENT)
    result = make.remote({"source": sign("get_object", job["source_key"]), "pieces": pieces, "video_put": sign("put_object", job["review_key"]),
                          "poster_put": sign("put_object", job["poster_key"]), "poster_second": float(job["poster_second"])})
    progress("copying", .9)
    # The export, untouched, for the review's Download button: copied within R2.
    s3.copy({"Bucket": bucket, "Key": job["source_key"]}, bucket, job["full_key"])
    try:
        listed = s3.list_objects_v2(Bucket=bucket, Prefix=temp + "/")
        if listed.get("Contents"):
            s3.delete_objects(Bucket=bucket, Delete={"Objects": [{"Key": one["Key"]} for one in listed["Contents"]]})
    except Exception:
        pass
    say(done=True, progress=1, seconds=time.monotonic() - started, pieces=len(pieces), **result)


def deploy(build, check, progress):
    """Deploys the app's Modal functions when this checkout's worker build
    isn't the deployed one; one export at a time does (the others wait)."""
    STATE.mkdir(parents=True, exist_ok=True)
    record = STATE / f"{APP}.json"
    with (STATE / f"{APP}.lock").open("w") as lock:
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                check()
                time.sleep(1)
        try:
            if json.loads(record.read_text())["build"] == build:
                return
        except (OSError, ValueError, KeyError):
            pass
        progress("deploying", .01)
        env = {**os.environ, "EDIT_MODAL_GPU": "L40S", "EDIT_SECTIONS_APP": APP, "EDIT_SECTIONS_VOLUME": VOLUME,
               "EDIT_SECTIONS_POOL": "32", "EDIT_VERIFIERS_POOL": "64", "EDIT_SECTIONS_COORDINATORS": "6"}
        # The image build's log is long: to a file, not a pipe that could fill.
        log = STATE / f"{APP}-deploy.log"
        with log.open("w") as out:
            process = subprocess.Popen([sys.executable, "-m", "modal", "deploy", "apps/worker/sections_v3.py", "--env", ENVIRONMENT],
                                       cwd=ROOT, env=env, stdout=out, stderr=subprocess.STDOUT)
            try:
                while process.poll() is None:
                    check()
                    time.sleep(1)
            except Stopped:
                process.terminate()
                raise
        if process.returncode:
            raise RuntimeError(f"Deploying the cloud exporter failed (see {log}): " + log.read_text()[-1500:])
        record.write_text(json.dumps({"build": build, "deployed_ms": int(time.time() * 1000)}))


if __name__ == "__main__":
    try:
        main()
    except Stopped:
        say(error="cancelled")
        sys.exit(1)
    except Exception as error:
        say(error=plain(error))
        sys.exit(1)
