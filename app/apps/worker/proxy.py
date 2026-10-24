"""Cloud proxy generation: one Modal CPU function per proxy.

Reads the job manifest the server uploaded (`edit/proxies/jobs/<digest>.json`):
{source, originalKey, proxyKey, width, height, spec}. The relay presigns a
GET for the original and a PUT for the proxy, so this worker holds no R2
keys. The encode mirrors the engine's make_cloud_proxy spec (server
cloud_proxy.ts PROXY_SPEC): <=1080p H.264, half-second keyframes, no
B-frames, BT.709, AAC 160k. On success the proxy is in R2; the server's
next registry check marks it ready. Failures raise, and the job is
retried by asking again (the manifest digest is the job identity).
"""
import json
import os
import subprocess
import tempfile
from pathlib import Path

import modal

image = (modal.Image.debian_slim(python_version="3.12")
         .apt_install("ffmpeg", "curl")
         .pip_install("fastapi[standard]==0.140.0"))

app = modal.App("edit-proxies")


def run(command: list[str]) -> None:
    done = subprocess.run(command, capture_output=True, text=True)
    if done.returncode != 0:
        raise RuntimeError(done.stderr.strip().splitlines()[-1] if done.stderr.strip() else "ffmpeg failed")


@app.function(image=image, cpu=(4, 4), memory=(8192, 8192), timeout=1800, retries=0)
def make_proxy(get_url: str, put_url: str, spec: dict, width: int, height: int) -> dict:
    bitrate = int(spec["bitrate"])
    with tempfile.TemporaryDirectory() as folder:
        out = Path(folder) / "proxy.mp4"
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "stream=avg_frame_rate,r_frame_rate",
             "-of", "json", get_url],
            capture_output=True, text=True)
        fps = 30.0
        try:
            rate = json.loads(probe.stdout)["streams"][0]["avg_frame_rate"]
            num, den = rate.split("/")
            fps = float(num) / max(float(den), 1.0)
        except Exception:
            pass
        gop = max(1, round(fps * float(spec["gopSeconds"])))
        run(["ffmpeg", "-v", "error", "-y", "-i", get_url,
             "-vf", "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:out_color_matrix=bt709:out_range=tv,format=yuv420p",
             "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
             "-c:v", "libx264", "-preset", "veryfast", "-b:v", str(bitrate),
             "-maxrate", str(bitrate * 5 // 4), "-bufsize", str(bitrate * 2),
             "-g", str(gop), "-bf", "0",
             "-c:a", "aac", "-b:a", str(int(spec["audioBitrate"])), "-ac", "2",
             "-movflags", "+faststart", str(out)])
        data = out.read_bytes()
        put = subprocess.run(["curl", "-sS", "-X", "PUT", "--data-binary", f"@{out}", put_url],
                             capture_output=True, text=True)
        if put.returncode != 0:
            raise RuntimeError(put.stderr.strip() or "upload failed")
        return {"bytes": len(data), "width": width, "height": height}


def build_web():
    from fastapi import FastAPI, Header, HTTPException, Request

    web = FastAPI()

    @web.post("/")
    async def accept(request: Request, x_proxy_token: str | None = Header(default=None)) -> dict:
        expected = os.environ.get("EDIT_PROXY_TOKEN")
        if expected and x_proxy_token != expected:
            raise HTTPException(status_code=403, detail="bad token")
        payload = await request.json()
        for field in ("getUrl", "putUrl", "spec"):
            if field not in payload:
                raise HTTPException(status_code=400, detail=f"missing {field}")
        make_proxy.spawn(payload["getUrl"], payload["putUrl"], payload["spec"],
                         int(payload.get("width") or 0), int(payload.get("height") or 0))
        return {"accepted": True, "proxyKey": payload.get("proxyKey")}

    return web


@app.function(image=image, cpu=(1, 1), memory=(512, 512), timeout=120,
              secrets=[modal.Secret.from_name("edit-proxies-token")])
@modal.asgi_app()
def endpoint():
    return build_web()


@app.local_entrypoint()
def main(manifest_path: str, get_url: str, put_url: str) -> None:
    job = json.loads(Path(manifest_path).read_text())
    print(make_proxy.remote(get_url, put_url, job["spec"], job["width"], job["height"]))


if __name__ == "__main__":
    raise SystemExit("run with: modal run proxy.py --manifest-path ... (URLs presigned by the relay)")
