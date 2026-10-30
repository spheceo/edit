# Speed plan

Cloud functionality remains required for every project.

Changes to make Edit much faster from import to export, more reliable, lighter on RAM and disk, and good over Tailscale. Numbers come from `~/.edit/logs/edit.log` (Oct 15–17) unless noted.

Status: in progress (see *Progress*); Workers Paid is available. Server items land in `apps/server`, engine items in `crates/edit-engine`, cloud items in `apps/relay` (reusing R2 and the existing Convex registry). File references in the tables are to the code as it was when the plan was written.

## Progress (Oct 18)

Landed on `main` after the rewrite. **Measured end to end on Young Actress** (29 min, the same steps as the Oct 17 baseline, the file remuxed so nothing came from cache): link on Drive **2185 s → 1096 s** (36.4 → 18.3 min), correct subtitles 1229 s → 696 s. Download 174 → 161, import 466 → 265, transcription 73 → 40, watch 101 → 56 (+4 s for who is who), subtitles 219 + 196 (a second run to fix the cast by hand) → 170, export 864 → 306 (sound 211 → 34, picture 558 → 256, join 95 → 11), Drive 92 → 94. Numbers in `/tmp/subsrun/baseline.json` and `rerun.json`.

- **0.1 done.** Media back on the internal disk: 53 files copied with their exact modification times (so every cache still matches), `edit media off`. The LaCie copies were checked against the internal ones and deleted on Oct 18 (1.9 GB).
- **1.1, first part.** Background FFmpeg gives way to exports: previews and proxies (`media::run_background`) and smoothing are stopped while an export runs and continued after. Smoothing has its own lane, so imports never wait behind it. Not yet: priorities across lanes, RAM budgets.
- **3.4 / 3.6, the proxy.** Cloud proxies and light previews in VideoToolbox from end to end (FFmpeg hardware decode, `scale_vt`, `h264_videotoolbox`): ~195 fps at 1080p, the M1 encoder's own rate, with little CPU. Against the native path in the optimised build (~171 fps) that's ~15% faster, not the 2× a debug-build benchmark first showed; the bigger win is the CPU it leaves free. The light preview of a 29-minute video: 7:33 → 3:06; thumbnails 2:47 → 0:59.
- **4.1 done.** An export reads a cloud original from the file it was imported from while that's here and unchanged (AVFoundation, local); footage from a Drive link is downloaded to this Mac (3.8). Footage that's only in the cloud mixes from a **sound copy** (`cloud_media.ts` `soundCopy`: the original's sound copied out without re-encoding, MOV, `edit/sound/<original>.mov` on R2): made at upload from the local file, else once from R2 by the first export that needs it, then fetched by every machine (~1% of the file). **Measured on Young Actress** with its local original hidden: the first export made the copy in 1:39 (reading the 3.5 GB original once; the Oct 17 export spent 3:31 on sound over the network) and shared it in 5 s; on a machine without it, the 69 MB copy downloaded in 3.9 s and the sound mixed in 11 ms.
- **4.2 done: chunked exports** (`crates/edit-engine/src/chunks.rs`). The picture is encoded in chunks named by what's on screen (each frame's scene without clip ids, media by content; the picture settings; a hash of the code that draws and encodes, `EDIT_RENDER_SOURCE`); boundaries are cuts whose frame hash is a multiple of 16 (10–120 s), so a trim near the start leaves every later chunk as it was. The file is the chunks joined by FFmpeg's concat without re-encoding; a re-export copies unchanged chunks out of the last export (nothing extra kept on disk) and the sound too when nothing heard changed; a join is checked frame for frame (count) and falls back to a whole export. **Measured on Young Actress (29 min):** the first export 4:54 (5:06 before), the same again 11.5 s, after changing one subtitle **16.4 s** (1 of 47 chunks rendered). Frames compared with the earlier whole export: identical but for 21 frames where a repeated CCTV frame was picked differently, nowhere near a join; sound and picture start at 0 and end within 3 ms.
- **1.2 done (the jobs).** Exports, Drive uploads, background smoothing and watches are written down while they run (`<home>/jobs.json`, `apps/server/src/jobs.ts`) and started again when the server starts; an export carries on from its finished chunks, a watch from its cached windows. A job cut short three times isn't started again. **Tested live:** a 10-minute export stopped with the server after 40 s carried on when it started again, from 5 of its 16 chunks (half the frames), and finished in 42 s. Partial exports a dead server left beside the destination are removed. The agent's turn itself still stops with a restart.
- **5.1 done: patches.** The browser asks for project changes as patches (`/api/ws?patches=1`): top-level fields set or removed, and for lists of things with ids only the items added or changed, the ids removed and a new order when it moved (`apps/server/src/patch.ts`, the same file as `apps/web/src/lib/patch.ts`). Saves send a patch against the server's revision (`PUT` with `patch`); a patch that doesn't follow on fetches the project whole. One subtitle changed in Young Actress sends 770 bytes instead of the 640 KB project (31 KB compressed); an edit's project is ~2 MB.
- **Fractional rates.** `settings.ntsc` runs a project at fps×1000/1001 (23.976, 29.97): a subtitled video takes its footage's exact rate, so every frame is shown once; exports are exactly 24000/1001. Projects made before keep 24 (changing a project's rate would move every clip by 0.1%).
- **7.1 started: Drive → R2 in the cloud** (`apps/relay/src/jobs.ts`, deployed Oct 18). A Cloudflare Workflow copies a Drive file into an R2 multipart upload 64 MiB at a time, each part a durable step (bytes piped through, never held; only ETags kept), checks the size, records the original in the registry (Convex `edit:putMedia`) and aborts its upload if it fails. The job's id is the file, key and the file's checksum, so asking again finds it and a changed file is a new copy. Edit's script import asks the relay first and follows the job's progress (the parts in R2), streaming through the Mac only when the relay can't (`cloud_media.ts` `driveInTheCloud`, `EDIT_CLOUD_JOBS=0` to skip). Tested: a 68 MB file through `wrangler dev`, byte for byte the same as Drive's (MD5); deployed, **Young Actress's 3.5 GB original copied in 115 s** (~30 MB/s) with the Mac only asking how far it had got (the Oct 17 baseline downloaded it to the Mac in 174 s before uploading it again), 10 ranges across part boundaries identical to Drive's. Not yet tried: a Worker restart mid-copy (each part is a retried step), 7.2–7.6. Other clients (and the parity harness) still get whole projects.
- **4.7 done.** Only subtitled videos upload to Drive. Every project keeps its exports in a list that survives restarts, with download (Mac or Tailscale), show and delete.
- **Subtitles** (done): the cast with person ids enforced by `Project::validate`, one colour rule (ΔE 28) for both subtitlers, and timing that never starts a line late.

## 0. First: media back on the internal disk

| # | Change | Why | Done when |
|---|---|---|---|
| 0.1 | **Move the media folder off the LaCie** onto the internal disk (`edit media move`, with Edit quit) and stop using the LaCie for Edit. | It's a spinning disk: ~120 MB/s and ~10 ms per seek, against the SSD's 2–3 GB/s. Exports read smoothed shots and map renders from it with three decoders seeking at once, and write the export to it. It's a likely cause of the slow preview copies (2.4). Only ~3 GB lives there (cloud originals are on R2); the internal disk has 25 GB free. | Settings → Media drive unset; nothing under `/Volumes/External/Edit` in use. |

With only 25 GB free, cache cleanup (2.7) and export cleanup (3.7) go with this.

## 1. Scheduling and reliability

The biggest finding: exports aren't slow because of the export pipeline; other work running beside them is what slows them down. The same project at the same length exported in 4:33, 8:55 and 14:45; another in 5:13 to 15:52. Exporting alone, Edit runs at ~150 fps.

| # | Change | Why | Done when |
|---|---|---|---|
| 1.1 | *server + engine* **A real job scheduler.** Priorities: exports and agent renders, then what blocks editing (a new file's preview, transcription), then analysis (loudness, faces, censor, light previews), then smoothing. Separate queues, so a slow job of one kind never holds up another. Lower-priority FFmpeg children are paused with SIGSTOP/SIGCONT while higher-priority work runs. The M1's single hardware encoder is a resource like the CPU. | One background slot (`crates/edit/src/media.rs:24`) is shared by imports and smoothing, so a 77-min smoothing run holds every new file's preview behind it. Only the hardware preview maker pauses for exports (`crates/edit-engine/src/media.rs:742`); FFmpeg jobs keep running. | The same export takes the same time with or without background work; imports never wait behind smoothing. |
| 1.2 | *server* **Jobs survive restarts.** A durable job queue (exports, smoothing, watches, media work) that picks up where it left off after a restart. Chunked exports (3.2) make resuming an export cheap. Design it into `apps/server` from the start. | 95 restarts in 3 days of logs. Each drops running exports, smoothing and the agent's turn in the middle of an edit. | A restart mid-export carries on from the last finished chunk. |

## 2. Agent editing

| # | Change | Why | Done when |
|---|---|---|---|
| 2.1 | *server* **Measure the agent's time first.** Log Codex's token usage per turn (input read, reasoning, output written) and the time between tool calls. If output dominates, make the plan format terser; if reasoning does, use lower effort for the mechanical stages. | Turns log only how long they took, so the ~3.5 h of model time is a guess. | Every turn's log line has its tokens. |
| 2.2 | *engine + server* **Smoothing on Video Toolbox, automatic, at render time.** Replace FFmpeg `minterpolate` (`crates/edit/src/broll.rs:316`) with `VTFrameProcessor` frame rate conversion in `mac_media.m`. Smoothing becomes a render-time effect of a slowed clip, not a media file swapped in: cached by (media, source range plus a margin, speed), so a re-trim within the margin reuses it. Every slowed cut-in shot is smoothed by Edit itself in the background (lowest priority, 1.1). FFmpeg only as a fallback. The agent stops calling `smooth_slow_motion`. | 124 calls; 18 renders averaging 77 min; 23 CPU-hours. Today a re-trim throws away a finished render: three were discarded after minutes of work ("changed while smoothing"). Slowed footage is almost always wanted smooth, so it stays on: decided by the user (Oct 17), kept over the audit's "don't smooth every slowed shot". Shots with a cut inside are skipped. | Benchmark on a Mom & Teen shot first; a shot smooths in seconds; a re-trim doesn't smooth again. |
| 2.3 | *server* **Seats cache reads back.** | `repack_subtitles` 13 min per call, paying Gemini every time. | In progress. |
| 2.4 | *server* **Watch footage at import**, in the background. | `watch_footage` 6 min per call; 150 windows at ~94 s each. | The agent never waits on it. |
| 2.5 | *server* **One look per stage, enforced.** The plan's `review_frames` is the look; mechanical checks come from the audit. | `contact_sheet` 96 calls, `render_frame` 72. | Under ~10 renders per edit. |
| 2.6 | *server* **Parallel stage agents** (intro, story, outro on separate parts of the timeline). | ~3.5 h of model round trips. | Later: after 2.1–2.5, measure again. |

## 3. Import (0 → editable)

| # | Change | Why | Done when |
|---|---|---|---|
| 3.1 | *server* **Script import in parallel.** Download 2–3 files at once (now one after another, `crates/edit/src/script.rs:1458`), and start the voice-over at once: it needs only the script. | Downloads up to 6 min each; lay out 2.5 min, then the voice-over after it. | Voice-over ready when footage is. |
| 3.2 | *engine* **One decode per file.** The hardware preview pass already decodes every frame: take thumbnails, censor greys and camera-angle frames from it, and the sound once for loudness and transcription. | Each file is decoded ~6 times, one step after another (`crates/edit/src/media.rs:190-260`). | One read of the source per import. |
| 3.3 | *engine* **The waveform for free.** Loudness analysis already keeps 100 sample peaks a second (`loudness.rs`), exactly the waveform's resolution (`PEAKS_PER_SECOND`): draw it from that and drop `make_peaks`. | A whole extra FFmpeg decode of every file's sound. | No `media: waveform` step. |
| 3.4 | *engine* **Fix slow preview copies.** Measure again after 0.1 and 1.1 (suspects: reading off the LaCie, contention; hardware encode is already the path), and drop the bitrate from 8 to ~5 Mbit/s. | 4.5 h over 71 files, up to 43 min each. | No file over a few minutes. |
| 3.5 | *server* **Light preview on demand.** Made from the proxy only when a remote browser first asks for it. Keep it: it's what Tailscale viewers stream (`apps/web/src/lib/previewQuality.ts:21`). | 3.5 h over 124 files; 307 MB for one file. | Not made for local-only projects. |
| 3.6 | *server* **Upload the original while the proxy encodes**; editing starts as soon as the proxy is ready. | Up to 10 min per file, in series. | Nobody waits on the upload. |
| 3.8 | *server* **Subtitle videos start from the sound.** Transcription, the watch and seats don't need the preview: start them from the sound (extracted in seconds) as soon as the file is down, beside the proxy and upload, and run seats at import like the watch. `repack_subtitles` then only lays out lines. Also a **Drive folder import** (paste the folder link: the footage streams Drive → R2 and the proxy, the Doc is ignored), which doesn't exist today. | Young Actress (29 min, 3.5 GB): download 2:54 → import 7:46 (upload 1:34, proxy 7:09, proxy upload 0:27, in series) → transcription 1:13 → watch 1:41 → `repack_subtitles` 3:39 (seats 3:38 of it): ~17 min before subtitles exist, ~9 of it waiting on the proxy and uploads. | Subtitles ready ~8 min after the link is pasted. |
| 3.7 | *server* **Cache cleanup.** Remove previews no project uses; cap the total size. | 4.2 GB cache, one file at 1.1 GB, never evicted. | The cache stays under its cap. |

## 4. Export (→ download)

| # | Change | Why | Done when |
|---|---|---|---|
| 4.1 | *engine + server* **Fast sound: an audio-only copy of each cloud original**, made at upload (`-vn -c:a copy`: seconds, ~1% of the file) and kept beside it, so the mix reads it locally with AVFoundation. Not "sound and picture in parallel": that was tried and made both slower (`crates/edit-engine/src/render.rs:1262`). | 11 min of sound before the 32-min export's picture; 4 min of it decoding 171 sounds over the network, one FFmpeg per clip (`mix.rs:184`). | The sound of a 30-min edit mixes in under a minute. |
| 4.2 | *engine* **Chunked, incremental exports.** Export in ~1-minute chunks, each fingerprinted by what's on screen in it (clips, their media keys, effects); a re-export redoes only the chunks that changed and joins the rest without re-encoding. Also what makes resuming after a restart cheap (1.2). | Re-exports are common: 15-Year-Old was exported 6 times, Mom & Teen 3. Each redid everything (5–16 min). | A re-export after a small fix takes seconds. |
| 4.3 | *engine* **No join step.** The sound is ready before the picture: write it into the same AVAssetWriter as the picture (chapters too, or a quick remux only when chapters are asked for). | The join took up to 1.5 min and writes the whole file again (twice with faststart). | No `export: join` for standard exports. |
| 4.4 | *engine* **Faster hand-off to the encoder.** Convert to NV12 on the GPU and write into IOSurface pixel buffers (skip the CPU copy, 8 MB → 3 MB per 1080p frame); replace the 1 ms sleep-poll in `edit_writer_frame` (`mac_media.m:682`). | 12.5 of 27 min of the 32-minute export waited on encoding (part of it contention, 1.1). | Wait on encoding near zero. |
| 4.5 | *engine* **Skip footage hidden under full-frame B-roll.** | 20–40% of decode work. | In progress. |
| 4.6 | *engine* **Prefetch cloud originals** ahead of the decoders. | 24 fps from R2 against 55 locally; 8 min waiting on decoding. | Within ~20% of local. |
| 4.7 | *server + relay* **Normal edits aren't uploaded to Drive; they're downloaded.** Decided by the user (Oct 17), kept over the audit's "preserve Drive delivery". Only subtitled videos go to Drive (Repack's folder, for now; section 7.5 can move that upload to a cloud job once the export is in R2). Every project gets an exports list that survives restarts, each with a local and a cloud (R2) download link (on the Mac and over Tailscale), and old exports can be deleted from it. File-ready, cloud-ready and Drive-ready are tracked separately. | Today every whole video export uploads to Drive, not only subtitled ones (`apps/server/src/drive.ts:79` `wanted`), and a re-export replaces the Drive file (PATCH). Downloads only know the current session's exports (`apps/server/src/exports.ts:34`). | A normal export is ready to download the moment it finishes; export records survive restarts. |

## 5. Remote and browser (Tailscale)

| # | Change | Why | Done when |
|---|---|---|---|
| 5.1 | *server + web* **Send changes, not the whole project.** Events carry patches; the UI saves patches. | Every commit sends the 1–2 MB project to every browser (`crates/edit/src/store.rs:484`), and every UI save PUTs all of it (`apps/web/src/lib/store.ts:259`). | Small edits send kilobytes. |
| 5.2 | *server* **Compression** (gzip/brotli) on JSON, JS and WASM. | None today; 867 KB JS + 853 KB WASM + project JSON. | ~4–5× less over the wire. |
| 5.3 | *server* **Sign-in over Tailscale** (`tailscale serve` identity headers, or a token). | Anyone on the tailnet can open projects and call the agent tools; only the Host header is checked. | Unknown devices are refused. |

## 6. Storage and build

| # | Change | Why |
|---|---|---|
| 6.1 | *engine* **Compact project JSON** on disk and in history. | 2.1 MB pretty against ~1.2 MB compact; 127 MB of history. |
| 6.2 | **Drop the Intel build** if no one uses an Intel Mac. | Halves release CI. Done Oct 29: the whole team is on Apple Silicon. |

## 7. Workers Paid rollout: move suitable work off the Mac

**Decision:** use the now-available Workers Paid account for durable transfers and external-service orchestration. Cloud support stays on for every project. This is planned work, not a claim that the new services have been deployed or credentials configured.

### Foundation and implementation order

1. **7.1 — Shared cloud job foundation and Drive → R2.** Extend `apps/relay` with Cloudflare Workflows and authenticated start/status/cancel endpoints. Jobs carry a stable ID, source version, operation/settings fingerprint, progress, attempts and result manifest. Stream bounded Drive ranges into R2 multipart uploads; persist upload IDs and completed-part metadata, never media bytes in Workflow state. Reuse the current cloud registry for lookup/status, with one authoritative owner for each state. Configure cloud-side Google OAuth secrets and verify source-file permissions/scopes. Deduplicate repeated submissions, detect source changes, reconcile uncertain completion and clean up abandoned uploads. First prove completion with the Mac disconnected, interruption recovery and verified output on a representative large source; then replace `cloud_media.ts::streamDrive` in the Bun import path.
2. **7.2 — Direct cloud playback and downloads.** Authorise access through the relay; remote browsers fetch uploaded immutable proxies/audio/exports from R2 using short-lived access. Editing commands stay on the Mac/Tailscale. Retain local desktop reads and host fallback for unpublished artifacts. Verify range seeks, CORS/WebGPU access, expired-access refresh and A/V sync while the Mac exports. Measure playback stalls and host outbound bandwidth.
3. **7.3 — Durable voice generation and transcription.** Extend existing ElevenLabs relay routes into jobs that store generated takes/transcripts in R2 before reporting success. Reuse completed takes and schedule their transcription. The Mac prepares necessary audio inputs once and downloads results needed for playback/export. Persist provider operation IDs where available; reconcile retries to avoid duplicate paid work. Test reconnect, cancellation and interruption between provider completion and result publication.
4. **7.4 — Footage-watch jobs and shared analysis.** Upload small analysis clips once; run external Gemini requests/retries from cloud jobs and publish versioned results directly to R2. Keep clip cutting, audio extraction and native visual analysis on the Mac initially. Use artifact keys covering source/version/range, model/prompt/settings and relevant evidence revision. Coordinate claims with leases/fencing so concurrent projects or machines reuse one result and stale workers cannot overwrite newer output. Preserve human corrections. Validate bounded request-payload memory, attribution quality, cache reuse and recovery with two consumers requesting the same artifact.
5. **7.5 — R2 → Drive delivery.** Once the complete export is verified in R2, a job performs resumable Drive upload, permissions and delivery-status updates. Persist the session and destination file ID; retries must not create duplicate deliveries or let an older export replace a newer one. Keep required delivery destinations. Initially upload the finished local export to R2; overlapping upload with rendering remains a separate experiment requiring immutable output fragments/compatible packaging. Measure the complete path to Drive-ready so an extra staging hop does not masquerade as a speedup.
6. **7.6 — Research and metadata preparation.** Fetch script documents, Drive metadata, ordinary article text and research assets as reusable project jobs. Bound payloads, concurrency and retries; cache by source/version where possible. Begin with ordinary HTTP retrieval. Browser automation is a separate later capability and budget decision.

### Execution boundary

Workers coordinate external AI calls; they do not run ElevenLabs/Gemini models themselves. Keep encoding, optical flow, GPU compositing, audio mixing, proxy generation and Apple's face detection in the native Mac engine. Standard Workers are not a replacement for native media hardware. Do not add a second database or a separately billed compute/browser service just to implement this rollout; reuse the existing infrastructure first.

### Budget and observability

Target the **US$5/month Workers base allowance**, shared with existing account workloads, rather than promising a fixed total bill. Pricing checked Oct 17: 10 million monthly requests, 30 million CPU milliseconds, 500,000 Workflow steps and 1 GB-month of Workflow state are included; network/API waiting does not count as CPU time. The subscription has overage billing, not a hard $5 cap. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/).

R2 storage/operations, model providers, existing Convex/Drive plans and any later browser/compute service remain separate costs. Store media in R2, keep job state small, expire completed-job metadata appropriately, bound logs/retries/concurrency and expose account usage plus per-project transfer/model costs. Add usage alerts and configurable job admission limits before broad rollout; alerts alone are not a spending cap. Measure actual CPU, steps and retained state in the pilot before claiming the full rollout fits the allowance.

### Acceptance across the rollout

Measure time from import request to editable, correct subtitles, final file, cloud-ready and required Drive-ready; also measure Mac peak memory, temporary disk usage and bytes transferred. Cloud-ready work must survive a Mac disconnect, duplicate submissions and worker retries. Pin results to source/project revisions and publish only complete verified artifacts. Keep the existing path available during pilot rollout; compare identical inputs and required outputs, including provider charges and any extra R2 staging.

## Order

The cloud workstream starts with **7.1**, then **7.2 → 7.3 → 7.4 → 7.5 → 7.6**, measuring after each. Relay-only preparation can precede the TS switch; new desktop integration belongs in Bun. It complements the native performance work below rather than requiring the entire engine roadmap first.

Desktop/engine sequence (after the rewrite):

1. 0.1 media back on the internal disk (can happen any time: it's a move, not code)
2. 1.1 the scheduler, 2.1 measure the agent's time
3. 2.2 smoothing on Video Toolbox, at render time (benchmark first)
4. 4.1 fast sound, 4.3 no join
5. 4.7 downloads instead of Drive for normal edits, exports list, 3.7 cache cleanup
6. 4.2 chunked exports, 1.2 jobs survive restarts
7. 3.1 script import in parallel, 3.2 one decode per file, 3.3 free waveform, 3.4 preview copies
8. 5.1 + 5.2 patches and compression
9. 4.4 encoder hand-off
10. The rest, measuring after each
