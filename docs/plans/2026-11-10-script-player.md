# Script mode on the editor's player (Nov 10, 2026)

Sphe, Nov 10: "it seems like the script mode and the edits mode are seen as distinct, completely separate options when we're making improvements to video playback. When one is improved, the other should be improved as well… within the edits app, in the script writing section, we should have the same improvements." To be discussed with Sphe after nightly-70 is out, then built. Nothing here is started.

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

## Open questions for the discussion

- Hold a nightly for this, or ship it as it lands (the browser's Script player stays as it is either way)?
- 2× only, or other speeds while the rate is being built?
- Does the browser (Marc's tabs) need Script mode faster too, or is Edit.app where the team writes?
- Long script proxies on a small disk (Sphe's M1 has 5 GB free): fetch only around the playhead, or the whole file when there's room?

## Size

About a day: steps 1–3 are mostly page and server code over what exists; step 4 is engine work and the uncertain part.
