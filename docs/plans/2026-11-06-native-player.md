# Native player, footage on the Mac, and what JJ's logs say (Nov 6)

The plan agreed with Sphe on Nov 6. Order: **nightly-59 → keep footage on the Mac → native player.** Each step waits for Sphe's go.

## Where things stand

| Step | State |
|---|---|
| 1. nightly-59 | Committed, not pushed: waiting for Sphe's yes |
| 2. Keep footage on the Mac | Agreed in principle; Sphe will say when to make the change |
| 3. Native player | Start with the measurement below once Sphe says go |

### nightly-59 holds

- `8a6a41c6` Smoothing looks past the scene finder's false cuts (about 25 slowed bodycam shots left unsmoothed on Predator Son & Dad).
- `8e47926e` A server that stopped without quitting is logged at the next start, with macOS's crash report (`last_run.ts`).
- `3978ca5c` Finding where an older smoother's render began decodes its source once, on the video hardware.
- `885821b0` A UI error records where in the page's built code it came from (`assets/<file>:<line>:<column>`).
- `43025670` A New project's script builds once its import is ready (16 of 16 first builds failed since Nov 3).
- `13131e24` A deleted script's preview is asked for once, not thousands of times.

JJ still has to press Build on "Off-Duty Cop Thinks Colleagues Will Take Her Side After Killing Neighbor" (`8a6e3eb5`).

## What we have today

- **Window:** Edit.app is a Tauri window (`crates/edit-window`) showing the page from Edit's own server on this Mac.
- **Page:** React, about 44k lines (`apps/web`).
- **Server:** Bun (`apps/server`).
- **Engine:** Rust. `crates/edit-render` is the wgpu compositor. The browser preview (compiled to WASM, drawn with WebGPU, `crates/edit-wasm`) and the export (`crates/edit-native`) both call `Renderer::render`.
- **Preview decoding:** happens in the page. Decoder workers (`apps/web/src/lib/decode.worker.ts`, mediabunny/WebCodecs) read through `range-source.ts`, and the server streams cloud footage through the shared block cache (`cloud_blocks.ts`).
- **Smooth playback:** a render of the whole edit played in a `<video>` (`playback_render.ts`). It's a workaround for live decoding stalling.
- **Script mode:** has its own player (`apps/web/src/writer/playback.ts`).
- **Review links:** an export saved in R2, played by an ordinary `<video>` (`Viewer.tsx`). The native player doesn't touch them.

### Why the native player wasn't built sooner

- **Oct 29:** Sphe approved it on two conditions: "will look identical in terms of ui to what we have and won't cause perf issues". It covers Edit's timeline and Script mode's preview. The pain points Sphe confirmed were stutter at times, lag when scrubbing, and a slow first frame. Measuring first showed R2 latency was the main cause (about 0.25 s per read). The block cache fixed most of it: 21 → 30 fps, a 4.8 s freeze down to 0.25 s, audio underruns 568 → 0. The player was then parked until someone measured inside Edit.app, and that never happened.
- **Oct 31:** smooth playback was built as another workaround.
- **Since then:** symptoms were patched one at a time ("Loading frame…", decoder hangs, CORS, stutter). The root fix is the native player.

## What JJ's logs say (Nov 3–6, `mathiass-macbook-pro`, nightly-58)

- **Drawing is cheap.** In 39 export chunks of 200 frames or more, compositing took 1.43 ms a frame at the median, 2.04 ms at p90 and 2.55 ms at p99. At 60 fps there are 16.7 ms per frame. Encoding is 68% of an export's time at the median, and decoding waits are 0.05 ms a frame. One playback export: 2,230 frames composited in 9.7 s, 6.0 s of that waiting on the encoder.
- **Decoding cloud footage is the bottleneck.** In about 2.5 days, the agent's contact sheets and strips (192 runs, 1,710 frames) spent 2,797 s (47 min) decoding pictures and 11.4 s compositing them.
  - A picture took 0.87 s at the median, 2.8 s at p90 and 21 s at most.
  - Single `render_frame` calls took 4.3 s at the median and 9.3 s at p90 (54 logged, 318 s in all).
- **Why decoding is slow:** JJ's current project ("Cops Realize Their Own Colleague Is The KILLER", `p1793808303783-46052`) has all its footage cloud-only. Every file says `light: skipped`: the light 720p preview (short keyframe intervals, cheap seeks) is never made for streamed media (`apps/server/src/media.ts`, `statusFromDisk` and the light step). So every picture is decoded from R2.
- **React freeze (#185):** all 20 since Nov 3 came within 5 s of an agent turn ending (52 turns in that span). The store selectors were checked and are fine. The watchdog logged store churn only once (`useEditor.media` 380×), so this is likely a React state loop in an effect, not a store selector. nightly-59 makes the log say where it happens.
- **Revision conflicts (12):** revisions start from a new base at each server start. The ones with unrelated numbers were the server restarting mid-turn, and one was the agent mistyping. No edits were lost.
- **Already fixed in earlier nightlies, seen in these logs:**
  - "sound … SIGKILL" (15): cancelled renders logged as failures, fixed `6ac4ce95`.
  - The Claude plan limit (91 failed calls on Nov 4, 23:00–23:50 Dubai): Edit now waits for the reset, `81c936ff`.
- **Network, not code:** `/api/cloud/preview` "connection was closed" (36 times), around JJ's DNS timeouts (03:12 Nov 6).

## Step 2: keep footage on the Mac (waiting for Sphe's go)

- **Today:**
  - Script footage is deleted from the Mac once the cloud has it and the script has been left alone for 30 minutes, however much room the disk has (`apps/server/src/writer/storage.ts`, Oct 29: "everything on the cloud!").
  - Edit's own footage sits in a capped cache (`apps/server/src/storage.ts`): a quarter of the room (free space plus the cache itself), between 0.4 and 50 GB, always leaving 1 GB free, with the least recently used footage evicted first.
- **Change:** drop the 30-minute rule, so script footage lives in the same capped cache. The cloud stays the real copy. Anything evicted downloads from R2 again when needed.
- **Disk use stays capped.** JJ's Mac has 54 GB free of 494 GB, which allows about 14 GB of footage. A fixed smaller cap (for example 10 GB) would be a one-line change if Sphe prefers it.
- **Also consider:**
  - Downloading a project's footage once while it's open, instead of block by block as it plays.
  - Making the light preview for cloud footage once it's local, so the agent's pictures decode in tens of milliseconds, not about a second.
- **Expected:** most of the agent's 47 minutes of picture decoding goes away, and playback starts at once on footage you've worked with.

## Step 3: native player

### Decision

Build our own native view inside Edit.app's window. No new UI framework. Everything else stays React. A browser, and the review page, keep today's player.

- **GPUI (Zed's UI framework):** fast, but it can't run in a browser. It needs Xcode's Metal compiler unless built with `runtime_shaders`. Not for Edit.
- **Rune** (github.com/anomalyco/rune, MIT): the strongest candidate if the whole UI ever goes native.
  - What it offers: native and web (an experimental WebGPU canvas), headless PNG output and element-tree dumps for agent checks, springs, AccessKit, and `NativeSurface`, which shows CoreVideo frames with no copy. It builds with the Command Line Tools alone.
  - Why not now: created Oct 22, pre-release, about 1,560 commits in two weeks, and the maintainers take no pull requests.
  - If adopted later: pin a revision, and fork only on the day something blocks the team. Don't recreate it.
- **Build tools:** our own view needs nothing new. This Mac has only the Command Line Tools, and wgpu compiles its shaders while the app runs.

### Sketch

- **The view:** a Metal-backed view (wgpu surface) in the Tauri window, sitting where the preview is.
  - Overlays: notes, handles and menus are HTML. Either the page stays on top with a transparent hole over the video (a transparent webview), or the native view goes on top and overlays move into it.
  - Prefer the transparent hole, so the UI stays identical and stays in React.
- **The page tells the window three things:** the preview's rect as it moves and resizes, the playhead, and play/pause/seek/rate. Tauri commands go one way and events the other. Add each to `capabilities/page.json`, which today allows only `start-dragging`.
- **The engine draws each frame:** it decodes with VideoToolbox from local files (or the block cache for cloud footage), composites with the same `Renderer::render`, and presents to the surface. Frames never leave the graphics chip.
- **Sound:** to decide. Either the native side plays it (CoreAudio, one clock for picture and sound) or the page's AudioContext stays the clock and the native side follows. Prefer one native clock: drift between two clocks is its own bug.
- **Coverage:** Edit's timeline viewer and Script mode's preview. Outside Edit.app (a browser), keep today's player.
- **If live compositing keeps up,** smooth-playback renders, their caches and the stale-render smoothing can go.

### First, measure (about an hour)

On a real busy project (Predator Son & Dad or "Cops Realize…"):

1. Time `Renderer::render` for single busy frames: several layers, subtitles, blur, B-roll. It needs to stay well under 16.7 ms.
2. Time seek-and-decode latency per source, locally and through the block cache. This decides how scrubbing feels.

The results decide whether live playback replaces smooth-playback renders, or whether renders stay for the heaviest parts.

### Expected (estimates until measured)

| | Today | Native, footage on the Mac | Native, footage still in R2 |
|---|---|---|---|
| Playback | about 30 fps, stutters at times | 60 fps | as today until blocks arrive |
| Scrubbing | about half the positions shown | nearly every position | download-bound |
| First frame | about 1.7–3 s | under 0.2 s | about 0.3–0.5 s per new file |
| Smooth edit playback | waits for a render (about 50 min the first time for a 26-min cloud edit from South Africa) | live, if compositing keeps up | live once the footage is local |

### Done means

- The UI looks identical (Sphe's condition), checked at 960–1600 px and in every state.
- It's measured against the current player in Edit.app: fps, first frame, scrub coverage, CPU and memory. It's no worse anywhere.
- Edit's timeline and Script mode both use it, and a browser falls back cleanly.
- It ships in a nightly only with Sphe's yes.

## Using the whole chip for exports (measured Nov 6)

### Where a full export's time goes

From JJ's 11 full exports, Nov 4–6, on an M4 Pro (12 cores, 24 GB), each taking 15–33 min:

| Stage | Time | What limits it |
|---|---|---|
| Footage ready (excerpts cut from cloud originals, 6 at once, stream copy) | 2.5–16.5 min | Network (R2 round trip about 0.2 s from Dubai) |
| Video | 4–16 min | The hardware encoder: about 75% of the video stage is waiting on it |
| Sound | 40–60 s | Fine |
| Join | about 13 s | Fine |

The proof that waiting at export can mostly go: re-exporting "Cops Realize…" with its chunks and excerpts already made took **2 min 47 s instead of 31 min 52 s**.

### The hardware encoder is already maxed

Measured on this Mac (M1, `scratchpad/encbench`), with 1080p H.264 at Edit's High bitrate:
- **The API makes no difference.** AVAssetWriter (Edit today), VideoToolbox driven directly, BGRA or NV12 input, and speed-over-quality all ran at about 200 fps. So did two or three sessions at once: Pro chips have one encode engine (M1 Pro through M4 Pro), while Max chips have two.
- **JJ's M4 Pro** works out to about 230 fps in his exports.
- **HEVC with speed-over-quality** reached 296 fps against 185, but that's a quality trade to trial, and it's not H.264.

### The CPU cores sit idle, and they can encode too

On real footage on this M1 (a 720p courtroom clip scaled to 1080p, so softer than bodycam):

| Encoder | Speed |
|---|---|
| Hardware | 188 fps |
| x264 "veryfast" | 268 fps |
| x264 "faster" | 214 fps |
| Hardware and x264 veryfast at once | **346 fps (1.8×)** |

- **Mixing works.** A hardware chunk and an x264 chunk (with `repeat-headers=1`), joined by the concat stream copy Edit already uses, decoded with no errors in FFmpeg (software and hardware) and in AVFoundation (all 900 frames, frame 700 matching the source).
- **Quality at the same requested 8.7 Mbps:** x264 measured SSIM 31.2 dB against the hardware's 25.7 dB, but it used more of the bitrate (8.3 Mbps against the hardware's 5.5).
- **Still to trial** on JJ's Mac with a real noisy bodycam project: noise slows x264 down, and an export's other CPU work competes with it.

### Levers, biggest first

1. **Have exports ready before Export is pressed.**
   - Cut a project's excerpts in the background while it's being edited, instead of when Export is pressed. That saves 2.5–16.5 min per export, and with footage kept on the Mac they're mostly there already.
   - Render final-quality chunks in the background while the Mac is idle, so Export only makes the few chunks that changed.
   - Costs: disk (about 65 MB a minute at 8.7 Mbps, so about 7 GB for a 112-min edit, inside the cache cap) and the encoder kept busy in the background.
2. **The native player** removes smooth-playback renders, which compete with exports for the one encoder.
3. **Hardware and CPU encoding together:** chunks given to both, about 1.5–1.8× on the video stage. Trial it first, with quality measured on bodycam footage.
4. **HEVC with speed-over-quality** for previews or proxies only, after a trial.

### Imports (JJ's Mac, Nov 3–6)

Mostly network:
- **Uploads:** 3,107 to the cloud, 17 h in all (in the background, several at once; p50 3.3 s, the longest 53 min).
- **Transcription:** 3.4 h (p90 94 s).
- **Proxies:** 1.5 h (p50 18 s). This is also encoder work, so it could use the CPU too.
- **YouTube downloads:** 1.5 h (p50 94 s, the longest 18 min).

Still to look into: upload bandwidth, and whether uploads hold up anything the person waits on.

## Open items

- **React #185 at turn end:** find it from nightly-59's logged location.
- **`TypeError: null is not an object (evaluating 'e.clips')`:** 4 times on Nov 5. Also needs the location.
- **`plugin:window|start_dragging not allowed by ACL`:** 4 times in 3 days. The capability allows `start-dragging` for `127.0.0.1:*` and `localhost:*`, so the page was probably on another address at the time. Check which.
- **Censor analysis "Input/output error"** opening its input: 8 times.
- **The agent's plans refused for media that "runs out at" a time:** 19 times. The agent may not be shown each media's length clearly enough.
- **VideoToolbox "A pixel buffer cannot be appended"** on `_Extraction_1_23-8814_BWC_Video_3-_Redacted.mp4`.
- **Speed:**
  - A watch waited 20 minutes on transcription (relay Scribe throughput).
  - Contact sheets of cloud footage take 1–3 s a picture (step 2 should fix this).
  - "Putting spilled words back" made 215 Opus calls ($4.22). Don't move it to a cheaper model without a trial.
