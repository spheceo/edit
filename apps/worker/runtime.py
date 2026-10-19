"""The worker protocol, independently testable without Modal or a GPU."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import queue
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time

import httpx


class Stop(threading.Event):
    def __init__(self):
        super().__init__()
        self.processes = set()
        self.lock = threading.Lock()

    def watch(self, process):
        with self.lock:
            self.processes.add(process)
            if self.is_set():
                self.signal(process)

    def unwatch(self, process):
        with self.lock:
            self.processes.discard(process)

    @staticmethod
    def signal(process):
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

    def request(self):
        self.set()
        with self.lock:
            for process in self.processes:
                self.signal(process)


def plain(error):
    return re.sub(r"https?://\S+", "[link]", str(error))[-1000:]


class Control:
    def __init__(self, job, build, gpu, client, stop=None):
        self.job = {**job, "build": build, "gpu": gpu}
        self.client = client
        self.url = os.environ["EDIT_RELAY_URL"].rstrip("/") + "/v1/cloud/exports/worker/"
        if not self.url.startswith("https://"):
            raise ValueError("The Relay must use HTTPS")
        self.headers = {"authorization": f"Bearer {os.environ['MODAL_WORKER_TOKEN']}"}
        self.deadline = time.monotonic() + 1760
        self.progress = 0
        self.last_heartbeat = 0
        self.started = time.monotonic()
        self.stop = stop if stop is not None else Stop()

    def post(self, operation, **values):
        self.check()
        response = self.client.post(self.url + operation, headers=self.headers, json={**self.job, **values}, timeout=10)
        if response.status_code == 409:
            raise RuntimeError("Export cancelled, expired, or already claimed")
        response.raise_for_status()
        return response.json()

    def check(self):
        if self.stop.is_set() or time.monotonic() >= self.deadline:
            raise RuntimeError("Cloud export stopped or reached its deadline")

    def heartbeat(self, force=False):
        if force or time.monotonic() - self.last_heartbeat >= 5:
            self.post("heartbeat", progress=self.progress)
            self.last_heartbeat = time.monotonic()


def terminate(process):
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()


def command(args, control, cwd, output_limit=None):
    """Bound output memory and kill the entire decoder/encoder process group."""
    with tempfile.TemporaryFile(mode="w+") as errors:
        process = subprocess.Popen(args, cwd=cwd, stdout=subprocess.PIPE, stderr=errors,
                                   text=True, start_new_session=True)
        control.stop.watch(process)
        lines = queue.Queue(maxsize=64)

        def collect():
            for line in process.stdout:
                try:
                    lines.put_nowait(line[:4096])
                except queue.Full:
                    pass

        reader = threading.Thread(target=collect, daemon=True)
        reader.start()
        try:
            while process.poll() is None:
                control.heartbeat()
                if output_limit and any(path.is_file() and path.stat().st_size > output_limit[1] for path in output_limit[0].glob("output*")):
                    raise RuntimeError("The export exceeds its output limit")
                try:
                    line = lines.get(timeout=0.25)
                except queue.Empty:
                    continue
                try:
                    value = json.loads(line)
                    if isinstance(value.get("progress"), (int, float)):
                        control.progress = max(control.progress, 0.1 + 0.8 * value["progress"])
                except (ValueError, TypeError, AttributeError):
                    pass
            if process.returncode:
                errors.seek(max(0, errors.tell() - 4096))
                raise RuntimeError(plain(errors.read()) or "The export engine failed")
        finally:
            terminate(process)
            control.stop.unwatch(process)
            reader.join(timeout=1)
            process.stdout.close()


def download(asset, dest, client, control):
    """An ETag and exact length pin the bytes; an interrupted file is invisible."""
    partial = dest.with_suffix(".partial")
    try:
        with client.stream("GET", asset["url"], headers={"if-match": asset["etag"]}, timeout=30) as response:
            response.raise_for_status()
            if response.headers.get("etag", "").strip('"') != asset["etag"].strip('"'):
                raise RuntimeError("An input changed after the export snapshot")
            size = 0
            with partial.open("wb") as output:
                for chunk in response.iter_bytes(1024 * 1024):
                    control.check()
                    size += len(chunk)
                    if size > asset["size"]:
                        raise RuntimeError("An input exceeded its declared size")
                    output.write(chunk)
            if size != asset["size"]:
                raise RuntimeError("An input download was truncated")
        partial.replace(dest)
    finally:
        partial.unlink(missing_ok=True)


def stage(assets, folder, client, control):
    paths = {}
    with ThreadPoolExecutor(max_workers=4) as pool:
        work = []
        for i, asset in enumerate(assets):
            dest = folder / f"asset-{i}"
            paths[asset["media"]] = str(dest)
            work.append(pool.submit(download, asset, dest, client, control))
        while any(not item.done() for item in work):
            try:
                control.heartbeat()
            except Exception:
                control.stop.set()
                raise
            time.sleep(0.25)
        for item in work:
            item.result()
    return paths


def verify(path, manifest, folder, control):
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
                           capture_output=True, text=True, timeout=30, check=True)
    found = json.loads(probe.stdout)
    videos = [s for s in found["streams"] if s["codec_type"] == "video"]
    expected = "hevc" if manifest["options"]["format"] == "hevc" else "h264"
    if len(videos) != 1 or videos[0]["codec_name"] != expected:
        raise RuntimeError("The exported video has the wrong codec")
    receipt = json.loads((folder / "cache/result.json").read_text())
    video = videos[0]
    if (video["width"], video["height"]) != (receipt["width"], receipt["height"]):
        raise RuntimeError("The exported video has the wrong dimensions")
    if abs(int(video.get("nb_frames", "0")) - receipt["frames"]) > 1:
        raise RuntimeError("The exported video has the wrong frame count")
    if abs(float(video["duration"]) - receipt["seconds"]) > 2 / receipt["fps"]:
        raise RuntimeError("The exported video has the wrong duration")
    if receipt["audio"] and not any(s["codec_type"] == "audio" for s in found["streams"]):
        raise RuntimeError("The exported video is missing its sound")
    # Decode the finished streams before publishing any result. Both audio
    # and video failures are fatal, rather than a successful but broken file.
    command(["ffmpeg", "-v", "error", "-xerror", "-i", str(path), "-map", "0:v", "-map", "0:a?", "-f", "null", "-"], control, folder)


def upload(path, control, client):
    size = path.stat().st_size
    parts = []
    first = 1
    with path.open("rb") as source:
        while source.tell() < size:
            batch = control.post("upload", bytes=size, first=first)
            for part in batch["urls"]:
                control.heartbeat()
                data = source.read(batch["partSize"])
                response = client.put(part["url"], content=data, timeout=60)
                response.raise_for_status()
                etag = response.headers.get("etag")
                if not etag:
                    raise RuntimeError("An output part has no ETag")
                parts.append({"number": part["number"], "etag": etag})
                first += 1
    return control.post("complete", parts=parts, seconds=time.monotonic() - control.started)


def run(job, build, gpu, stop=None):
    started = time.monotonic()
    # Never follow a signed URL redirect to another host or an insecure URL.
    with httpx.Client(follow_redirects=False) as client:
        control = Control(job, build, gpu, client, stop)
        try:
            claim = control.post("claim")
            control.deadline = min(control.deadline, time.monotonic() + max(10, claim["seconds"] - 10))
        except Exception:
            # A duplicated spawn must not fail the worker which already owns it.
            return {"claimed": False}
        try:
            manifest = claim["manifest"]
            with tempfile.TemporaryDirectory(prefix="edit-export-") as temporary:
                folder = Path(temporary)
                needed = sum(a["size"] for a in claim["assets"]) + 3 * claim["maxOutputBytes"]
                if shutil.disk_usage(folder).free < needed:
                    raise RuntimeError("Insufficient worker disk for the export inputs and output")
                # Fail fast before downloading footage if graphics or the
                # hardware encoder is unavailable. No software fallback.
                command(["edit-worker", "--probe"], control, folder)
                command(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=s=320x180:r=30", "-frames:v", "2",
                         "-c:v", "hevc_nvenc" if manifest["options"]["format"] == "hevc" else "h264_nvenc", "-f", "null", "-"], control, folder)
                paths = stage(claim["assets"], folder, client, control)
                for media in manifest["project"]["media"]:
                    media["path"] = paths.get(media["id"], str(folder / "unused"))
                (folder / "project.json").write_text(json.dumps(manifest["project"]))
                (folder / "options.json").write_text(json.dumps(manifest["options"]))
                output = folder / "output.mp4"
                control.progress = 0.1
                command(["edit-worker", "project.json", "options.json", str(output), str(folder / "cache")], control, folder,
                        output_limit=(folder, claim["maxOutputBytes"]))
                if not 0 < output.stat().st_size <= claim["maxOutputBytes"]:
                    raise RuntimeError("The export exceeds its output limit")
                verify(output, manifest, folder, control)
                control.progress = 0.9
                result = upload(output, control, client)
                return {"id": job["id"], "status": result["status"], "seconds": time.monotonic() - started}
        except Exception as error:
            try:
                # A failed/cancelled worker makes no replacement paid call.
                control.stop.clear()
                control.post("fail", error=plain(error))
            except Exception:
                pass  # The Relay deadline fences an unreachable worker.
            raise RuntimeError(plain(error)) from None
