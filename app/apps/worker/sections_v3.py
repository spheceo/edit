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
if POOL not in {4, 8, 16, 32} or CPU_POOL not in {8, 16, 32, 64} or GPU != "L40S" or not 1 <= COORDINATORS <= 8:
    raise ValueError("Use 4, 8, 16 or 32 L40S workers, 8 to 64 CPU verifiers and one to eight coordinators")
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
for module in ["sections_runtime.py", "sections_v3_runtime.py", "review_runtime.py", "cloud_job.py"]:
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


@app.function(image=image, gpu=GPU, cpu=(4, 4), memory=(8192, 8192), max_containers=POOL, timeout=900,
              startup_timeout=300, scaledown_window=2, retries=0, serialized=True)
def review_piece(source: str, start: float, frames: int, upload: str):
    """One piece of a review copy at 720p on its own GPU (review_runtime.py)."""
    from review_runtime import piece
    from runtime import plain
    try:
        return piece(source, start, frames, upload)
    except Exception as error:
        raise RuntimeError(plain(error)) from None


@app.function(image=image, cpu=(4, 4), memory=(8192, 8192), max_containers=COORDINATORS,
              timeout=1800, startup_timeout=300, scaledown_window=2, retries=0, serialized=True)
def review(job: dict):
    """A review copy made in the cloud: its pieces at once, joined with the sound; its poster and waveform."""
    from review_runtime import join
    from runtime import plain
    try:
        return join(job, review_piece)
    except Exception as error:
        raise RuntimeError(plain(error)) from None


# For an Edit installed on anyone's Mac: the relay (which signed the person
# in) starts these through `api` with the shared token; R2's keys and the
# token are this secret's, never on any Mac.
cloud = modal.Secret.from_name(APP + "-cloud", required_keys=["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "EDIT_V3_TOKEN"])
# The drivers talk to R2 themselves.
cloud_image = image.pip_install("boto3==1.40.31")


@app.function(image=cloud_image, secrets=[cloud], cpu=(1, 2), memory=(2048, 4096), max_containers=COORDINATORS * 2, timeout=3600,
              startup_timeout=300, scaledown_window=2, retries=0, serialized=True)
def run_export(job: dict):
    from cloud_job import export
    from runtime import plain
    try:
        progress = modal.Dict.from_name(PROGRESS, create_if_missing=True)
        return export(job, coordinate, lambda state: progress.put(job["id"], state), BUILD)
    except Exception as error:
        raise RuntimeError(plain(error)) from None


@app.function(image=cloud_image, secrets=[cloud], cpu=(4, 4), memory=(8192, 8192), max_containers=COORDINATORS * 2, timeout=1800,
              startup_timeout=300, scaledown_window=2, retries=0, serialized=True)
def run_review(job: dict):
    from cloud_job import review as made_in_cloud
    from review_runtime import join
    from runtime import plain
    try:
        return made_in_cloud(job, lambda one: join(one, review_piece))
    except Exception as error:
        raise RuntimeError(plain(error)) from None
