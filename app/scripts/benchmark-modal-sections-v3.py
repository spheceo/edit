#!/usr/bin/env python3
"""Two frozen real edits on a bounded GPU pool, with the current engine.

Run through Repack's process-only R2 environment injection. This experiment
does not deploy or alter Relay, the normal worker, Edit, or its projects.
Only presigned object URLs reach the workers. The private temporary volume
and benchmark app are removed/stopped even after a failed run.
"""
from concurrent.futures import ThreadPoolExecutor
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time

import boto3
from botocore.config import Config
import httpx
import modal

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps/worker"))
from build import build_id

APP = "edit-exports-sections-v3-benchmark"
VERIFY_RATE = 4 * .0000131 + 4 * .00000222
CPU_RATE = 4 * .0000131 + 16 * .00000222
GPU_RATE = .000542 + CPU_RATE
PART_BYTES = 32 * 1024 * 1024


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--smoke-fixture", type=int, choices=[0, 1], default=0)
    parser.add_argument("--smoke-frames", type=int, default=120)
    parser.add_argument("--compute-budget-usd", type=float, required=True)
    parser.add_argument("--sections", type=int, default=8)
    parser.add_argument("--gpu-workers", type=int, choices=[4, 8], default=4)
    parser.add_argument("--cache-volume", help="Explicit sections cache volume, never another app's volume")
    parser.add_argument("--keep-cache", action="store_true", help="Retain only this experiment's cache for a warm rerun")
    parser.add_argument("--skip-download", action="store_true", help="Measure verified cloud publication without local delivery")
    parser.add_argument("--baseline", type=Path, default=ROOT.parent / "docs/benchmarks/modal-sections-2026-10-19.json")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not args.execute or not 1 <= args.sections <= 8:
        raise RuntimeError("Explicit --execute and 1..8 sections are required")
    count = 1 if args.smoke else 2
    maximum = count * args.sections * (300 + 300 + 60) * GPU_RATE + count * (1200 + 300 + 60) * CPU_RATE + count * (args.sections + 1) * (240 + 300 + 60) * VERIFY_RATE
    if args.compute_budget_usd < maximum:
        raise RuntimeError(f"The conservative compute allowance must be at least ${maximum:.2f}")
    args.output.mkdir(parents=True, exist_ok=True)
    report_path = args.output / "report.json"
    if report_path.exists():
        raise RuntimeError("Choose a fresh output folder; never resubmit a previous run")
    for key in ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]:
        if not os.environ.get(key):
            raise RuntimeError("Inject the existing R2 settings through the process environment")
    bucket = os.environ["R2_BUCKET"]
    s3 = boto3.client("s3", endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
                      aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"], aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
                      region_name="auto", config=Config(signature_version="s3v4", retries={"max_attempts": 0}))
    listing = json.loads(subprocess.check_output([sys.executable, "-m", "modal", "app", "list", "--env", "dev", "--json"], text=True))
    if any(a["description"] == APP and int(a.get("tasks", 0)) for a in listing):
        raise RuntimeError("The section benchmark app is busy; leave its active run alone")
    run = secrets.token_hex(8)
    volume = args.cache_volume or ("edit-exports-sections-v3-" + run)
    if not re.fullmatch(r"edit-exports-sections-v3-[a-z0-9-]+", volume):
        raise ValueError("Use this experiment's edit-exports-sections-v3-* volume")
    env = {**os.environ, "EDIT_MODAL_GPU": "L40S", "EDIT_SECTIONS_VOLUME": volume, "EDIT_SECTIONS_POOL": str(args.gpu_workers)}
    baseline = json.loads(args.baseline.read_text())
    fields = {"id", "snapshot", "label", "local_seconds", "local_frames", "local_note", "snapshot_sha256"}
    selected = baseline["fixtures"][args.smoke_fixture:args.smoke_fixture + 1] if args.smoke else baseline["fixtures"]
    fixtures = [{key: copy.deepcopy(value) for key, value in f.items() if key in fields} for f in selected]
    jobs, uploads, calls = [], [], []
    report = {"build": build_id(), "app": APP, "volume": volume, "gpu": "L40S", "gpu_pool_limit": args.gpu_workers,
              "sections_per_video": args.sections, "cpu_cores_per_worker": 4, "memory_gib_per_worker": 16,
              "fixtures": fixtures, "maximum_execution_compute_usd": maximum, "compute_allowance_usd": args.compute_budget_usd,
              "pipeline": "v3", "keep_cache": args.keep_cache, "download_requested": not args.skip_download,
              "notes": "Same frozen fixtures, dimensions, codec, loudness and section ranges as v2. Deployment and source preparation excluded; source cache checks/transfers, GPU allocation, planning, continuous audio, assembly, parallel full finished-file decode, packet checks, multipart upload and publication included. Cached picture and sound bytes are SHA-256 checked. Estimates include CPU verification but exclude image builds, startup/idle, storage and network; not an invoice.",
              "samples": []}

    def save():
        temporary = report_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(report, indent=2) + "\n")
        temporary.replace(report_path)

    try:
        for fixture in fixtures:
            fixture.pop("delivery", None)
            fixture.pop("published_seconds", None)
            fixture.pop("job", None)
            history = Path.home() / ".edit/projects/history" / fixture["id"] / (fixture["snapshot"] + ".json")
            raw = history.read_bytes()
            if hashlib.sha256(raw).hexdigest() != fixture["snapshot_sha256"]:
                raise RuntimeError("The frozen benchmark changed")
            project = json.loads(raw)
            (args.output / (fixture["id"] + ".json")).write_bytes(raw)
            if args.smoke:
                # Exercise a genuine edit's first 4 seconds, including nonzero
                # section starts. The full benchmark retains every frame.
                if not args.sections <= args.smoke_frames <= 300:
                    raise RuntimeError("Smoke length must be between the section count and 300 frames")
                project["clips"] = [dict(c, duration=min(c["duration"], args.smoke_frames - c["start"]))
                                    for c in project["clips"] if c["start"] < args.smoke_frames]
                project.pop("in_out", None)
                project["settings"] = {"width": 1920, "height": 1080, "fps": 30}
            assets = []
            for media in project["media"]:
                key = media["cloud"]["original"]
                head = s3.head_object(Bucket=bucket, Key=key)
                assets.append({"media": media["id"], "etag": head["ETag"], "size": head["ContentLength"],
                               "key": key, "url": s3.generate_presigned_url("get_object", Params={"Bucket": bucket, "Key": key}, ExpiresIn=7200)})
                media["path"] = "asset:" + media["id"]
            fixture["input_bytes"] = sum(a["size"] for a in assets)
            name = f"{run}-{fixture['id']}"
            key = f"edit/test/sections-v3-benchmark/{name}.mp4"
            fixture["output_key"] = key
            upload = s3.create_multipart_upload(Bucket=bucket, Key=key, ContentType="video/mp4")
            uploads.append({"Bucket": bucket, "Key": key, "UploadId": upload["UploadId"]})
            urls = [s3.generate_presigned_url("upload_part", Params={**uploads[-1], "PartNumber": i}, ExpiresIn=7200)
                    for i in range(1, 129)]
            jobs.append({"id": name, "project": project, "assets": assets, "upload_urls": urls,
                         "sections": args.sections,
                         "options": {"format": "h264", "audio": True, "quality": "high", "hardware": True, "loudness": -14}})
        save()
        deployed = subprocess.run([sys.executable, "-m", "modal", "deploy", "apps/worker/sections_v3.py", "--env", "dev"],
                                  cwd=ROOT, env=env, capture_output=True, text=True)
        if deployed.returncode:
            raise RuntimeError(deployed.stderr[-3000:] or deployed.stdout[-3000:])
        print(json.dumps({"phase": "deployed", "app": APP, "gpu_pool_limit": args.gpu_workers, "sections": args.sections,
                          "compute_allowance_usd": args.compute_budget_usd}), flush=True)
        coordinate = modal.Function.from_name(APP, "coordinate", environment_name="dev")
        started = time.monotonic()
        report["submitted_ms"] = int(time.time() * 1000)
        completed, downloads = set(), {}
        for job in jobs:
            calls.append(coordinate.spawn(job))
        report["calls"] = [call.object_id for call in calls]
        save()

        def deliver(index):
            url = s3.generate_presigned_url("get_object", Params={"Bucket": bucket, "Key": uploads[index]["Key"]}, ExpiresIn=3600)
            path = args.output / (fixtures[index]["label"].replace(" ", "-") + ".mp4")
            from runtime import stage
            from sections_runtime import LocalControl
            receipt = fixtures[index]["receipt"]
            head = s3.head_object(Bucket=bucket, Key=uploads[index]["Key"])
            (args.output / f"delivery-{index}").mkdir()
            with httpx.Client(follow_redirects=False) as client:
                inputs = stage([{"media": "output", "url": url, "etag": head["ETag"], "size": head["ContentLength"]}],
                               args.output / f"delivery-{index}", client, LocalControl("delivery", 900))
            partial = Path(inputs["output"])
            with partial.open("rb") as stream:
                checksum = hashlib.file_digest(stream, "sha256").hexdigest()
            if partial.stat().st_size != receipt["upload"]["size"] or checksum != receipt["sha256"]:
                raise RuntimeError("Delivered output does not match verified cloud output")
            partial.replace(path)
            return {"path": str(path), "sha256": checksum, "bytes": path.stat().st_size,
                    "delivered_seconds": time.monotonic() - started}

        with ThreadPoolExecutor(max_workers=2) as pool:
            while time.monotonic() - started < 1500:
                if (args.output / "cancel").exists():
                    raise RuntimeError("Benchmark explicitly cancelled")
                for index, call in enumerate(calls):
                    if index in completed:
                        continue
                    try:
                        receipt = call.get(timeout=0)
                    except TimeoutError:
                        continue
                    if receipt["build"] != report["build"] or receipt["gpu"] != "L40S":
                        raise RuntimeError("Worker configuration changed")
                    fixtures[index]["receipt"] = receipt
                    s3.complete_multipart_upload(**uploads[index], MultipartUpload={"Parts": receipt["upload"]["parts"]})
                    head = s3.head_object(Bucket=bucket, Key=uploads[index]["Key"])
                    if head["ContentLength"] != receipt["upload"]["size"]:
                        raise RuntimeError("Published output length mismatch")
                    fixtures[index]["published_seconds"] = time.monotonic() - started
                    completed.add(index)
                    if not args.skip_download:
                        downloads[index] = pool.submit(deliver, index)
                sample = {"seconds": time.monotonic() - started, "published": len(completed)}
                report["samples"].append(sample)
                save()
                print(json.dumps(sample), flush=True)
                if len(completed) == len(calls):
                    break
                time.sleep(1)
            else:
                raise RuntimeError("Benchmark deadline reached")
            for index, future in downloads.items():
                fixtures[index]["delivery"] = future.result()
                save()
        report["total_delivery_seconds"] = time.monotonic() - started if not args.skip_download else None
        report["both_published_seconds"] = max(f["published_seconds"] for f in fixtures)
        sections = [s for f in fixtures for s in f["receipt"]["sections"] if not s["cached"]]
        report["gpu_execution_seconds"] = sum(s["finished"] - s["started"] for s in sections)
        report["cpu_execution_seconds"] = sum(f["receipt"]["finished"] - f["receipt"]["started"] for f in fixtures)
        report["verification_execution_seconds"] = sum(v["finished"] - v["started"] for f in fixtures for v in f["receipt"]["verification"])
        report["estimated_execution_compute_usd"] = report["gpu_execution_seconds"] * GPU_RATE + report["cpu_execution_seconds"] * CPU_RATE + report["verification_execution_seconds"] * VERIFY_RATE
        active = peak = 0
        for _, change in sorted([(s["started"], 1) for s in sections] + [(s["finished"], -1) for s in sections]):
            active += change
            peak = max(active, peak)
        report["peak_concurrent_gpu_sections"] = peak
        report["gpu_containers"] = sorted({s["container"] for s in sections})
        report["passed"] = True
        save()
        print(json.dumps({"passed": True, "both_published_seconds": report["both_published_seconds"],
                          "delivered_seconds": report["total_delivery_seconds"],
                          "estimated_execution_compute_usd": report["estimated_execution_compute_usd"]}), flush=True)
    except Exception as error:
        report["failure"] = re.sub(r"https?://\S+", "[link]", str(error))[-3000:]
        save()
        raise
    finally:
        for call in calls:
            try:
                call.cancel(terminate_containers=True)
            except Exception:
                pass
        # An app-level stop also fences children after a coordinator timeout.
        stopped = subprocess.run([sys.executable, "-m", "modal", "app", "stop", APP, "--env", "dev", "--yes"], capture_output=True, text=True)
        report["app_stopped"] = stopped.returncode == 0
        if report["app_stopped"] and not args.keep_cache:
            modal.Volume.objects.delete(volume, environment_name="dev", allow_missing=True)
            report["temporary_volume_deleted"] = True
        for index, upload in enumerate(uploads):
            try:
                s3.abort_multipart_upload(**upload)
            except s3.exceptions.NoSuchUpload:
                pass
        save()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(re.sub(r"https?://\S+", "[link]", str(error))[-3000:], file=sys.stderr)
        sys.exit(1)
