#!/usr/bin/env python3
"""Explicit two-real-project benchmark on the isolated pilot; never opens Edit.

Run with Repack's process-only R2 injection and --execute. Snapshots are read
from history, all media must already be in R2, and no project is saved back.
Disposable credentials stay in memory and the isolated services' secret stores.
"""
from concurrent.futures import ThreadPoolExecutor
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps/worker"))
from build import build_id
from pilot import command
import httpx
import modal

FIXTURES = [
    {"id": "p1792277363823-0", "snapshot": "1792279232788", "label": "Young Actress",
     "local_seconds": 306.47543175, "local_frames": 51958,
     "local_note": "Oct 18 first full export; no reused output chunks"},
    {"id": "p1792325414706-2", "snapshot": "1792391689020", "label": "Corrupt Cop",
     "local_seconds": 793.0, "local_frames": 34987,
     "local_note": "Oct 19 full export, rounded log timing; later 35s cached re-export excluded"},
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--reuse-deployment", action="store_true", help="Keep the existing idle worker and its scoped credential")
    parser.add_argument("--daily-reservation-usd", type=float, required=True)
    parser.add_argument("--output", type=Path, default=Path("/tmp/edit-modal-real-benchmark"))
    args = parser.parse_args()
    if not args.execute:
        raise RuntimeError("--execute is required to deploy the pilot and run two paid exports")
    r2 = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]
    if not all(os.environ.get(key) for key in r2):
        raise RuntimeError("Inject the four existing R2 settings through the process environment")
    app = "edit-exports-pilot"
    listing = subprocess.run([sys.executable, "-m", "modal", "app", "list", "--env", "dev", "--json"],
                             capture_output=True, text=True, check=True)
    if any(item.get("description") == app and int(item.get("tasks", 0)) for item in json.loads(listing.stdout)):
        raise RuntimeError("The pilot has active tasks; do not change its credentials")
    output = args.output
    output.mkdir(parents=True, exist_ok=True)
    report_path = output / "report.json"
    if report_path.exists():
        raise RuntimeError("Choose a fresh output directory; an existing benchmark must not be resubmitted")
    projects = []
    for fixture in FIXTURES:
        path = Path.home() / ".edit/projects/history" / fixture["id"] / (fixture["snapshot"] + ".json")
        raw = path.read_bytes()
        project = json.loads(raw)
        frames = max(c["start"] + c["duration"] for c in project["clips"])
        if frames != fixture["local_frames"] or project["settings"] != {"width": 1920, "height": 1080, "fps": 30}:
            raise RuntimeError("The frozen fixture no longer matches its local export")
        if any(not media.get("cloud", {}).get("original") for media in project["media"]):
            raise RuntimeError("This benchmark requires already-uploaded assets")
        projects.append(project)
        fixture["snapshot_sha256"] = hashlib.sha256(raw).hexdigest()
        (output / (fixture["id"] + ".json")).write_bytes(raw)
    config = "wrangler.modal-pilot.toml"
    base = "https://edit-relay-modal-pilot.sphe-g-personal.workers.dev"
    build = build_id()
    client_token, worker_token = secrets.token_urlsafe(48), secrets.token_urlsafe(48)
    settings = {key: os.environ[key] for key in r2}
    settings.update({"CLOUD_TOKEN": client_token, "MODAL_WORKER_TOKEN": worker_token,
                     "MODAL_RENDER_VERSION": build, "MODAL_GPU": "L4",
                     "MODAL_DAILY_BUDGET_USD": str(args.daily_reservation_usd),
                     "MODAL_JOB_SECONDS": "1800", "MODAL_STARTUP_SECONDS": "300", "MODAL_SHUTDOWN_SECONDS": "60"})
    if args.reuse_deployment:
        settings = {"CLOUD_TOKEN": client_token, "MODAL_DAILY_BUDGET_USD": str(args.daily_reservation_usd)}
    command(["bunx", "wrangler", "secret", "bulk", "--config", config], data=json.dumps(settings))
    if not args.reuse_deployment:
        env = {**os.environ, "EDIT_MODAL_APP": app, "EDIT_RELAY_URL": base, "MODAL_WORKER_TOKEN": worker_token,
               "EDIT_MODAL_JOB_SECONDS": "1800", "EDIT_MODAL_STARTUP_SECONDS": "300"}
        result = subprocess.run([sys.executable, str(ROOT / "apps/worker/deploy.py")], cwd=ROOT,
                                env=env, capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError(result.stderr[-3000:] or result.stdout[-3000:])
    gateway = modal.Function.from_name(app, "gateway", environment_name="dev").get_web_url()
    if not args.reuse_deployment:
        command(["bunx", "wrangler", "secret", "bulk", "--config", config], data=json.dumps({"MODAL_EXPORT_URL": gateway}))
    report = {"build": build, "app": app, "gpu": "L4", "cpu_cores": 4, "memory_gib": 16,
              "fixtures": FIXTURES, "daily_reservation_usd": args.daily_reservation_usd,
              "notes": "Historical local timings, not a simultaneous Mac rerun. Cloud jobs share one GPU. All cold source transfers and worker verification are included; deployment is excluded.",
              "samples": []}
    def save():
        temporary = report_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(report, indent=2))
        temporary.replace(report_path)
    with httpx.Client(follow_redirects=False, timeout=120) as client:
        if not args.reuse_deployment:
            health = client.post(gateway + "/health", headers={"authorization": f"Bearer {worker_token}"})
            health.raise_for_status()
            if health.json()["build"] != build or health.json()["seconds"] != 1800:
                raise RuntimeError("Worker and Relay configuration mismatch")
        def relay(route, body):
            for _ in range(20):
                response = client.post(base + "/v1/cloud/" + route, json=body,
                                       headers={"authorization": f"Bearer {client_token}"})
                if response.status_code != 401:
                    break
                # A new isolated Worker secret can take a few seconds to
                # propagate. Retrying the same request cannot buy a retry.
                time.sleep(2)
            response.raise_for_status()
            return response.json()
        configured = relay("exports/config", {})
        if configured.get("build") != build or configured.get("gpu") != "L4":
            raise RuntimeError("The existing pilot deployment does not match this checkout")
        manifests = []
        for fixture, project in zip(FIXTURES, projects):
            assets = []
            for media in project["media"]:
                key = media["cloud"]["original"]
                head = relay("r2/head", {"key": key})
                if not head.get("exists") or not head.get("etag") or not head.get("size"):
                    raise RuntimeError("An input is missing from R2: " + media["name"])
                assets.append({"media": media["id"], "key": key, "etag": head["etag"], "size": head["size"]})
                media["path"] = "asset:" + media["id"]
            fixture["input_bytes"] = sum(a["size"] for a in assets)
            manifest = {"version": 1, "project": project, "options": {"format": "h264", "audio": True,
                         "quality": "high", "hardware": True, "loudness": -14}, "assets": assets}
            text = json.dumps(manifest, separators=(",", ":")).encode()
            digest = hashlib.sha256(text).hexdigest()
            key = f"edit/exports/manifests/{digest}.json"
            url = relay("r2/url", {"key": key, "method": "PUT"})["url"]
            client.put(url, content=text).raise_for_status()
            manifests.append({"manifest": key, "digest": digest, "request": secrets.token_hex(16)})
        started = time.monotonic()
        report["submitted_ms"] = int(time.time() * 1000)
        ids = []
        for fixture, body in zip(FIXTURES, manifests):
            status = relay("exports/start", body)
            fixture["job"] = status["id"]
            fixture["reserved_usd"] = status["reservedUsd"]
            ids.append(status["id"])
        save()
        downloads = {}
        pool = ThreadPoolExecutor(max_workers=2)
        def deliver(index, status):
            url = relay("r2/url", {"key": status["output"]["key"], "method": "GET"})["url"]
            path = output / (FIXTURES[index]["label"].replace(" ", "-") + ".mp4")
            partial = path.with_suffix(".partial")
            sent = 0
            with client.stream("GET", url, timeout=120) as response:
                response.raise_for_status()
                with partial.open("wb") as target:
                    for chunk in response.iter_bytes(1024 * 1024):
                        target.write(chunk)
                        sent += len(chunk)
            if sent != status["output"]["size"]:
                raise RuntimeError("Downloaded output size mismatch")
            partial.replace(path)
            return {"path": str(path), "bytes": sent, "delivered_seconds": time.monotonic() - started}
        deadline = started + 2200
        try:
            while time.monotonic() < deadline:
                if (output / "cancel").exists():
                    for id in ids:
                        relay("exports/cancel", {"id": id})
                statuses = [relay("exports/status", {"id": id}) for id in ids]
                elapsed = time.monotonic() - started
                report["jobs"] = statuses
                report["elapsed_seconds"] = elapsed
                report["samples"].append({"seconds": elapsed, "states": [s["status"] for s in statuses],
                                           "progress": [s.get("progress", 0) for s in statuses]})
                for index, status in enumerate(statuses):
                    if status["status"] == "done" and index not in downloads:
                        FIXTURES[index]["published_seconds"] = elapsed
                        downloads[index] = pool.submit(deliver, index, status)
                    if index in downloads and downloads[index].done():
                        FIXTURES[index]["delivery"] = downloads[index].result()
                save()
                print(json.dumps({"seconds": round(elapsed, 1), "states": [s["status"] for s in statuses],
                                  "progress": [round(s.get("progress", 0), 3) for s in statuses]}), flush=True)
                if all(s["status"] in {"done", "failed", "cancelled"} for s in statuses):
                    break
                time.sleep(5)
            else:
                for id in ids:
                    relay("exports/cancel", {"id": id})
                raise RuntimeError("Benchmark deadline reached; both jobs cancelled")
            for index, future in downloads.items():
                FIXTURES[index]["delivery"] = future.result()
            report["total_delivery_seconds"] = time.monotonic() - started
            save()
        finally:
            pool.shutdown(wait=True)
        if any(s["status"] != "done" for s in statuses):
            raise RuntimeError("One or more exports failed; inspect the report without resubmitting")
        print(json.dumps({"passed": True, "report": str(report_path), "seconds": report["total_delivery_seconds"]}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Signed URLs are credentials and must not escape in HTTP errors.
        print(re.sub(r"https?://\S+", "[link]", str(error))[-3000:], file=sys.stderr)
        sys.exit(1)
