# Feedback, Oct 29–31: 16-Year-Old, Bookkeeper, She Left Him, Predator Masseur, and the user's list

Sources: every note on feedback.spheceo.com (266 reviewer notes over 24 edit reviews, read through
`reviewPage:list`/`reviewPage:page`), the user's list of Oct 31, and their screenshot of a Windows screen
in Predator Masseur. The 16-Year-Old's v2–v4 were made by this Mac's dev server (the fixing computer), so
what they show is current code, not an old build.

## The user's list, Oct 31

> windows zoom background issue · syncing of audio needs to be fixed!!! · voiceover starts before the cut in
> starts · real sound footage starts before the cut ins · mismatch between the subtitles · agent mistakenly
> adds a small frame where its almost a glitch maybe half a second of something · the agent sometimes makes
> mistakes with notepad and where the text flies out when we zoom in or out or move around … ideally we
> should have the fileviewers be in the roughly same position and not animate together in · would be great if
> it was possible to play the video within the software, currently super laggy! we have too many loading
> frame issues and this has been the biggest issue we've faced!!!

## Patterns

### 1. Narration over the footage's own voice at a cut-in's ends
- 16-Year-Old v1 9:53 "the voiceover starts before the real sound audio is finished… doesn't overlap at
  either end", 12:40, 13:00 "We start the real sound audio too early", 15:01; Bookkeeper v1 10:48, 11:10,
  37:50 "VO starts here where we are still inside the footage - critical mistake throughout"; She Left Him
  9:07 "we start the voiceover before we have actually had our visual transition".
- Cause: the script's ranges were cut 0.08 s after their last word (`script.WORD_PAD`) and the narration
  started on the next frame; transcript times end words a little early, so the tail of a voice ran under
  the narration. `voiceover_in_footage` (Oct 30) compared clip edges only: the Bookkeeper after its fix had
  no flags while six cut-ins started under 0.3 s after a word, two inside it.
- Code: `script.CUT_IN_PAD`: a range beside a cut-in gets 0.4 s of its own sound before its first word or
  after its last (never into the next word); between ranges it stays 0.08 s.
- Audit: `voiceover_in_footage` hears the words (narration within 0.25 s of the footage's voice at either end).
- Teaching: cut-ins skill, VOICE-OVERS: the room Edit leaves, kept when footage beside a cut-in is trimmed.

### 2. Glimpses: half a second of something between two shots
- 16-Year-Old v2 15:16 "half a second with this that just looks glitchy to the eye… these really, really
  small clips… are removed", 18:43; Mom & Teen 7:48 "only appears for around .2 sec"; N3on 1:17 "a small
  frame of something else in between".
- Cause: a long clip mostly under something else (a 4 s B-roll shot under a Pause showed 6 frames each side).
  `sliver` only flagged clips short in themselves.
- Audit: `glimpse` (edit_plan.glimpses): a frame-filling picture on top for under 0.5 s between two others.
  On the v2 snapshot it finds 15:16 and the ones the agent removed by hand (7:01, 23:11…); one still at 10:13
  on the current 16-Year-Old; 14 in She Left Him. In FIXABLE.
- Teaching: both final passes say what it is and how to fix it.

### 3. Subtitles late
- Bookkeeper v1 10:48 "the subtitles are slightly delayed at many places", 12:19; 16-Year-Old 19:52 "sync the
  subtitles throughout the entire video".
- Cause (open): subtitles are made 250 ms ahead of their words (subtitles.LEAD_MS), but lines later sit 0.7–1 s
  late: they likely didn't move with footage that was retimed after them. `text_not_said` allows a second either
  side, so nothing flagged them.
- Audit: `subtitle_late`: a subtitle that comes up after its first two words are heard. The Bookkeeper still has
  14 after its "6 frames before" fix. In FIXABLE; the final passes say add_subtitles again over a late run.

### 4. The Windows screen: black around it, windows moving, not the same places
- She Left Him v1 2:06 "never have black borders around the windows screen", v2 0:29 "instead of camera moving
  around on the screen, its the fileviewers moving around", v4 0:32; 16-Yr v1 3:23 "have the window screen
  locked the entire time"; Bookkeeper 36:18; the user's screenshot (Predator Masseur, JJ's Mac).
- Already in code since Oct 30 (13e96a0c): one camera over the whole desktop, the wallpaper sized so its edge
  never shows. Predator Masseur's desktops have the Oct 29 still wallpaper, so JJ's app was older than nightly-32
  when it was built.
- Code now: no window floats on its own (only the camera moves), and the nth window is in the nth place on every
  screen (no turn through the places per desktop). Teaching: the agent gives no x or y.

### 5. Notepad text drifting or flying out
- Bookkeeper v3 2:53 "the top line… moves around"; 16-Yr v2 3:40, v3 3:38 "text in the Notepad that moves around…
  when we zoom back into the footage"; She Left Him 4:47 "fix the note pad"; the user: "the text flies out when we
  zoom in or out".
- Found: the current 16-Year-Old's lines stay within 1 px of their window in the keyframes, but each line's text
  image was rounded up to whole pixels and drawn by its centre, so every frame the camera changed their size the
  line moved by up to half a pixel against its window. In Predator Masseur (older build) the lines hang past the
  window's left edge and the first one shows outside it as the window pops in.
- Code: edit-render centres the text exactly in its image (a test measures the ink's centre across sizes).

### 6. Renders failing on cloud photos (found on the way)
- render_frame/contact_sheet failed with "ImageIO couldn't decode the image" on the 16-Year-Old's Windows screens:
  cloud photos come down when a project opens and the cache cleaner later evicts them. Renders now fetch them again
  (`cloud_media.restoreStills`, at most 20 s). The agent had been unable to look at these screens.

### 7. Playback in the app
- The user: "currently super laggy! we have too many loading frame issues and this has been the biggest issue";
  a teammate on the latest nightly stalled scrubbing and playing.
- Code: smooth playback (docs/preview.md): the open edit rendered in the background through the export's chunks,
  played and scrubbed as a video while it shows what's on screen; live drawing otherwise. The first render of a
  long cloud edit reads its footage once from R2 (about 13 frames/s from South Africa); edits after that redo only
  their chunks.

## One-offs (in the notes, not patterns here)
Music choices and loops ("loop the first part of the song… super clean"), names ("call him Deputy Ensley"), mutes,
speaker attribution, script fidelity in intros. Most were fixed by the agent in their review rounds.

## Open questions
- Which nightly was JJ on when Predator Masseur's Windows screens were built (Oct 30–31)? Its desktops are the
  Oct 29 kind.
- Smooth playback renders on this Mac; for long cloud edits the first render could go to Modal (fast reads from
  R2) if the local one is too slow for the team.

## Teaching loop 6
Answer key and rounds under `~/edit-experiments/loop6/` (bases: 16-Year-Old interrogation, Welfare Check bodycam;
holdout Concerned Sergeant). Results are added below when it finishes.

## Fixed on the way (Nov 1, loop 6's e-code trials on the trial server)
- **e-code scripts timing out on a busy Mac** (E2, the editing workflow's cut-ins): `note("hi")` failed "ran for more than 20 s" three times. Cause: the clock started before the sandbox process had loaded, and it loaded the whole server. Fix a007be45: the sandbox loads its own two files and says when it starts; the 20 s count from there. Verified: a test runs a script at a 150 ms limit and stops a loop.
- **Map labels refused from e-code** (E2, the date cut-in): place_label wanted the building track map_view had answered with; E1's agent dropped the label. Fix 85a03a53, then 61b69765 for cloud projects (the map's media points at its cloud copy once it's up): the track is read from what the map's render measured, by its file name. Verified: tests, and E3's labels went in after a restart on the fixed build.
- **An hour of turns asking for maps again** (E2): maps queued behind each other on a busy Mac and the agent was told to call again. Fix 86bc09d1: after a minute map_view answers with a dark stand-in, which the first frame and then the footage replace by themselves, labels re-pinned. Verified on the trial server: two maps at once answered in 65 s each and swapped in.
- **Notepad lines moving against their window as the camera zooms** (the team's Notepad notes): each clip's keys were thinned apart, 1.6 px on a fast zoom in R1. Fix 1e6b33ac: a window and everything in it keyed at the same frames. Verified: the desktop test measures every frame, under 0.1 px.
- **Smooth playback made on Modal lost its record** in a fresh data folder (never copied down, a restart would pay to make it again). Fix 65cb9797. Verified on the trial server.
- **red_quote refused without a face** (E2, E3; the agent guessed one). Fix 081b5c95: the face found in the footage under it.

Checked, nothing to change: the Windows screen in the user's screenshot (Predator Masseur, Cut-in 1) draws full frame with its Notepad lines inside the window in the current build's preview: the black border and hanging text were the older build JJ had (nightly-39 and later have the fixes, also for projects made before). R1's three desktops: no black at their widest, in the export or the preview. Smooth playback of R1's 26 minutes: made on Modal in about 5 minutes, plays at 30 fps, seeks show in 25–180 ms, no "Loading frame".
