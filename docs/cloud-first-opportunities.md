# New opportunities: faster completion with cloud on every project

2026-10-17. Cloud functionality for **every project is a fixed requirement**. Originals, project state, reusable analysis and required delivery remain available through the cloud. The proposals below aim to make that cloud infrastructure remove work from the Mac, not remove cloud functionality.

Workers Paid is now available, as confirmed by the user. The actionable rollout, implementation order, acceptance checks and US$5 Workers allowance target are recorded in [speed plan, section 7](speed-plan.md#7-workers-paid-rollout-move-suitable-work-off-the-mac). This document retains the wider design options; they are not all prerequisites for that rollout.

This is an independent design exploration, not another critique of the existing plans. Findings are grounded in the current implementation and read-only inspection of local projects. Numerical benefits are labelled as measurements or illustrative calculations; none is a new end-to-end benchmark.

## 1. Move cloud-to-cloud transfers off the Mac

**Question:** Why should bytes travelling between Google Drive and R2 pass through an 8 GB Mac and its internet connection?

`apps/server/src/cloud_media.ts::driveOriginal` calls `streamDrive`, which fetches Drive on the Mac and feeds `cloud.uploadStream`. This avoids a disk copy but still consumes both download and upload bandwidth, memory, and the Mac's uptime.

Introduce a durable transfer service: the Mac submits a source file identity/version and destination, then observes progress. The service copies Drive → R2 with resumable bounded ranges/parts. It can also copy a completed R2 export → Drive. Keep the transfer record and credentials server-side; use narrow authorised source/destination operations, not arbitrary URLs. Handle source changes, Google redirect/auth behavior, quotas and uncertain completion explicitly.

A Worker can coordinate multipart R2 work, but one long request is not a durable job. Persist the upload ID, source version and completed parts, execute bounded steps, and resume after failure. A small transfer process/container is an alternative if streaming/auth constraints make Worker execution awkward. Cloudflare documents streaming and resumable multipart primitives; the complete integration needs a spike.

**Illustrative lower bound:** uploading 3.5 GB through a 20 Mbit/s home uplink takes about 23 minutes before overhead. Bypassing that uplink can remove this bottleneck; it does not guarantee a particular cloud-copy speed.

**First experiment:** same Drive source through existing Mac relay and service transfer; compare time until R2 is complete, Mac traffic/RSS and interrupted-transfer recovery. No paid service deployment was performed in this investigation.

## 2. Use Tailscale for control; let remote clients fetch cloud media directly

**Question:** Why make the Mac retransmit a proxy that already lives in R2?

The current media route serves local files (`apps/server/src/routes.ts`, media handler). A remote browser therefore uses the Mac's uplink for playback while export/upload may be competing for it.

Keep editing commands, project revisions and live control over the Tailscale connection. Give an authorised remote browser short-lived cloud read access for immutable proxy/audio/export objects. The local desktop can still read its local cache. Select direct cloud versus host delivery using availability and measured performance; provide a host fallback for artifacts not uploaded yet.

This separates playback bandwidth from the Mac's job throughput. It also allows a completed cloud review/export to remain viewable while the Mac is asleep; live editing still needs an available host unless separately implemented.

R2 supports presigned GET URLs, with CORS required for browser use. Test HTTP range seeks, WebGPU texture access, expired-URL refresh, audio synchronisation, exact origin policy and fallback. Keep stable object identity separate from rotating credentials so URL refresh does not invalidate caches or repeatedly seek the player.

**First experiment:** remote playback during an export/upload, comparing host-served and R2-served identical proxies. Measure stalls, seek latency and host outbound bandwidth.

## 3. Replace physical excerpts with source-time references where possible

**Question:** Why must a trimmed view of cloud footage become another original file?

`excerptMedia` currently cuts a new file, uploads it, makes/uploads its proxy and creates a new media identity. The full source already has an R2 object. This is convenient for decoding but multiplies lifecycle work.

Represent an excerpt primarily as `(source version, source start, source end, timestamp mapping)`. Persist a keyframe/sample index for the source and create physical excerpts only when a decoder or network access pattern benefits. Cache bounded playable segments, rather than making every project's exact trim its own durable original. The full original remains cloud durable.

The same source-time model can serve transcripts, face tracks, scene boundaries, waveform peaks, censorship flags and cast observations. An excerpt asks for the relevant interval and transforms timestamps; it does not need a separate analysis universe. Re-trimming can fetch missing intervals. Speed changes and audio encoder priming need explicit maps, not just a guessed offset.

**Local inventory:** 13 saved projects, 639 media references, 124 distinct cloud source identifiers, including 20 excerpt identifiers from eight parent Drive files. Their distinct excerpt ranges total 4,090.704 seconds; no overlap was found among those ranges. This snapshot does **not** establish repeated overlapping analysis. It establishes the current excerpt representation and its footprint; reuse grows when later projects or changed trims revisit the source.

**First experiment:** reopen and re-trim a cloud excerpt with no new full-quality media upload, then export with matching source frame/audio timestamps. Compare bytes stored, requests, derivative count and analysis cache hits.

## 4. Treat subtitles as a compact timed data track

**Question:** Why store a short subtitle as a complete generic graphics clip with a full copy of its style?

Read-only measurements found a project with 1,214 subtitle clips:

- Compact project JSON: **929,674 bytes**.
- Repeated subtitle styles: **514,405 bytes**.
- Nine distinct styles: **3,789 bytes**.
- In-memory substitution of style references plus a style dictionary: **425,157 bytes**, a **54.3% reduction** in compact project JSON.

This is a serialization experiment, not a measured RAM saving or production migration. It preserves the style values and subtitle content, but the application does not yet understand that representation.

Introduce subtitle cues with stable word/person references, timing, style reference and sparse per-cue overrides. Keep shared style definitions immutable/versioned. Compile cues into the existing resolved text layers so preview and export retain the same visual semantics. Only materialise a generic graphics clip when the user asks for capabilities the cue track cannot represent.

A person/style change then touches a handful of definitions instead of hundreds of clips. Cloud snapshots, history, validation, WASM/JSON crossings and UI updates all carry less repeated state. Shared styles alone are a smaller first migration than replacing the full clip representation.

**First experiment:** style interning with lossless expand/compact round-trip on current projects, then measure process heap, load/save, cloud bytes and rendered parity. Do not equate compressed transport size with heap size.

## 5. Compile the timeline once per revision

**Question:** Why rediscover which clips and subtitle styles are active on every frame?

`edit-core/src/eval.rs::evaluate` scans all clips into a fresh active-track map for each evaluated frame. It also clones active text/style data. A 30-minute 30 fps output with 1,214 cues involves roughly 65.6 million cue membership checks if all cues participate in that scan.

Build a revision-scoped execution plan: sorted interval events, per-track cursors, media lookup tables, pre-resolved styles and static versus animated parameters. Sequential exports advance cursors; random seeks use an interval index. Invalidation can initially rebuild the whole compiled plan per revision—there is no need to solve fine-grained mutation first.

Cache subtitle layout/overlay state until a cue, word reveal, position or animation changes. The renderer already caches text images; this proposal removes repeated scene discovery and state construction around that cache. Keep time-varying effects dynamic.

**First experiment:** compare the compiled evaluator against `evaluate_seen` frame-by-frame on adversarial overlapping tracks and effects, then benchmark long subtitle timelines and scrubbing. Existing logs show small planning waits in some exports, so this may improve UI/CPU more than wall-clock export speed.

## 6. Add an eligibility-checked subtitle export fast path

**Question:** Must a simple interview with captions pay for every capability of a general compositor and mixer?

At export planning, classify the actual workload. A single continuous source with normal speed and subtitle overlays is materially simpler than an edit with transforms, transitions, blurs, grades and music.

Two opportunities:

- **Sound passthrough:** copy compatible encoded source audio when there are no mutes, fades, mixing, speed changes, required gain/normalisation changes or timing incompatibilities. Otherwise use the existing mixer. This must be a proof of eligibility; preserve all house-word mutes and output sound requirements.
- **Simple picture pipeline:** decode once, composite only the changing overlay regions, then encode. Experiment with YUV source/output residency and overlay-region conversion to reduce full-frame RGB transfers. Keep the same text rendering and colour semantics; support the optimisation within the shared renderer/backend contract, with the general path as fallback.

Burned-in subtitles still require video encoding. This is not a claim that a captioned MP4 can be produced by stream-copying the original picture.

**First experiment:** identify how many real subtitle exports are eligible; benchmark one eligible project and confirm A/V sync, mutes, loudness requirements and visual parity. If most are ineligible, avoid a large specialised implementation.

## 7. Upload export output while it is being produced

**Question:** Why does delivery begin only after rendering and local assembly finish?

Current Drive upload starts after the export completes. A streamable export representation can overlap encode and upload, reducing the delivery tail. For example, independent render and upload stages of eight and five minutes have a serial total of thirteen minutes; with sufficient buffering and no resource contention their combined duration can approach eight plus finalisation. This is arithmetic, not a measured promise.

Use immutable output fragments with a manifest or another format whose completed byte ranges will not be rewritten. Upload those artifacts to cloud storage as they finish; publish the final export only when checksums, duration and A/V validation pass. Consider final packaging and Drive transfer near R2, so the Mac need not retain multiple complete delivery copies.

Apple documents fragmented MP4 output. That is a candidate, not automatic compatibility with every Drive/player workflow. Standard MP4 finalisation/faststart can change earlier bytes, so blindly tailing today's growing file is unsafe. R2 multipart completion also does not expose a partially uploaded object; use distinct fragments for early cloud consumption.

**First experiment:** fragment export → cloud upload → packaging → Drive playback, including crash mid-fragment, cancellation and invalidation. Measure extra I/O and storage; keep the ordinary MP4 fallback.

## 8. Make cloud computation reusable across Macs and projects

**Question:** Why should every Mac independently discover that the same derivative needs generating?

Add an artifact registry keyed by source revision, interval, algorithm/model version, settings and relevant evidence revision. A worker claims a short lease, computes the artifact, atomically publishes its checksum/manifest and releases the lease. Other projects subscribe to the result. Expired leases allow takeover; a fencing token prevents a late worker overwriting a newer result.

Start with paid analysis and expensive proxies; extend to reusable graphics and suitable render fragments. Store algorithm provenance so a software update does not silently reuse incompatible output. Human corrections remain durable records, not evictable derivative cache entries.

The executor can initially be the current Mac. Later, another authorised Mac reachable over Tailscale can run the same native renderer with the same fonts/assets/version, reading cloud inputs and publishing cloud results. This offers optional capacity without moving the whole renderer to a different operating system or assuming a GPU exists in the relay.

**First experiment:** two isolated worker instances request the same artifact simultaneously, one dies, and exactly one valid result becomes visible with safe recovery. No second hardware purchase or remote job was initiated here.

## 9. Resolve identity anchors before exhaustive subtitle work

**Question:** Can a small, good evidence set prevent hundreds of lines being confidently assigned to the wrong person?

Build a cast calibration packet early: representative scene images, clean voice snippets, introductions and examples of each diarisation cluster. Ask for provisional identities and explicit uncertain relationships before full-window attribution. Subsequent analysis refers to these stable candidates rather than inventing fresh labels independently.

Then choose extra evidence by the unresolved question: short higher-frame-rate clips for a disputed on-screen speaker, more clean audio for a split voice, or a wider scene for a seating change. Preserve an unknown option. Appearance, voice and seat are evidence features, not identity guarantees.

This differs from simply watching all footage faster: it tries to prevent expensive correction cascades. For story comprehension, retain the necessary broad viewing. For identity, test whether targeted evidence gives better error reduction per second of model work. A human-confirmed anchor should outweigh later guesses.

**First experiment:** held-out hand-labelled footage; compare existing attribution with anchor-first attribution on wrong-person lines, unresolved lines, paid calls and time until correct subtitles. A faster answer with more attribution errors is a failed experiment.

## 10. Render stable sections before the edit is fully finished

**Question:** Can export's work begin before the user or agent asks for the final file?

After a stage passes review, mark its revision and dependencies as stable enough to prepare. When the machine has spare capacity, render reusable video fragments, sound or expensive effects for that revision. Final export reuses valid results; changed dependencies discard only the affected work.

This is more than speeding up a re-export: it moves first-export computation into otherwise idle periods during research/model waits. Use a strict speculative-work budget and low priority. The acceptance metric is useful reused work minus discarded work, not background utilisation. Global audio normalisation and cross-boundary effects must remain correctly accounted for.

**First experiment:** replay an edit's revision history and calculate how much speculative rendering would survive to the final revision before implementing it. If most work is invalidated, restrict preparation to stable source derivatives and sound.

## 11. Keep cloud transfers fast with a much smaller RAM envelope

**Question:** Do we need hundreds of megabytes buffered to saturate this connection?

`apps/server/src/cloud.ts` uses 64 MiB file parts with four in flight, and 32 MiB stream parts with two in flight. `readPart` also gathers chunks and copies them into a contiguous result. Its documented 320/96 MiB limits should not be interpreted as whole-process peak memory, including temporary copies and fetch buffers.

For seekable files, stream bounded byte ranges and re-read a range on retry instead of keeping every part resident. For non-seekable input, use one reusable bounded buffer or bounded disk spool; cloud-to-cloud transfer removes that burden from the Mac altogether. Choose concurrency against measured throughput and a global transfer budget, not just a per-file constant. Multipart size/part-count constraints still apply.

**Illustrative bandwidth-delay product:** 100 Mbit/s at 100 ms RTT is about 1.25 MB. Application/HTTP concurrency can require more, but this does not inherently require 256 MB of resident upload payload.

**First experiment:** throughput/RSS under several part sizes and 1–4 streams, including retries and simultaneous playback. Select the smallest configuration that achieves nearly the best measured throughput.

## What I would investigate first

The strongest near-term bets are **cloud-to-cloud transfer**, **direct cloud playback**, **shared subtitle styles**, and **smaller streaming upload buffers**. They have concrete code entry points and bounded experiments, and directly serve cloud continuity, memory use and time to completion.

The larger architectural bets are **source-time assets**, **shared cloud artifacts**, and **delivery overlapping rendering**. Together they allow every project to remain cloud-backed while making this Mac handle fewer redundant bytes and less repeated work.

The highest uncertainty is in the specialised picture pipeline, anchor-first attribution and speculative rendering. Prototype each against a narrow representative case before committing to its architecture. Success means a correct final file, and Drive delivery when requested, with less total elapsed time and bounded resource use.

## Sources checked

- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) — create/resume/complete multipart uploads.
- [Cloudflare streaming APIs](https://developers.cloudflare.com/workers/runtime-apis/streams/) — streaming large bodies within Worker memory limits.
- [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) — browser access and CORS requirements.
- [Apple fragmented MP4 authoring](https://developer.apple.com/videos/play/wwdc2020/10011/) — candidate export representation.
- [Google Drive resumable uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads) — delivery sessions, chunks and recovery.
