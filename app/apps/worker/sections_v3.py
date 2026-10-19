"""V3 section exports: the app's (`edit-exports-v3`, a lasting cache, from
`export_v3.py`) and the benchmark's (its own app and volume, deleted after)."""
import os
from pathlib import Path
import re
import time

import modal
from app import image, BUILD, GPU
from build import engine_id

APP = os.environ.get("EDIT_SECTIONS_APP", "edit-exports-sections-v3-benchmark")
POOL = int(os.environ.get("EDIT_SECTIONS_POOL", "8"))
CPU_POOL = int(os.environ.get("EDIT_VERIFIERS_POOL", "16"))
# Exports at once (each has its own coordinator; their sections share the pool).
COORDINATORS = int(os.environ.get("EDIT_SECTIONS_COORDINATORS", "2"))
ENGINE = engine_id()
if POOL not in {4, 8} or CPU_POOL not in {8, 16} or GPU != "L40S" or not 1 <= COORDINATORS <= 8:
    raise ValueError("Use four/eight L40S workers, eight/sixteen CPU verifiers and one to eight coordinators")
if not re.fullmatch(r"edit-exports-(sections-v3-benchmark|v3)", APP):
    raise ValueError("Use the benchmark's or the app's own v3 Modal app")
VOLUME = os.environ["EDIT_SECTIONS_VOLUME"]
if not re.fullmatch(r"edit-exports-sections-[a-z0-9-]+", VOLUME):
    raise ValueError("Use an independent sections volume")
volume = modal.Volume.from_name(VOLUME, create_if_missing=True)
# Each export's phase, read by its host while it waits (display only). Looked
# up inside each call: a serialized function can't carry an unhydrated Dict.
PROGRESS = APP + "-progress"
root = Path("/sections")
app = modal.App(APP)
for module in ["sections_runtime.py", "sections_v3_runtime.py"]:
    image = image.add_local_file(Path(__file__).with_name(module), "/opt/edit/" + module, copy=True)


@app.function(image=image, gpu=GPU, cpu=(4, 4), memory=(16384, 16384), volumes={root: volume},
              max_containers=POOL, timeout=600, startup_timeout=300, scaledown_window=2, retries=0, serialized=True)
def section(name: str, index: int, span: tuple, identity: str):
    from sections_v3_runtime import render_section
    from runtime import plain
    if (not re.fullmatch(r"[a-z0-9-]{1,100}", name) or not 0 <= index < 8
            or not re.fullmatch(r"[0-9a-f]{64}", identity)):
        raise ValueError("Invalid section identity")
    started = time.time()
    try:
        volume.reload()
        result = render_section(root / name, root / "cache-v3", index, span, identity)
        volume.commit()
    except Exception as error:
        raise RuntimeError(plain(error)) from None
    return {**result, "started": started, "finished": time.time()}


@app.function(image=image, cpu=(4, 4), memory=(4096, 4096), volumes={root: volume},
              max_containers=CPU_POOL, timeout=240, startup_timeout=300, scaledown_window=2, retries=0, serialized=True)
def verify(name: str, index: int, span: tuple, fps: str, total: int):
    from sections_v3_runtime import verify_job
    from runtime import plain
    if not re.fullmatch(r"[a-z0-9-]{1,100}", name) or not -1 <= index < 8:
        raise ValueError("Invalid verification input")
    started = time.time()
    try:
        volume.reload()
        result = verify_job(root / name, index, span, fps, total)
        return {**result, "started": started, "finished": time.time()}
    except Exception as error:
        raise RuntimeError(plain(error)) from None


@app.function(image=image, cpu=(4, 4), memory=(16384, 16384), volumes={root: volume},
              max_containers=COORDINATORS, timeout=1800, startup_timeout=300, scaledown_window=2, retries=0, serialized=True)
def coordinate(job: dict):
    from sections_v3_runtime import coordinate as run
    from runtime import plain
    started = time.time()
    try:
        volume.reload()
        progress = modal.Dict.from_name(PROGRESS, create_if_missing=True)
        result = run(job, volume, section, verify, root, BUILD, ENGINE, POOL,
                     report=lambda state: progress.put(job["id"], state), seconds=1700)
        return {**result, "started": started, "finished": time.time(), "cpu_verifier_pool_limit": CPU_POOL}
    except Exception as error:
        raise RuntimeError(plain(error)) from None


@app.function(image=image, cpu=(1, 2), memory=(1024, 2048), volumes={root: volume},
              max_containers=2, timeout=300, scaledown_window=2, retries=0, serialized=True)
def cleanup(name: str):
    from sections_v3_runtime import cleanup as run
    volume.reload()
    result = run(root, name)
    volume.commit()
    try:
        modal.Dict.from_name(PROGRESS, create_if_missing=True).pop(name)
    except KeyError:
        pass
    return result
