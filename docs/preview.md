# Preview decoding

## Edit.app draws the picture itself

In Edit.app's window the viewer's picture is drawn by the engine, not the page
(docs/plans/2026-11-06-native-player.md). `crates/edit-engine/src/player.rs`
evaluates the frame as the page's engine did, decodes its pictures with the
export's readers (the Mac's video decoder; a reader just behind a frame decodes
forward, anything else seeks) and presents onto a Core Animation layer under the
page (`crates/edit-window/src/preview.rs`). The page turns see-through over the
viewer (`native-preview` on `<html>`), so everything it draws over the picture
stays on top, and asks for each frame (`lib/nativePreview.ts`); it keeps the
playhead, the sound and its engine (sections, checks), but decodes no video and
asks for no smooth-playback render, in full screen either. The edit goes to the
window whole once, then as patches (`lib/patch.ts`), each answered with the
revision the window draws or why it refused (a refused edit: the page draws).
Each frame's answer says its time and where it went (`diagnostics.nativeFrames`,
the `ui: preview: native …` timings). Each picture comes from its preview file,
a cloud one's whole copy (a made proxy, or footage that's its own proxy), else
its footage on the Mac, else the server's loopback stream while the whole file
comes down; a pieced proxy's pieces on the Mac are read as files of their own
(`apps/server/src/native_preview.ts`). Full screen, a browser, or five failed
frames in a row: the page draws as below. Measured Nov 8 on Cops Realize (M1,
cloud footage): 160 s with 30 cuts drew 4,816 of 4,823 frames, 2.1 ms p50 and
3.8 ms p90, the cuts' seeks the slow ones (docs/plans/2026-11-08-audit.md).

To see it without screen access: `EDIT_PREVIEW_TRACE=1` says each placement and
draw on stderr; `EDIT_PREVIEW_CHECK=<frame>` has the window seek there, scrub,
play and pause by itself, and `EDIT_PREVIEW_SHOT=<file.png>` then saves the
window's own picture (an app may capture its own windows without permission);
`EDIT_PREVIEW_JS=<file>` runs a file's steps in the page instead (a line
`--- wait <seconds>` between them), for scripted measurements.

## Smooth playback

The viewer plays and scrubs a render of the edit when one shows what's on screen
(the team, Oct 31: "currently super laggy! we have too many loading frame issues").
`apps/server/src/playback_render.ts` exports the open project in the background at its
own size, smallest quality, on the video engine, through the export's chunks under the
project's id plus `.playback` (so a real export's chunks are never touched): a re-render
after an edit copies the chunks that didn't change. The page asks for it
(`POST /api/projects/{id}/playback`) once its edits have settled for 2.5 s; one render at
a time, never beside a local export (it stops and carries on after). The file is
`<cache>/playback/<project>.mp4` (about 2.9 Mbit/s, kept for the three projects rendered
last) with a `.json` saying which picture it shows. `lib/playback.ts` shows it in a
`<video>` over the canvas while its revision is the one on screen and nothing waits to
save: play follows the video's clock, a seek sets its time, and nothing is decoded live.
An edit drops back to the live preview below until the next render lands (a smooth play
that goes stale pauses there), and the page asks for none while the agent is mid-turn.
It renders on this Mac whatever its footage, and plays
a chunk at a time while it renders (`playback_stream.ts`, `lib/smoothStream.ts`): the
render does the chunks from the viewer's playhead first (`Plan.focus`, the page sends its
frame), the minute from it before the sound's mix and the rest after, and the page appends
each finished chunk to a MediaSource as it lands (fragmented MP4, remuxed from the chunk
file or the joined file on request), the sound in an `<audio>` beside it once mixed. Where
no chunk is in yet the viewer draws live. Measured Nov 2 on the 16-Year-Old (26.7 min, 54
chunks): with the render done, a seek anywhere shows it in 0.5–1.6 s and it plays at 30 fps;
with it under way, the first chunk showed 17 s after the render started (it had waited
142 s for the whole sound's mix), and on a Mac with nothing cached and the machine loaded,
138 s. The whole render took 16 min 49 s here (48 fps).

`apps/web/src/lib/playback.ts` owns the playhead, Web Audio clock and complete-scene
presentation. The WASM engine still evaluates and draws through the same renderer
as native export. No project model or exported media is changed by preview decoding.

The server makes two preview files per source (`apps/server/src/media.ts`):
`preview.mp4`, H.264 at most 1080p with a keyframe every half second and no
B-frames (a few Mbit/s, where the old all-intra proxies ran at 15–85), and
`preview.m4a`, AAC. Picture and sound are fetched separately, so decoding sound
never downloads video. Until `preview.done` exists both URLs serve the original.
On macOS, AVFoundation/VideoToolbox produces the preview video and light copy
with a bounded pixel-buffer pool. Audio remains a separate FFmpeg job. Imports
and optional optical flow share one background slot, rather than independent
limits that add up. Photos use ImageIO and remain images: no synthetic video,
video proxy or optical-flow job is needed for a still.

`decoder.ts` creates separate module workers for video and audio, using
`decode.worker.ts` and Mediabunny for demuxing and WebCodecs decoding. Bytes come
through `range-source.ts`: bounded, 256 KiB-aligned range requests with a small
block cache and readahead once access turns sequential. (Mediabunny's `UrlSource`
requests `bytes=N-` and aborts on every seek; over Wi-Fi most of each scrub went to
bytes that were thrown away.) Each worker runs at most two jobs concurrently and
retains at most four idle/active input files after jobs settle.

Cloud previews come through the server (`/api/cloud/preview`, `cloud_media.streamFromCloud`),
which serves the page's bounded reads from 2 MiB blocks of the R2 object (`cloud_blocks.ts`):
each block read from R2 once, both workers' reads of the same file sharing it, kept on disk under
`<cache>/cloud/blocks/` and dropped by the cleaner after a few hours, the next two read ahead.
Measured Oct 29 on Mom & Teen from South Africa, where every R2 read waits ~0.25 s for its first
byte whatever its size: before, 256 KiB reads straight to R2 (picture and sound each reading the
same file) played at 21 fps with a 4.8 s freeze, 565 late frames and 568 audio underruns, and 3 of
8 cold seeks hadn't landed after 4 s; with the blocks, cold, it plays at 30 fps (worst hold
0.25 s, 14 late frames, no underruns) and every seek lands in 0.3–1.9 s; warm, seeks take
34–150 ms and the first frame 1.7 s. A scrub (a position every 33 ms) shows about half the
positions asked: each decodes from the keyframe before it. The measuring script drove headless
Chrome over its debugging protocol (`window.__edit.preview`: seek, play, `diagnostics`).

Video lanes (one per visible clip) keep a decoder open during playback and read
forward from it across batches; a jump of more than a second, or backwards,
reopens it at the preceding keyframe. A scrub decodes from the keyframe to exactly
its picture instead, since an open decoder reads dozens of packets ahead. Obsolete
jobs finish their first requested picture before dropping prefetch work; lanes the
preview no longer shows release their decoder, and replaced sources are cancelled.

The main thread owns LRU caches of decoded `VideoFrame`s (128 MiB) and PCM audio
(32 MiB). Frame eviction calls `close()`. One frame larger than the video budget
is allowed so large sources can still be displayed. Prefetch batches adapt to frame
size, playback speed and concurrent sources. Scrubbing only requests the desired
picture; it does not launch audio or upcoming-cut decodes. Once the playhead has
rested for 300 ms its sound is decoded, so Play starts without waiting for audio. Playback batches are
allowed to finish instead of being continually replaced by new prefetch requests.
Project switches and detach terminate workers and
release all cached resources. Image files decode through `createImageBitmap`.

Source video timestamps select the nearest source frame, matching export. During
scrubbing, completed requests render their own full scene, including graphics;
the latest requested position remains queued and lands exactly when ready. Older
completion messages cannot move the displayed scrub sequence backwards.

Playback uses `AudioContext.currentTime` for both picture and sound. PCM is decoded
as continuous runs with decoder preroll, then stored in half-second source chunks.
Keeping the decoder open across chunks preserves AAC's overlap state. PCM is
trimmed at sample boundaries and scheduled with
clip offsets, volume keyframes and fades. Non-unit speeds use worker-side WSOLA
stretching with neighboring context to preserve pitch. Startup waits for picture
and half a second of audio. During playback the audio clock continues when video
is late: the compositor uses a nearby cached picture within the same clip or
holds the displayed scene while the decoder catches up. Seeking, editing, pausing
and visibility changes clear scheduled nodes. Upcoming picture cuts and sound are warmed one second
ahead, including different moments from the same file.

`window.__edit.preview.diagnostics` reports the displayed frame, cache bytes,
decoded frames, requests, cache hits, video misses, audio underruns and scheduled
audio nodes. Use these alongside
browser tracing when checking cold seeks, repeated forward/reverse scrubs and cuts.
Unsupported codecs surface an error; completion of the H.264/AAC proxy changes the
source URL and clears the error. There is no hidden HTML video playback path.

Native frame reviews and exports use persistent AVAssetReader cursors on macOS,
with Accelerate scaling/rotation and nearest-source-frame selection. Standard
H.264/HEVC hardware exports encode through AVAssetWriter, then copy that video
when mixing audio/chapters. The compositor remains shared with the browser.
Custom output shapes, resizes/rates, software quality modes and other formats use
the FFmpeg encoder; unsupported native decoders fall back per source and log why.
`EDIT_FFMPEG_VIDEO=1` selects the compatibility video backend for comparison.
Native handles drain temporary objects per frame, readers are discarded when
their clips leave the scene, and the encoder pool allows at most six buffers.

To measure over a realistic link, run the editor through a bandwidth- and
latency-limited proxy (Chrome's `--proxy-server`; DevTools throttling does not reach
the decoder workers) and compare shown scrub positions, settle time, start time and
`videoMisses`/`audioUnderruns`. At 100 Mbit/s with 10 ms RTT the teen hit-and-run
edit starts playback in 0.1–0.4 s with no misses or underruns.

Run `just check` and `bun run --cwd apps/web build`. Browser verification should include
the teen hit-and-run map/date reveal, rapid scrubbing, cold seeks across bodycam
sources, playback across cuts, slow/fast audio, pause/resume, mute/fades, source-to-
proxy replacement, project switches and GPU recovery.

For audio regressions, compare decoded PCM at chunk joins against a continuous
decode of the same file, and measure audio-clock resets during real editor playback.
The loading badge only appears after 600 ms; its absence does not prove that short
stalls or audio interruptions are absent.
