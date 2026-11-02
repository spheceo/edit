# Diffusion Studio's ideas in Edit (Nov 2–3)

Sphe's list of what to take from Diffusion Studio's agent video editor
(github.com/diffusionstudio/editor, MPL-2.0; read, never run), in order of
value. What shipped is in the commits; this note holds the measurements and
what's still a decision.

## Shipped

| # | What | Commit |
|---|------|--------|
| 3 | The look fits the question; the check fits the change; never export to see your work; a worked walkthrough per story style | d9521f07, 8b3d92d4 |
| 4 | Background work says how long it has left; `wait` once instead of polling | f1a61f23 |
| 5 | `listen`: what's heard over a stretch (loudness strip, loud and silent stretches, who says what) | 4752aed8 |
| 7 | `report_problem`: the agent files a bug with this Mac's diagnostics | 7a146f34 |
| 6 | The Inspector moves, sizes and times a whole house graphic | c654b22c |

## 1. Sheets sized for the model's eyes (code done; waits for an addon build)

Claude reads a picture in 28 × 28 px patches, one token each
(`⌈w/28⌉ × ⌈h/28⌉`), up to 2,576 px and 4,784 tokens on Opus 4.7 and later
(1,568 on older models; platform.claude.com vision docs). `sheet.rs` lays every
agent sheet on that grid (each cell's slot whole patches, so no token pays for
a sliver), labels each cell with its number and time, puts a ruler over each
row of a sheet in time (its span and a tick per cell), and sizes it to a
budget: 160 tokens and 140 a frame, at most 1,300 (`detail: "fine"` twice
that). A flat 1,300 made a two-frame review 49 % dearer than before (few
frames blown up), so the budget follows the count.

Tokens per look, before (the sheets the agent actually got, from its Claude
Code transcripts to Nov 2) and after (the new plan for the same requests),
over 3,008 sheets:

| Tool | Looks | Before | After | Change |
|---|---|---|---|---|
| look_at_media | 1,319 | 1,337 | 991 | −26 % |
| apply_edit_plan review frames | 875 | 825 | 857 | +4 % |
| look_at_found | 364 | 3,327 | 1,078 | −68 % |
| contact_sheet | 309 | 947 | 1,131 | +19 % (the ruler; cells kept at 360 px) |
| review_edit | 128 | 1,253 | 1,123 | −10 % |
| check_shots | 13 | 2,064 | 1,179 | −43 % |
| all | 3,008 | 1,388 | 983 | −29 % |

Planned within Claude Code's own edge: it sends a picture wider than 2,000 px
shrunk to 2,000 (a 2,184 px sheet reached the model at 1,999), so sheets stop
at 1,988 px (27eaccd3); with that the same 3,010 requests cost 960 tokens a
look against 1,388 (−31 %).

ON A RUN (Nov 3, 01:03, R2 on the dev server, one read-only turn of the
in-app agent, Claude Code, Opus 5.5): a 12-frame contact_sheet of 0–120 s and
a look_at_media cost ~1,080 tokens each in its own usage (two looks and the
export's text moved its input from 82,205 to 85,417 tokens). Its answers held
against the same stretch described from single 960 px frames in an earlier
turn: the close shot of Lola at ~45 s, the grey room with the countdown at
~65–70 s, the raw wide room at ~100 s, the burned-in captions read word for
word ("s****** her with my pocket knife."); what it lost is the fine print a
whole frame gives ("a small timer in the corner", where the single frame read
"INTERROGATION STARTS IN 00:12"): what `detail: "fine"` is for.

Item 4 on the same turn: the 30 s export (frames 0–900) said how long it had
left, the agent called `wait` once (waited ~40 s, done) and read nothing
again: 0 repeated reads, against up to 9 in a turn before.

One thing it showed: R2's chat had loaded look_at_media's schema before `pick`
existed, and a resumed Claude Code conversation keeps the schema it already
has, so it said "look_at_media has no pick option" and didn't try it. A new
argument on a tool a chat has already used reaches that chat when it starts
afresh (a reset, or its compaction near 150k tokens); new tools (`wait`) are
seen at once. Open: whether Edit should say new arguments in the turn's
context, or start the agent's session afresh on a new build.

## 2. Frames that follow the footage (code done; waits for the same build)

`frame_picks.ts`: the stretch at 2 frames a second in the camera angles' small
grey frames (64 × 36, brightness taken out); a new state wherever the picture
is 0.16 unlike where the current one began (seats.rs's cut); the stillest
frame of each state kept (transitions waited out), states under a second
skipped, past the cap the least distinct dropped. `look_at_media pick: "auto"`.

On real footage (scenes: stretches of 1 s or more between frame-to-frame jumps
over 0.16):

| Stretch | Scenes | Auto, cap 24 | Auto, cap 12 | Even, 12 | Reading the frames |
|---|---|---|---|---|---|
| Welfare bodycam 300–420 s | 22 | 24 frames, 2 missed | 11 missed | 17 missed | 15.1 s |
| Welfare bodycam 800–920 s | 20 | 24, 1 missed | 8 missed | 16 missed | 8.5 s |
| Welfare bodycam 1200–1320 s | 25 | 24, 1 missed | 13 missed | 22 missed | 7.5 s |
| Lola's interview room 600–720 s | 1 | 1 frame | 1 | 12 frames | 11.5 s |
| Lola's interview room 1100–1220 s | 1 | 1 frame | 1 | 12 frames | 9.1 s |

Picking takes under 0.2 s; the frames are read from the cloud preview on a
Mac under load 10–40, so the reading times are high.

## 5b. A model that hears: Apple's sound classifier (decision for Sphe)

`listen` answers from loudness and the transcript; it can't say what's
playing. The watcher hasn't heard since Oct 30 (Gemini dropped: "I just wanna
get rid of gemini"), and no model Edit calls takes sound. Apple's on-device
classifier (SoundAnalysis, `SNClassifySoundRequest`, ~300 labels: speech,
shout, music, siren, gunshot, applause, crowd, dog…) is free and runs on the
Mac. Probe: `~/edit-experiments/sound-analysis/probe.m` (one file, clang, no
engine) over 10 minutes of a real interrogation's sound.

Measured Nov 3, 00:20, on this 8 GB M1 under load 10–15 (two other threads
running), 1.5 s windows overlapping by half, one process, 52 MB resident:

| Footage (10 min of sound) | Classify | Cut the sound | What it heard (labels over 0.6) |
|---|---|---|---|
| Lola's interview room (16-Year-Old, m7 540–1140 s) | 13.0 s (46× real time) | 2.8 s | speech 578 of 600 s, its gaps where the room is quiet; a pen writing (31 s); sighs, a gasp, whispering; a few wrong ones (burp, hiccup at 1.00) |
| Welfare Check bodycam (m6 0–600 s) | 11.2 s (54×) | 1.2 s | speech 313 s; a phone ringing 52–94 s; keys; a knock and a door at 137 s; an emergency vehicle at 193 s; screaming at 228 s; a shout at 293 s; laughter; a baby crying; a steady beep 360–469 s (a redaction tone or an alarm: not yet checked against the picture) |

At 0.3 it lists twice as many labels, most of them noise; 0.6 keeps what an
editor would want to know. Single windows of odd labels (cow_moo, burp) are
its mistakes: a label held for one window only should be dropped unless it's
one of the ones that matter alone (gunshot, scream, shout, glass breaking,
siren).

DESIGN, if Sphe says yes: `sound-v1.json` beside `loudness-v1.bin` in the
media's cache dir: for each label from a short list that matters to an edit
(speech, shout, screaming, crying, music, singing, siren and emergency vehicle,
gunshot, glass breaking, door and knock, dog, crowd and applause, laughter,
phone, beep), its runs (from, to, best confidence), merged as the probe does.
Made at import on the same decode that makes the loudness analysis (loudness.rs
already reads the whole sound once; the classifier takes the same PCM through
`SNAudioStreamAnalyzer`, so no second decode): ~1 s per minute of sound on this
Mac, nothing sent anywhere, nothing paid. Native code beside mac_media.m (a
new `sound_classes.m` and its build line), a napi call, and `listen` reading
it: "HEARD: shouting 228.0–229.5 s, a siren 192.8–195.0 s, music none". The
watcher's windows could take the same labels as text, so it hears again
without Gemini. Cost: a day's work, one Rust/ObjC build; the decision is
Sphe's because it's new native code in the import path.

## 8. SAM 2.1 tracking for blurs (feasibility)

Diffusion runs SAM 2.1 in the browser on WebGPU through onnxruntime-web, from
its own fp16 ONNX export on Hugging Face (`diffusionstudio/sam2.1-*-video-onnx-fp16`):
Tiny is 512 px and 83 MB in five graphs (vision encoder 58 MB, memory
attention 13 MB, mask decoder 9 MB, memory encoder 3 MB, pointer positions),
Small 1024 px and ~110 MB. A tracked frame runs all five (tracker.ts `track`);
a click runs the decoder alone on a held frame. Probe:
`~/edit-experiments/sam2-probe/probe.py` (onnxruntime 1.31, CPU and Core ML;
the weights from the commit Diffusion pins, sizes matching its constants).

Measured Nov 3, 01:00, on this 8 GB M1 under load 12–26 (other threads
exporting), niced, 4 threads, a real 1080p bodycam frame:

| | Seed (a click: encoder, decoder, memory) | A tracked frame | Of which: encoder / memory attention / decoder / memory encoder |
|---|---|---|---|
| Core ML | 1.4–2.4 s | 2.1–3.0 s (0.3–0.5 fps) | 1.1–1.6 s / 0.8–1.2 s / 0.06–0.09 s / 0.1–0.15 s |
| CPU | 3.5–4.9 s | 3.0–4.0 s (0.25–0.3 fps) | 1.5–2.2 s / 1.2–1.5 s / 0.12 s / 0.14–0.19 s |

Memory: 0.8 GB resident, 1.3 GB at peak, both sessions loaded. Core ML takes
only part of the memory attention graph (its zero-length slices fall back to
the CPU). On a quiet Mac, perhaps twice as fast; Diffusion's own path
(onnxruntime-web on WebGPU, Metal underneath, in a browser) is untried here.

What it means for blurs: a 10 s shot at 30 fps is 300 frames, ~10–15 min of
tracking at these speeds; every 6th frame (5 a second, the mask's box
interpolated between) is ~2 min. Edit's template tracking (`track_region`,
`blur_marks`) does the same shot in seconds. SAM's gain is a mask that
follows a face or a plate through turns and occlusion, where the template
loses it, from one click; its cost is minutes a shot on this Mac and 1.3 GB.

Recommendation: not as the default tracker on 8 GB Macs. Worth it as a
fallback, run in the background like smoothing (progress.ts would say how long),
for the shots where template tracking reports it lost the face (track.rs's
confidence), at 5 samples a second with the box interpolated. Next step if
Sphe wants it: the same probe through onnxruntime-web in Edit's headless
Chrome (WebGPU), since the browser path may be several times faster on the
M1's GPU; then a `track_region` option `follow: "mask"`.

## 9. HTML as a graphic clip (design only)

What it would be: a graphic written as a web page (HTML, CSS, an animation
timeline) that Edit renders to frames and places like footage, for what the
house graphics can't draw (a chart building up, a phone's messages scrolling,
a document with lines highlighting). Diffusion composes everything this way;
Edit already does it once, for maps.

How, on what's there: map_view's page is exactly this pipeline. broll.ts opens
a page in headless Chrome (`renderMap`: its own profile, the page served by
Edit at `/api/maps/<token>`), the page posts each frame back
(`POST /api/maps/<token>/frame/<n>`, written whole by rename), a stall is
noticed by the frames stopping (`mapStallMs`), the frames become an MP4
(`framesVideo`), a stand-in holds the clip's place until it's done
(`swapInMap`, the same media id), jobs.json carries it across a restart, and
exports wait for it (`waitForMaps`). An HTML graphic needs the same with two
changes:

1. Deterministic time instead of real time. The page exports
   `window.edit = { duration, fps, seek(t) }`; Edit calls `seek(frame / fps)`
   and screenshots (`Page.captureScreenshot` over the DevTools protocol, which
   map_view's page doesn't need because it draws to a canvas it reads back
   itself). CSS animations are driven by `document.getAnimations()`'s
   `currentTime`, GSAP and Web Animations timelines the same way, so a page
   written for the browser renders frame-exact.
2. Transparency. A graphic sits over the picture: frames as PNG with alpha
   (`Emulation.setDefaultBackgroundColorOverride` to transparent), made into
   ProRes 4444 or HEVC with alpha, which the engine's decoder (mac_media,
   VideoToolbox) would need to read as BGRA with its alpha kept: the one
   engine change, checked first on a 2 s clip.

The tool: `html_graphic {html, duration, size?}` (or `make("html", …)` in
e-code), its page kept beside its frames as a job file so it can be rendered
again and edited (its source in the clip's media, so the agent and JJ can
change a word and re-render). The audit treats it as any graphic (text_late,
graphics_short). Cost, roughly: a minute of Chrome per 10 s of 30 fps
graphic on this Mac (map_view's 1.2–1.9 s a frame was the tiles; a local page
is faster), cached by the page's hash.

Not tonight: it needs the engine's alpha path and a design pass with the team
on which graphics are worth it; everything above it on the list came first.
