# Speed plan

Changes to make Edit much faster from import to Drive, lighter on RAM and disk, and good over Tailscale. Numbers come from `~/.edit/logs/edit.log` (Oct 17) unless noted. Status: proposed, not started.

## 1. Agent editing

| # | Change | Why | Done when |
|---|---|---|---|
| 1.1 | **Smoothing on Video Toolbox, automatic.** Replace FFmpeg `minterpolate` (`crates/edit/src/broll.rs:316`) with `VTFrameProcessor` frame rate conversion in `mac_media.m`. Every slowed cut-in shot is smoothed by Edit itself: cached per shot, redone only when speed or trim changes, paused during exports. FFmpeg only as a fallback. The agent stops calling `smooth_slow_motion`. | 124 calls; 18 renders averaging 77 min; 23 CPU-hours. The user almost always wants it, so it stays on. | Benchmark on a Mom & Teen shot first; a shot smooths in seconds. |
| 1.2 | **Seats cache reads back.** | `repack_subtitles` 13 min per call, paying Gemini every time. | In progress. |
| 1.3 | **Watch footage at import**, in the background. | `watch_footage` 6 min per call; 150 windows at ~94 s each. | The agent never waits on it. |
| 1.4 | **One look per stage, enforced.** The plan's `review_frames` is the look; mechanical checks come from the audit. | `contact_sheet` 96 calls, `render_frame` 72. | Under ~10 renders per edit. |
| 1.5 | **Parallel stage agents** (intro, story, outro on separate parts of the timeline). | ~3.5 h of model round trips. | Later: after 1.1–1.4, measure again. |

## 2. Import (0 → editable)

| # | Change | Why | Done when |
|---|---|---|---|
| 2.1 | **Script import in parallel.** Download 2–3 files at once (now one after another, `crates/edit/src/script.rs:1458`), and start the voice-over at once: it needs only the script. | Downloads up to 6 min each; lay out 2.5 min, then the voice-over after it. | Voice-over ready when footage is. |
| 2.2 | **One decode per file** feeding thumbnails, waveform, loudness and censor (and the preview where it's made). | Each file is decoded ~6 times, one step after another (`crates/edit/src/media.rs:190-260`). | One read of the source per import. |
| 2.3 | **Fix slow preview copies.** Find why some take 20–43 min (hardware encode is already the path; suspects: reading off the LaCie, contention with smoothing) and drop the bitrate from 8 to ~5 Mbit/s. | 4.5 h over 71 files. | No file over a few minutes. |
| 2.4 | **Light preview on demand.** Made from the proxy only when a remote browser first asks for it. Keep it: it's what Tailscale viewers stream (`apps/web/src/lib/previewQuality.ts:21`). | 3.5 h over 124 files; 307 MB for one file. | Not made for local-only projects. |
| 2.5 | **Upload the original while the proxy encodes**; editing starts as soon as the proxy is ready. | Up to 10 min per file, in series. | Nobody waits on the upload. |
| 2.6 | **Cache cleanup.** Remove previews no project uses; cap the total size. | 4.2 GB cache, one file at 1.1 GB, never evicted. | The cache stays under its cap. |

## 3. Export (→ Drive)

| # | Change | Why | Done when |
|---|---|---|---|
| 3.1 | **Sound and picture in parallel.** | Sound mixing 11 min before the picture starts. | ~25% faster exports. |
| 3.2 | **Faster hand-off to the encoder.** Convert to NV12 on the GPU and write into IOSurface pixel buffers (skip the CPU copy, 8 MB → 3 MB per 1080p frame); replace the 1 ms sleep-poll in `edit_writer_frame` (`mac_media.m:682`). | Encoding is the bottleneck: 12.5 of 27 min of the 32-minute export waited on it. | Wait on encoding near zero. |
| 3.3 | **Pause background work during exports.** | The same 29k-frame export took 3 min alone and 12 min with jobs beside it. | Exports run at the solo speed. |
| 3.4 | **Skip footage hidden under full-frame B-roll.** | 20–40% of decode work. | In progress. |
| 3.5 | **Prefetch cloud originals** ahead of the decoders. | 24 fps from R2 against 55 locally. | Within ~20% of local. |
| 3.6 | **Upload to Drive while the export is written.** | Uploads only start after the export: 19 took 52 min. | Link ready seconds after the export. |

## 4. Remote and browser (Tailscale)

| # | Change | Why | Done when |
|---|---|---|---|
| 4.1 | **Send changes, not the whole project.** Events carry patches; the UI saves patches. | Every commit sends the 1–2 MB project to every browser (`store.rs:484`), and every UI save PUTs all of it (`apps/web/src/lib/store.ts:259`). | Small edits send kilobytes. |
| 4.2 | **Compression.** tower-http's gzip/brotli on JSON, JS and WASM. | No compression on; 867 KB JS + 853 KB WASM + project JSON. | ~4–5× less over the wire. |
| 4.3 | **Sign-in over Tailscale** (`tailscale serve` identity headers, or a token). | Anyone on the tailnet can open projects and call the agent tools; only the Host header is checked. | Unknown devices are refused. |

## 5. Quality and extensibility

| # | Change | Why |
|---|---|---|
| 5.1 | **Decide on the TS rewrite**: freeze it or commit to finishing it, not both. | 175 commits to the Rust server this week against 9 to `apps/server`: every change is written twice. Bun beside the Rust engine also costs RAM. |
| 5.2 | **Compact project JSON** on disk and in history. | 2.1 MB pretty against ~1.2 MB compact; 127 MB of history. |
| 5.3 | **Drop the Intel build** if no one uses an Intel Mac. | Halves release CI. |

## Order

1. 1.1 smoothing on Video Toolbox (benchmark first)
2. 3.3 pause background work during exports, 3.1 sound and picture in parallel
3. 2.1 script import in parallel, 2.2 one decode per file, 2.3 preview copies
4. 4.1 + 4.2 patches and compression
5. 3.2 encoder hand-off, 3.6 upload while exporting
6. The rest, measuring after each
