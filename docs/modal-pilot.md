# Modal export pilot — 2026-10-19

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

Follow the [worker deployment guide](../apps/worker/README.md) in an idle
window, using a production worker/Relay configuration with matching timeouts,
a separate worker token and an explicit budget. Run a representative real
edit before deciding throughput targets or retiring Repack resources. Finished
files still download to the desktop; existing subtitled-video Drive delivery
continues from there. Moving that final R2 → Drive delivery fully into Relay
is a separate remaining transfer optimization.
