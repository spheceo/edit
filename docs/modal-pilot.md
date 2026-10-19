# Modal export pilot — 2026-10-19

Latest: the [concurrent section benchmark](modal-sections-benchmark.md) includes
the current audio improvements. The same full 1080p pair was cloud-ready in
6:54 and downloaded in 8:46, using a four-L40S pool with eight sections per video.

Built on `feat/modal-workers` in a separate worktree. The original checkout,
running `/tmp/run/edit` process (PID 13625), production Relay, Repack apps,
shared project registry and user projects were not restarted, deployed over
or changed. Pilot media were synthetic, under Edit's own R2 namespace.

The desktop continues to own the agent and its subscription. The optional
backend stages an immutable timeline/asset manifest, queues it through Relay,
and exports with the actual Rust engine and compositor on Linux. Three
asynchronous inputs share one L4, with separate native processes, temporary
folders and cancellation signals. Cloud renders do not pause local media
work. Three footage imports can independently transfer in parallel, with
four Drive ranges per source and local excerpt encodes in their own lane.

## Observed result

Three distinct **30-second, 640×360, 30 fps** timelines, each containing video,
a text overlay and audio with a mute, completed through **Relay → Modal → R2
→ verified download** in **38.60 seconds**. All three worker intervals overlap
for **18.95 seconds**. No duplicate render was created by repeating each
submission. The outputs each contain 900 video frames and stereo AAC sound.

The worker verified codec, dimensions, frame count, duration, required audio
and a full decode before publishing. One downloaded output was additionally
inspected visually (the expected source and text overlay) and decoded for
audio level checks: -24.4 dB mean / -19.7 dB maximum in its first two seconds.
The L4 hardware probe separately opened actual H.264 and HEVC NVENC sessions
and initialized Edit's GPU compositor.

The first shared Function pool reused one GPU serially: 49.93 seconds for the
three outputs. Separate parameterized worker pools also failed to overlap in
this account during the test (160.89 seconds); the cause of their allocation
delays was not established. Explicit asynchronous input concurrency on a
single GPU produced the successful overlap. These experiments do not establish
a speed comparison against a Mac or the cost of a full 1080p/4K edit.

The [raw successful run](benchmarks/modal-2026-10-19.json) records the tested
build and each job's timestamps, output key and size. Startup, queueing and
output delivery are included in the reported end-to-end time; image building
and deployment are not.

## Cost and verification boundaries

The Relay's cumulative compute reservation limit for the pilot was **$4.20**.
Two production-timeout rounds reserved $2.01 each; the final smoke test used
enforced 120-second input / 30-second startup limits and reserved $0.05 per
job, bringing reservations to **$4.17**. Reservations are conservative limits,
not billed costs. The recorded per-job runtime estimate assumes a whole
worker; do not sum these as invoice attribution when jobs share a GPU.
Hardware probes, gateway/image building, network/storage, unrelated workspace
usage and an actual Modal invoice are outside this reservation ledger.

Offline checks cover durable admission, duplicate claims/submissions, three
slots, deadlines, cancellation fencing, explicit retries versus reconnects,
multipart publication, version-pinned and truncated inputs, parallel source
transfers, source-copy races and cancellation of one process without killing
its peer. Native export unit tests, Rust clippy/formatting, web/server
typechecks and their test suites were run. The pilot Relay was bundle-checked
before its independent deployment.

## Activation

Cloud exports and parallel imports remain opt-in, through
`EDIT_CLOUD_EXPORTS=1` and `EDIT_PARALLEL_DOWNLOADS=1` on a future desktop
start. The pilot services scale to zero. Test tokens were deliberately
disposable and were not written to local files. Reconfigure them through the
normal process-only secret injection before another pilot/client session.

Follow the [worker deployment guide](../app/apps/worker/README.md) in an idle
window, using a production worker/Relay configuration with matching timeouts,
a separate worker token and an explicit budget. Run a representative real
edit before deciding throughput targets or retiring Repack resources. Finished
files still download to the desktop; existing subtitled-video Drive delivery
continues from there. Moving that final R2 → Drive delivery fully into Relay
is a separate remaining transfer optimization.


## Real 1080p pair — 2026-10-19

Two recently exported, frozen history revisions were submitted together to one L4 (four physical CPU cores, 16 GiB). Both used native 1920×1080/30 fps, H.264 High quality, stereo sound and a -14 LUFS target. Original assets were already in R2. Timings begin at the first job submission and include cold allocation, R2 inputs, audio, picture, join, full decode validation and R2 publication; desktop delivery is recorded separately. Deployment and manifest preparation precede the timer.

- **Young Actress** (28.9 minutes): cloud result observed at **26:59**, downloaded at **28:47**. Historical full local export: **5:06**.
- **Corrupt Cop** (19.4 minutes): cloud result observed at **15:59**, downloaded at **16:56**. Historical full local export: **13:13**.

Both files were on the Mac by **28:47**, versus **18:19** for the sum of the earlier full local exports. This is a historical comparison, not a new controlled Mac rerun. Cached local re-exports (including Corrupt Cop's 35 seconds) are excluded. **This L4 configuration was slower overall.**

The shared worker execution interval implies about **$0.48** at [Modal's published base rates](https://modal.com/pricing), before gateway/build/startup/storage/network costs and prior cancelled trials. This is an allocation-based estimate, not the actual invoice. Per-job estimates double-count overlapping GPU use. The daily reservation ledger reached $8.19 against $8.20, including $4.17 from the earlier synthetic trials; reservations are not charges.

Picture-progress samples show an approximately **211.0-second** overlap window before either render approached completion; this is a stage estimate, not GPU kernel timing. Inspection also showed two growing picture files and GPU contexts in the same L4 container. Both outputs passed the worker's full decode, codec, dimensions, duration and frame-count checks. Local ffprobe confirmed all 51,958 / 34,987 video frames, audio starting at zero and stereo AAC at 48 kHz. Frames were checked against frozen local previews, including the desktop profile and subtitles; this is a visual spot check, not a full perceptual quality comparison between encoders.

- Young Actress sound: -14.1 LUFS, true peak -0.8 dBFS.
- Corrupt Cop sound: -14.1 LUFS, true peak -1.3 dBFS.

The decoded AAC for Young Actress has a true peak 0.2 dB above the -1 dB PCM limiter ceiling; the recorded value is retained as a lossy-encoding quality limitation.

The first real trial exposed a roughly 2 MB/s single-stream download for the 3.5 GB source. Both jobs were cancelled; eight bounded, ETag-pinned byte ranges then fetched that source in **39.4 seconds**. A second trial was cancelled after catching a quality-setting mismatch, before the final High-quality run. Those attempts are retained in the ledger.

The full run also exposed a Linux audio bottleneck: dozens of word-mute expressions evaluated for every sample in FFmpeg. A subsequent change applies normal-speed mutes in Rust using the same cosine ramps as the native reader; nonstandard speeds still mute before atempo. Eleven audio tests, including decoder parity, passed, along with clippy and formatting. **The timing above predates this audio change.** The idle pilot was refreshed afterward without starting a new export; this does not establish its new full-export speed.

The benchmark never opened or saved the live projects, restarted the editor, deployed production Relay or changed Repack. The original PID 13625 remained running. Cloud exports remain opt-in. Final R2 → Drive delivery and efficient GPU/CPU data movement still need measurement before production activation.

The [raw real-project run](benchmarks/modal-real-2026-10-19.json) includes immutable snapshot hashes, job/build identities, progress samples, output keys, delivery times and verification. Reproduce with `scripts/benchmark-modal.py --execute --daily-reservation-usd <explicit cumulative cap>` through process-only R2 injection; use a fresh output folder and wait for the pilot to be idle. The current branch includes the later audio fix, so another run will measure a different build.


## RTX PRO 6000 attempt — 2026-10-19

The same frozen Young Actress and Corrupt Cop revisions were submitted together
twice to one RTX-PRO-6000, with the same four cores, 16 GiB, High H.264 settings
and original engine revision `b5a2477`. A detached benchmark checkout deliberately
excluded the later audio optimization so a successful run could isolate the GPU
change. Snapshot hashes exactly matched the completed L4 run.

**Neither pair produced an export.** Both attempts failed in GPU preflight with
`GPU device: Parent device is lost`, before downloading footage. Their roughly
six-second failure windows are not render timings. Short diagnostics separately
passed H.264 and HEVC NVENC but reproduced `vkCreateDevice` initialization
failure in Vulkan's own tool. The same traced image and driver libraries passed
on one allocation (`/dev/nvidia1`) and failed on another (`/dev/nvidia4`), with
driver 610.57.04 in both. Allocation-dependent graphics compatibility is the
remaining blocker; the specific host/driver cause is not established.

There is no RTX speedup, output quality or completed-export cost result to compare
with L4. Its requested allocation is about $3.35/hour at
[Modal's base rates](https://modal.com/pricing). Four failed jobs conservatively
reserved $8.04, bringing the day's export reservations to $16.23 against $16.24;
these are not charges. Three separate, bounded diagnostic invocations were short
and are outside that ledger. No automatic paid retry or CPU fallback was added.

The [RTX evidence](benchmarks/modal-rtx-2026-10-19.json) retains both failed pairs,
exact fixture hashes and diagnostic outcomes. The harness now accepts `--gpu` and
`--baseline <prior-report>` to check GPU configuration and freeze identical inputs.
RTX remains experimental until graphics preflight and the complete pair pass.
The live editor, production Relay and Repack remained untouched.

After both attempts ended, the idle pilot was restored to the current L4 worker
(with the audio optimization), its CPU gateway health check passed, and new
export admission was disabled with a zero test budget. No new exports were
started during this reset.


## L40S real 1080p pair — 2026-10-19

The exact frozen Young Actress and Corrupt Cop snapshots from the completed L4 benchmark were submitted together to one L40S with the same four physical cores, 16 GiB, 1080p/30 H.264 High settings and -14 LUFS audio. A detached checkout retained the original `b5a2477` renderer, mixer and transfer runtime; the later audio optimization was excluded to preserve the comparison. L40S passed graphics and H.264/HEVC hardware preflight. No region premium or automatic paid retry was enabled.

- **Young Actress**: L40S result observed in R2 at **16:20**, delivered to the Mac at **18:03**; L4 delivery was **28:47**.
- **Corrupt Cop**: L40S result observed in R2 at **8:46**, delivered to the Mac at **9:32**; L4 delivery was **16:56**.

Both outputs were delivered in **18:03**, versus **28:47** on L4 (1.59× end-to-end speedup). Shared worker execution was **16:12**, implying approximately **$0.61**, versus L4's approximately **$0.48**. These use [Modal's published requested-allocation rates](https://modal.com/pricing); they exclude gateway/build/startup outside the recorded interval, storage/network, the hardware probe and prior trials. They are estimates, not an invoice. Do not sum overlapping per-job estimates.

Input staging took 26.0 seconds for Young Actress's 3.5 GB original and 6.8 seconds for Corrupt Cop's assets. Timings start at first export submission, include allocation, inputs, audio, picture, join, full decode validation and R2 publication, and separately record desktop delivery. Deployment and manifest preparation precede the timer. One cold run per GPU and differing allocations do not isolate GPU kernel speed or establish a stable performance distribution.

Both outputs passed the worker full decode and local codec, dimensions, exact frame-count, stereo AAC, zero-start and duration checks. Whole-file SHA-256 checks also matched the earlier L4 files byte for byte, covering the complete video and audio output. This proves consistency with the checked L4 outputs; it is not a new perceptual comparison against the Mac encoder.

- Young Actress sound: -14.1 LUFS; decoded AAC true peak -0.8 dBFS.
- Corrupt Cop sound: -14.1 LUFS; decoded AAC true peak -1.3 dBFS.

The two jobs conservatively reserved $2.74, bringing daily export reservations to $18.97 against $18.98. Reservations are not charges; the short independent hardware probe and other services are outside that ledger. The original editor PID 13625, production Relay and Repack were not restarted or changed. Cloud exports remain opt-in.

The [raw L40S run](benchmarks/modal-l40s-2026-10-19.json) includes source control, immutable fixture hashes, job identities, timing samples, output metadata and verification.

After the benchmark completed, the idle pilot was restored to the current L4 worker with the newer audio mixer, its gateway health check passed and new test admission was disabled. No additional exports were started during reset.
