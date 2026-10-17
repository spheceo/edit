# Speed and subtitles: implementation audit and revised roadmap

2026-10-17 · inspected commit `0826f09` · macOS 26.3.1

Direction clarified after this review: cloud functionality is required for every project going forward. See [new cloud-first opportunities](cloud-first-opportunities.md) for the subsequent independent design exploration and measurements. Local execution/cache proposals here must preserve cloud durability, sharing and cross-machine access.

The plans identify real problems, but several explanations are stronger than the evidence and some proposed remedies would introduce new delays or correctness risks. The highest-value change is to make a project a durable graph of reusable results: editing, analysis, rendering and publication advance independently, with bounded resource use. Optimise time to a correct delivered project, not individual tool speed.

This review checked both plans, the Rust engine and reference server, the Bun server, the browser paths, local logs and the existing benchmark report. No production media was changed, no exports or paid AI work were started. Historical subtitle identities were not independently relabelled by watching the videos. Their reported counts remain historical evidence, not newly verified ground truth.

## What is confirmed, and what needs correcting

### Export variance is real; its cause is not isolated

The current log reproduces Mom & Teen's **29,359-frame** exports in **4:33, 14:45 and 8:55**. Encoding waits were **2:01, 8:27 and 3:56**, respectively. This supports investigating contention, but does not prove it alone caused the differences: matching duration does not fix project revision, effects, encoder settings, cache state, network, thermals or other applications. Waiting on an encoder is also normal backpressure when it is the slowest stage; zero wait is not a useful acceptance criterion.

The current log has 100 server-start records, not the earlier 95. These are starts, not 100 crashes or interrupted exports. Classify update/dev restarts, explicit quits, crashes and sleep/network interruptions before choosing recovery machinery. The log also includes a **129:06 preview-copy operation** and a **3:26 join**, so the earlier maxima are incomplete. Timed background operations may include waiting; they cannot be summed as CPU-hours. `docs/performance-results.json` explicitly notes this for smoothing and explicitly limits its impressive 8.46× export result to a short component benchmark with an encoder change.

### Several planned changes already exist in the checkout

- **Seats cache round-trip:** `apps/server/src/seats.ts:88` parses the infinite final scene encoded as JSON `null`. The targeted seats tests passed: **4 pass, 1 native-addon-dependent skip**. Names remain part of the cache validity check, so renaming can still trigger expensive visual re-analysis.
- **Upload/proxy overlap:** `apps/server/src/cloud_media.ts:378` already runs local-original upload and proxy creation together. It still waits for both and proxy publication before completing; on publication failure it deletes a proxy made by that invocation. The missing improvement is independent readiness and durable retry, not simply adding `Promise.all`.
- **Hidden picture removal:** `edit_core::evaluate_seen` already drops covered layers and both WASM and native rendering call it. Benchmark its coverage and extend only where correctness can be proved; do not count the whole proposed saving again.
- **Memory discipline:** bounded render channels, a six-buffer native writer pool, a 16 MiB loudness cache, text eviction and shared browser history already exist. The next step is system-wide byte budgets and measurement, not assuming every cache grows forever.
- **Request protection:** Bun checks Host **and Origin**. That is not user authentication. It binds localhost and the Tailscale address by default, which matters if adopting trusted proxy identity headers.

### Confirmed remaining problems

`apps/server/src/media.ts:61` still gives video processing and smoothing one shared slot; one task holds it across multiple stages. `apps/server/src/exports.ts:34` keeps completed paths only in memory. `apps/server/src/drive.ts:89` requests upload for any whole video export, not just subtitle projects. Current Drive code can replace the existing Drive file on re-export, contrary to older agent notes saying every export creates a new file.

`subtitles.rs::shown` delays each speaker's next cue in overlap mode. `hold_readable` also delays cues in non-overlap mode. The timing defect is broader than the plan's overlap-only account. The two identity/colour systems and thresholds (20 versus 28) are confirmed.

## Change the fundamental architecture before polishing every stage

### 1. Local editing should not wait for cloud publication

Today cloud mode deliberately replaces local original paths with proxies and export reads remote originals. That trades disk capacity for repeat network decoding and FFmpeg processes, even when this Mac initially had the original.

Keep cloud durability, but make residency a separate policy. Maintain a source identity with original, audio, proxy and analysis representations. Prefer an available local original; otherwise stage the required source or independently decodable excerpts to a bounded SSD working set. Pin upcoming export inputs, evict reconstructible artifacts by bytes and reuse probability, and retain remote-range fallback for very large sources. Do not make downloading every original mandatory: prefetch can lose on short excerpts and slow connections.

Record `local_ready`, `analysis_ready`, `remote_original_ready`, `remote_proxy_ready` and `published` independently. A failed upload must not invalidate a successful proxy. Local work can continue while sharing correctly reports incomplete publication. Source deletion is allowed only after verified durable storage under the chosen retention policy.

For Drive imports, compare two paths: direct local staging with asynchronous R2 upload versus today's Drive → R2 → ranged processing. The first may win for a complete subtitle video; the second may win for a few short excerpts. Select by required coverage and available space instead of imposing one route.

### 2. A resource-aware dependency scheduler, not just priority queues

Give jobs explicit dependencies, estimated RAM, temporary disk, decoder/encoder demand, network class and cancellation/checkpoint boundaries. Admit work against **one shared budget** across native calls, FFmpeg, AI request payloads and uploads. Separate queues alone can recreate the memory overload the current single slot was added to prevent.

Use cooperative yielding between small units of work. Do not make SIGSTOP the primary scheduler: a stopped process retains its memory, open pipes and potentially codec resources, and can stall producers or expire a network operation. Keep OS process suspension as a measured fallback for suitable local jobs.

Prioritise short interactive reads, then completion-critical export/import dependencies; add aging so background work finishes. Preserve light I/O/remote AI overlap where it does not contend with encoding. The earlier AVFoundation audio/video slowdown supports isolating those readers on this workload, not banning all useful concurrency.

Persist job intent, source/project revision, artifact fingerprints, attempts and completed outputs. Retry external side effects with idempotency/reconciliation. Persist Drive resumable-session state and verify whether an uncertain upload completed before creating another. Recovery does not have to wait for chunked video exports: cached analyses, imports, proxies, voice takes, completed sound and upload sessions can all survive first.

### 3. The desktop window should be a client of a persistent host

The bundled window currently starts a server and stops it when the window closes (`edit-window`; `apps/server/src/window.ts`). For a Mac serving Tailscale clients, consider an opt-in per-user background service with a single-instance lock. Closing the editor should not accidentally cancel a remote session or export. Make “close window”, “pause jobs” and “quit service” separate operations.

Use an activity-scoped macOS sleep assertion while doing explicitly requested long work; release it when idle. Test sleep/wake, disk disconnect, network changes and relaunch. Schedule updates at durable boundaries. A persistent service improves lifetime; it still needs recovery and does not make a sleeping Mac reachable.

### 4. Generate only the representations the workflow needs

“One decode per file” is a useful direction, not an absolute contract. Sparse thumbnail/censor/angle sampling does not inherently require full decoding, and a slow consumer must not stall a preview producer. Reuse decoded frames opportunistically through bounded fan-out; persist small timestamped samples so individual analyses can retry independently.

Transcription can start from audio before the editing proxy. Watch and seats need **video as well as audio**: give them a cheap analysis representation early. Combine their shared scene/cast evidence where experiments show no quality loss; avoid asking two model pipelines to independently rediscover the same room and speakers.

Choose one sufficient proxy initially. Do not always make both 1080p and 720p. A source already suitable for local playback can be used immediately; remux or create a smaller proxy when required. Light preview demand must include analysis and agent rendering, not just remote browsers, because they currently use it too. Remote clients can trigger generation when bandwidth or playback warrants it.

The local-preview bitrate is 8 Mbit/s, but the cloud proxy is already 4 Mbit/s. A generic “drop to 5” would increase the latter. Measure visual legibility, seek latency and bytes per minute separately for each representation.

Loudness peaks can eliminate a separate waveform decode, but they are not identical to today's mono 4 kHz waveform. Define the new waveform semantics and test stereo cancellation, transients and silence. Share audio decoding without claiming bitwise parity.

### 5. Avoid work before accelerating it

Do not automatically interpolate every slowed shot. Prefer native high-frame-rate source where available, acceptable frame repetition where appropriate, and explicit interpolation for shots that benefit. Interpolation can damage faces, text, occlusions and cuts.

A minimal Objective-C capability probe on this Mac returned **`frame_rate_conversion_supported=1`**. Apple's API exposes runtime support and configuration constraints; support is not a throughput or quality result. Benchmark several representative shots and memory use before committing to render-time processing. Cache by source identity, frame pair/range, algorithm revision, quality and sampling parameters, not clip identity; handle cut boundaries explicitly. Browser preview must consume equivalent cached results or implement the same effect, since it cannot simply call macOS VideoToolbox.

Move deterministic house-style work into typed stage operations. Model work should choose story, identity and visual treatment; code should apply repeatable layout, validate and emit focused review points. Measure model/tool/network/queue time separately. “One look per stage” should be a default with evidence-triggered exceptions, not a hard cap that suppresses correction of a bad result. Parallel stage agents remain a later experiment: shared identity, timing, audio and revision conflicts can cost more than the overlap saves.

## Subtitle correctness: keep the cast, revise its contract

### Source evidence and project presentation need separate ownership

Stable person references are the right foundation. But mutable shared `people-v1.json` must not silently alter an old project's export whenever another project corrects the source.

Use immutable, versioned source evidence: transcript revision, stable word IDs, attribution hypotheses, model provenance and confidence. Keep human overrides separately, with precedence over new model runs. A project pins a cast/evidence revision and owns its display labels and colour assignment; it can explicitly adopt newer corrections. A source can suggest a preferred colour, but project-level casts can combine people whose source colours collide.

Retain merge **and split** operations and their provenance. Never reduce attribution to `speaker_N → person`: one diarisation voice can contain multiple people. Assign person at word/span level. Index ranges alone become unsafe when a retranscription inserts or deletes words; revision-bound word IDs or an explicit alignment map are needed. Migration must preserve current appearance and flag uncertain identity merges rather than guess from display names.

Resolve person references inside the pure model/evaluation boundary from the pinned project cast. Both renderers then consume the same resolved scene; no network/cache lookup during rendering. Fonts, caption style and effects also belong in export fingerprints.

### Agreement is useful evidence, not certainty

Watch, seats and diarisation are not necessarily independent: visual prompts already contain transcript names, and a wrong name can propagate through all three. One-frame-per-second viewing is not sufficient evidence of precise lip synchronisation for short replies. Offscreen voices, cuts, uniforms and similar seats need an explicit unresolved state.

Apple's `VNGenerateImageFeaturePrintRequest` generates **general image similarity** features; it does not document reliable face-identity verification. Crops can be a retrieval hint, not a confirmation rule. Appearance/place reconciliation is promising within a scene, but should preserve competing matches across angle, clothing or position changes. Evaluate on labelled examples before automatic merges.

Keep attribution accuracy, display identity and colour consistency as separate metrics. A perfectly consistent colour can still belong to the wrong speaker.

### Timing constraints need explicit conflict handling

Exact speech onset, 400 ms minimum visibility, no overlap and a hard cut cannot all be satisfied for every rapid exchange. Do not repair this by pushing all following lines late. Merge adjacent same-person cues within semantic, length and cut boundaries; allow overlap when the style permits; otherwise report a short-cue exception or use a readable multi-speaker layout. Never merge across an attribution change just to satisfy minimum duration.

Filter truly hidden voices before they participate in scheduling. Drop only boundary fragments covered by an explicit policy; a short audible word is not automatically disposable. Verify word coverage and ordering, onset/offset error, reading speed and clipping at cuts, not just duration.

10 ms energy can flag likely silence, but is not speech detection or word alignment: music and noise are energetic, and quiet speech may not be. Use it for triage; consider VAD or targeted alignment for disputed spans, measured against hand-checked audio.

The source-frame-rate proposal requires a model migration: `Settings.fps` and export FPS are currently `u32`. Use a rational rate (such as 24000/1001) with consistent frame/time conversion; support variable-frame-rate input by timestamps. Do not merely round 23.976 to 24 or change FPS on an existing project without retiming. Fractional-rate support will also reduce unnecessary output frames for these sources, but timing and audio-sync regression tests come first.

### Improve the evidence before using it as a release gate

`/tmp/subsrun/check.py` is useful triage, but not independent ground truth. It compares subtitles with the same transcript, cannot establish a real person's identity, and permits partial text matches. Its normalisation strips `*` before a later starred-word branch checks for `*`, making that branch ineffective. Its source mapping also chooses the first active video and does not apply speed to the subtitle end. Report unmatched/partially matched coverage and fix these issues before trusting accuracy percentages on edited footage.

Bring sanitised, hand-reviewed fixtures into a maintained evaluation suite **before** migration, not at the end. Preserve short replies, overlapping speakers, wrong diarisation, cut-edge words, renamed voices, frame-rate changes and human overrides. Keep a held-out set. ΔE 28 is a product rule, not a guarantee of accessible discrimination on real backgrounds; specify the colour metric and colour space, test contrast and colour-vision variants, and offer labels/position as additional cues. Invalid identity references should hard-fail; an explicitly recorded visual exception should not make the entire project uneditable.

## Exports, RAM and disk: additional opportunities

1. **Persist and cache the completed audio mix independently.** A subtitle-only fix should reuse sound. Fingerprint heard clips, source revisions, speed, gain, fades, mutes, format and loudness settings. A source audio sidecar avoids repeated remote video demuxing; preserve channels and timestamps, and do not use a lossy preview soundtrack as an unannounced mastering source.
2. **Measure audio CPU separately from network.** `mix.rs` runs true-peak measurement, writes float PCM, can make two limiter-measurement passes, then encodes. Thirty minutes of 48 kHz stereo float PCM alone is about **691 MB decimal**. Even perfect source caching does not eliminate these passes. Reuse the mix first; change normalisation only with sound-quality validation.
3. **Persist completed export manifests now.** Include project revision, settings, output checksum, destination and delivery status. File-ready and Drive-ready are different milestones. Make Drive a project/output policy; skipping a required delivery is not a speed improvement. Replace-in-place uploads must not race over a mutable local export path.
4. **Incremental video is valuable but not “hash what's on screen”.** Include transitions, neighbouring frames for temporal effects, global grades, source versions, fonts, cast/style and encoder configuration. Use closed GOP boundaries, compatible codec parameters and exact timestamps. Keep audio continuous to avoid AAC priming and global-normalisation seams. Chunking adds disk and assembly work; a tiny fix still may require copying the whole delivery file. Start with sound reuse and video chunk experiments, not a promise of seconds for every re-export.
5. **Single-writer A/V and zero-copy are separate experiments.** A single writer can remove the final full-file remux without running AVFoundation sound readers beside video decoders. GPU-to-IOSurface NV12 may reduce transfers, but needs shared-buffer lifetimes, bounded pools, colour/range handling and wgpu/Metal interoperability. Validate BT.709, HDR/tone mapping, alpha composition and preview parity. Measure total wall time and energy rather than only encoder-wait counters.
6. **Budget disk before starting a job.** Account for pinned inputs, PCM scratch, picture, final output, faststart/remux duplication, interpolation and resumable artifacts. An internal SSD is attractive, but ~24 GiB free at inspection is not unlimited capacity. Prefer an active SSD working set and slower archival storage; benchmark the drive path before attributing all delays to it. Cache deletion must respect open jobs, history/undo, offline-only sources and completed paid analyses. Orphan partials need expiry; active partials need leases. Measure physical allocated bytes because previews may be hard links.
7. **Measure the whole machine.** Include server, native workers, FFmpeg, WebView/browser, GPU and codec services, plus swap and memory pressure. A 1080p BGRA frame is ~8.3 MB; 4K is ~33.2 MB. Fixed frame-count limits do not give fixed RAM limits. AI base64 payloads and JSON serialisation also multiply resident data. Budget bytes and bound all concurrent lanes.

## Tailscale-first without rebuilding a remote-desktop product

Keep local rendering and editing on the Mac, and use the browser as a remote control/editor. Tailscale Serve gives HTTPS and authenticated identity headers, but the backend must be reachable only through the trusted proxy path for those headers to be meaningful. Tagged devices lack user identity headers, so define their authorisation separately. Preserve Origin checks and authorise API, WebSocket, media and MCP paths consistently. These are documented Serve constraints, not an argument that every tailnet is inherently open.

Measure direct versus relayed connectivity and actual throughput before changing media delivery. Add resumable downloads, reconnect/resync, adaptive preview selection and backpressure for slow WebSocket consumers. Compress static assets and JSON first. Follow with revisioned ID-based operations/patches and snapshot fallback on gaps; positional array patches alone are fragile under concurrent edits. Browser history already shares unchanged objects, so transport patches should not be credited with the entire existing RAM saving.

## Revised implementation order and acceptance experiments

1. **Establish end-to-end traces and fixtures.** Capture import-start, editable, subtitles-ready, review-complete, file-ready and Drive-ready; tie each to project/source revisions. Split queue, compute, network and model time. Test subtitle-only and full edits, cold/warm, local/cloud, with/without background work, including a long session. Report distributions and failures, not just one fastest run.
2. **Remove avoidable barriers and preserve results.** Durable manifests/jobs, independent local/cloud readiness, retain successful proxies, seats-cache verification, audio-first transcription, transcript/cast provenance. These do not require chunked export or a full one-pass media rewrite.
3. **Fix timing and establish the cast contract.** Fixtures first; both timing paths, unknown attribution, human overrides, pinned casts and unified rendering. Benchmark targeted review against full repeated watch/seats calls.
4. **Resource budgets and service lifetime.** Cooperative scheduling, storage reservations/eviction, persistent host, sleep/wake and crash recovery. Test that an import gets service while smoothing exists and that background work has a bounded effect on identical exports.
5. **Audio reuse and source residency.** Compare remote clip readers, local audio sidecars and bounded local originals on the same revision. Track total bytes and scratch space as well as wall time.
6. **Reduce media and model work.** Workflow-specific proxy/analysis graphs, reusable visual observations and deterministic stage tools. Capability/quality/performance experiment for VideoToolbox interpolation before changing its default.
7. **Export assembly and incremental rendering.** Measure single-writer A/V, then video chunks and GPU encoder handoff. Inject restart/corruption at boundaries and compare resumed/reused outputs with fresh renders, including boundary audio and frames.
8. **Remote efficiency and release simplification.** Compression, reconnect-safe patches, adaptive preview. Drop Intel only with an explicit supported-machine decision; it helps release cost, not the current M1's project runtime.

Do not make all engine improvements wait for the entire server rewrite. Keep new server orchestration in Bun as planned, but the shared engine, measurement and fixture work can proceed independently. Avoid implementing the same server feature twice.

No new end-to-end speedup or “eight-minute subtitle project” is established by this review. Those are benchmark targets. The most credible route is fewer dependencies, reusable completed work and earlier correctness—not merely more parallel processes.

## External API checks

- [Apple: VideoToolbox frame-rate conversion configuration](https://developer.apple.com/documentation/videotoolbox/vtframerateconversionconfiguration) — runtime support and configuration constraints.
- [Apple WWDC25: ML-based video effects](https://developer.apple.com/videos/play/wwdc2025/300/) — frame processor, introduced on macOS 15.4; allocation and flow-processing integration.
- [Apple: image feature-print request](https://developer.apple.com/documentation/vision/vngenerateimagefeatureprintrequest) — image feature generation, not a documented face-identity guarantee.
- [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) — HTTPS, identity headers, tagged-device limitation and localhost-only trust recommendation.
