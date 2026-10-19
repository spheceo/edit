"""Edit's independent Modal app. Does not touch Repack apps or volumes.

The gateway only queues work. Three isolated export processes share a GPU and use the actual
edit-engine/edit-render, not a reimplementation of the project's effects.
Credentials are limited to the worker-scoped Relay token and Relay URL.
"""
import hmac
import asyncio
import os
from pathlib import Path

import modal

from build import ROOT, build_id

HERE = Path(__file__).resolve().parent
BUILD = os.environ.get("EDIT_WORKER_BUILD") or build_id()
GPU = os.environ.get("EDIT_MODAL_GPU", "L4")
if GPU not in {"L4", "L40S", "RTX-PRO-6000"}:
    raise ValueError("EDIT_MODAL_GPU must be L4, L40S or RTX-PRO-6000")
APP_NAME = os.environ.get("EDIT_MODAL_APP", "edit-exports-pilot")
SECONDS = int(os.environ.get("EDIT_MODAL_JOB_SECONDS", "1800"))
STARTUP = int(os.environ.get("EDIT_MODAL_STARTUP_SECONDS", "300"))
if not 30 <= SECONDS <= 1800 or not 30 <= STARTUP <= 300:
    raise ValueError("Invalid worker execution limits")
if not APP_NAME.startswith("edit-exports-"):
    raise ValueError("Use a separate edit-exports-* Modal app")
app = modal.App(APP_NAME)
secret = modal.Secret.from_name(f"{APP_NAME}-relay", required_keys=["EDIT_RELAY_URL", "MODAL_WORKER_TOKEN"])
gateway_image = (modal.Image.debian_slim(python_version="3.12")
                 .pip_install("fastapi[standard]==0.140.0")
                 .add_local_file(HERE / "build.py", "/root/build.py", copy=True)
                 .env({"EDIT_WORKER_BUILD": BUILD, "EDIT_WORKER_SOURCE_ROOT": "/build", "EDIT_MODAL_GPU": GPU, "EDIT_MODAL_APP": APP_NAME, "EDIT_MODAL_JOB_SECONDS": str(SECONDS), "EDIT_MODAL_STARTUP_SECONDS": str(STARTUP)}))
image = (modal.Image.from_registry("rust:1.99-bookworm", add_python="3.12")
         .apt_install("ffmpeg", "libvulkan1", "libegl1", "libgl1", "vulkan-tools", "pkg-config")
         .pip_install("httpx==0.28.1")
         .add_local_file(ROOT / "Cargo.toml", "/build/Cargo.toml", copy=True)
         .add_local_file(ROOT / "Cargo.lock", "/build/Cargo.lock", copy=True))
for crate in ["edit-core", "edit-render", "edit-engine", "edit-native", "edit-wasm", "edit-window"]:
    image = image.add_local_dir(ROOT / "crates" / crate, f"/build/crates/{crate}", copy=True,
                                ignore=["**/node_modules/**", "**/*.node", "**/target/**", "**/__pycache__/**"])
image = (image.workdir("/build")
         .run_commands(
             "cargo build --release --locked -p edit-engine --bin edit-worker -j 4",
             "cp target/release/edit-worker /usr/local/bin/edit-worker",
         )
         .env({"EDIT_WORKER_BUILD": BUILD, "EDIT_WORKER_SOURCE_ROOT": "/build", "EDIT_MODAL_GPU": GPU, "EDIT_MODAL_APP": APP_NAME, "EDIT_MODAL_JOB_SECONDS": str(SECONDS), "EDIT_MODAL_STARTUP_SECONDS": str(STARTUP), "NVIDIA_DRIVER_CAPABILITIES": "compute,utility,video,graphics", "EDIT_NVENC": "1", "EDIT_NVDEC": "1", "EDIT_REQUIRE_GPU": "1", "XDG_RUNTIME_DIR": "/tmp"})
         .add_local_file(HERE / "runtime.py", "/opt/edit/runtime.py", copy=True)
         .env({"PYTHONPATH": "/opt/edit"})
         .add_local_file(HERE / "build.py", "/root/build.py", copy=True)
         .add_local_file(HERE / "app.py", "/root/app.py", copy=True))


@app.function(image=image, secrets=[secret], gpu=GPU, cpu=(4, 4), memory=(16384, 16384),
              timeout=SECONDS, startup_timeout=STARTUP, max_containers=1, scaledown_window=2, retries=0)
@modal.concurrent(max_inputs=3)
async def render(job: dict):
    from runtime import Stop, run
    stop = Stop()
    # Independent native processes share the GPU. An async Modal input can
    # be cancelled independently; sync input cancellation kills its peers.
    task = asyncio.create_task(asyncio.to_thread(run, job, BUILD, GPU, stop))
    task.add_done_callback(lambda future: None if future.cancelled() else future.exception())
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        stop.request()
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=5)
        except (Exception, asyncio.CancelledError):
            pass
        raise


@app.function(image=gateway_image, secrets=[secret], cpu=0.125, memory=256,
              timeout=30, max_containers=2, scaledown_window=2)
@modal.asgi_app()
def gateway():
    from fastapi import FastAPI, HTTPException, Request
    api = FastAPI()

    def authorize(request):
        expected = f"Bearer {os.environ['MODAL_WORKER_TOKEN']}"
        if not hmac.compare_digest(request.headers.get("authorization", ""), expected):
            raise HTTPException(401, "Worker authorization required")

    @api.post("/start")
    async def start(request: Request):
        authorize(request)
        if int(request.headers.get("content-length", "0")) > 4096:
            raise HTTPException(413, "Request too large")
        job = await request.json()
        if job.get("build") != BUILD or job.get("gpu") != GPU or job.get("seconds") != SECONDS or job.get("startup") != STARTUP:
            raise HTTPException(409, "Worker deployment does not match the Relay configuration")
        call = await render.spawn.aio(job)
        return {"call": call.object_id, "build": BUILD, "gpu": GPU}

    @api.post("/health")
    async def health(request: Request):
        authorize(request)
        return {"build": BUILD, "gpu": GPU, "concurrency": 3, "seconds": SECONDS, "startup": STARTUP}

    return api
