# Concurrent exports on Modal

The desktop keeps the agent and its subscription. Relay accepts immutable
export manifests and owns a durable queue. An independent `edit-exports-*`
Modal app runs up to three exports concurrently on one GPU, each in its own
native process with a separate workspace and cancellation signal. Every export calls the existing Rust
engine and wgpu compositor, with NVIDIA decoding/encoding on Linux. Subtitles,
edits and transfers can continue on the Mac while these exports run.

This checkout does not activate cloud exports by itself. No startup, test or
build deploys anything. `EDIT_CLOUD_EXPORTS=1` selects the backend on a future
desktop start. `EDIT_PARALLEL_DOWNLOADS=1` independently enables three footage
transfers across projects, preserving script order; local excerpt encodes use
their own single lane. Drive → R2 already copies four ranges per file in the
Relay Workflow. It verifies the source version again before publishing.

## What is durable

- A manifest freezes the timeline and options, required media keys, lengths
  and ETags. Small local graphics/sounds upload by SHA-256. Cloud originals
  go straight from R2 to Modal, without downloading through the Mac again.
- Manifest digest + renderer build + GPU identify one export. A repeated
  submission or desktop restart finds the same job, including a failed job.
  A changed source version, timeline, options or renderer produces a new id.
  A new explicit desktop request can retry a failed export. Its UUID and
  backend survive restarts, so reconnecting never creates a paid retry.
- A Durable Object persists admission, worker permits, state and progress.
  It dispatches once; ambiguous dispatches are not paid automatic retries.
  Duplicate worker calls cannot claim the same render. Queued jobs survive
  disconnects. An expired worker cannot publish a result.
- Cancellation holds its slot until the worker acknowledges stopping or its
  hard deadline passes. All native decoder/encoder subprocesses are killed
  as a group. A lost Relay connection stops the worker, rather than letting
  it run indefinitely.
- Before completion, the worker checks codec, dimensions, frame count,
  duration, required sound and decodes the finished streams. R2 multipart
  output is published only after completion and an exact-size check.
  Local delivery uses the existing resumable/atomic R2 downloader. Existing
  subtitled-video Drive delivery then runs as before, on the desktop.

## Limits and cost

Workers request and limit CPU to four physical cores and memory to 16 GiB.
L4 is the default; L40S and RTX-PRO-6000 are explicit deployment choices. There is one GPU
container with three asynchronous input slots, no automatic GPU/model fallback, a 30-minute function timeout,
five-minute startup timeout, two-second idle window, eight concurrent input
requests per worker (files and 32 MiB byte ranges share one pool), 128 GiB
total input and 16 GiB output limits. Every range is ETag-pinned and checked
before a completed file becomes visible. H.264 and HEVC are
supported. Other output formats require the existing local backend.

RTX-PRO-6000 remains experimental: the 2026-10-19 real-pair attempts failed
graphics initialization before source transfer, while short probes passed on
one allocation and failed on another. NVENC alone passed. See the
[RTX evidence](../../../docs/benchmarks/modal-rtx-2026-10-19.json); there is no
completed RTX export timing or cost comparison yet. Run the bounded hardware
probe before a new GPU deployment; it reports graphics and both encoders
separately, including driver diagnostics on a failure.

Using Modal's published Function rates on 2026-10-19, compute is approximately
$1.12/hour on L4, $2.27/hour on L40S or $3.35/hour on RTX-PRO-6000 for this allocation. Relay conservatively
reserves **$0.67 (L4), $1.37 (L40S) or $2.01 (RTX-PRO-6000)** per accepted job, covering the full
execution/startup timeouts plus a minute of shutdown allowance. An explicit
`MODAL_DAILY_BUDGET_USD` limits daily **reservations**; missing/zero disables
new jobs. Reservations are never refunded on failure. This is deliberately
stricter than charging a successful short export's actual runtime.

This is not an invoice-level spending cap: gateway requests, image builds,
network/storage, region premiums and external account workloads are outside
the job reservation. Queued work is reserved on admission day, not execution
day. Individual runtime estimates charge the whole worker and must not be
summed as invoice attribution when jobs share it. Set an account-level Modal
spending limit as well. Actual export speed
and billed cost require representative measurements; a hardware probe alone
does not establish either. Source: https://modal.com/pricing

The [real 1080p benchmark](../../../docs/modal-pilot.md#real-1080p-pair--2026-10-19)
records a full two-video run and its historical local comparison. Its measured
build predates the subsequent normal-speed audio optimization: word mutes
now run in Rust on both decoder paths, while tempo changes retain FFmpeg's
source-clock muting before atempo. Do not treat an audio parity test as a new
full-export performance result.

## Safe pilot deployment

1. Keep the live editor checkout/binary and existing Relay/Repack deployments
   running. Use a separate worktree and `wrangler.modal-pilot.toml`, which has
   its own Worker and DO namespaces and no live Drive Workflow binding.
2. Through the existing process-only credential injection, configure the
   pilot Relay's existing R2 settings and `CLOUD_TOKEN`. Set a **different**
   `MODAL_WORKER_TOKEN`, `MODAL_DAILY_BUDGET_USD`, `MODAL_GPU=L4` and renderer
   build from `python apps/worker/build.py`. Secrets never go in source or
   local environment files. The Modal app receives only the scoped worker
   token and Relay URL; no R2, Google, Convex or model credentials.
3. Explicitly deploy the pilot Relay (`wrangler deploy --config
   wrangler.modal-pilot.toml` from `apps/relay`) and the independent Modal app:

   ```sh
   uv run --python 3.12 --with-requirements apps/worker/requirements.txt python apps/worker/deploy.py
   ```

   Inject `EDIT_RELAY_URL` (pilot URL), `MODAL_WORKER_TOKEN`, optional
   `EDIT_MODAL_APP=edit-exports-pilot`, and `EDIT_MODAL_GPU=L4`. The deployment
   script refuses an app with running tasks. It leaves Repack untouched.
4. Set the pilot Relay's `MODAL_EXPORT_URL` to the returned gateway URL.
   Its authenticated `/health` must agree with `MODAL_RENDER_VERSION` and
   `MODAL_GPU`. Short smoke tests can pair Relay's `MODAL_JOB_SECONDS`,
   `MODAL_STARTUP_SECONDS`, `MODAL_SHUTDOWN_SECONDS` with the worker's
   `EDIT_MODAL_JOB_SECONDS` / `EDIT_MODAL_STARTUP_SECONDS`; the gateway
   refuses execution/startup mismatches. Production defaults are
   1800 / 300 / 60 seconds. Run a disposable project against this Relay, using a separate
   `EDIT_HOME` and unused port. Do not redirect the active editor to the pilot.
5. Compare one real edit locally and remotely, then three distinct exports
   concurrently while editing/subtitling other projects. Record complete
   transfer/render/verification/delivery time, output quality, runtime,
   reservation and the Modal invoice. Do not retire or migrate Repack until
   those results are satisfactory. Activate the production path only during
   an idle deployment window; ongoing jobs need no migration.

The independent hardware-only probe never contacts Relay or live projects:

```sh
EDIT_MODAL_PROBE_COMPUTE_BUDGET_USD=0.20 uv run --python 3.12 --with modal==1.5.3 modal run --env dev apps/worker/hardware_probe.py
```

This permits one bounded 120-second L4 probe, including startup allowance;
image-build/network charges are separate. It rejects missing/smaller compute
budgets. L40S needs a higher bound.

## Offline verification

```sh
bun run --cwd apps/server typecheck
EDIT_HTTPS=0 bun run --cwd apps/web test -- --run src/lib/cloud-exports.test.ts src/lib/relay.test.ts
uv run --python 3.12 --with httpx==0.28.1 python -m unittest discover -s apps/worker -p 'test_*.py' -v
cargo clippy -p edit-engine --bin edit-worker -- -D warnings
```

Queue tests use memory-only Durable Object storage and mocked R2/Modal.
Runtime tests check pinned/truncated inputs, concurrent transfers and multipart
completion without network, GPU or credentials. The hardware probe separately
checks the Linux build, physical graphics adapter and actual NVENC sessions.
