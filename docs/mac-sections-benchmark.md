# Local Mac section-export benchmark

Two concurrent workers took **12.18% longer** on the complete frozen pair in
this experiment. The small gain in the two-minute calibration did not carry
over to the full edits.

| Measurement | Seconds | Time |
| --- | ---: | ---: |
| Young Actress, normal export | 299.569 | 4:59.6 |
| Corrupt Cop, normal export | 1,143.979 | 19:04.0 |
| Serial baseline: sum of individual exports | 1,443.548 | 24:03.5 |
| Both videos, two workers and eight sections per video | 1,619.424 | 26:59.4 |

The concurrent run took an extra 175.876 seconds. Its first complete video
was ready after 1,483.463 seconds. This is one trial on this Mac, with fresh
export caches; incremental re-exports that reuse unchanged chunks are not
measured here. The application keeps its existing local export behavior.

All four complete outputs passed full software decoding, exact frame counts
(51,958 and 34,987) and timestamp checks. Both concurrent files have the same
decoded audio hashes as their normal exports. Fourteen sampled joins had
SSIM between 0.991447 and 0.998189; maximum frame-grid timing error was
0.016667 ms. Post-export verification took 266.988 s across the individual
normal files and 290.887 s for the concurrent pair, separate from the table.
Python syntax and the process-group cancellation isolation test passed.

[Raw measurements, source hashes and validation](benchmarks/mac-sections-2026-10-19.json)
include the individual normal runs, the derived serial timeline, every
section's timing and the discarded-trial notes. The rendering binary is
pinned by SHA-256; the archived script hash identifies the final reproduction
version, which includes additional reporting diagnostics.

Corrupt Cop's model has rectangular blurs across 97.08% of its frame span,
often two at once; Young Actress has none. This is a useful candidate for
future profiling. Stage utilization was not measured, so this experiment
does not identify the precise bottleneck. Both worker processes share the
same M1 hardware. Power was observed on AC with Low Power Mode off; process
priority was `nice 15`. Memory pressure varied between normal and the warning
level already seen before the experiment, below the critical stop threshold.

The experiment runs on this machine, an Apple M1 MacBook Air with 8 GiB RAM.
It makes no Modal API calls and uses an independent `edit-worker` binary
built with `[profile.serve]` (optimized native code). It neither starts a
replacement editor nor writes the live project registry or application caches.

The same frozen Young Actress (51,958 frames) and Corrupt Cop (34,987 frames)
snapshots used by the Modal benchmark are copied to a private temporary
folder. Full-quality original media are pinned by R2 ETag and size, then
SHA-256 hashed. Existing local images, music and narration are copied too,
so an ongoing edit cannot change the benchmark's sources. Source preparation
is separate from the export timers.

The baseline uses the normal Mac export path, each video on its own with
fresh private chunk caches. Live media jobs interrupted three
attempts at an uninterrupted serial batch. After the user confirmed the Mac
was idle, the completed Young Actress baseline was preserved and Corrupt Cop
was measured separately. The reported serial total is the **sum of these two
individual export times**, excluding idle gaps and all interrupted work; it
is not an observed uninterrupted batch wall time.

The candidate mixes each video's
continuous audio first, then renders absolute frame ranges through a bounded
pool of independent native processes sharing this Mac. The sections are
joined with explicit frame-derived durations and stream-copy muxing. They
use H.264 High, 1920×1080/30 fps, hardware encoding and -14 LUFS, matching the
baseline. Audio never decodes beside the picture's AVFoundation readers on
this one machine; Modal could overlap these on separate machines.

The timer ends when both complete output MP4s exist. Full decode, frame and
audio integrity checks happen afterward and are recorded separately. This
matches normal local-export readiness; Modal's published cloud-ready metric
also included its mandatory full validation and network publication, so these
are different timing boundaries. Each configuration has fresh export caches;
the OS's file caches are not flushed, and thermal/background variation is
not controlled. A single pair is an experiment, not a speed guarantee.

## Controls

The workers run at reduced priority and have memory, free-space, cancellation
and execution-time checks. They terminate only their own process groups. An
external video/media FFmpeg job causes the benchmark to yield; the live job
is never paused or killed. Interrupted timings are excluded and a new private
run starts after an idle window. The live application may change or restart
through other work; this benchmark does not perform those actions.

A three-second native smoke export checks the native path before longer runs.
An initial calibration used extensionless downloaded sources, causing
AVFoundation to report no native tracks and fall back to FFmpeg. Those
calibrations were discarded. Downloaded sources now retain their proper
extensions. A later calibration was stopped when another live-project import
began using the media engine; it is excluded too.

VideoToolbox's native MP4 timestamps are rounded in 600 kHz ticks (about
1.7 microseconds); normal and joined outputs can differ from a mathematical
30 fps grid by several ticks. Checks require every frame exactly once, presentation times
within 1 ms of the expected frame, monotonically increasing DTS and the
correct nominal rate and duration. They do not reject a valid native output
merely because its reported average rate differs by a tiny rounding error.
Additional checks decode the complete audio/video streams, compare decoded
float-PCM audio hashes against the normal export and sample picture frames
around section boundaries. Sampling seeks half a frame early so microscopic
PTS rounding cannot select a different frame in just one file.

The short trials completed in 79.191 s normally, 74.234 s with two workers
and 75.728 s with three. Normal and two-worker trials passed decoded-audio
parity and boundary comparisons (SSIM 0.993322 and 0.996654). Three workers
were not selected: they were slower and Corrupt Cop's decoded audio checksum
differed. That difference occurred before any picture worker started.
Three later standalone audio-only repeats had identical mixed-PCM and decoded
AAC hashes, matching the three-worker audio variant. The cause of the earlier
two native-audio variants has not been established; the three-worker trial
is not treated as a fully passed result. The differing 120-second files have
equal decoded sample counts; their RMS sample difference is -83.83 dBFS.

## Reproduction

Build in a separate internal-SSD build directory, with two compiler jobs:

```sh
CARGO_BUILD_JOBS=2 \
CARGO_TARGET_DIR="$HOME/edit-build/mac-sections/target" \
CARGO_BUILD_BUILD_DIR="$HOME/edit-build/mac-sections/build" \
cargo build --profile serve --locked -p edit-engine --bin edit-worker
```

Prepare originals once, using the existing R2 settings injected into this
process only:

```sh
bun --no-env-file ../repack/scripts/env.ts --path=/media -- \
  uv run --python 3.12 --with-requirements apps/worker/requirements.txt \
  --with boto3==1.40.31 python scripts/benchmark-mac-sections.py prepare \
  --execute --folder /tmp/edit-mac-sections
```

Run the baseline and candidate sequentially in fresh output directories. A
`--frames 3600 --sections 2` calibration exports two minutes of each video.
Omit `--frames` for the complete real pair.
Use `--fixture "Young Actress"` or `--fixture "Corrupt Cop"` to measure only
one fixture with its own fresh export cache.

```sh
uv run --python 3.12 --no-project python scripts/benchmark-mac-sections.py run \
  --execute --folder /tmp/edit-mac-sections \
  --binary "$HOME/edit-build/mac-sections/target/serve/edit-worker" \
  --name full-normal --mode normal --lanes 1 --sections 1

uv run --python 3.12 --no-project python scripts/benchmark-mac-sections.py run \
  --execute --folder /tmp/edit-mac-sections \
  --binary "$HOME/edit-build/mac-sections/target/serve/edit-worker" \
  --name full-parallel --mode sections --lanes 2 --sections 8

uv run --python 3.12 --no-project python scripts/benchmark-mac-sections.py verify \
  --execute --folder /tmp/edit-mac-sections --name full-normal

uv run --python 3.12 --no-project python scripts/benchmark-mac-sections.py verify \
  --execute --folder /tmp/edit-mac-sections --name full-parallel \
  --reference /tmp/edit-mac-sections/full-normal/report.json
```

A `cancel` file in the experiment folder stops only its own workers. The
script refuses to reuse an existing run directory. Local rendering carries
no Modal compute charge; source storage/network and electricity are separate.
Production local exports retain their existing behavior.

After validation, owned section MP4s and interrupted-run MP4s were removed,
reclaiming 4.864 GB. All four verified full outputs, pinned original inputs,
logs and reports remain in the private experiment folder.
