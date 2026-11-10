# Script mode on the editor's player (Nov 10, 2026)

Sphe, Nov 10: "it seems like the script mode and the edits mode are seen as distinct, completely separate options when we're making improvements to video playback. When one is improved, the other should be improved as well… within the edits app, in the script writing section, we should have the same improvements." Sphe, later that day: "let's build things out." Built Nov 10 (see "Where it stands"); how it works now is in docs/preview.md, "Script mode plays on the same player".

## Why it keeps happening

Two players live in the page, in two files, sharing only the decoder underneath:

| | Edit mode | Script mode |
|---|---|---|
| The player | `apps/web/src/lib/playback.ts` (`Preview`) | `apps/web/src/writer/playback.ts` (`ScriptPlayer`) |
| In Edit.app | the window's own player (`crates/edit-engine/src/player.rs`, `crates/edit-window/src/preview.rs`, `lib/nativePreview.ts`): the Mac's decoder, the speaker's clock, cuts warmed ahead | the page: WebCodecs workers (`lib/decoder.ts`), a 2D canvas, the page's AudioContext clock |
| Footage read from | whole copies on the Mac (`native_preview.ts`, `local_previews.ts`) | the server's stream of the script's proxy (`/api/writer/scripts/{id}/proxy`), in ranges |
| Measured Nov 10 | plays every frame, jumps ~40 ms, a drag ~24 pictures a second (docs/plans/2026-11-08-audit.md, "Playback, checked before nightly-70") | not measured |

Every stage of the Nov 6–9 player work (pooled decoders, the speaker's clock, decode-ahead, whole local copies, patches) went into the left column only. So did the Nov 8 audit: its finding 5 names Script mode as a place the new player doesn't reach, and nothing was built for it.

## What Script mode's player does (what the new one must keep)

From `writer/playback.ts`'s `Player` and its callers (`editor.tsx`, `monitor.tsx`, `transcript.tsx`, `commentary-view.tsx`, `hover-preview.tsx`):

- Plays **the cut**: a list of items, each a stretch `[startMs, endMs)` of a recording, in order; a cut-in is a card with no picture (the monitor draws its words). A commentary's items each name their own recording (`Item.src`); otherwise all play from the script's one proxy (`setSource(url, durationMs)`).
- `seek(ms)` on the edited clock, `play(from?)`, `pause`, `toggle`.
- `cue(sourceMs)`: jump to a moment of the footage (a word clicked in the transcript); `audition(sourceMs)`: play the footage straight through from there, outside the cut (a word double-clicked, a found moment).
- `setRate(rate)`: 1× or 2× (`monitor.tsx`'s button), the sound with it.
- `setVolume`, `frameRatio` (the captions' frame), `framed`, `buffering`, `error`, `current` (the item showing).
- Reports the playhead every frame as `ms` (edited) and `sourceMs` (the footage's own clock, for the transcript's live word).
- Proxies are conformed to 30 fps when made (`writer/media.ts`).
- `hover-preview.tsx` is a separate small `<video>` over a commentary's mention; not this player.

## The plan

One player for both: Script mode hands its cut to the same window player the editor uses, so the next improvement to it is one change.

1. **The cut as an edit.** A pure function (shared, tested) turns a script's items into the small project the player takes: one video track and one sound track, a clip per footage item (`source_in` in seconds, `start`/`duration` in frames at 30), nothing where a card is. The audition is the same thing with one clip, the whole recording. Edited ms ↔ frames is exact at 30 fps.
2. **A `Player` for Edit.app.** `newPlayer` answers one that drives `nativePreview` (`open`, `place` under the monitor, `project`, `frame` at rest, `play`/`pause`/`position` on the speaker's clock, `hint` on hover) when `nativeAvailable()`, and today's `ScriptPlayer` otherwise (browsers, Linux), behind the same interface, so no caller changes. The window has one player: the script page and the editor are never on screen together, and each opens it as it mounts.
3. **Script footage on the Mac.** A script's sources for the window (`GET /api/writer/scripts/{id}/native-sources`, as the project's): the proxy file where it's here, else its whole copy fetched behind the stream (`local_previews.fetchWhole`), a pieced proxy's pieces as files (`native_preview.pieceExcerpts`). Script proxies are long (the School Teacher script's is 3.8 GB): what comes down first is the piece under the playhead, and the cleaner's budget has to count them (cache_cleanup.ts).
4. **Speed.** The window's player has no rate (`preview_play(frame)` only), and Script mode's 2× is used all day. Needed in `player.rs`: the speaker's clock run at a rate, the mix resampled or time-stretched (the export's atempo is FFmpeg's; the live mixer has none). Once there, Edit mode can have it too.
5. **Measure both, the same way.** The harness from Nov 10 (step files through `EDIT_PREVIEW_JS`, the window's trace) on a real script: a play across 30 cuts, 40 jumps, a drag, a cold open, a word clicked in the transcript to its picture. Same marks as the editor's.
6. **Keep them together after.** Acceptance (`scripts/acceptance.ts`) opens a script as well as an edit; and `--native` has to work first (today the window shows "Sign in to Edit", so it has never drawn a frame).

## Where it stands (Nov 10)

- **1, the cut as an edit:** `app/packages/edit-types/src/script_cut.ts` (`cutProject`, `auditionProject`), checked against the engine's own rules in `apps/server/test/script_cut.test.ts`. Item boundaries are in milliseconds (word times), so "exact at 30 fps" became: each boundary on the nearest frame of the edited clock, never drifting. Black runs under the whole cut, so one that ends on a card plays to the card's end.
- **2, a `Player` for Edit.app:** `apps/web/src/writer/window-player.ts`, chosen by `writer/player.ts` (the window's when every recording is a file here, else the page's; the cut moves between them where it rests). The window's layer goes under the monitor's screen. No patches: a cut is small, so it goes whole when it changes.
- **3, script footage on the Mac:** `POST /api/writer/window-sources` (`apps/server/src/writer/window_sources.ts`). The preview file where it's here; one only in the cloud comes down whole when the scripts' budget has room, and plays on the page's player until then. Not built: the piece under the playhead first. A streamed preview stays on the page's player, which reads it in blocks; the window would open it through FFmpeg at every jump.
- **4, speed and volume:** `preview_rate` / `preview_volume` in the window's player, built on the Mac (the engine only compiles there).
- **5, measured:** Nov 10 on Sphe's M1, below, with what the check found and fixed.
- **6, kept together:** acceptance opens a script in headless Chrome (first picture, a play across a cut, a drag, a source moment, no error), which is the page's player. The window's (`--native`) still can't sign in, so it isn't run for either mode.

## Measured (step 5, Nov 10, Sphe's M1)

A real script in a home of its own, reaching no cloud: Cops Realize's 230 clips (191 of footage, 39 cut-ins, 61 minutes of cut) and its words, re-timed onto the 103 minutes of its footage that were on the Mac, joined into one preview the way Script mode makes them (854×480, 30 fps, a key frame a second). The window's player in a dev build of Edit.app's window, the page's in headless Chrome, the same step file through both (`EDIT_PREVIEW_JS`, with `--- shot <file.png>` for the window's own picture). Other sessions were building and running windows on the Mac through most of it; the numbers are from the quiet stretches, and say where they aren't.

| | The window's player | The page's player (Chrome) |
|---|---|---|
| Cold open to the first picture | 1.0–1.5 s after the page began (four opens; 2.1–2.5 s on three earlier ones) | 2.6 s and 6.4 s (two opens) |
| A play across 30 cuts at 1× (271 s) | 1.000 s of the cut a second. A replay of its first 100 s alone: 2,999 of 2,999 frames, none slow, none missed, the speaker never short. The full run, with other windows playing on the Mac: 28.7 pictures a second, 22 slow, 365 missed in one 80 s stretch, the speaker never short | 0.999 s of the cut a second; 28.3 pictures a second in all (the cards draw none); 5 frames passed undrawn; one gap over 100 ms |
| The same at 2× (136 s) | 2.000 s of the cut a second; 30.0 pictures a second (every other frame, by design); none slow, 1 missed, the speaker never short, no seek | 1.999 s of the cut a second; 51 pictures a second; 744 frames passed undrawn; three gaps over 100 ms |
| 40 jumps | all drawn; p50 33 ms, p95 39, worst 39 | all drawn; p50 54 ms, p95 89, worst 92 |
| A drag (240 positions in 8 s) | 240 pictures, 30 a second, the longest gap 56 ms | 59 pictures, 7.4 a second |
| A word clicked in the transcript to its picture (six) | 27–35 ms | 50–95 ms |

Before the fix to when the playhead settles (below), the window's drag was 47 pictures, 5.4 a second, and its jumps p95 102 ms, worst 223. Nobody listened to either player, and the page's sound wasn't measured (it has no count of its own).

Found and fixed:

- **In development the window lost the script at once** ("the preview isn't open", then a page player that never drew): React's StrictMode makes the player twice and unmounts the kept one once, and the one never shown had opened the window's preview. The player asks for nothing until its canvas is there, and lives again when used after a dispose.
- **A view changed or the split dragged left the picture stretched for a second or two**: every size was a new decoder (opened and seeked), and the old picture was scaled to the new shape meanwhile. Sizes are in eighths of the edit's now, the layer keeps a stale picture's shape, and a resize at rest draws at once.
- **The Script view decoded and drew every frame for a monitor nobody sees.** Nothing is, now.
- **A cut played to its end never ended** (the editor's player too): the clock stopped a speaker's latency short of the last frame, playing for good.
- **Start the edit (and Open the edit) landed on Home**, since Oct 30: Script mode, still there while it fades out, took the edit's address for its own list.
- **The editor opened after a script showed black until Play**, from this change's own out-of-sight rule, caught and fixed the same day: the playhead's frame is drawn when its layer comes into sight.
- **A drag armed the sound at every frame it passed** (the editor's too): a mixer started and stopped thirty times a second. The playhead settles once it has rested a quarter second.
- **A preview moved from under an open script played on in silence**, the picture still right (the file was open), nothing said. The window says the sound won't open, and the page's player takes the cut: it says why it can't (the file's gone) and plays again once it's back.

Not fixed, to know about: pausing a source audition and pressing Space again goes on from where it paused on the window's player, and starts again from the word on the page's; in the window, switching to the Script view while playing held the page's playhead for about 1.5 s twice (seen with the Mac at load 40, not measured quiet; the sound and the clock went on); with the preview gone, the window still draws at rest (its file is open) and hands over only once a play finds the sound won't open.

## What was decided for the open questions

- Shipped as it lands, behind nothing: the page's player is still there for everything the window can't play.
- Any speed from 0.25× to 4× in the engine; the monitor's button stays 1× / 2×.
- The browser keeps the page's player as it is.
- A long preview comes down whole only when there's room for it; on a small disk it stays in the cloud and plays as before.

## Open questions for the discussion (as asked before it was built)

- Hold a nightly for this, or ship it as it lands (the browser's Script player stays as it is either way)?
- 2× only, or other speeds while the rate is being built?
- Does the browser (Marc's tabs) need Script mode faster too, or is Edit.app where the team writes?
- Long script proxies on a small disk (Sphe's M1 has 5 GB free): fetch only around the playhead, or the whole file when there's room?

## Size

About a day: steps 1–3 are mostly page and server code over what exists; step 4 is engine work and the uncertain part.
