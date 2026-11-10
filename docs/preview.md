# Preview decoding

## Edit.app draws the picture itself

In Edit.app's window the viewer's picture is drawn by the engine, not the page
(docs/plans/2026-11-06-native-player.md). `crates/edit-engine/src/player.rs`
evaluates the frame as the page's engine did, decodes its pictures with the
export's readers (the Mac's video decoder; a reader just behind a frame decodes
forward, anything else seeks) and presents onto a Core Animation layer under the
page (`crates/edit-window/src/preview.rs`). The page turns see-through over the
viewer (`native-preview` on `<html>`), so everything it draws over the picture
stays on top. At rest the page owns the playhead and asks for each frame
(`lib/nativePreview.ts`); playing is the window's: the edit's sound is mixed
there as the export mixes it (`crate::mix`, a quarter second at a time into a
CoreAudio speaker, `mac_media::Speaker`), the frames the speaker has played are
the one clock, the picture follows it, and the page asks where it is once an
animation frame (`preview_position`) and moves its playhead there. Short of
sound the clock holds, so picture and sound never drift. The cuts within the
next three seconds have readers opened and seeked on two other threads
(`PreviewPictures::warm`), so a cut reads on instead of seeking on the drawing
path; a hover over the timeline's ruler tells the window where a click would
land (`preview_hint`), and a resting playhead has its sound armed and its cuts
warmed after a quarter second. The page decodes nothing and asks for no
smooth-playback render, in full screen either (full screen plays on in the
page, on its own clock). The edit goes to the window whole once, then as
patches (`lib/patch.ts`, applied to the parsed clips: `edit_core::patch`), each
answered with the revision the window draws or why it refused (a refused edit:
the page draws); the page's own engine takes the same clips-only patches
(`Engine::applyPatch`) instead of parsing the whole edit each change. Each
frame's answer and each position says its time and where it went
(`diagnostics.nativeFrames`: `played`, `playedSkipped`, `starved`; the
`ui: preview: native …` timings). Each picture comes from its preview file,
a cloud one's whole copy (a made proxy, or footage that's its own proxy), else
its footage on the Mac, else the server's loopback stream while the whole file
comes down; a pieced proxy's pieces on the Mac are read as files of their own;
each sound from a made preview's `preview.m4a`, a cloud copy's own sound, else
the footage or the stream (`apps/server/src/native_preview.ts`). A project the window
draws is marked as its on the server (`apps/server/src/player.ts`): its whole
copies come down in playhead order when it opens, and the page player's block
prefetch, scrub pieces and after-turn smooth render stay off for it. Full screen, a
browser, or five failed frames in a row: the page draws as below. Measured Nov
8–9 on Cops Realize (M1, cloud footage) in docs/plans/2026-11-08-audit.md
("A's stage 2, measured after").

**Script mode plays on the same player** (Nov 10,
docs/plans/2026-11-10-script-player.md; Sphe: "When one is improved, the other
should be improved as well"). Until then the script page had a player of its
own in the page (`writer/playback.ts`, WebCodecs on a canvas, the page's audio
clock), and every improvement above passed it by. Now the script's cut is
handed to the window as a small edit (`@edit/types/script_cut`: a linked
picture and sound clip per footage item, black where a card is, boundaries on
the nearest frame of the edited clock at 30 fps) and drawn in the same layer,
placed under the monitor's screen (`writer/window-player.ts`); an audition
(the footage straight through) is the same edit with one clip, the whole
recording. The monitor's `Player` is unchanged, so the transcript, the
timeline, the captions and the cards drive it as before. `writer/player.ts`
chooses: the window's player when every recording the cut plays is a file on
this Mac (`POST /api/writer/window-sources`, `writer/window_sources.ts`: the
script's `proxy.mp4`, a commentary's clip footage), the page's otherwise (a
browser, Linux, a preview only in the cloud). A preview only in the cloud
comes down whole behind the ask when the scripts' footage and Edit's cache
have room for it (`storage.overBudget`), and the cut moves to the window where
it rests once it's here; a script open on this Mac keeps its footage here
(`locks.openHere`), so the file never goes from under the window. Three failed
asks in a row and the page's player takes the cut back at the same moment.
Speed (1× and 2×, the sound's pitch kept) and volume are the window's
(`preview_rate`, `preview_volume`). For checks, `window.__editScript` has the
page's `player`, its `playhead` and `drawnBy()` ("window", "page" or
"choosing").

Checked in the real window on a real script (Nov 10; the measurements are in the
plan, "Measured"), and what that found is how it works now. A layer that changes
size at rest (a view changed, the split dragged, the editor opened after a script)
draws the playhead's frame again at once, and shows the old picture fitted, never
stretched, until it has (`Player::resize`, the layer's `contentsGravity`); pictures
are decoded at the eighth of the edit's size above what's shown, so a dragged
panel isn't a new decoder for every pixel. A layer of a pixel or two (the Script
view: the monitor away, the cut playing on) has nothing decoded or drawn for it.
The playhead is settled (its sound armed, its cuts warmed) only once it has rested
a quarter second, not after every frame of a drag. A quarter second of silence
follows the sound's end, so the clock, which runs a speaker's latency behind what's
been played, reaches the last frame and a cut played to its end ends (the editor's
too). A mix that can't open its sound (the recording gone from this Mac under an
open script) says so with the next position (`problem`), and Script mode hands the
cut to the page's player, where the window played on in silence. Going from a
script straight to an edit (Start the edit) stays on the edit. In development
(`just dev`, React's StrictMode) the script's player asks for nothing until its
canvas is there and lives again after the unmount StrictMode stages.

**The editor plays at 2× as well** (Nov 10; JJ: "a button where we can speed
up when watching the video. like in premiere"): the viewer's 1× / 2× button,
the one Script mode's monitor has, and L while it plays. `preview.setSpeed`
(`lib/playback.ts`) is the one place, for whichever player plays: the window's
is told (`preview_rate`, before a play and at once mid-play; a window opened
again is told as it opens, since a new one plays at 1× and the sound it makes
ready at rest is at the speed it has), the render's video plays at
it with its sound in step (`SmoothStream.follow`'s `speed`), and the page's own
clock runs at it with each clip's sound asked of the decoder at its own speed
times the player's (the worker's WSOLA, as a sped clip's). A window that
refuses the speed plays at 1×, and the button says 1×. The speed stays until
it's changed or Edit is closed.

**How the window plays at a speed** (Nov 10). The speed and the loudness are
the page's to set (`preview_rate`, 0.25–4, and
`preview_volume`, 0–1; both kept until changed, both 1 in a preview just opened):
Script mode's 2× and volume buttons (docs/plans/2026-11-10-script-player.md, step 4).
The mixer still mixes the timeline as it is; each window is made shorter or longer
with its pitch kept on its way to the speaker (`crates/edit-engine/src/tempo.rs`:
WSOLA, 20 ms blocks laid half over each other, each taken where the sound best goes
on within 15 ms of where the speed puts it; at 1× the sound goes through untouched),
the clock is the speaker's count times the speed, and the picture is drawn a stride
of frames at a time (every other frame at 2×, which the reader decodes forward to;
`skipped` counts only pictures missed beyond that). A change while playing never
stops it: the sound at the speed before plays on while a second mixer gets the new
speed's ready, which takes the speaker over a tenth of a second ahead of what's
playing (`Feed::join`), each side faded 5 ms, and the clock changes speed at that
sample. The volume is the speaker's own mixer, after the ring, so it's heard at once.
The cuts warmed ahead are those within three seconds of playing (twice the frames
at 2×), nearest first and no more than the reader pool keeps beside the readers
playing, and a reader made ready for a cut is the last the pool lets go for four
seconds, not the first. Measured Nov 10 on Cops Realize (M1): 2.000 s of timeline a
second at 2× with 30 pictures a second drawn, no seek while playing, no change of
speed leaving the speaker short (the new sound ready 11–83 ms after it's asked);
on a minute of interrogation speech at 2× its pitch stays within 50 cents on 95.7%
of voiced frames (FFmpeg's atempo 94.1%, the page's SoundTouch 89.2%). Nobody has
listened to it yet.

To see it without screen access: `EDIT_PREVIEW_TRACE=1` says each placement and
draw on stderr; `EDIT_PREVIEW_CHECK=<frame>` has the window seek there, scrub,
play and pause by itself, and `EDIT_PREVIEW_SHOT=<file.png>` then saves the
window's own picture (an app may capture its own windows without permission);
`EDIT_PREVIEW_JS=<file>` runs a file's steps in the page instead (a line
`--- wait <seconds>` between them, `--- shot <file.png>` for the window's picture
then), for scripted measurements; the trace says each open and close, and what
playing missed (pictures, the speaker short) since the page last asked.

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
