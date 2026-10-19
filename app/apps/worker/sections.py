"""Isolated, explicit benchmark deployment; never changes the normal export app."""
import os
from pathlib import Path

import modal
from app import image, BUILD, GPU

APP = "edit-exports-sections-benchmark"
POOL = 4
SECTION_SECONDS = 300
COORDINATOR_SECONDS = 1200
STARTUP = 300
VOLUME = os.environ.get("EDIT_SECTIONS_VOLUME", "edit-exports-sections-benchmark")
if not VOLUME.startswith("edit-exports-sections-"):
    raise ValueError("Use an independent benchmark volume")
volume = modal.Volume.from_name(VOLUME, create_if_missing=True)
root = Path("/sections")
app = modal.App(APP)
image = (image.add_local_file(Path(__file__).with_name("sections_runtime.py"), "/opt/edit/sections_runtime.py", copy=True)
         .env({"EDIT_SECTIONS_VOLUME": VOLUME}))


@app.function(image=image, gpu=GPU, cpu=(4, 4), memory=(16384, 16384), volumes={root: volume},
              max_containers=POOL, timeout=SECTION_SECONDS, startup_timeout=STARTUP, scaledown_window=2, retries=0,
              serialized=True)
def section(name: str, index: int, span: tuple):
    from sections_runtime import LocalControl, picture
    from runtime import plain
    import re
    if not re.fullmatch(r"[a-z0-9-]{1,100}", name) or not 0 <= index < 8:
        raise ValueError("Invalid section identifier")
    import time
    started = time.time()
    try:
        volume.reload()
        result = picture(root / name, index, span, LocalControl(name, SECTION_SECONDS - 10))
        volume.commit()
    except Exception as error:
        raise RuntimeError(plain(error)) from None
    result["started"] = started
    result["finished"] = time.time()
    return result


@app.function(image=image, cpu=(4, 4), memory=(16384, 16384), volumes={root: volume},
              max_containers=2, timeout=COORDINATOR_SECONDS, startup_timeout=STARTUP, scaledown_window=2, retries=0,
              serialized=True)
def coordinate(job: dict):
    from sections_runtime import coordinate as run
    from runtime import plain
    try:
        result = run(job, volume, section, root)
    except Exception as error:
        raise RuntimeError(plain(error)) from None
    return {**result, "build": BUILD, "gpu": GPU, "gpu_pool_limit": POOL}
