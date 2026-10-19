#!/usr/bin/env python3
"""Compare delivered cloud exports with v2; QC is outside export timers.

The cloud has already decoded every finished-file frame and checked delivery
hashes. This adds decoded-audio parity and three-frame SSIM at every join.
Software-only FFmpeg runs at low priority and yields if another media job starts.
"""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]


def media_jobs():
    rows = subprocess.check_output(["ps", "-axo", "pid=,comm="], text=True).splitlines()
    return [int(parts[0]) for row in rows if len(parts := row.split(None, 1)) == 2
            and Path(parts[1]).name in {"ffmpeg", "edit-ffmpeg", "edit-worker"}]


def command(args):
    while True:
        while media_jobs():
            time.sleep(2)
        process = subprocess.Popen(["nice", "-n", "15", *args], stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, start_new_session=True)
        interrupted = False
        while True:
            try:
                stdout, stderr = process.communicate(timeout=.5)
                break
            except subprocess.TimeoutExpired:
                if any(pid != process.pid for pid in media_jobs()):
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                        process.communicate(timeout=3)
                    except ProcessLookupError:
                        process.communicate()
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.communicate()
                    interrupted = True
                    break
        if interrupted:
            continue
        if process.returncode:
            raise RuntimeError(stderr[-2000:])
        return stdout, stderr


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    current, previous = json.loads(args.report.read_text()), json.loads(args.reference.read_text())
    if not current.get("passed"):
        raise RuntimeError("Only completed exports can be compared")
    tools = json.loads(subprocess.check_output(["bun", "-e", 'import {ffmpeg} from "./apps/server/src/tools.ts"; console.log(JSON.stringify({ffmpeg:ffmpeg()}));'], cwd=ROOT, text=True))
    result = {"report": str(args.report), "reference": str(args.reference), "fixtures": [], "passed": False}
    started = time.monotonic()
    for fixture in current["fixtures"]:
        old = next(f for f in previous["fixtures"] if f["id"] == fixture["id"])
        if fixture["snapshot_sha256"] != old["snapshot_sha256"] or fixture.get("benchmark_edit"):
            raise RuntimeError("Quality comparison requires the same unchanged timeline")
        path, reference = fixture["delivery"]["path"], old["delivery"]["path"]
        hashes = []
        for video in [path, reference]:
            stdout, _ = command([tools["ffmpeg"], "-v", "error", "-xerror", "-threads", "1", "-i", video,
                                 "-map", "0:a:0", "-vn", "-c:a", "pcm_f32le", "-f", "hash", "-hash", "sha256", "-"])
            hashes.append(stdout.strip().split("=")[-1])
        row = {"label": fixture["label"], "decoded_audio_sha256": hashes[0],
               "reference_decoded_audio_sha256": hashes[1], "same_decoded_audio": hashes[0] == hashes[1], "seams": []}
        for section in fixture["receipt"]["sections"][1:]:
            frame = section["range"][0]
            at = f"{(frame - 1.5)/30:.9f}"
            graph = "[0:v]setpts=PTS-STARTPTS,scale=960:540[a];[1:v]setpts=PTS-STARTPTS,scale=960:540[b];[a][b]ssim"
            _, stderr = command([tools["ffmpeg"], "-hide_banner", "-nostats", "-threads", "1", "-ss", at, "-i", path,
                                 "-threads", "1", "-ss", at, "-i", reference, "-filter_complex_threads", "1",
                                 "-lavfi", graph, "-frames:v", "3", "-an", "-f", "null", "-"])
            values = re.findall(r"SSIM Y:.*?All:([0-9.]+)", stderr)
            if not values:
                raise RuntimeError("Missing seam comparison")
            row["seams"].append({"frame": frame, "three_frame_ssim": float(values[-1])})
        result["fixtures"].append(row)
        args.output.write_text(json.dumps(result, indent=2) + "\n")
    result["seconds"] = time.monotonic() - started
    result["passed"] = all(f["same_decoded_audio"] and all(s["three_frame_ssim"] >= .99 for s in f["seams"]) for f in result["fixtures"])
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))
    if not result["passed"]:
        raise RuntimeError("Quality parity needs investigation")


if __name__ == "__main__":
    main()
