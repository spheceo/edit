# Preview decoding

`web/src/lib/playback.ts` owns the playhead, Web Audio clock and complete-scene
presentation. The WASM engine still evaluates and draws through the same renderer
as native export. No project model or exported media is changed by preview decoding.

The server makes two preview files per source (`crates/edit/src/media.rs`):
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

Run `just check` and `bun run --cwd web build`. Browser verification should include
the teen hit-and-run map/date reveal, rapid scrubbing, cold seeks across bodycam
sources, playback across cuts, slow/fast audio, pause/resume, mute/fades, source-to-
proxy replacement, project switches and GPU recovery.

For audio regressions, compare decoded PCM at chunk joins against a continuous
decode of the same file, and measure audio-clock resets during real editor playback.
The loading badge only appears after 600 ms; its absence does not prove that short
stalls or audio interruptions are absent.
