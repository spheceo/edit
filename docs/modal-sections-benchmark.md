# Concurrent section export experiment

This is an explicit benchmark in `edit-exports-sections-benchmark`, separate
from the normal `edit-exports-pilot` deployment, Relay and the desktop app.
It uses the current native engine, including normal-speed audio muting in
Rust. The previous L4 and L40S measurements intentionally used the old mixer.

Each video has a CPU coordinator. It downloads the ETag-pinned source assets
once into a new, private Modal Volume, then submits eight frame ranges to a
shared pool capped at four L40S workers. Each GPU worker has four physical CPU
cores and 16 GiB RAM and runs one picture section at a time. The full timeline
stays intact, so source offsets, subtitles, keyframes and transitions keep
their absolute timeline times. Integer half-open ranges cover every frame
exactly once, including videos whose length is not divisible by eight.

A separate CPU process mixes each video's sound continuously, using the same
engine and codec options. It runs alongside the remote picture work. Joining
the video-only sections with that sound uses FFmpeg stream copying, followed
by exact metadata/timing checks and a full software decode of the assembled
MP4. Four concurrent 32 MiB multipart uploads publish the verified output to
an experiment-only R2 key. Downloading to the Mac is a separate measurement;
no Mac media download is required to render or publish the cloud result.

The two real fixtures are the same frozen Young Actress (51,958 frames) and
Corrupt Cop (34,987 frames) snapshots as the previous benchmarks. Source
preparation and image deployment precede the timer; allocation, source
transfers, audio, all picture work, assembly, final validation and publication
are included. Quality remains 1920×1080/30 fps, H.264 High, stereo AAC and
-14 LUFS. Section boundaries reset encoding state, so the compressed picture
will not be byte-identical to a single-session export.

## Running

From the isolated `edit-modal` checkout, with process-only R2 injection:

```sh
cd app
bun --no-env-file ../../repack/scripts/env.ts --path=/media -- \
  uv run --python 3.12 --with-requirements apps/worker/requirements.txt \
  --with boto3==1.40.31 python scripts/benchmark-modal-sections.py \
  --execute --sections 8 --compute-budget-usd 7 \
  --output /tmp/edit-modal-sections-real
```

A four-second, four-section smoke check uses `--smoke --sections 4
--compute-budget-usd 2` and a different output folder. The source still
transfers cold. Never reuse an existing report directory or repeat a failed
run without inspecting its result. A `cancel` file in the output directory
stops the local driver, which stops this experiment's entire app and aborts
unfinished multipart uploads. It does not contact other apps.

Each GPU input has a 300-second execution timeout and 300-second startup
allowance, with zero paid retries. CPU coordinators have a 1,200-second input
timeout. The allowance check conservatively accounts for every possible input
and startup/shutdown allowance; it is not a charge or invoice. Image builds,
network and storage are separate. Execution estimates sum each section's GPU,
CPU and RAM interval, plus the coordinators' CPU and RAM intervals at the
[published rates](https://modal.com/pricing); they exclude allocation startup
and idle time. The benchmark app stops and its temporary volume is deleted
on completion or failure.

This is a performance experiment, not activation of production distributed
exports. Durable parent/section receipts, fair admission across projects,
content-addressed reusable chunks, production cancellation/recovery and
cloud-first desktop export records still need integration before rollout.

## Full 1080p pair — 2026-10-19

The successful run used build
`9bd9f47c97291401b50b2126b23d77a7fa3b0855cf7592445c31b845a5204716`.
Both full-length edits were submitted together, split into eight sections
each and served by four separate L40S containers. The complete verified cloud
results were ready in **6:54**, compared with **16:20** for the earlier whole
exports sharing one L40S: **2.37×** faster for the pair.

- Young Actress (28.9 minutes): **6:54**, previously **16:20**.
- Corrupt Cop (19.4 minutes): **3:35**, previously **8:46**.

Both complete files were downloaded to the Mac in **8:46**, previously **18:03**
(2.06× faster including delivery). The source video never downloaded to the
Mac for cloud rendering. The verified cloud-to-Mac output copies matched their
cloud SHA-256 values.

The full finished-file software decodes passed. Local checks confirmed exact
51,958 / 34,987 frame counts, continuous frame-by-frame PTS and DTS, stereo AAC
starting at zero and -14.1 LUFS on both files. Decoded AAC peaks were -0.8 dBFS
for Young Actress and -1.3 dBFS for Corrupt Cop, matching the old measurements.
Samples around all fourteen section boundaries had SSIM 0.9967–0.9989 against
the old whole-video exports at 960×540. These are boundary samples, not a full
perceptual comparison. The [raw evidence](benchmarks/modal-sections-2026-10-19.json)
contains per-section allocation intervals, all stages, output hashes, checks,
prior attempts and the comparison calculations.

Measured execution resource estimates are **$0.557** for the successful pair,
versus **$0.612** previously (about 9% lower). This includes 799.91 GPU-worker
seconds at $0.00062992/s and 602.62 CPU-coordinator seconds at $0.00008792/s.
The GPU-worker rate includes its four CPU cores and 16 GiB, as does the
CPU-coordinator rate. Allocation startup, idle gaps, builds, storage/network,
two short smoke checks and one failed full-pair attempt are additional.
These estimates are not invoices or a guarantee of lower bills. There is one
successful pair per configuration, with different allocations and potential
host/cache/network variation.

The first full attempt stopped at assembled-file metadata validation after
all eight Corrupt Cop picture sections had passed individually. No output
from that attempt was published. The concat list now declares each section's
length from its frame count instead of relying on inferred container
lengths. A short 123-frame/eight-section case then passed, followed by the
full pair. The first error did not retain detailed assembled-file metadata,
so the precise failed field is not established retrospectively.

The original editor process remained running. This experiment did not deploy
over Relay, the normal pilot or Repack, and did not edit a user project.
The benchmark app stops and its temporary shared volume is removed at the
end; the finished cloud MP4s remain under `edit/test/sections-benchmark/`.

### Remaining latency

Young Actress's last picture section was available about **3:53** after
submission. Assembly, full finished-file software decoding, hashing, upload
and publication took the remaining approximately **3:01**. Its full decode
alone took **130.5 seconds**, versus **80.0 seconds** for Corrupt Cop.
This demonstrates that the current complete pipeline has substantial CPU and
I/O work after the GPU rendering ends. A one-minute full cold export has not
been demonstrated. Persistent source/chunk reuse, validation distributed over
finished sections and faster assembly/delivery remain useful next experiments.
