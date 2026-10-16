#!/usr/bin/env python3
"""Compare two built Edit binaries without touching ~/.edit or calling paid APIs.

python3 scripts/benchmark.py --baseline target/performance/edit-before \
    --candidate target/debug/edit [--project /path/to/project.json]

    --fixture edit --minutes 15   ~900 cuts across six generated 1080p files,
                                  ~900 audio segments (linked sound with fades
                                  and mutes, music bed, sound effects, sped-up
                                  voice-over), slowed B-roll and titles
    --fixture subtitled           one long source, about one subtitle a second
                                  in the house style, its sound with mutes
    --only candidate              measure one binary

Writes isolated projects, exports, logs and results under target/performance/
(generated sources stay in target/performance/fixtures for the next run).
The optional project is copied; its media is only read. Exports stop one frame
short of the end so the benchmark never uploads a video to Drive. RSS is
sampled for the server and descendants, not shared macOS codec services.
"""
import argparse
import copy
import json
import os
import random
import re
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


def make_source(path, seconds, pattern, frequency, hue=0):
    """1080p30 H.264 (3 s GOPs, like long-GOP camera or downloaded footage), stereo AAC."""
    if path.exists():
        return
    partial = path.with_suffix(".partial.mp4")
    subprocess.run(["ffmpeg", "-v", "error", "-y",
                    "-f", "lavfi", "-i", f"{pattern}=size=1920x1080:rate=30:duration={seconds}",
                    "-f", "lavfi", "-i", f"sine=frequency={frequency}:sample_rate=48000:duration={seconds}",
                    "-vf", f"hue=h={hue}", "-c:v", "h264_videotoolbox", "-b:v", "3M" if seconds <= 300 else "1500k", "-g", "90",
                    "-c:a", "aac", "-b:a", "128k", "-ac", "2", str(partial)], check=True)
    partial.rename(path)


def make_sound(path, seconds, source):
    if not path.exists():
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                        f"{source}:sample_rate=48000:duration={seconds}", "-ac", "2", str(path)],
                       check=True)


def media_entry(id, path, seconds, video=True):
    entry = {"id": id, "name": path.stem, "path": str(path), "kind": "video" if video else "audio",
             "duration": seconds, "has_audio": True}
    if video:
        entry.update(width=1920, height=1080, fps=30)
    return entry


def house_subtitle(text, start, duration, id, track="s", y=432):
    return {"id": id, "track": track, "type": "text", "start": start, "duration": duration,
            "text": text, "transform": {"y": y}, "animation": {}, "opacity": 1,
            "style": {"font": "Montserrat", "weight": 600, "size": 48, "color": [1, 0.85, 0.2, 1],
                      "line_height": 1.15, "max_width": 1512,
                      "glow": {"enabled": True, "radius": 46, "strength": 0.5},
                      "background": {"color": [0, 0, 0, 1], "opacity": 0.75, "pad_x": 12, "pad_y": 8},
                      "shadow": {"color": [0, 0, 0, 1], "opacity": 0.65, "distance": 3, "angle": 112,
                                 "size": 6, "blur": 8}}}


def generated(kind, minutes):
    """A representative edit or subtitled video (see the module docs); sources are cached."""
    fps, seconds = 30, int(minutes * 60)
    total = seconds * fps
    # Both fixtures of a length share their sources.
    root = (Path("target/performance/fixtures") / f"{minutes:g}").resolve()
    root.mkdir(parents=True, exist_ok=True)
    long = root / "long.mp4"
    make_source(long, seconds + 5, "testsrc2", 220)
    project = {"version": 1, "id": "bench", "name": "Performance fixture",
               "settings": {"width": 1920, "height": 1080, "fps": fps}, "next_id": 100000,
               "media": [media_entry("long", long, seconds + 5)], "clips": []}
    clips = project["clips"]
    words = "the officer said he saw the car turn left before the light changed".split()
    rng = random.Random(7)
    if kind == "subtitled":
        project["tracks"] = [{"id": "v", "kind": "video"}, {"id": "s", "kind": "video", "subtitles": True},
                             {"id": "a", "kind": "audio"}]
        clips.append({"id": "v", "track": "v", "type": "video", "media": "long", "source_in": 0,
                      "start": 0, "duration": total, "speed": 1, "transform": {}, "opacity": 1})
        mutes = [{"from": t + 0.1, "to": t + 0.45} for t in range(3, seconds - 2, 6)]
        clips.append({"id": "a", "track": "a", "type": "audio", "media": "long", "source_in": 0,
                      "start": 0, "duration": total, "speed": 1, "volume_db": 0, "mutes": mutes})
        start = 0
        while start < total - fps:
            length = rng.randint(20, 40)
            text = " ".join(rng.choice(words) for _ in range(rng.randint(3, 8)))
            clips.append(house_subtitle(text, start, length, f"s{start}"))
            start += length + rng.randint(0, 4)
        return project
    broll = []
    for index, (pattern, hue) in enumerate([("testsrc2", 90), ("testsrc", 0), ("smptehdbars", 0),
                                             ("testsrc2", 200), ("rgbtestsrc", 0)]):
        path = root / f"b{index}.mp4"
        make_source(path, 120, pattern, 330 + 110 * index, hue)
        project["media"].append(media_entry(f"b{index}", path, 120))
        broll.append(f"b{index}")
    music, whoosh = root / "music.m4a", root / "whoosh.wav"
    make_sound(music, seconds, "sine=frequency=523")
    make_sound(whoosh, 0.4, "anoisesrc=color=pink:amplitude=0.4")
    project["media"].append(media_entry("music", music, seconds, video=False))
    project["media"].append(media_entry("whoosh", whoosh, 0.4, video=False))
    project["tracks"] = [{"id": "v1", "kind": "video"}, {"id": "v2", "kind": "video"},
                         {"id": "t", "kind": "video"}, {"id": "a1", "kind": "audio"},
                         {"id": "a2", "kind": "audio"}, {"id": "a3", "kind": "audio"},
                         {"id": "a4", "kind": "audio"}]
    # V1/A1: an interview cut every ~1 s (jump cuts forward through the long
    # source), about a third of the shots from other files; each with its sound.
    start, position = 0, 0.0
    while start < total:
        length = min(rng.randint(18, 45), total - start)
        if rng.random() < 0.35:
            media, source_in, volume = rng.choice(broll), round(rng.uniform(0, 110), 3), -6
        else:
            media, source_in, volume = "long", round(position, 3), 0
            position += length / fps + rng.uniform(0.1, 2.0)
        clips.append({"id": f"v{start}", "track": "v1", "type": "video", "media": media,
                      "source_in": source_in, "start": start, "duration": length, "speed": 1,
                      "transform": {}, "opacity": 1})
        sound = {"id": f"a{start}", "track": "a1", "type": "audio", "media": media,
                 "source_in": source_in, "start": start, "duration": length, "speed": 1,
                 "volume_db": volume, "fade_in": 2, "fade_out": 2}
        if rng.random() < 0.1:
            middle = source_in + length / fps / 2
            sound["mutes"] = [{"from": round(middle - 0.1, 3), "to": round(middle + 0.1, 3)}]
        clips.append(sound)
        start += length
    # V2: slowed B-roll over the interview every ~20 s, crossfaded in, a whoosh on each.
    for start in range(10 * fps, total - 4 * fps, 20 * fps):
        clips.append({"id": f"b{start}", "track": "v2", "type": "video", "media": rng.choice(broll),
                      "source_in": round(rng.uniform(0, 100), 3), "start": start, "duration": 90,
                      "speed": 0.5, "fade_in": 12, "transform": {"scale": 1.05}, "opacity": 1})
        clips.append({"id": f"w{start}", "track": "a3", "type": "audio", "media": "whoosh",
                      "source_in": 0, "start": start - 6, "duration": 12, "speed": 1, "volume_db": -8})
    # Titles every ~30 s; a voice-over sped up a little every ~90 s; a music bed.
    for start in range(5 * fps, total - 4 * fps, 30 * fps):
        clips.append(house_subtitle("Chapter title", start, 90, f"t{start}", track="t", y=-300))
    for start in range(45 * fps, total - 8 * fps, 90 * fps):
        clips.append({"id": f"vo{start}", "track": "a4", "type": "audio", "media": rng.choice(broll),
                      "source_in": round(rng.uniform(0, 100), 3), "start": start, "duration": 150,
                      "speed": 1.1, "volume_db": -3, "fade_in": 3, "fade_out": 3})
    clips.append({"id": "music", "track": "a2", "type": "audio", "media": "music", "source_in": 0,
                  "start": 0, "duration": total, "speed": 1, "volume_db": -18,
                  "fade_in": 30, "fade_out": 60})
    return project


def probe(path):
    """Each stream's duration and the container's."""
    info = json.loads(subprocess.check_output(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)]))
    streams = {stream["codec_type"]: round(float(stream.get("duration", 0)), 3)
               for stream in info["streams"]}
    return {"format_seconds": round(float(info["format"]["duration"]), 3), "streams": streams,
            "bytes": int(info["format"]["size"])}


def export_failure(home):
    log = home / "logs" / "edit.log"
    if not log.exists():
        return None
    failed = [line for line in log.read_text(errors="replace").splitlines()
              if re.search(r"export.*(error|failed|crash)", line, re.I)]
    return failed[-1] if failed else None


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
            length = max(c["start"] + c["duration"] for c in project["clips"])
            # One frame short of the end: never a whole export (that uploads to Drive).
            end = length - 1 if FULL else min(15 * fps, length - 1)
            extension = {"wav": "wav", "mp3": "mp3", "prores": "mov", "gif": "gif"}.get(EXPORT_OPTIONS.get("format"), "mp4")
            output = home / f"export.{extension}"
            start = time.monotonic()
            with Memory(server.pid) as memory:
                request(port, "/api/projects/bench/export", {"path": str(output),
                        "options": {"range": [0, end], **EXPORT_OPTIONS}})
                while not output.exists():
                    if time.monotonic() - start > 3600:
                        raise RuntimeError(f"{label} export timed out; see {home}/logs/edit.log")
                    failure = export_failure(home)
                    if failure:
                        raise RuntimeError(f"{label} export failed: {failure}")
                    time.sleep(0.05)
            result["export"] = {"seconds": round(time.monotonic() - start, 4), "frames": end,
                                "peak_process_tree_mib": round(memory.peak / 1024, 1),
                                "expected_seconds": round(end / fps, 3), **probe(output)}
            if FULL:
                output.unlink()
            for stage in ["cold", "warm"]:
                start = time.monotonic()
                tool(port, "contact_sheet", {"start": 0, "end": end / fps - 0.1, "count": 12})
                result[f"contact_sheet_{stage}_seconds"] = round(time.monotonic() - start, 4)
            start = time.monotonic()
            tool(port, "contact_sheet", {"start": 1, "end": end / fps - 1, "count": 16})
            result["contact_sheet_16_seconds"] = round(time.monotonic() - start, 4)
            frames = [int(end * k / 7) for k in range(1, 7)]
            took = []
            for frame in frames:
                start = time.monotonic()
                tool(port, "render_frame", {"frame": frame})
                took.append(time.monotonic() - start)
            result["render_frame_seconds"] = {"first": round(took[0], 4),
                                              "median": round(sorted(took)[len(took) // 2], 4),
                                              "max": round(max(took), 4)}
            start = time.monotonic()
            tool(port, "render_frame", {"frame": frames[-1] + 1})
            result["render_frame_next_seconds"] = round(time.monotonic() - start, 4)
            media = project["media"][0]
            start = time.monotonic()
            tool(port, "look_at_media", {"media_id": media["id"], "start": 0,
                                         "end": media["duration"], "count": 12})
            result["look_at_media_seconds"] = round(time.monotonic() - start, 4)
            start = time.monotonic()
            tool(port, "still_frame", {"media_id": media["id"], "time": round(media["duration"] / 3, 2),
                                       "name": "bench still"})
            result["still_frame_seconds"] = round(time.monotonic() - start, 4)
            if FULL:
                return result
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


FULL = False
EXPORT_OPTIONS = {}


def main():
    global FULL
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--candidate", type=Path)
    parser.add_argument("--project", type=Path)
    parser.add_argument("--fixture", choices=["basic", "edit", "subtitled"], default="basic")
    parser.add_argument("--minutes", type=float, default=15)
    parser.add_argument("--only", choices=["baseline", "candidate"])
    parser.add_argument("--loudness", type=float, help="export loudness target (the UI's default is -14)")
    parser.add_argument("--quality", choices=["high", "balanced", "small"], help="export quality (default high)")
    parser.add_argument("--format", choices=["h264", "hevc", "prores", "wav", "mp3"], help="export format (default h264)")
    parser.add_argument("--revisions", type=int, default=80)
    parser.add_argument("--full", action="store_true", help="with --project, export the whole timeline (one frame short)")
    args = parser.parse_args()
    if args.loudness is not None:
        EXPORT_OPTIONS["loudness"] = args.loudness
    if args.quality:
        EXPORT_OPTIONS["quality"] = args.quality
    if args.format:
        EXPORT_OPTIONS["format"] = args.format
    root = Path("target/performance") / time.strftime("run-%Y%m%d-%H%M%S")
    root = root.resolve()
    root.mkdir(parents=True)
    if args.fixture != "basic" and not args.project:
        # The whole timeline is exported; editing-tool timings are left to the basic fixture.
        FULL = True
        project = generated(args.fixture, args.minutes)
    else:
        project = json.loads(args.project.read_text()) if args.project else synthetic(root)
        FULL = bool(args.project and args.full)
    project = copy.deepcopy(project)
    project.update(id="bench", name="Performance fixture")
    project.pop("drive", None)
    results = {"fixture": {"clips": len(project["clips"]), "media": len(project["media"]),
                           "settings": project["settings"]}, "measurements": {}}
    for label in [args.only] if args.only else ["baseline", "candidate"]:
        if getattr(args, label) is None:
            parser.error(f"--{label} is required")
        results["measurements"][label] = run(getattr(args, label).resolve(), label, root, project, args.revisions)
        print(label, json.dumps(results["measurements"][label]), flush=True)
        (root / "results.json").write_text(json.dumps(results, indent=2) + "\n")
    print(f"Results: {root}/results.json")


if __name__ == "__main__":
    main()
