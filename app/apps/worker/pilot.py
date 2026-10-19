"""Explicit, isolated three-export smoke test. Never targets the live Relay.

Inject only the existing R2 configuration through the process environment.
New tokens stay in memory and the two services' secret stores, never files.
The report contains job/timing/output metadata, not sign-ins or signed URLs.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import time

import httpx
import modal
from build import ROOT, build_id

RELAY = ROOT / "apps/relay"
CONFIG = "wrangler.modal-pilot.toml"


def command(args, *, env=None, data=None):
    result = subprocess.run(args, cwd=RELAY, env=env, input=data, text=True, capture_output=True)
    if result.returncode:
        # CLI errors are safe metadata; secret payloads only went to stdin.
        raise RuntimeError(result.stderr[-3000:] or result.stdout[-3000:])
    return result.stdout


def main():
    if os.environ.get("EDIT_RUN_MODAL_PILOT") != "1":
        raise RuntimeError("Set EDIT_RUN_MODAL_PILOT=1 for an explicit pilot deployment and three synthetic exports")
    r2 = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]
    if not all(os.environ.get(key) for key in r2):
        raise RuntimeError("Inject the four existing R2 settings through the process environment")
    app = "edit-exports-pilot"
    listing = subprocess.run([sys.executable, "-m", "modal", "app", "list", "--env", "dev", "--json"], capture_output=True, text=True, check=True)
    if any(item.get("description") == app and int(item.get("tasks", 0)) for item in json.loads(listing.stdout)):
        raise RuntimeError("The pilot app has active tasks; wait before rotating its test credentials")
    build = build_id()
    client_token, worker_token = secrets.token_urlsafe(48), secrets.token_urlsafe(48)
    deployed = command(["bunx", "wrangler", "deploy", "--config", CONFIG])
    matches = re.findall(r"https://edit-relay-modal-pilot\.[a-z0-9-]+\.workers\.dev", deployed)
    if not matches:
        raise RuntimeError("Pilot deployment returned no Worker URL")
    base = matches[-1]
    settings = {key: os.environ[key] for key in r2}
    budget = float(os.environ.get("EDIT_MODAL_PILOT_DAILY_RESERVATION_USD", "2.10"))
    settings.update({"CLOUD_TOKEN": client_token, "MODAL_WORKER_TOKEN": worker_token,
                     "MODAL_RENDER_VERSION": build, "MODAL_GPU": "L4", "MODAL_DAILY_BUDGET_USD": str(budget)})
    # A short smoke test reserves 5 cents per job rather than reserving a
    # full production timeout; the actual Modal input uses the same limits.
    settings.update({"MODAL_JOB_SECONDS": "120", "MODAL_STARTUP_SECONDS": "30", "MODAL_SHUTDOWN_SECONDS": "2"})
    command(["bunx", "wrangler", "secret", "bulk", "--config", CONFIG], data=json.dumps(settings))
    print(json.dumps({"pilot_relay": base, "phase": "relay deployed", "reserved_compute_budget_usd": budget}), flush=True)
    env = {**os.environ, "EDIT_MODAL_APP": app, "EDIT_RELAY_URL": base, "MODAL_WORKER_TOKEN": worker_token,
           "EDIT_MODAL_JOB_SECONDS": "120", "EDIT_MODAL_STARTUP_SECONDS": "30"}
    result = subprocess.run([sys.executable, str(ROOT / "apps/worker/deploy.py")], cwd=ROOT, env=env, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr[-3000:] or result.stdout[-3000:])
    gateway = modal.Function.from_name(app, "gateway", environment_name="dev").get_web_url()
    if not gateway or not gateway.startswith("https://") or not gateway.endswith(".modal.run"):
        raise RuntimeError("Modal returned an invalid gateway URL")
    command(["bunx", "wrangler", "secret", "bulk", "--config", CONFIG], data=json.dumps({"MODAL_EXPORT_URL": gateway}))
    print(json.dumps({"phase": "worker deployed", "app": app, "build": build, "gateway": gateway}), flush=True)
    with httpx.Client(follow_redirects=False, timeout=30) as client:
        health = client.post(gateway + "/health", headers={"authorization": f"Bearer {worker_token}"})
        health.raise_for_status()
        if health.json()["build"] != build:
            raise RuntimeError("Worker build identity differs from the Relay")

        def relay(route, body):
            response = client.post(base + "/v1/cloud/" + route, json=body, headers={"authorization": f"Bearer {client_token}"})
            response.raise_for_status()
            return response.json()

        def put(key, path):
            url = relay("r2/url", {"key": key, "method": "PUT"})["url"]
            with path.open("rb") as source:
                response = client.put(url, content=source, headers={"content-length": str(path.stat().st_size)})
            response.raise_for_status()
            return response.headers["etag"]

        with tempfile.TemporaryDirectory(prefix="edit-modal-pilot-") as temporary:
            folder = Path(temporary)
            source = folder / "source.mp4"
            subprocess.run(["nice", "-n", "19", "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
                            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "30", "-c:v", "libx264", "-preset", "ultrafast",
                            "-threads", "1", "-c:a", "aac", "-y", str(source)], check=True, timeout=90)
            source_key = "edit/test/modal-pilot/" + hashlib.sha256(source.read_bytes()).hexdigest() + ".mp4"
            etag = put(source_key, source)
            submitted = []
            started = time.monotonic()
            for i in range(3):
                project = {"version": 1, "id": f"modal-pilot-{i}", "name": f"Modal pilot {i}",
                           "settings": {"width": 640, "height": 360, "fps": 30},
                           "media": [{"id": "m", "name": "synthetic input", "path": "asset:m", "kind": "video", "duration": 30,
                                      "width": 640, "height": 360, "fps": 30, "has_audio": True}],
                           "tracks": [{"id": "v", "kind": "video"}, {"id": "t", "kind": "video"}, {"id": "a", "kind": "audio"}],
                           "clips": [{"id": "v", "track": "v", "type": "video", "media": "m", "start": 0, "duration": 900},
                                     {"id": "a", "track": "a", "type": "audio", "media": "m", "start": 0, "duration": 900, "mutes": [{"from": 1, "to": 1.1}]},
                                     {"id": "t", "track": "t", "type": "text", "text": f"Edit on Modal {i}", "style": {"size": 32}, "start": 0, "duration": 900}]}
                manifest = {"version": 1, "project": project, "options": {"format": "h264", "audio": True, "quality": "balanced"},
                            "assets": [{"media": "m", "key": source_key, "etag": etag, "size": source.stat().st_size}]}
                text = json.dumps(manifest, separators=(",", ":"))
                digest = hashlib.sha256(text.encode()).hexdigest()
                path = folder / f"manifest-{i}.json"
                path.write_text(text)
                key = f"edit/exports/manifests/{digest}.json"
                put(key, path)
                body = {"manifest": key, "digest": digest}
                job = relay("exports/start", body)
                if relay("exports/start", body)["id"] != job["id"]:
                    raise RuntimeError("Duplicate submission started a different job")
                submitted.append(job["id"])
            peak = 0
            deadline = time.monotonic() + 600
            while time.monotonic() < deadline:
                statuses = [relay("exports/status", {"id": id}) for id in submitted]
                peak = max(peak, sum(s["status"] in {"running", "dispatching"} for s in statuses))
                if any(s["status"] in {"failed", "cancelled"} for s in statuses):
                    raise RuntimeError(json.dumps(statuses))
                if all(s["status"] == "done" for s in statuses):
                    break
                print(json.dumps({"phase": "exports", "statuses": [s["status"] for s in statuses], "peak_admitted": peak}), flush=True)
                time.sleep(5)
            else:
                raise RuntimeError("The isolated pilot did not finish within ten minutes")
            report = {"build": build, "relay": base, "modal_app": app, "jobs": statuses, "peak_admitted": peak,
                      "three_exports_seconds": time.monotonic() - started,
                      "notes": "Synthetic 30s 640x360 exports; runtime compute estimates exclude cold start, gateway and image builds."}
            intervals = [(job["started"], 1) for job in statuses] + [(job["finished"], -1) for job in statuses]
            active = maximum = 0
            for _, change in sorted(intervals):
                active += change
                maximum = max(maximum, active)
            report["peak_rendering"] = maximum
            for i, status in enumerate(statuses):
                url = relay("r2/url", {"key": status["output"]["key"], "method": "GET"})["url"]
                response = client.get(url)
                response.raise_for_status()
                if len(response.content) != status["output"]["size"]:
                    raise RuntimeError("Downloaded export size differs from the published result")
            report_path = Path("/tmp/edit-modal-pilot-result.json")
            report_path.write_text(json.dumps(report, indent=2))
            if maximum != 3:
                raise RuntimeError("All outputs passed, but three renders did not overlap; inspect the Modal allocation")
            print(json.dumps({"phase": "passed", "report": str(report_path), "peak_admitted": peak, "peak_rendering": maximum, "seconds": report["three_exports_seconds"]}), flush=True)


if __name__ == "__main__":
    main()
