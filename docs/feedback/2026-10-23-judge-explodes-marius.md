# Judge EXPLODES: Marius's review (Oct 23)

The video: Judge EXPLODES On Father Who STARVED 7 Year Old Son (courtroom), shared for review on feedback.spheceo.com Oct 22. Marius left 12 notes, all in the first 1:31, and told the user he wouldn't mark everything: "this does occur later on in the video as well, so we do need to fix those things".

Edit's auto-fix had already answered each note ("done in V2": changed in the project, not yet exported), but only where he'd marked it. The same problems were still there across the rest of the video: the 22-second whoosh under nine more cut-ins, and 26 logo blurs left over after their shot ended.

## Patterns

### 1. Loud sound effects for no reason
- **The notes:** "Really loud sound effect for no reason" (0:20), "Again sound effect for no reason" (0:27).
- **Cause:** the library's "Swooshes, Whoosh, Dark, Big, Rustles" is 22 s of many whooshes in one file. With no `seconds` given, `add_from_library` placed the whole file. Its loudness was then measured over all 22 s, mostly silence, so the agent turned it up to +3 dB. It played under the teasers and on both sides of every narration bridge.
- **Code:** a long one-moment effect (a whoosh, hit, boom or stinger longer than 4 s) now plays only its hit unless told otherwise: 1.8 s, with the hit two thirds of the way in, then a fade (`media_tools.addFromLibrary`, `sfx.LONG_MOMENT` / `HIT_PLAY`). It's measured over that stretch too.
- **Audit:** `sfx_long` names any such effect running past 4 s. It's fixable, so the follow-up asks about it.
- **Teaching:** in `music-and-sound`: every sound has a reason on screen, and a whoosh or hit is one hit, never a file left running.

### 2. Logo blurs that stay on screen
- **The notes:** "Blur stays on the screen for no reason… I recommend for the bot to do something, where the blur is sticky on the logo, no matter if you zoom in specific places or switch frame to something else. Just like in after effects where you can make it sticky. This is a problem throughout the vid" (0:42), plus five more, and "everytime there's a transition in footage it happens" (0:56).
- **Cause:** the agent's logo blurs were rectangles fixed on the screen, each laid over a run of shots. They didn't follow a shot's push-in (so they were drawn huge, 690 × 680, to cover the logo as it moved), and they ran past the shot into the next one and through every dissolve.
- **Code: `blur_marks`**, a new plan op (`mark_blurs.ts`). For every mark Edit has found on the footage and photos (watermarks.ts), it builds one blur per shot:
  - it starts and ends with the shot;
  - its box is keyframed from the shot's own framing, so it follows the push-in;
  - it fades as the shot's picture does through a dissolve, at three times the pace, since at the picture's pace "COURTROOM WATCH" was still readable mid-dissolve;
  - it's gone wherever a full-frame picture covers the shot.

  It replaces the still rectangles over the same marks. Two more details:
  - a slowed shot's smoothed copy uses its source's marks (Judge's B-roll was 60 copies of one hearing, and one copy's own look missed the logo);
  - `leave` marks something as not another outlet's, such as Trooper's "D54A Court Room 3" room tag. It's a "not a mark" media marker that later runs and the audit respect.
- **Audit:** `blur_off_shot` names a still rectangle that runs across a cut or sits over a moving shot. One such flag is enough for a follow-up.
- **Teaching:** in `cut-ins` and the courtroom notes: one `blur_marks` after the pictures are laid, never a logo blur of your own.

### 3. Clicks under the typing
- **The notes:** "Click sound effect that doesn't match, should've been a typewriter sound effect. Also too loud and mistimed" (1:09), and "Click sound effect again for no reason" (1:10, 1:13).
- **Cause:** the skills ask for a typewriter under each Notepad line, but the team's library had none. The agent used a multi-click mouse file at +3.5 dB, 0.3–0.7 s off its lines. The auto-fix then swapped it for a phone's touchscreen tapping.
- **Library:** a typewriter and a soft keyboard sound were added to Sound effects / Clicks and on-screen graphics, with their sources in the index.
  - The user then picked the typewriter: https://youtu.be/PqCfH6dv948, trimmed to 3.6 s from its first keystroke.
  - The keyboard sound is from https://youtu.be/us_ccZ8PK30.
- **Code:** a typing sound plays exactly while its line types (the user: "starts exactly when the animation starts and ends exactly when the animation stops"; `typing_sounds.ts`).
  - A line's letters come one every `stagger` frames, and spaces aren't typed, so Edit knows each line's first and last letter.
  - A typing sound placed or planned near a line is cut to exactly that span, from the sound's own start. Before, `placeSound` lined up the sound's loudest key, which put it 3 s before its line.
- **Audit:** `typing_sound_off` names a typing sound that's off its line or under none.
- **Teaching:** typing gets the typewriter, placed on the line's "desktop line" marker, or nothing; never mouse clicks or phone taps.

### 4. A loud, weird boom on the cliffhangers
- **The note:** "Too loud sound effect and sounds like a weird one" (1:31).
- **Cause:** a "Boom, Impact, Thud, Deep Hit, Heavy, Reverb" on both cliffhanger titles and on the sentencing card.
  - Asked for "a soft deep thud", round 1 picked the same file again, because its name says thud and deep hit.
  - Judge's own fix pass also kept it, only turned down.
- **Teaching:** a cliffhanger or reveal gets the library's "Stinger, Soft Hit, Short", about 6 LU under the speech, never the Heavy Reverb boom (both named).
- **Audit:** `sfx_loud`: a whoosh, hit or typing within 2 LU of the narration. Judge's fix pass had left nine stingers 1.7 LU over it.

### 5. Every note is a pattern
- **The note:** Marius, through the user: he isn't going to mark everything.
- **Teaching:** the `feedback` skill: for each note, find its cause and fix it everywhere it is, then say how many places.
- **Applied:**
  - Judge's agent removed the nine leftover whooshes and laid 114 sticky blurs.
  - Trooper's agent, given Marius's Judge notes, found all four problems there and fixed them.

### Found on the way
- **Smoothing crashed the server.** VideoToolbox's frame processor threw an Objective-C exception, which `util::catch` can't stop, and the dev server aborted twice. It's now an error, and FFmpeg smooths the shot instead (`mac_media.m`, 8bf10a9).
- **Sharing a fix replaces the version.** A share can replace the latest version's files instead of adding one, so a small fix after sharing stays V2 (the user asked for that). The route is `POST /api/projects/{id}/review/share {path, replace: true}`.

## The teaching loop
Loop 4 (`~/edit-experiments/loop4/`; the key is private) ran fresh edits:
- **Training:** Judge, from its snapshot just before the agent's first edit (Oct 22, 22:47).
- **Holdout:** Trooper, from its pre-edit snapshot with the voice-over generated. It was never taught from.
- **Interrogation control:** Helpful Wife, from loop 3's base.

Every trial was "Start the editing workflow." alone; the agent never saw the notes.

| trial | min | M1 one hit (longest) | M2 sticky blurs / still / flagged | M3 typing | M4 cliffhanger hit |
|---|---|---|---|---|---|
| judge R1 | 16.9 | ok (2.0 s) | 114 / 0 / 0 | no taps (library had no typewriter yet) | ✗ Heavy Reverb boom ×3 |
| judge R2 | 15.7 | ok (2.4 s) | 108 / 0 / 0, but one Windows photo's logo shown (an audit bug, fixed) | typewriter ×4 | ok, soft stinger |
| judge R3 | 17.2 | ok (2.4 s) | 111 / 0 / 0 | typewriter ×4 | ok |
| **trooper (holdout)** | **14.1** | ok (2.4 s) | 130 / 0 / 0, a logo on a still cropped off | typewriter ×3 | ok |
| hw (control) | 24.4 | – | – | – | – |

**Helpful Wife held**, at the same 24.4 minutes as loop 3's last round:
- every pop-up clicked (75 of 75);
- every teaser punched in;
- no centred text, no cut mid-word;
- text early on 22 of 29 lines, 3 late.

Its new `blur_off_shot` flags were false (the film look's soft edges, and a `blur_marks` blur on a still), which is fixed in 090b5d8.

Its first control run was invalid. Its voice-over files had been deleted with media folders that looked unused: a copied project points into another project's folder. They were restored from R2, and the run was repeated.

**What the measures can't say:** nothing was listened to. Whether the typewriter and stingers sound right, and whether the blurs look clean frame by frame through every dissolve, needs the team's eyes and ears. Frames checked by hand looked right; the second frame of a dissolve can show a faint ghost of the logo.

## Applied to the two videos
- **Judge:** its agent laid 114 sticky blurs and removed the nine leftover 22 s whooshes, with one short whoosh on each flash. The soft stinger went on the cliffhangers and the sentencing card, set to −28.9 LUFS, 6 LU under the narration. The typewriter is under its three Notepad lines.
- **Trooper:** its agent, given Marius's Judge notes, found all four problems:
  - 201 sticky blurs, and the court's own room tag left clear;
  - the SUBSCRIBE blur fixed;
  - the phone taps removed and the typewriter added on four lines;
  - the reverb boom replaced by the stinger.
- **Shared:** both as V2 on the same links, and replaced in place after the stinger and typewriter fixes.

## Open
- **Whether to ship:** these commits aren't pushed; a nightly is the user's call.
- **The logo's blue square:** blurring the "COURTROOM WATCH" logo leaves its blue box visible as a soft blue patch. A stronger look (a solid patch, or a crop) would be the team's call.
