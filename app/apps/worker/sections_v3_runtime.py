"""Cached cloud sections and parallel decoding of every finished-file frame.

All cache entries are immutable, versioned and SHA-256 checked. Paid children
have bounded pools/deadlines, no retries, and remain owned by their coordinator.
Output parts can upload during validation, but are never published before it.
"""
from concurrent.futures import ThreadPoolExecutor
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import uuid

import httpx
from runtime import command, stage
from sections_runtime import LocalControl, MAX_OUTPUT, check_picture, inspect, parallel_upload, picture, ranges

VERSION = 3


def sha(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def key(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def write_json(path, value):
    partial = path.with_name(path.name + "." + uuid.uuid4().hex + ".partial")
    try:
        partial.write_text(json.dumps(value))
        partial.replace(path)
    finally:
        partial.unlink(missing_ok=True)


def cached(path, identity):
    """A missing, old, truncated or corrupted entry is a miss, never success."""
    try:
        receipt = json.loads(path.with_suffix(".json").read_text())
        if (receipt["version"] == VERSION and receipt["identity"] == identity
                and path.stat().st_size == receipt["bytes"] and sha(path) == receipt["sha256"]):
            return receipt
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return None


def remember(source, path, identity, move=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(path.name + "." + uuid.uuid4().hex + ".partial")
    try:
        if move:
            source.replace(partial)
        else:
            shutil.copyfile(source, partial)
        receipt = {"version": VERSION, "identity": identity,
                   "bytes": partial.stat().st_size, "sha256": sha(partial)}
        partial.replace(path)
        write_json(path.with_suffix(".json"), receipt)
        return receipt
    finally:
        partial.unlink(missing_ok=True)


def asset_identity(asset):
    # Object identity is supplied by the trusted host, never a signed URL.
    if not asset.get("key") or not asset.get("etag") or not 0 < asset["size"] <= 32 * 1024 ** 3:
        raise ValueError("A cacheable source needs an object key, ETag and bounded size")
    return key({field: asset[field] for field in ("key", "etag", "size")})


def stage_cached(assets, folder, cache, client, control):
    paths, misses, identities, hits = {}, [], {}, 0
    for asset in assets:
        identity = asset_identity(asset)
        dest = cache / "inputs" / identity / "asset.bin"
        identities[asset["media"]] = identity
        if cached(dest, identity):
            paths[asset["media"]] = str(dest)
            hits += 1
        else:
            misses.append(asset)
    downloaded = {}
    if misses:
        work = folder / "downloads"
        work.mkdir()
        downloaded = stage(misses, work, client, control)
    for asset in misses:
        identity = identities[asset["media"]]
        dest = cache / "inputs" / identity / "asset.bin"
        remember(Path(downloaded[asset["media"]]), dest, identity, move=True)
        paths[asset["media"]] = str(dest)
    if downloaded:
        shutil.rmtree(folder / "downloads")
    return paths, identities, {"hits": hits, "misses": len(misses),
                               "downloaded_bytes": sum(a["size"] for a in misses)}


def plan_keys(project, options, identities, count, folder, control, build):
    model = copy.deepcopy(project)
    for media in model["media"]:
        # chunks::split and sound_key use these immutable identities rather
        # than staging mtimes, media IDs, signatures or this run's directory.
        media["path"] = "https://edit.invalid/content/" + identities[media["id"]]
    (folder / "key-project.json").write_text(json.dumps(model))
    command(["edit-worker", "--cloud-plan", "key-project.json", "options.json", "keys.json", str(count)],
            control, folder)
    plan = json.loads((folder / "keys.json").read_text())
    for section in plan["sections"]:
        section["key"] = key({"build": build, "picture": section.pop("keys"), "version": VERSION})
    plan["sound"] = key({"build": build, "sound": plan["sound"], "version": VERSION})
    return plan


def decode_frames(output, span, fps, control, folder):
    """Decode an exact absolute frame interval, including overlapped joins.

    Input seeking starts a second early; copyts + the CFR time base select
    absolute PTS, and the final progress count must match every requested frame.
    Packet validation separately checks the entire file's unique PTS grid.
    """
    a, b = span
    progress = folder / "decode-progress.txt"
    command(["ffmpeg", "-v", "error", "-xerror", "-threads", "4", "-copyts",
             "-ss", f"{max(0, a / fps - 1):.9f}", "-i", str(output), "-map", "0:v:0", "-an",
             "-vf", f"settb=1/{fps},trim=start_pts={a}:end_pts={b}",
             "-frames:v", str(b - a), "-fps_mode", "passthrough", "-progress", str(progress),
             "-nostats", "-f", "null", "-"], control, folder)
    counts = [int(line.split("=", 1)[1]) for line in progress.read_text().splitlines() if line.startswith("frame=")]
    if not counts or counts[-1] != b - a:
        raise RuntimeError(f"Finished-file decode produced {counts[-1:]}, expected {b-a} frames")
    return {"range": [a, b], "frames": counts[-1]}


def verify_job(folder, index, span, fps, total, seconds=240):
    started = time.time()
    control = LocalControl(folder.name, seconds - 10)
    with tempfile.TemporaryDirectory(prefix="edit-verify-") as temporary:
        work = Path(temporary)
        if index == -1:
            command(["ffmpeg", "-v", "error", "-xerror", "-threads", "4", "-i", str(folder / "output.mp4"),
                     "-map", "0:a:0", "-vn", "-f", "null", "-"], control, work)
            result = {"audio": True}
        else:
            # Every interior boundary is decoded with frames on BOTH sides.
            overlap = (max(0, span[0] - 2), min(total, span[1] + 2))
            result = decode_frames(folder / "output.mp4", overlap, fps, control, work)
    return {**result, "index": index, "started": started, "finished": time.time(),
            "container": os.environ.get("MODAL_TASK_ID", "unknown")}


def check_packets(output, frames, fps):
    raw = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "packet=pts_time,dts_time", "-of", "csv=p=0", str(output)],
                         capture_output=True, text=True, check=True, timeout=60).stdout
    pts, dts = [], []
    for line in raw.splitlines():
        values = line.split(",")
        pts.append(float(values[0]))
        dts.append(float(values[1]))
    if len(pts) != frames or any(b <= a for a, b in zip(dts, dts[1:])):
        raise RuntimeError("Finished-file packet count or decoding timestamps are invalid")
    error = max(abs(value - index / fps) for index, value in enumerate(sorted(pts)))
    if error > 0.00001:
        raise RuntimeError("Finished-file presentation timestamps are not an exact CFR grid")
    return {"frames": len(pts), "max_pts_error_seconds": error, "monotonic_dts": True}


def coordinate(job, volume, section_function, verify_function, root, build, gpu_pool):
    name = job["id"]
    if not re.fullmatch(r"[a-z0-9-]{1,100}", name):
        raise ValueError("Invalid experiment identifier")
    started = time.time()
    control = LocalControl(name, 1100)
    folder, cache = root / name, root / "cache-v3"
    folder.mkdir(exist_ok=False)
    calls, received = [], set()

    def submit(function, *args):
        call = function.spawn(*args)
        calls.append(call)
        return call

    def collect(pending):
        results = []
        while pending:
            control.check()
            for index, call in list(pending.items()):
                try:
                    result = call.get(timeout=0)
                except TimeoutError:
                    continue
                if result["index"] != index:
                    raise RuntimeError("Unexpected child receipt")
                received.add(call.object_id)
                results.append(result)
                del pending[index]
            if pending:
                time.sleep(0.25)
        return sorted(results, key=lambda r: r["index"])

    try:
        project, options = copy.deepcopy(job["project"]), job["options"]
        if options != {"format": "h264", "audio": True, "quality": "high", "hardware": True, "loudness": -14}:
            raise ValueError("Unsupported section benchmark options")
        settings = project["settings"]
        total = max(c["start"] + c["duration"] for c in project["clips"])
        spans = ranges(0, total, job["sections"])
        with httpx.Client(follow_redirects=False) as client:
            paths, identities, input_cache = stage_cached(job["assets"], folder, cache, client, control)
            for media in project["media"]:
                media["path"] = paths[media["id"]]
            (folder / "project.json").write_text(json.dumps(project))
            (folder / "options.json").write_text(json.dumps(options))
            staged = time.time()
            plan = plan_keys(project, options, identities, len(spans), folder, control, build)
            if [s["range"] for s in plan["sections"]] != [list(span) for span in spans]:
                raise RuntimeError("Native planner and coordinator frame ranges disagree")
            sections, pending = [], {}
            for section in plan["sections"]:
                hit = cached(cache / "pictures" / (section["key"] + ".mp4"), section["key"])
                if hit:
                    sections.append({**section, "cached": True, "bytes": hit["bytes"], "sha256": hit["sha256"]})
            volume.commit()
            planned = time.time()
            for section in plan["sections"]:
                if not any(s["index"] == section["index"] for s in sections):
                    pending[section["index"]] = submit(section_function, name, section["index"], tuple(section["range"]), section["key"])
            sound = cache / "sounds" / (plan["sound"] + ".m4a")
            sound_cached = cached(sound, plan["sound"]) is not None
            if not sound_cached:
                command(["edit-worker", "--audio-only", "project.json", "options.json", "sound.m4a", str(folder / "audio-cache")],
                        control, folder)
                remember(folder / "sound.m4a", sound, plan["sound"], move=True)
            audio_finished = time.time()
            volume.commit()
            sections.extend(collect(pending))
            sections.sort(key=lambda s: s["index"])
            volume.reload()
            picture_finished = time.time()
            for section in sections:
                if section["range"] != list(spans[section["index"]]):
                    raise RuntimeError("Unexpected picture range")
                path = cache / "pictures" / (section["key"] + ".mp4")
                if not cached(path, section["key"]):
                    raise RuntimeError("A completed picture section is missing or corrupt")
            concat = folder / "concat.txt"
            concat.write_text("ffconcat version 1.0\nstream\nexact_stream_id 1\n" + "".join(
                f"file '{cache / 'pictures' / (s['key'] + '.mp4')}'\nduration {(s['range'][1]-s['range'][0])/settings['fps']:.12f}\n"
                for s in sections))
            output = folder / "output.mp4"
            command(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(concat),
                     "-i", str(sound), "-map", "0:v:0", "-map", "1:a:0", "-map_metadata", "-1", "-map_chapters", "-1",
                     "-c", "copy", "-movflags", "+faststart", str(output)], control, folder)
            assembled = time.time()
            found = inspect(output)
            check_picture(found, total, settings["width"], settings["height"], settings["fps"], True)
            if not 0 < output.stat().st_size <= MAX_OUTPUT:
                raise RuntimeError("Output exceeded its size limit")
            volume.commit()
            validation = {i: submit(verify_function, name, i, span, settings["fps"], total)
                          for i, span in enumerate(spans)}
            validation[-1] = submit(verify_function, name, -1, (0, total), settings["fps"], total)
            # Incomplete multipart uploads are private. The host publishes only
            # after every validation receipt, digest and part ETag has passed.
            with ThreadPoolExecutor(max_workers=2) as pool:
                upload = pool.submit(parallel_upload, output, job["upload_urls"], client, control)
                digest = pool.submit(sha, output)
                packet_check = check_packets(output, total, settings["fps"])
                verification = collect(validation)
                for receipt in verification:
                    index = receipt["index"]
                    if index == -1:
                        if receipt.get("audio") is not True:
                            raise RuntimeError("Missing continuous-audio verification")
                    else:
                        a, b = spans[index]
                        expected = [max(0, a - 2), min(total, b + 2)]
                        if receipt.get("range") != expected or receipt.get("frames") != expected[1] - expected[0]:
                            raise RuntimeError("Incomplete finished-file frame verification")
                verified = time.time()
                uploaded, checksum = upload.result(), digest.result()
            finished = time.time()
            result = {"id": name, "started": started, "staged": staged, "planned": planned,
                      "audio_finished": audio_finished, "picture_finished": picture_finished,
                      "assembled": assembled, "verified": verified, "finished": finished,
                      "sections": sections, "verification": verification, "packet_check": packet_check,
                      "input_cache": input_cache, "sound_cached": sound_cached,
                      "sha256": checksum, "frames": total, "probe": found, "upload": uploaded,
                      "build": build, "gpu": "L40S", "gpu_pool_limit": gpu_pool, "pipeline": "v3",
                      "container": os.environ.get("MODAL_TASK_ID", "unknown")}
            write_json(folder / "receipt.json", result)
            return result
    finally:
        control.stop.request()
        for call in calls:
            if call.object_id not in received:
                call.cancel(terminate_containers=True)


def render_section(folder, cache, index, span, identity):
    control = LocalControl(folder.name, 290)
    receipt = picture(folder, index, span, control)
    source = folder / f"section-{index}.mp4"
    remembered = remember(source, cache / "pictures" / (identity + ".mp4"), identity, move=True)
    return {**receipt, "key": identity, "sha256": remembered["sha256"], "cached": False}
