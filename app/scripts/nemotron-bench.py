#!/usr/bin/env python3
"""NVIDIA Nemotron 3.5 Transcribe on our own hour-long footage, on Modal.

A bench, not part of Edit (docs/plans/2026-10-29-nemotron-transcribe.md):
serves the model with vLLM on one H100 as its model card does, hears each
whole file once per prompt with word timestamps and speaker tags, and saves
the raw answers for nemotron-score.py to compare with our transcripts.

    uv run --with modal python scripts/nemotron-bench.py \
        --audio /tmp/nemo-bench/audio --out /tmp/nemo-bench/out \
        --terms killer-couple="Jasmine Jones,Phazion Whyte,Malik Jones,Mike,Jeff"

Audio is 16 kHz mono WAV, one file per video, at most an hour (the model's
limit). The weights stay in the `nemotron-bench` volume between runs.
"""
import argparse
import json
from pathlib import Path
import time

import modal

MODEL = "nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B"
WEIGHTS = "/vol/weights"
AUDIO = "/vol/audio"

# The card's prompt for speaker tags with word timestamps, word for word.
CARD = (
    "Transcribe this audio with punctuation and capitalization. "
    "Include all spoken words and verbal fillers. "
    "Write numbers in their standard written form. "
    "Put speaker tags <spk:0> <spk:1> <spk:2> <spk:3> on the transcription."
)
# Ours: the card's multi-speaker wording (more than four people talk in our
# videos) and the case's names, as Scribe gets them as keyterms.
OURS = (
    "Transcribe this audio with punctuation and capitalization. "
    "Include all spoken words and verbal fillers. "
    "Write numbers in their standard written form. "
    "Start every speaker turn with a speaker tag such as <spk:0>, <spk:1>, <spk:2>, etc.; "
    "assign one stable tag per speaker and keep speaker identities consistent."
)

app = modal.App("nemotron-bench")
volume = modal.Volume.from_name("nemotron-bench", create_if_missing=True)

image = (
    modal.Image.from_registry("nvidia/cuda:12.9.1-devel-ubuntu24.04", add_python="3.13")
    .apt_install("git", "curl")
    .pip_install("uv")
    .run_commands(
        "git clone https://github.com/NVIDIA-NeMo/Speech.git /opt/nemo-speech",
        "cd /opt/nemo-speech && git rev-parse HEAD > /opt/nemo-speech.commit",
        "cd /opt/nemo-speech && uv venv --python 3.13 .venv"
        " && UV_PROJECT_ENVIRONMENT=/opt/nemo-speech/.venv uv sync --extra asr --extra vllm --locked --no-install-project",
        "cd /opt/nemo-speech && uv pip install --python .venv/bin/python --no-deps -e ."
        " && uv pip install --python .venv/bin/python --no-deps av==19.0.2 opencv-python-headless==5.0.0.93",
    )
    # FlashInfer compiles its kernels on first start, with ninja from the PATH.
    .run_commands("uv pip install --python /opt/nemo-speech/.venv/bin/python ninja")
)


@app.function(image=image, volumes={"/vol": volume}, timeout=3 * 3600, cpu=16, memory=32768)
def download() -> str:
    import os
    import subprocess

    # One 67.5 GB file: xet's high-performance mode, resuming what an earlier run left.
    weights = Path(WEIGHTS, "model.safetensors")
    if weights.exists() and weights.stat().st_size > 67e9:
        return "weights already in the volume"
    subprocess.run(
        ["/opt/nemo-speech/.venv/bin/python", "-c",
         f"from huggingface_hub import snapshot_download; snapshot_download({MODEL!r}, local_dir={WEIGHTS!r})"],
        check=True, env=dict(os.environ, HF_XET_HIGH_PERFORMANCE="1"),
    )
    volume.commit()
    return "weights downloaded"


@app.function(image=image, volumes={"/vol": volume}, gpu="H100", timeout=3 * 3600)
def hear(jobs: list[dict]) -> dict:
    """Serves the model and sends every job at once; returns each answer with its timings."""
    import base64
    from concurrent.futures import ThreadPoolExecutor
    import os
    import subprocess
    import urllib.request

    started = time.time()
    env = dict(os.environ,
               PATH=f"/opt/nemo-speech/.venv/bin:/usr/local/cuda/bin:{os.environ['PATH']}",
               VLLM_PLUGINS="nemo_speechlm",
               VLLM_MAX_AUDIO_DECODE_DURATION_S="3600",
               VLLM_MAX_AUDIO_CLIP_FILESIZE_MB="180",
               VLLM_USE_V2_MODEL_RUNNER="0")
    server = subprocess.Popen([
        "/opt/nemo-speech/.venv/bin/vllm", "serve", WEIGHTS,
        "--served-model-name", MODEL,
        "--trust-remote-code", "--dtype", "bfloat16", "--gpu-memory-utilization", "0.94",
        "--max-model-len", "65536", "--max-num-batched-tokens", "4096", "--max-num-seqs", "192",
        "--enable-chunked-prefill", "--no-enable-prefix-caching",
        "--use-replayssm", "--mamba-backend", "flashinfer", "--mamba-cache-mode", "none",
        "--mm-processor-cache-gb", "0", "--no-async-scheduling",
        "--limit-mm-per-prompt", '{"audio":{"count":6,"length":120000000}}',
        "--speculative-config", '{"method":"mtp","num_speculative_tokens":8}',
        "--reasoning-parser", "nemotron_v3",
        "--trust-request-mm-kwargs",
        "--middleware", "nemo.collections.speechlm2.vllm.salm.ctc_serving.ctc_timestamp_middleware",
    ], env=env)
    try:
        while True:
            if server.poll() is not None:
                raise RuntimeError(f"vllm serve exited with {server.returncode}")
            try:
                urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=5)
                break
            except OSError:
                time.sleep(5)
        ready = time.time()

        def one(job: dict) -> dict:
            audio = base64.b64encode(Path(AUDIO, job["file"]).read_bytes()).decode()
            body = {
                "model": MODEL,
                "messages": [{"role": "user", "content": [
                    {"type": "text", "text": job["prompt"]},
                    {"type": "audio_url", "audio_url": {"url": f"data:audio/wav;base64,{audio}"}},
                ]}],
                "temperature": 0,
                "top_p": 1.0,
                "chat_template_kwargs": {"enable_thinking": False},
                "skip_special_tokens": False,
                "spaces_between_special_tokens": False,
                "seed": 0,
                "mm_processor_kwargs": {"capture_ctc_timestamps": True},
            }
            request = urllib.request.Request(
                "http://127.0.0.1:8000/v1/chat/completions",
                data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
            began = time.time()
            try:
                with urllib.request.urlopen(request, timeout=7200) as answer:
                    result = json.load(answer)
            except urllib.error.HTTPError as error:
                result = {"http_error": error.code, "body": error.read().decode(errors="replace")[:4000]}
            return {**job, "seconds": round(time.time() - began, 1), "response": result}

        with ThreadPoolExecutor(len(jobs)) as pool:
            answers = list(pool.map(one, jobs))
        return {
            "nemo_speech_commit": Path("/opt/nemo-speech.commit").read_text().strip(),
            "load_seconds": round(ready - started, 1),
            "hear_seconds": round(time.time() - ready, 1),
            "answers": answers,
        }
    finally:
        server.terminate()
        try:
            server.wait(30)
        except subprocess.TimeoutExpired:
            server.kill()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", type=Path, required=True, help="folder of <video>.wav")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--terms", action="append", default=[], help='video="Name One,Name Two"')
    args = parser.parse_args()
    terms = dict(item.split("=", 1) for item in args.terms)
    files = sorted(args.audio.glob("*.wav"))
    args.out.mkdir(parents=True, exist_ok=True)

    with modal.enable_output(), app.run():
        print(download.remote())
        with volume.batch_upload(force=True) as batch:
            for file in files:
                batch.put_file(file, f"/audio/{file.name}")
        jobs = []
        for file in files:
            jobs.append({"video": file.stem, "file": file.name, "variant": "card", "prompt": CARD})
            ours = OURS + (f" Context terms: {terms[file.stem]}." if file.stem in terms else "")
            jobs.append({"video": file.stem, "file": file.name, "variant": "ours", "prompt": ours})
        began = time.time()
        result = hear.remote(jobs)
        print(f"loaded in {result['load_seconds']} s, heard in {result['hear_seconds']} s, "
              f"{round(time.time() - began)} s on the H100 in all (NeMo Speech {result['nemo_speech_commit'][:10]})")
        for answer in result["answers"]:
            path = args.out / f"{answer['video']}-{answer['variant']}.json"
            path.write_text(json.dumps({**answer, "nemo_speech_commit": result["nemo_speech_commit"],
                                        "load_seconds": result["load_seconds"]}, indent=1))
            print(f"{path.name}: {answer['seconds']} s")


if __name__ == "__main__":
    main()
