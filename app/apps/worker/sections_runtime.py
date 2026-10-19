"""Bounded section-export experiment; the existing native compositor is unchanged.

The coordinator stages sources once. GPU workers read that immutable snapshot,
render absolute timeline ranges without sound and return whole sections. Audio,
assembly, finished-file decoding and parallel R2 publication use a CPU worker.
No worker receives storage credentials, and no paid call is retried.
"""
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time

import httpx
from runtime import Stop, command, stage

PART_BYTES = 32 * 1024 * 1024
MAX_OUTPUT = 4 * 1024 ** 3


class LocalControl:
    def __init__(self, name, seconds):
        self.job = {"id": name}
        self.stop = Stop()
        self.deadline = time.monotonic() + seconds
        self.progress = 0

    def check(self):
        if self.stop.is_set() or time.monotonic() >= self.deadline:
            raise RuntimeError("Section benchmark cancelled or timed out")

    def heartbeat(self, force=False):
        self.check()


def rate(settings):
    """The timeline's real frame rate: an NTSC 24 is 24000/1001 (23.976)."""
    fps = settings["fps"]
    return Fraction(fps * 1000, 1001) if settings.get("ntsc") else Fraction(fps)


def ranges(start, end, count):
    if not 1 <= count <= 8 or start < 0 or end <= start or end - start < count:
        raise ValueError("Invalid section range")
    edges = [start + (end - start) * i // count for i in range(count + 1)]
    return list(zip(edges, edges[1:]))


def inspect(path):
    result = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
                            capture_output=True, text=True, check=True, timeout=30)
    return json.loads(result.stdout)


def check_picture(found, frames, width, height, fps, audio):
    videos = [s for s in found["streams"] if s["codec_type"] == "video"]
    sounds = [s for s in found["streams"] if s["codec_type"] == "audio"]
    if len(videos) != 1:
        raise RuntimeError("Missing or multiple picture streams")
    v = videos[0]
    actual = (v["codec_name"], v["width"], v["height"], int(v.get("nb_frames", 0)), Fraction(v["avg_frame_rate"]))
    if actual != (
            "h264", width, height, frames, Fraction(fps)):
        raise RuntimeError(f"Picture mismatch: found {actual}, expected h264 {width}x{height}, {frames} frames at {fps} fps")
    if abs(float(v["duration"]) - float(frames / Fraction(fps))) > 0.001 or abs(float(v.get("start_time", 0))) > 0.001:
        raise RuntimeError("Section picture timing mismatch")
    if len(sounds) != int(audio):
        raise RuntimeError("Unexpected sound streams")
    if audio:
        a = sounds[0]
        if (a["codec_name"], a["sample_rate"], a["channels"]) != ("aac", "48000", 2):
            raise RuntimeError("Unexpected audio format")
        if abs(float(a.get("start_time", 0))) > 0.001 or abs(float(a["duration"]) - float(frames / Fraction(fps))) > 0.05:
            raise RuntimeError("Sound duration or start does not match picture")


def picture(folder, index, span, control):
    """Each call owns one GPU, one native process and its own working directory."""
    started = time.time()
    project = json.loads((folder / "project.json").read_text())
    options = json.loads((folder / "options.json").read_text())
    options.update({"range": list(span), "audio": False, "chapters": []})
    dest = folder / f"section-{index}.mp4"
    with tempfile.TemporaryDirectory(prefix="edit-section-") as scratch:
        work = Path(scratch)
        (work / "project.json").write_text(json.dumps(project))
        (work / "options.json").write_text(json.dumps(options))
        command(["edit-worker", "--probe"], control, work)
        render_started = time.monotonic()
        command(["edit-worker", "project.json", "options.json", "output.mp4", str(work / "cache")], control, work,
                output_limit=(work, MAX_OUTPUT))
        render_seconds = time.monotonic() - render_started
        output = work / "output.mp4"
        check_picture(inspect(output), span[1] - span[0], project["settings"]["width"],
                      project["settings"]["height"], rate(project["settings"]), False)
        # Copy only a complete section into the shared volume; the coordinator
        # validates the entire assembled file before publishing anything.
        import shutil
        partial = dest.with_suffix(".partial")
        shutil.copyfile(output, partial)
        partial.replace(dest)
    return {"index": index, "range": list(span), "started": started, "render_seconds": render_seconds,
            "finished": time.time(), "container": os.environ.get("MODAL_TASK_ID", "unknown"),
            "bytes": dest.stat().st_size}


def parallel_upload(path, urls, client, control):
    size = path.stat().st_size
    if not 0 < size <= MAX_OUTPUT:
        raise RuntimeError("Output exceeded the benchmark limit")
    count = (size + PART_BYTES - 1) // PART_BYTES
    if len(urls) < count:
        raise RuntimeError("Insufficient presigned output parts")

    def put(index):
        control.check()
        with path.open("rb") as source:
            source.seek(index * PART_BYTES)
            data = source.read(min(PART_BYTES, size - index * PART_BYTES))
        response = client.put(urls[index], content=data, timeout=60)
        response.raise_for_status()
        etag = response.headers.get("etag")
        if not etag:
            raise RuntimeError("Uploaded part has no ETag")
        return {"PartNumber": index + 1, "ETag": etag}

    with ThreadPoolExecutor(max_workers=4) as pool:
        parts = list(pool.map(put, range(count)))
    return {"size": size, "parts": parts}


def coordinate(job, volume, section_function, root):
    """A single video; two coordinators share the same capped GPU function pool."""
    name = job["id"]
    if not re.fullmatch(r"[a-z0-9-]{1,100}", name):
        raise ValueError("Invalid experiment identifier")
    folder = root / name
    folder.mkdir(exist_ok=False)
    started = time.time()
    control = LocalControl(name, 1100)
    calls = []
    received = set()
    try:
        project, options = job["project"], job["options"]
        # This experiment deliberately supports the benchmark's original
        # dimensions/rate/quality, not target-size or format conversions.
        if options != {"format": "h264", "audio": True, "quality": "high", "hardware": True, "loudness": -14}:
            raise ValueError("Unsupported section benchmark options")
        settings = project["settings"]
        total = max(c["start"] + c["duration"] for c in project["clips"])
        spans = ranges(0, total, job["sections"])
        with httpx.Client(follow_redirects=False) as client:
            paths = stage(job["assets"], folder, client, control)
            for media in project["media"]:
                media["path"] = paths[media["id"]]
            (folder / "project.json").write_text(json.dumps(project))
            (folder / "options.json").write_text(json.dumps(options))
            volume.commit()
            staged = time.time()
            for index, span in enumerate(spans):
                control.check()
                calls.append(section_function.spawn(name, index, span))
            # CPU mixing overlaps picture work on separate GPU machines. This
            # is the current engine, including the normal-speed mute fix.
            command(["edit-worker", "--audio-only", "project.json", "options.json", "sound.m4a", str(folder / "cache")],
                    control, folder)
            audio_finished = time.time()
            volume.commit()
            sections = []
            while len(sections) < len(calls):
                control.check()
                for index, call in enumerate(calls):
                    if any(s["index"] == index for s in sections):
                        continue
                    try:
                        receipt = call.get(timeout=0)
                    except TimeoutError:
                        continue
                    if receipt["index"] != index or receipt["range"] != list(spans[index]):
                        raise RuntimeError("Unexpected section receipt")
                    sections.append(receipt)
                    received.add(index)
                if len(sections) < len(calls):
                    time.sleep(1)
            # All local file handles and native processes have closed before
            # reload. Each child committed its uniquely named complete file.
            volume.reload()
            picture_finished = time.time()
            concat = folder / "concat.txt"
            # MP4's movie duration is rounded to milliseconds. Letting concat
            # infer each section's length accumulates gaps and changes avg FPS.
            # Declare durations from frame counts instead, keeping exact CFR.
            concat.write_text("".join(f"file 'section-{i}.mp4'\nduration {float((b - a) / rate(settings)):.12f}\n"
                                      for i, (a, b) in enumerate(spans)))
            output = folder / "output.mp4"
            command(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(concat),
                     "-i", "sound.m4a", "-map", "0:v:0", "-map", "1:a:0", "-map_metadata", "-1", "-map_chapters", "-1",
                     "-c", "copy", "-movflags", "+faststart", str(output)], control, folder)
            assembled = time.time()
            found = inspect(output)
            check_picture(found, total, settings["width"], settings["height"], rate(settings), True)
            # Retain the baseline's full software decode of the finished file,
            # including the joins and continuous audio, before cloud readiness.
            command(["ffmpeg", "-v", "error", "-xerror", "-threads", "4", "-i", str(output),
                     "-map", "0:v", "-map", "0:a", "-f", "null", "-"], control, folder)
            verified = time.time()
            with output.open("rb") as source:
                digest = hashlib.file_digest(source, "sha256").hexdigest()
            uploaded = parallel_upload(output, job["upload_urls"], client, control)
            finished = time.time()
            return {"id": name, "started": started, "staged": staged, "audio_finished": audio_finished,
                    "picture_finished": picture_finished, "assembled": assembled, "verified": verified,
                    "finished": finished, "sections": sorted(sections, key=lambda s: s["index"]),
                    "sha256": digest, "frames": total, "probe": found, "upload": uploaded,
                    "container": os.environ.get("MODAL_TASK_ID", "unknown")}
    finally:
        control.stop.request()
        # No detached or replacement GPU work survives coordinator failure.
        for index, call in enumerate(calls):
            if index not in received:
                call.cancel(terminate_containers=True)
