# Cloud exporter v3

V2 and the previous benchmarks were merged into `main` as `c9cba31`, adapted
to the code's new `app/` directory. This experiment layers v3 on that commit.
The existing pilot, Relay, live editor and user projects remain unchanged.

V3 keeps eight absolute picture ranges per video and the same native engine,
1080p/30 H.264 High, continuous 48 kHz stereo AAC and -14 LUFS. Its changes are:

- Immutable ETag/size/object-version source caching, SHA-256 checked on reuse.
- Picture keys from the engine's evaluated scenes (`chunks::split`), so a
  caption change invalidates its section and unchanged sections can be reused.
  Keys include native engine sources/dependencies, the image recipe, encoder
  version and GPU type. Transfer-only deployments preserve them. Audio uses
  the engine's independent sound key and encoder identity.
- SHA-256/length/version checks on every reused encoded picture and audio file.
- Eight CPU workers decode **every frame of the assembled finished MP4**, in
  exact PTS ranges overlapping each join by two frames. A separate job decodes
  the entire continuous audio. The coordinator checks every decoded range's
  frame count plus the whole picture stream's unique CFR PTS and monotonic DTS.
- Multipart uploads run during validation; the host completes/publishes an
  upload only after all checks pass. Failure cancels owned children and aborts
  unfinished uploads. Paid calls have no automatic retries.
- An explicit four/eight-L40S pool cap and eight/sixteen CPU-verifier cap. These are
  separate machines, each GPU worker retaining four CPU cores and 16 GiB RAM;
  CPU verifiers have four cores and 4 GiB. Coordinators retain four cores/16 GiB.
- Mac delivery uses ETag-pinned parallel 32 MiB ranges and verifies the final
  SHA-256 against the verified cloud artifact.
- Version-pinned file/range GETs and idempotent multipart PUTs get at most two
  retries on transport errors and transient HTTP failures. Authentication,
  source-version and integrity failures are fatal. Upload receipts record each
  part's attempts and duration. GPU and CPU function calls still have no retries.

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
and records no Mac delivery result. Add `--caption-edit` for a warm test that
changes one caption per video: source and sound should be reused, with only
the affected picture section rendered again. A short odd-length smoke check uses
`--smoke --smoke-frames 123`; it is not a full-export speed measurement.

The fastest configuration uses `--gpu-workers 8 --cpu-verifiers 16`; the
four-GPU and initial caption-revision measurements use eight CPU verifiers.
The faster configuration also queues continuous-audio verification before the
picture checks, so it cannot be held behind a burst of picture jobs. Treat
this as a combined GPU/CPU scaling comparison, not a GPU-only experiment.

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
section while preserving the sound key; changing audio gain preserves picture
keys and changes the sound key. Injected transfer failures check exact-byte
part retries, pinned source versions, retry bounds and fatal authorization errors.

The first smoke caught a serialized helper missing from the remote environment;
it was cancelled and its volume removed. The corrected 123-frame/eight-section
smoke passed. A subsequent first full trial rendered all sixteen sections and
published Corrupt Cop in 162.247 seconds (byte-identical to v2), but the longer
output hit a write timeout during finishing. That pair is excluded. Both
assembled files existed in its private volume; a missing successful longer-file
receipt prevents reporting a cloud-ready time for it. The retry handling,
stage diagnostics and independent engine cache identity were added before the
fresh full trials. Failed trials and image builds are additional costs.

## Selected full-pair measurements

Both unchanged videos total 86,945 frames / 48 minutes 18 seconds. Both v3
cold configurations' full MP4 SHA-256 hashes match historical v2 exactly, including every
picture frame, AAC packet and timestamp; the Mac copies match the cloud hashes.
The independent Corrupt Cop decoded-audio check and all seven sampled joins
also match exactly (SSIM 1.0). Complete raw receipts and comparisons are in
[the evidence](benchmarks/modal-v3-2026-10-19.json).

- **V3, four L40S / eight CPU-verifier cap:** both cloud-ready in **291.242 s
  (4:51)**; both on the Mac in **316.682 s (5:17)**. Estimated execution
  resources **$0.57044**. Observed GPU concurrency: four.
- **V3, eight L40S / sixteen CPU-verifier cap:** both cloud-ready in
  **265.514 s (4:26)**; both on the Mac in **291.263 s (4:51)**. Estimated
  execution resources **$0.57624**. Observed GPU concurrency: eight.
- **One caption changed per video, four-GPU cap:** both verified cloud files
  ready in **158.634 s (2:39)**, estimated execution resources **$0.10551**.
  This reused all 23 sources, both continuous audio mixes and fourteen of
  sixteen picture sections; two sections rendered on two GPUs. No output
  download was requested. This is an incremental revision, not a cold export.

Compared with the historical v2 pair's 413.564 s / 526.229 s, the four-GPU
pipeline removes about 30% of cloud time and 40% of delivery time. The larger
GPU/CPU configuration saves a further 25.728 seconds of cloud time in this
trial (about 9%) for a similar execution resource estimate. Increasing worker
count did not halve elapsed time or reduce the GPU work being encoded.

The eight-GPU run's first three GPU inputs started about 21 seconds after
submission. The other five containers' first inputs began about 70–79 seconds
after submission, so the additional parallel capacity arrived gradually.
Receipts establish these start times, but do not isolate capacity allocation,
image initialization and scheduler effects. Young Actress's final picture
section finished around 196 seconds; assembly, validation and transfer still
followed. A real `WriteTimeout` on upload part 53 was recovered by one retry
(22.14 seconds for that part's attempts). No GPU section was submitted again.

The four-GPU and revision runs use worker build
`f8b791f6a612564d1e9358fa39e9e35b0c4eb3ccf78cf985a1a7122ac2fec4f6`.
The larger-pool run and refreshed v2 control use
`1680528c50c9a3e4daf388ced32e4c7e13efa6313c35b523ca54e19f9b9a6e99`.
Both share native engine/image-recipe identity
`920407ea3e51753e6ff44863467eba7fc3bb62723096ad152caf42d43821cebc`.
Source versions and timeline snapshot hashes are checked across the trials.

The refreshed v2 control uses the same native engine and source versions as
the larger-pool v3 run. Its cloud files were ready in **447.527 s (7:28)**.
Against this matched control, v3's four-GPU run reduces cloud time by about
35%, and the larger-pool run by about 41%. Corrupt Cop's control file is
byte-identical to historical v2; Young Actress's differs and is compared
separately for decoded audio and seam quality. Its decoded audio matches
exactly, and all seven three-frame seam comparisons have SSIM 1.0. The encoded
video differs by 5,844 bytes; the cause is not isolated. These boundary samples
are not a full perceptual comparison, while the unchanged v3 files do have
complete byte equality to historical v2.

Both control files reached the Mac in **583.993 s (9:44)**; estimated execution
resources were **$0.55181**. V3's larger pool cut this delivery time by about
50%, at an execution estimate roughly 2.4 cents higher for the pair. Its
four-GPU default cut delivery time by about 46%, at about 1.9 cents more.
The successful-trial estimate is not the total experiment bill: failed trials,
smokes, image builds, startup/idle and storage/network are additional.

All four selected trials passed source-version/snapshot checks, exact picture
counts and full finished-file software decoding. V3 additionally checks every
picture PTS on the CFR grid, monotonic DTS and every decoded validation range
with both sides of each join. Worker tests (22), server tests (437 passed,
7 skipped), web tests (110), both TypeScript checks, native worker build,
Rust fmt/clippy and the mixer/chunk tests (14) passed.

The benchmark apps are stopped and their temporary volumes deleted. The normal
pilot and all four Repack apps retained their original deployment IDs and
were not changed; the local editor process was not restarted or signalled.
The changes and evidence are committed on `main`, without a push, release or
production activation. Live exports still use their existing path until
distributed-export rollout is integrated explicitly.

One successful pair per configuration does not establish a stable production
latency distribution or guarantee a lower invoice. The larger-pool result
includes a real recovered upload stall; it is not a hypothetical best case.
