"""Bounded hardware-only test; never contacts Edit or changes its services."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

import modal
from app import BUILD, GPU, image

app = modal.App("edit-exports-hardware-probe")


@app.function(image=image, gpu=GPU, cpu=(4, 4), memory=(16384, 16384), timeout=120, serialized=True,
              startup_timeout=300, max_containers=1, scaledown_window=2, retries=0)
def probe():
    started = time.monotonic()
    checks = []
    with tempfile.TemporaryDirectory() as folder:
        for args in [
            ["nvidia-smi", "--query-gpu=name,driver_version,memory.total,compute_mode", "--format=csv"],
            ["vulkaninfo", "--summary"],
            ["edit-worker", "--probe"],
            ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=s=320x180:r=30", "-frames:v", "2", "-c:v", "h264_nvenc", "-f", "null", "-"],
            ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=s=320x180:r=30", "-frames:v", "2", "-c:v", "hevc_nvenc", "-f", "null", "-"],
        ]:
            try:
                result = subprocess.run(args, cwd=folder, capture_output=True, text=True, timeout=20)
                checks.append({"command": args, "code": result.returncode,
                               "stdout": result.stdout[-24000:], "stderr": result.stderr[-24000:]})
            except (OSError, subprocess.TimeoutExpired) as error:
                checks.append({"command": args, "code": None, "stdout": "", "stderr": str(error)})
    return {"build": BUILD, "gpu": GPU, "graphics": checks[2]["code"] == 0,
            "h264": checks[3]["code"] == 0, "hevc": checks[4]["code"] == 0,
            "seconds": time.monotonic() - started, "checks": checks,
            "device_files": [str(p) for p in Path("/dev").glob("nvidia*")]}


@app.local_entrypoint()
def main():
    # Includes the configured startup and shutdown allowances, not just the
    # 120s function timeout. Image builds and network charges are separate.
    maximum = {"L4": 0.000222, "L40S": 0.000542, "RTX-PRO-6000": 0.000842}[GPU] + 4 * 0.0000131 + 16 * 0.00000222
    maximum *= 120 + 300 + 60
    if float(os.environ.get("EDIT_MODAL_PROBE_COMPUTE_BUDGET_USD", "0")) < maximum:
        raise RuntimeError(f"Set a compute budget of at least ${maximum:.2f} for this single hardware test")
    result = probe.remote()
    print(json.dumps(result), flush=True)
    if not all(result[key] for key in ["graphics", "h264", "hevc"]):
        raise RuntimeError("Hardware preflight failed; inspect the graphics and encoder diagnostics above")
