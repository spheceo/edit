# Speed plan

Changes to make Edit much faster from import to export, more reliable, lighter on RAM and disk, and good over Tailscale. Numbers come from `~/.edit/logs/edit.log` (Oct 15–17) unless noted.

Status: proposed. **Starts after the TS rewrite (`apps/server`) is done.** Server items land in `apps/server`, engine items in `crates/edit-engine` (the Rust that stays); nothing new goes into `crates/edit`. Each item is tagged *server* or *engine*.

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
| 2.2 | *engine + server* **Smoothing on Video Toolbox, automatic, at render time.** Replace FFmpeg `minterpolate` (`crates/edit/src/broll.rs:316`) with `VTFrameProcessor` frame rate conversion in `mac_media.m`. Smoothing becomes a render-time effect of a slowed clip, not a media file swapped in: cached by (media, source range plus a margin, speed), so a re-trim within the margin reuses it. Every slowed cut-in shot is smoothed by Edit itself in the background (lowest priority, 1.1). FFmpeg only as a fallback. The agent stops calling `smooth_slow_motion`. | 124 calls; 18 renders averaging 77 min; 23 CPU-hours. Today a re-trim throws away a finished render: three were discarded after minutes of work ("changed while smoothing"). Slowed footage is almost always wanted smooth, so it stays on. | Benchmark on a Mom & Teen shot first; a shot smooths in seconds; a re-trim doesn't smooth again. |
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
| 4.7 | *server* **Normal edits aren't uploaded to Drive; they're downloaded.** Drive only for subtitled videos (Repack's folder, for now). Every project gets an exports list that survives restarts, each with a download button (works on the Mac and over Tailscale), and old exports can be deleted from it. | Today every full-length export uploads (`crates/edit/src/drive.rs:73`): 19 uploads took 52 min. The download (`crates/edit/src/server.rs:1808`) only knows exports from the current session, so it's gone after a restart. | A normal export is ready to download the moment it finishes. |

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
| 6.2 | **Drop the Intel build** if no one uses an Intel Mac. | Halves release CI. |

## Order (once the rewrite is done)

1. 0.1 media back on the internal disk (can happen any time: it's a move, not code)
2. 1.1 the scheduler, 2.1 measure the agent's time
3. 2.2 smoothing on Video Toolbox, at render time (benchmark first)
4. 4.1 fast sound, 4.3 no join
5. 4.7 downloads instead of Drive, 3.7 cache cleanup
6. 4.2 chunked exports, 1.2 jobs survive restarts
7. 3.1 script import in parallel, 3.2 one decode per file, 3.3 free waveform, 3.4 preview copies
8. 5.1 + 5.2 patches and compression
9. 4.4 encoder hand-off
10. The rest, measuring after each
