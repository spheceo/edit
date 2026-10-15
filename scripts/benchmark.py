#!/usr/bin/env python3
"""Compare two built Edit binaries without touching ~/.edit or calling paid APIs.

python3 scripts/benchmark.py --baseline target/performance/edit-before \
    --candidate target/debug/edit [--project /path/to/project.json]

Writes isolated projects, exports, logs and results under target/performance/.
The optional project is copied; its media is only read. Whole-project exports
are deliberately avoided so the benchmark never uploads a video to Drive.
RSS is sampled for the server and descendants, not shared macOS codec services.
"""
import argparse
import copy
import json
import os
from pathlib import Path
import socket
import subprocess
import threading
import time
from urllib.error import URLError
from urllib.request import Request, urlopen


def request(port, path, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    with urlopen(Request(f"http://127.0.0.1:{port}{path}", data=data,
                         headers={"Content-Type": "application/json"}), timeout=180) as response:
        return json.load(response)


def tool(port, name, args):
    response = request(port, "/mcp?project=bench", {
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": name, "arguments": args},
    })
    result = response["result"]
    if result.get("isError"):
        raise RuntimeError(result["content"])
    return result


def text_result(result):
    return json.loads(next(item["text"] for item in result["content"] if item["type"] == "text"))


class Memory:
    def __init__(self, pid):
        self.pid = pid
        self.peak = 0
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)

    def run(self):
        while not self.stop.is_set():
            rows = [tuple(map(int, row.split())) for row in subprocess.check_output(
                ["ps", "-axo", "pid=,ppid=,rss="], text=True).splitlines()]
            pids = {self.pid}
            while True:
                added = {pid for pid, parent, _ in rows if parent in pids} - pids
                if not added:
                    break
                pids.update(added)
            self.peak = max(self.peak, sum(rss for pid, _, rss in rows if pid in pids))
            self.stop.wait(0.1)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.stop.set()
        self.thread.join()


def synthetic(root):
    source = root / "source.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                    "testsrc2=size=1920x1080:rate=30:duration=16", "-f", "lavfi", "-i",
                    "sine=frequency=440:sample_rate=48000:duration=16", "-c:v", "libx264",
                    "-threads", "2", "-preset", "veryfast", "-crf", "20", "-c:a", "aac",
                    str(source)], check=True)
    project = {"version": 1, "id": "bench", "name": "Performance fixture",
               "settings": {"width": 1920, "height": 1080, "fps": 30}, "next_id": 2000,
               "media": [{"id": "m", "name": "source", "path": str(source), "kind": "video",
                          "duration": 16, "width": 1920, "height": 1080, "fps": 30, "has_audio": True}],
               "tracks": [{"id": "v", "kind": "video"}, {"id": "s", "kind": "video", "subtitles": True},
                          {"id": "a", "kind": "audio"}],
               "clips": [{"id": "v", "track": "v", "type": "video", "media": "m", "source_in": 0,
                          "start": 0, "duration": 480, "speed": 1, "transform": {}, "opacity": 1},
                         {"id": "a", "track": "a", "type": "audio", "media": "m", "source_in": 0,
                          "start": 0, "duration": 480, "speed": 1, "volume_db": 0}]}
    for i in range(120):
        project["clips"].append({"id": f"s{i}", "track": "s", "type": "text", "start": i * 4,
                                 "duration": 4, "text": f"Subtitle {i}", "style": {"size": 48},
                                 "transform": {"y": 430}, "animation": {}, "opacity": 1})
    return project


def run(binary, label, root, project, revision_count):
    home = root / label
    (home / "projects").mkdir(parents=True)
    (home / "projects/bench.json").write_text(json.dumps(project))
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    with (home / "server.out").open("w") as log:
        # Independent homes, no credentials and no inherited compatibility override.
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(("GOOGLE_", "AI_GATEWAY_", "EDIT_FFMPEG_VIDEO"))}
        server = subprocess.Popen([str(binary), "serve", "--home", str(home), "--host", "127.0.0.1",
                                   "--port", str(port)], stdout=log, stderr=log, env=env)
        try:
            deadline = time.monotonic() + 30
            while True:
                try:
                    request(port, "/api/health")
                    break
                except (URLError, ConnectionError):
                    if server.poll() is not None or time.monotonic() > deadline:
                        raise RuntimeError(f"{label} failed to start; see {home}/server.out")
                    time.sleep(0.1)
            result = {}
            fps = project["settings"]["fps"]
            end = min(15 * fps, max(c["start"] + c["duration"] for c in project["clips"]) - 1)
            output = home / "export.mp4"
            start = time.monotonic()
            with Memory(server.pid) as memory:
                request(port, "/api/projects/bench/export", {"path": str(output),
                        "options": {"range": [0, end]}})
                while not output.exists():
                    if time.monotonic() - start > 180:
                        raise RuntimeError(f"{label} export timed out; see {home}/logs/edit.log")
                    time.sleep(0.05)
            result["export"] = {"seconds": round(time.monotonic() - start, 4), "frames": end,
                                "peak_process_tree_mib": round(memory.peak / 1024, 1)}
            start = time.monotonic()
            tool(port, "contact_sheet", {"start": 0, "end": end / fps - 0.1, "count": 12})
            result["contact_sheet_seconds"] = round(time.monotonic() - start, 4)
            first = project["clips"][0]["id"]
            start = time.monotonic()
            if label == "candidate":
                context = tool(port, "get_edit_context", {})
                base = text_result(context)["rev"]
                operations = [{"op": "update", "select": {"ids": [first]}, "patch": {"name": f"revision {i}"}}
                              for i in range(revision_count)]
                tool(port, "apply_edit_plan", {"base_rev": base, "operations": operations})
                result["planning_context_bytes"] = len(json.dumps(context).encode())
                result["revision_tool_calls"] = 1
            else:
                context = tool(port, "get_project", {})
                for i in range(revision_count):
                    tool(port, "update_clip", {"clip_id": first, "patch": {"name": f"revision {i}"}})
                result["planning_context_bytes"] = len(json.dumps(context).encode())
                result["revision_tool_calls"] = revision_count
            result["revision_seconds_including_context"] = round(time.monotonic() - start, 4)
            result["revision_operations"] = revision_count
            start = time.monotonic()
            tool(port, "batch", {"calls": [{"tool":"update_clip", "args":{
                "clip_id":first, "patch":{"name":f"batched revision {i}"}}} for i in range(revision_count)]})
            result["legacy_batch_revision_seconds"] = round(time.monotonic() - start, 4)
            # Repeating source-level measurement should require no new decoding.
            for stage in ["cold", "warm"]:
                start = time.monotonic()
                tool(port, "measure_audio", {"start": 0, "end": min(10, end / fps)})
                result[f"audio_{stage}_seconds"] = round(time.monotonic() - start, 4)
            return result
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--project", type=Path)
    parser.add_argument("--revisions", type=int, default=80)
    args = parser.parse_args()
    root = Path("target/performance") / time.strftime("run-%Y%m%d-%H%M%S")
    root = root.resolve()
    root.mkdir(parents=True)
    project = json.loads(args.project.read_text()) if args.project else synthetic(root)
    project = copy.deepcopy(project)
    project.update(id="bench", name="Performance fixture")
    project.pop("drive", None)
    results = {"fixture": {"clips": len(project["clips"]), "media": len(project["media"]),
                           "settings": project["settings"]}, "measurements": {}}
    for label in ["baseline", "candidate"]:
        results["measurements"][label] = run(getattr(args, label).resolve(), label, root, project, args.revisions)
        print(label, json.dumps(results["measurements"][label]), flush=True)
        (root / "results.json").write_text(json.dumps(results, indent=2) + "\n")
    print(f"Results: {root}/results.json")


if __name__ == "__main__":
    main()
