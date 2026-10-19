"""Bounded hardware-only test; never contacts Edit or changes its services."""
import json
import os
import subprocess
import tempfile

import modal
from app import BUILD, GPU, image

app = modal.App("edit-exports-hardware-probe")


@app.function(image=image, gpu=GPU, cpu=(4, 4), memory=(16384, 16384), timeout=120, serialized=True,
              startup_timeout=300, max_containers=1, scaledown_window=2, retries=0)
def probe():
    with tempfile.TemporaryDirectory() as folder:
        for args in [
            ["edit-worker", "--probe"],
            ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=s=320x180:r=30", "-frames:v", "2", "-c:v", "h264_nvenc", "-f", "null", "-"],
            ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=s=320x180:r=30", "-frames:v", "2", "-c:v", "hevc_nvenc", "-f", "null", "-"],
        ]:
            subprocess.run(args, cwd=folder, check=True, timeout=30)
    return {"build": BUILD, "gpu": GPU, "graphics": True, "h264": True, "hevc": True}


@app.local_entrypoint()
def main():
    # Includes the configured startup and shutdown allowances, not just the
    # 120s function timeout. Image builds and network charges are separate.
    maximum = (0.000222 if GPU == "L4" else 0.000542) + 4 * 0.0000131 + 16 * 0.00000222
    maximum *= 120 + 300 + 60
    if float(os.environ.get("EDIT_MODAL_PROBE_COMPUTE_BUDGET_USD", "0")) < maximum:
        raise RuntimeError(f"Set a compute budget of at least ${maximum:.2f} for this single hardware test")
    print(json.dumps(probe.remote()))
