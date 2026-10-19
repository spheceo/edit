#!/usr/bin/env python3
"""Explicit local Mac experiment; no Modal calls or changes to the live editor.

prepare: pin the same frozen fixtures to local original bytes (R2 only when
needed). run: current normal exports versus bounded concurrent sections.
verify: full finished-file decode, packet timing, audio and seam samples.
Preparation and quality verification are timed separately from exports.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from fractions import Fraction
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
OPTIONS = {"format": "h264", "audio": True, "quality": "high", "hardware": True, "loudness": -14}


def save(path, value):
    partial = path.with_suffix(".json.partial")
    partial.write_text(json.dumps(value, indent=2) + "\n")
    partial.replace(path)


def sha(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def tools():
    code = 'import {ffmpeg,ffprobe} from "./apps/server/src/tools.ts"; console.log(JSON.stringify({ffmpeg:ffmpeg(),ffprobe:ffprobe()}));'
    return json.loads(subprocess.check_output(["bun", "-e", code], cwd=ROOT, text=True))


def hardware():
    names = ["hw.model", "hw.memsize", "hw.ncpu", "machdep.cpu.brand_string"]
    return dict(zip(names, subprocess.check_output(["sysctl", "-n", *names], text=True).splitlines()))


def pressure():
    return int(subprocess.check_output(["sysctl", "-n", "kern.memorystatus_vm_pressure_level"], text=True).strip())


def other_media(folder):
    found = []
    lines = subprocess.check_output(["ps", "-axo", "pid=,comm=,args="], text=True).splitlines()
    for line in lines:
        parts = line.strip().split(None, 2)
        if len(parts) != 3:
            continue
        pid, executable, args = parts
        if Path(executable).name in {"ffmpeg", "edit-ffmpeg"} and str(folder) not in args:
            found.append(int(pid))
    return found


def prepare(folder, baseline):
    import boto3
    from botocore.config import Config
    import httpx
    sys.path.insert(0, str(ROOT / "apps/worker"))
    from runtime import stage
    from sections_runtime import LocalControl
    path = folder / "prepared.json"
    if path.exists():
        raise RuntimeError("Preparation already exists; do not replace its pinned sources")
    folder.mkdir(parents=True, exist_ok=True)
    bucket = os.environ["R2_BUCKET"]
    s3 = boto3.client("s3", endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
                      aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"], aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
                      region_name="auto", config=Config(signature_version="s3v4", retries={"max_attempts": 0}))
    previous = json.loads(baseline.read_text())
    prepared = {"hardware": hardware(), "tools": tools(), "fixtures": [], "started": time.time(),
                "notes": "Original source preparation is outside the export timers. No Modal API or GPU calls."}
    with httpx.Client(follow_redirects=False) as client:
        for old in previous["fixtures"]:
            raw_path = Path.home() / ".edit/projects/history" / old["id"] / (old["snapshot"] + ".json")
            raw = raw_path.read_bytes()
            if hashlib.sha256(raw).hexdigest() != old["snapshot_sha256"]:
                raise RuntimeError("Frozen fixture changed")
            project = json.loads(raw)
            destination = folder / "inputs" / old["id"]
            destination.mkdir(parents=True)
            assets, downloads = [], []
            for media in project["media"]:
                key = media["cloud"]["original"]
                head = s3.head_object(Bucket=bucket, Key=key)
                existing = Path(media["path"])
                own = media["cloud"].get("proxy") == key
                local = own and existing.is_file() and existing.stat().st_size == head["ContentLength"]
                source_hash = re.search(r"/sha256/([a-f0-9]{64})/", key)
                if local and source_hash and sha(existing) != source_hash.group(1):
                    local = False
                asset = {"media": media["id"], "key": key, "etag": head["ETag"], "size": head["ContentLength"],
                         "path": str(existing.resolve()) if local else None, "downloaded": not local}
                if not local:
                    downloads.append({**asset, "url": s3.generate_presigned_url("get_object", Params={"Bucket": bucket, "Key": key}, ExpiresIn=3600)})
                assets.append(asset)
            needed = sum(a["size"] for a in downloads)
            if shutil.disk_usage(folder).free < needed + 6 * 1024 ** 3:
                raise RuntimeError("Insufficient temporary space for original footage and export outputs")
            local_paths = stage(downloads, destination, client, LocalControl(old["id"], 1800))
            for asset in assets:
                if asset["path"] is None:
                    downloaded = Path(local_paths[asset["media"]])
                    # AVURLAsset needs a recognizable extension to discover
                    # local tracks. Linux's FFmpeg accepts extensionless files.
                    extension = Path(asset["key"]).suffix
                    if extension:
                        renamed = downloaded.with_suffix(extension)
                        downloaded.rename(renamed)
                        downloaded = renamed
                    asset["path"] = str(downloaded)
                else:
                    # Freeze local music/pictures too: an agent can keep
                    # editing the live project while this benchmark runs.
                    existing = Path(asset["path"])
                    private = destination / ("snapshot-" + asset["media"] + existing.suffix)
                    shutil.copyfile(existing, private)
                    asset["path"] = str(private)
                asset["sha256"] = sha(Path(asset["path"]))
                expected = re.search(r"/sha256/([a-f0-9]{64})/", asset["key"])
                if expected and asset["sha256"] != expected.group(1):
                    raise RuntimeError(f"Pinned original checksum mismatch for {asset['media']}")
                next(m for m in project["media"] if m["id"] == asset["media"])["path"] = asset["path"]
            project_path = destination / "project.json"
            save(project_path, project)
            prepared["fixtures"].append({k: old[k] for k in ["id", "snapshot", "snapshot_sha256", "label", "local_frames"]} |
                                        {"project_path": str(project_path), "assets": assets, "original_bytes": sum(a["size"] for a in assets)})
            save(path, prepared)
    prepared["finished"] = time.time()
    prepared["all_originals_private"] = True
    save(path, prepared)
    print(json.dumps({"prepared": str(path), "downloaded_bytes": sum(a["size"] for f in prepared["fixtures"] for a in f["assets"] if a["downloaded"])}), flush=True)


class Runner:
    def __init__(self, folder, binary, resolved):
        self.folder, self.binary, self.resolved = folder, binary, resolved
        self.processes = set()
        self.lock = threading.Lock()
        self.stopped = threading.Event()
        self.last_activity_check = 0
        self.env = {k: v for k, v in os.environ.items() if k not in {
            "EDIT_NVENC", "EDIT_NVDEC", "EDIT_FFMPEG_VIDEO", "EDIT_FFMPEG_AUDIO"}}
        self.env.update(EDIT_REQUIRE_GPU="1", EDIT_FFMPEG=resolved["ffmpeg"], EDIT_FFPROBE=resolved["ffprobe"])

    def check(self):
        if self.stopped.is_set() or (self.folder / "cancel").exists():
            raise RuntimeError("Local benchmark cancelled")
        if pressure() >= 4 or shutil.disk_usage(self.folder).free < 2 * 1024 ** 3:
            raise RuntimeError("Local benchmark stopped to preserve memory/disk headroom")
        if time.monotonic() - self.last_activity_check > 5:
            self.last_activity_check = time.monotonic()
            if other_media(self.folder):
                raise RuntimeError("Local benchmark yielded to active media work outside the benchmark")

    def stop(self):
        self.stopped.set()
        with self.lock:
            for p in self.processes:
                try:
                    os.killpg(p.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass

    def command(self, args, work, name, limit=3600):
        self.check()
        start = time.monotonic()
        with (work / (name + ".stdout")).open("w") as out, (work / (name + ".stderr")).open("w") as err:
            p = subprocess.Popen(["nice", "-n", "15", "/usr/bin/time", "-l", *map(str, args)], cwd=work, env=self.env,
                                 stdout=out, stderr=err, start_new_session=True)
            with self.lock:
                self.processes.add(p)
            try:
                while p.poll() is None:
                    self.check()
                    if time.monotonic() - start > limit:
                        raise RuntimeError("Local benchmark command timed out")
                    time.sleep(.5)
                if p.returncode:
                    raise RuntimeError((work / (name + ".stderr")).read_text()[-2000:] or "Local worker failed")
            finally:
                if p.poll() is None:
                    try:
                        os.killpg(p.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    try:
                        p.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(p.pid, signal.SIGKILL)
                        p.wait()
                with self.lock:
                    self.processes.discard(p)
        diagnostics = (work / (name + ".stderr")).read_text()
        peak = re.search(r"(\d+)\s+maximum resident set size", diagnostics)
        cpu = re.search(r"([\d.]+)\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys", diagnostics)
        return {"started": start, "finished": time.monotonic(), "pid": p.pid,
                "seconds": time.monotonic() - start, "stderr": str(work / (name + ".stderr")),
                "peak_resident_bytes": int(peak.group(1)) if peak else None,
                "process_tree_timing": dict(zip(["real", "user", "system"], map(float, cpu.groups()))) if cpu else None}

    def engine(self, fixture, options, work, audio_only=False):
        work.mkdir(parents=True)
        save(work / "options.json", options)
        output = work / ("sound.m4a" if audio_only else "output.mp4")
        args = [self.binary] + (["--audio-only"] if audio_only else []) + [fixture["project_path"], work / "options.json", output, work / "cache"]
        result = self.command(args, work, "engine")
        (work / "cache/mix.f32").unlink(missing_ok=True)
        return {**result, "path": str(output), "bytes": output.stat().st_size}


def split(start, end, count):
    edges = [start + (end - start) * i // count for i in range(count + 1)]
    return list(zip(edges, edges[1:]))


def run(folder, binary, name, mode, lanes, sections, frames, fixture=None):
    prepared = json.loads((folder / "prepared.json").read_text())
    if not prepared.get("all_originals_private"):
        raise RuntimeError("Finish pinning private original media before running the benchmark")
    work = folder / name
    work.mkdir()
    report_path = work / "report.json"
    report = {"mode": mode, "lanes": lanes, "sections_per_video": sections, "prefix_frames": frames, "selected_fixture": fixture or "both",
              "binary": str(binary), "binary_sha256": sha(binary), "hardware": hardware(), "tools": prepared["tools"],
              "fixtures": [], "samples": [], "notes": "Fresh private chunk caches for every output; no inherited export chunks or sound. Audio is prepared before picture workers to avoid AVFoundation audio/video contention. Timed export completion excludes source preparation and subsequent quality verification."}
    runner = Runner(folder, binary, prepared["tools"])
    started = time.monotonic()
    done = threading.Event()

    def monitor():
        while not done.wait(5):
            sample = {"seconds": time.monotonic() - started, "memory_pressure_level": pressure(),
                      "free_disk_bytes": shutil.disk_usage(folder).free}
            report["samples"].append(sample)
            print(json.dumps({"run": name, **sample}), flush=True)

    watcher = threading.Thread(target=monitor, daemon=True)
    watcher.start()
    try:
        report["started_epoch"] = time.time()
        fixtures = []
        for f in prepared["fixtures"]:
            if fixture is not None and f["label"] != fixture:
                continue
            total = min(frames, f["local_frames"]) if frames else f["local_frames"]
            fixtures.append({**f, "frames": total, "range": [0, total]})
        if not fixtures:
            raise RuntimeError("The selected frozen fixture is unavailable")
        if mode == "normal":
            for index, f in enumerate(fixtures):
                q = runner.engine(f, {**OPTIONS, "range": f["range"]}, work / f"video-{index}")
                report["fixtures"].append({"label": f["label"], "frames": f["frames"], "completed_seconds": time.monotonic() - started,
                                           "output": q, "sections": []})
                save(report_path, report)
        else:
            rows = []
            # On one Mac all AVFoundation sound reads finish before picture
            # decoding starts. Modal can overlap these on different machines.
            for index, f in enumerate(fixtures):
                sound = runner.engine(f, {**OPTIONS, "range": f["range"]}, work / f"audio-{index}", True)
                row = {"label": f["label"], "frames": f["frames"], "audio": sound, "sections": []}
                rows.append(row)
            report["fixtures"] = rows
            report["audio_finished_seconds"] = time.monotonic() - started
            pending = []
            with ThreadPoolExecutor(max_workers=lanes) as pool:
                # Round robin between projects: one video's batch cannot take
                # every slot while the other waits for all its sections.
                for section in range(sections):
                    for index, f in enumerate(fixtures):
                        span = split(*f["range"], sections)[section]
                        future = pool.submit(runner.engine, f, {**OPTIONS, "range": list(span), "audio": False},
                                             work / f"video-{index}-section-{section}")
                        pending.append((future, index, section, span))
                mapping = {future: (index, section, span) for future, index, section, span in pending}
                for future in as_completed(mapping):
                    index, section, span = mapping[future]
                    row = rows[index]
                    try:
                        receipt = future.result()
                    except BaseException:
                        runner.stop()
                        for pending_future in mapping:
                            pending_future.cancel()
                        raise
                    row["sections"].append({**receipt, "index": section, "range": list(span)})
                    if len(row["sections"]) == sections:
                        q = work / f"assembled-{index}"
                        q.mkdir()
                        ordered = sorted(row["sections"], key=lambda x: x["index"])
                        concat = q / "concat.txt"
                        concat.write_text("ffconcat version 1.0\nstream\nexact_stream_id 1\n" + "".join(
                            f"file '{s['path']}'\nduration {(s['range'][1] - s['range'][0]) / 30:.12f}\n" for s in ordered))
                        output = q / "output.mp4"
                        joined = runner.command([prepared["tools"]["ffmpeg"], "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", concat,
                                                 "-i", row["audio"]["path"], "-map", "0:v:0", "-map", "1:a:0", "-map_metadata", "-1", "-map_chapters", "-1",
                                                 "-c", "copy", "-movflags", "+faststart", output], q, "join")
                        row["output"] = {**joined, "path": str(output), "bytes": output.stat().st_size}
                        row["completed_seconds"] = time.monotonic() - started
                    save(report_path, report)
        report["export_seconds"] = time.monotonic() - started
        report["passed_export"] = True
        save(report_path, report)
        print(json.dumps({"run": name, "export_seconds": report["export_seconds"], "passed_export": True}), flush=True)
    except BaseException as error:
        runner.stop()
        report["failure"] = str(error)
        save(report_path, report)
        raise
    finally:
        done.set()
        watcher.join(timeout=2)
        runner.stop()


def verify(report_path, reference=None):
    report = json.loads(report_path.read_text())
    if not report.get("passed_export"):
        raise RuntimeError("The export run is incomplete")
    tool = report["tools"]
    previous = json.loads(reference.read_text()) if reference else None
    started = time.monotonic()
    for row in report["fixtures"]:
        output = Path(row["output"]["path"])
        probe = subprocess.check_output([tool["ffprobe"], "-v", "error", "-show_streams", "-show_format", "-of", "json", str(output)], text=True)
        found = json.loads(probe)
        row["verification"] = {"probe": found, "stage": "metadata"}
        save(report_path, report)
        v = next(s for s in found["streams"] if s["codec_type"] == "video")
        a = next(s for s in found["streams"] if s["codec_type"] == "audio")
        if (v["width"], v["height"], int(v["nb_frames"]), Fraction(v["r_frame_rate"])) != (1920, 1080, row["frames"], Fraction(30)):
            raise RuntimeError(f"Export metadata mismatch: {v['width']}x{v['height']}, {v['nb_frames']} frames at {v['avg_frame_rate']}; expected {row['frames']} frames at 30 fps")
        if abs(float(v["duration"]) - row["frames"] / 30) > .001 or float(v["start_time"]) != 0 or float(a["start_time"]) != 0:
            raise RuntimeError("Export timestamp mismatch")
        if (a["codec_name"], a["sample_rate"], a["channels"]) != ("aac", "48000", 2):
            raise RuntimeError("Export audio format mismatch")
        packets = json.loads(subprocess.check_output([tool["ffprobe"], "-v", "error", "-select_streams", "v:0", "-show_packets", "-show_entries",
                                                       "packet=pts,dts", "-of", "json", str(output)], text=True))["packets"]
        step = Fraction(1, 30) / Fraction(v["time_base"])
        pts = sorted(int(p["pts"]) for p in packets)
        # VideoToolbox's 600 kHz timestamps round by a tick. Requiring exact
        # rational avg FPS rejected valid native files by ~1.7 microseconds.
        # Every frame must still be present exactly once, within 1 ms of its
        # expected time (a lost/repeated frame is 33.3 ms at this frame rate).
        drift = max((abs(float((p - i * step) * Fraction(v["time_base"]))) for i, p in enumerate(pts)), default=0)
        if len(pts) != row["frames"] or len(set(pts)) != row["frames"] or drift > .001:
            raise RuntimeError("Missing or repeated picture timestamps")
        dts = [int(p["dts"]) for p in packets]
        if any(b <= a for a, b in zip(dts, dts[1:])):
            raise RuntimeError("Non-increasing decoding timestamps")
        decode = subprocess.run(["nice", "-n", "15", tool["ffmpeg"], "-v", "error", "-xerror", "-threads", "2", "-i", str(output),
                                 "-map", "0:v", "-map", "0:a", "-f", "null", "-"], capture_output=True, text=True)
        if decode.returncode:
            raise RuntimeError(decode.stderr[-2000:])
        checks = {"probe": found, "every_frame_once": True, "max_frame_timing_error_ms": drift * 1000, "monotonic_dts": True,
                  "full_decode": True, "sha256": sha(output), "seams": []}
        audio = subprocess.run(["nice", "-n", "15", tool["ffmpeg"], "-v", "error", "-xerror", "-threads", "1", "-i", str(output),
                                "-map", "0:a:0", "-vn", "-c:a", "pcm_f32le", "-f", "hash", "-hash", "sha256", "-"],
                               capture_output=True, text=True, check=True, timeout=300)
        checks["decoded_audio_sha256"] = audio.stdout.strip().split("=")[-1]
        checks["exact_constant_dts_steps"] = all(b - a == step for a, b in zip(dts, dts[1:]))
        # Keep completed checks even when a later comparison fails, so the
        # report identifies the failed property rather than only its metadata.
        row["verification"] = checks
        save(report_path, report)
        if previous and row["sections"]:
            old = next(f for f in previous["fixtures"] if f["label"] == row["label"])
            checks["same_decoded_audio_as_normal"] = checks["decoded_audio_sha256"] == old["verification"]["decoded_audio_sha256"]
            if not checks["same_decoded_audio_as_normal"]:
                checks["failure"] = "Separate audio mix differs from the normal export"
                save(report_path, report)
                raise RuntimeError("Separate audio mix differs from the normal export")
            for section in sorted(row["sections"], key=lambda s: s["index"])[1:]:
                frame = section["range"][0]
                # Seek half a frame before the first requested sample so a
                # +/- one-tick VideoToolbox PTS cannot skip it on just one file.
                at = f"{(frame - 1.5) / 30:.9f}"
                graph = "[0:v]setpts=PTS-STARTPTS,scale=960:540[a];[1:v]setpts=PTS-STARTPTS,scale=960:540[b];[a][b]ssim"
                result = subprocess.run(["nice", "-n", "15", tool["ffmpeg"], "-hide_banner", "-nostats", "-threads", "1", "-ss", at, "-i", str(output),
                                          "-threads", "1", "-ss", at, "-i", old["output"]["path"], "-filter_complex_threads", "1", "-lavfi", graph,
                                          "-frames:v", "3", "-an", "-f", "null", "-"], capture_output=True, text=True, check=True)
                values = re.findall(r"SSIM Y:.*?All:([0-9.]+)", result.stderr)
                if not values:
                    raise RuntimeError("Missing seam comparison")
                checks["seams"].append({"frame": frame, "three_frame_ssim": float(values[-1])})
        row["verification"] = checks
        save(report_path, report)
        print(json.dumps({"video": row["label"], "frames": row["frames"], "verified": True, "seams": checks["seams"]}), flush=True)
    report["verification_seconds"] = time.monotonic() - started
    report["verified"] = True
    save(report_path, report)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=["prepare", "run", "verify"])
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--folder", type=Path, required=True)
    parser.add_argument("--binary", type=Path)
    parser.add_argument("--name", default="full-normal")
    parser.add_argument("--mode", choices=["normal", "sections"], default="normal")
    parser.add_argument("--lanes", type=int, choices=[1, 2, 3], default=2)
    parser.add_argument("--sections", type=int, choices=range(1, 9), default=8)
    parser.add_argument("--frames", type=int, default=0)
    parser.add_argument("--fixture", choices=["Young Actress", "Corrupt Cop"], help="Only export this fixture; omit for the full pair")
    parser.add_argument("--reference", type=Path)
    parser.add_argument("--baseline", type=Path, default=ROOT.parent / "docs/benchmarks/modal-sections-2026-10-19.json")
    args = parser.parse_args()
    if not args.execute or sys.platform != "darwin":
        raise RuntimeError("This is an explicit local Mac experiment; --execute is required")
    if args.phase == "prepare":
        prepare(args.folder, args.baseline)
    elif args.phase == "run":
        if not args.binary or not args.binary.is_file():
            raise RuntimeError("Build and provide the isolated optimized worker binary")
        run(args.folder, args.binary.resolve(), args.name, args.mode, args.lanes, args.sections, args.frames, args.fixture)
    else:
        verify(args.folder / args.name / "report.json", args.reference)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(re.sub(r"https?://\S+", "[link]", str(error))[-3000:], file=sys.stderr)
        sys.exit(1)
