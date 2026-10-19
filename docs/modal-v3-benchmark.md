# Cloud exporter v3

V2 and the previous benchmarks were merged into `main` as `c9cba31`, adapted
to the code's new `app/` directory. This experiment layers v3 on that commit.
The existing pilot, Relay, live editor and user projects remain unchanged.

V3 keeps eight absolute picture ranges per video and the same native engine,
1080p/30 H.264 High, continuous 48 kHz stereo AAC and -14 LUFS. Its changes are:

- Immutable ETag/size/object-version source caching, SHA-256 checked on reuse.
- Picture keys from the engine's evaluated scenes (`chunks::split`), so a
  caption change invalidates its section and unchanged sections can be reused.
  Keys include the worker build. Audio uses the engine's independent sound key.
- SHA-256/length/version checks on every reused encoded picture and audio file.
- Eight CPU workers decode **every frame of the assembled finished MP4**, in
  exact PTS ranges overlapping each join by two frames. A separate job decodes
  the entire continuous audio. The coordinator checks every decoded range's
  frame count plus the whole picture stream's unique CFR PTS and monotonic DTS.
- Multipart uploads run during validation; the host completes/publishes an
  upload only after all checks pass. Failure cancels owned children and aborts
  unfinished uploads. Paid calls have no automatic retries.
- An explicit four/eight-L40S pool cap and eight CPU-verifier cap. These are
  separate machines, each GPU worker retaining four CPU cores and 16 GiB RAM;
  CPU verifiers have four cores and 4 GiB. Coordinators retain four cores/16 GiB.
- Mac delivery uses ETag-pinned parallel 32 MiB ranges and verifies the final
  SHA-256 against the verified cloud artifact.

Sources and encoded chunks can survive across runs in an explicitly named
experiment volume. `--keep-cache` retains that volume for a warm measurement;
otherwise the app stops and its volume is deleted. These private experimental
volumes need explicit cleanup after a warm sequence. Production retention,
fair scheduling/admission and integration with durable desktop export records
remain separate rollout work, as they were for v2.

## Run

From the repository root:

```sh
cd app
bun --no-env-file ../../repack/scripts/env.ts --path=/media -- \
  uv run --python 3.12 --with-requirements apps/worker/requirements.txt \
  --with boto3==1.40.31 python scripts/benchmark-modal-sections-v3.py \
  --execute --sections 8 --gpu-workers 4 --compute-budget-usd 8 \
  --cache-volume edit-exports-sections-v3-example --keep-cache \
  --output /tmp/edit-modal-v3-cold
```

Use the same volume, unchanged source/build/options and a fresh output folder
for a warm rerun, omitting `--keep-cache` on the last run. Use a new volume for
a cold eight-GPU measurement. `--skip-download` measures cloud readiness only
and records no Mac delivery result. A short odd-length smoke check uses
`--smoke --smoke-frames 123`; it is not a full-export speed measurement.

The compute allowance is a conservative bound on configured input timeouts,
startup and shutdown allowances, not expected spending. Execution resource
estimates include GPU workers, coordinators and CPU verifiers at the
[published Modal rates](https://modal.com/pricing). Startup, idle gaps, builds,
network and storage remain separate; estimates are not invoices.

## Comparison contract

Use exactly the frozen Young Actress (51,958 frames) and Corrupt Cop (34,987
frames) snapshots and full originals from the v2 evidence. Cold results include
source transfers; warm results explicitly report source, picture and sound
hits. Deployment and snapshot/URL preparation precede the clock, as in v2.
Cloud readiness includes allocation, planning, audio, rendering, assembly,
every-frame finished-file decoding, packet checks, upload and publication.
Mac delivery is separate. Cache reuse is not a cold-render speedup.

V2's historical pair was cloud-ready in 413.564 seconds and delivered in
526.229 seconds, with an execution resource estimate of $0.55686. Host/cache/
network variation and main's intervening changes limit causal comparisons;
record build identity and separate the worker-count change from architecture.

## Verification

```sh
cd app
uv run --python 3.12 --with httpx==0.28.1 \
  python -m unittest discover -s apps/worker -p 'test_*.py' -v
```

The tests include source-version invalidation, same-size corruption, warm
source reuse without network calls, broken packet timing and real FFmpeg
decoding of odd-length spans across GOPs with B-frames. A short stream cannot
pass a longer requested frame range. The native planner is also exercised
against the frozen full edit: one caption change invalidates one picture
section while preserving the sound key.

Measured results will be recorded here after the benchmark completes.
