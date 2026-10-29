"""A review copy made in the cloud: the export cut in pieces, each scaled to
720p on its own L40S (NVENC), joined without re-encoding, the sound encoded
once, a poster and a waveform beside it, every file put straight into R2.
Nothing goes through the Mac (the team, Oct 29: "everything should be done
on the cloud"; a 93-minute edit's review copy took 10 minutes there)."""
import json
from pathlib import Path
import subprocess
import tempfile

import httpx


def run(cmd):
    done = subprocess.run(cmd, capture_output=True)
    if done.returncode != 0:
        raise RuntimeError(done.stderr.decode(errors="replace").strip().splitlines()[-1:] or ["ffmpeg failed"])
    return done.stdout


def put(url, path, kind):
    with open(path, "rb") as body:
        answer = httpx.put(url, content=body, headers={"content-type": kind}, timeout=1800)
    if answer.status_code >= 300:
        raise RuntimeError(f"upload refused ({answer.status_code})")


def piece(source, start, frames, upload):
    """Frames [start, start + frames) of `source` (seconds, then a count) at 720p, picture only."""
    with tempfile.TemporaryDirectory() as folder:
        out = Path(folder) / "piece.mp4"
        common = ["ffmpeg", "-v", "error", "-nostdin", "-y", "-ss", f"{start:.6f}", "-i", source, "-frames:v", str(frames), "-an",
                  "-vf", "scale=-2:720"]
        try:
            run(common + ["-c:v", "h264_nvenc", "-b:v", "3M", "-g", "60", str(out)])
        except RuntimeError:
            run(common + ["-c:v", "libx264", "-preset", "veryfast", "-crf", "26", str(out)])
        put(upload, out, "video/mp4")
        return {"bytes": out.stat().st_size}


def probe(path):
    try:
        found = json.loads(run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)]))
    except (RuntimeError, ValueError):
        return {}
    video = next((one for one in found.get("streams", []) if one.get("codec_type") == "video"), None)
    audio = next((one for one in found.get("streams", []) if one.get("codec_type") == "audio"), None)
    out = {"sizeBytes": int(found.get("format", {}).get("size") or 0) or None,
           "bitRate": int(found.get("format", {}).get("bit_rate") or 0) or None}
    if video:
        out["video"] = {"width": video.get("width"), "height": video.get("height"), "codec": video.get("codec_name"),
                        "bitRate": int(video.get("bit_rate") or 0) or None}
    if audio:
        out["audio"] = {"codec": audio.get("codec_name"), "sampleRate": int(audio.get("sample_rate") or 0) or None,
                        "channels": audio.get("channels")}
    return out


def join(job, make_piece):
    """The pieces made at once, joined with the sound into the review copy; its poster and waveform."""
    calls = [make_piece.spawn(job["source"], one["start"], one["frames"], one["put"]) for one in job["pieces"]]
    for call in calls:
        call.get()
    with tempfile.TemporaryDirectory() as folder:
        folder = Path(folder)
        names = []
        with httpx.Client(timeout=1800) as client:
            for index, one in enumerate(job["pieces"]):
                path = folder / f"{index:03d}.mp4"
                with client.stream("GET", one["get"]) as answer:
                    if answer.status_code >= 300:
                        raise RuntimeError(f"a piece couldn't be read back ({answer.status_code})")
                    with path.open("wb") as out:
                        for chunk in answer.iter_bytes(1 << 20):
                            out.write(chunk)
                names.append(path)
        listing = folder / "pieces.txt"
        listing.write_text("".join(f"file '{path}'\n" for path in names))
        review = folder / "review.mp4"
        run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", str(listing), "-i", job["source"],
             "-map", "0:v:0", "-map", "1:a:0?", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(review)])
        put(job["video_put"], review, "video/mp4")
        poster = folder / "poster.jpg"
        run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-ss", f"{job['poster_second']:.2f}", "-i", job["source"], "-frames:v", "1",
             "-vf", "scale=1280:-2", str(poster)])
        put(job["poster_put"], poster, "image/jpeg")
        # Its loudest sample every 100 ms, 0–100, as the review page draws it.
        pcm = run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(review), "-ac", "1", "-ar", "8000", "-f", "s16le", "-"])
        samples = memoryview(pcm).cast("h")
        peaks = [round(max((abs(x) for x in samples[at:at + 800]), default=0) / 32768 * 100) for at in range(0, len(samples), 800)]
        return {"review": probe(review), "export": probe(job["source"]), "peaks": peaks}
