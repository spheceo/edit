# Preview decoding

`web/src/lib/playback.ts` owns the playhead, Web Audio clock and complete-scene
presentation. The WASM engine still evaluates and draws through the same renderer
as native export. No project model or exported media is changed by preview decoding.

`decoder.ts` creates separate module workers for video and audio, using
`decode.worker.ts` and Mediabunny for lazy HTTP range reads, demuxing and WebCodecs
decoding. Each worker runs at most two jobs concurrently, retains at most four
idle/active input files after jobs settle, and limits each input's compressed byte
cache to 8 MiB. Obsolete jobs finish their first requested picture before dropping
prefetch work; jobs for removed lanes and replaced sources are cancelled.

The main thread owns LRU caches of decoded `VideoFrame`s (128 MiB) and PCM audio
(32 MiB). Frame eviction calls `close()`. One frame larger than the video budget
is allowed so large sources can still be displayed. Prefetch batches adapt to frame
size and concurrent sources. Project switches and detach terminate workers and
release all cached resources. Image files decode through `createImageBitmap`.

Source video timestamps select the nearest source frame, matching export. During
scrubbing, completed requests render their own full scene, including graphics;
the latest requested position remains queued and lands exactly when ready. Older
completion messages cannot move the displayed scrub sequence backwards.

Playback uses `AudioContext.currentTime` for both picture and sound. PCM is decoded
in half-second source chunks, trimmed at AAC sample boundaries and scheduled with
clip offsets, volume keyframes and fades. Non-unit speeds use worker-side WSOLA
stretching with neighboring context to preserve pitch. Buffering stops scheduled
audio and resets the common clock; seeking, editing, pausing and visibility changes
also clear scheduled nodes. Upcoming picture cuts and sound are warmed one second
ahead, including different moments from the same file.

`window.__edit.preview.diagnostics` reports the displayed frame, cache bytes,
decoded frames, requests, cache hits and scheduled audio nodes. Use these alongside
browser tracing when checking cold seeks, repeated forward/reverse scrubs and cuts.
Unsupported codecs surface an error; completion of the H.264/AAC proxy changes the
source URL and clears the error. There is no hidden HTML video playback path.

Run `just check` and `bun run --cwd web build`. Browser verification should include
the teen hit-and-run map/date reveal, rapid scrubbing, cold seeks across bodycam
sources, playback across cuts, slow/fast audio, pause/resume, mute/fades, source-to-
proxy replacement, project switches and GPU recovery.
