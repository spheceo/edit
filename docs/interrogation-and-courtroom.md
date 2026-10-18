# Interrogation and courtroom styles: findings and plan

Two demo projects, one interrogation and one courtroom, edited by the in-app agent from a script Doc each. Phase 1 (done) studied a reference video for each style with Gemini 3.8 Flash, checked its claims against stills, compared both with the bodycam house style (`mcp/instructions.ts`, `skills_text.ts`), and wrote each style's `Guide` into `apps/server/src/styles.ts` (first in the Rust server's `styles.rs`, ported Oct 18). Phase 2 (not started) creates and edits the demos.

Research (Gemini's answers, stills, transcripts, Doc exports) is on the LaCie:

- `/Volumes/External/Edit/research/interrogation/notes.md`
- `/Volumes/External/Edit/research/courtroom/notes.md`

## Inputs

| | Interrogation | Courtroom |
|---|---|---|
| Reference | https://youtu.be/4mqGp1IgqEw | https://youtu.be/RAhmNukjK2g (Judge Jester, 46:33, five cases) |
| Demo script | https://docs.google.com/document/d/1xsdkDg64YNVGz5Ivx1J7EKXzbQedGg4yANHbSJWUDyc | https://docs.google.com/document/d/12s-sqx0m7aRs2EF8tCnld9Lnayyq7ujBfME0GTOn5hg |
| Voice-over | Generated house voice (as for bodycam) | Recorded: `newest.mp3` (below) |

## Status

- [x] Style analysis, both styles
- [x] `styles.ts`: INTERROGATION and COURTROOM guides written
- [x] Questions below answered with the recommendations in bold (Oct 18; the Drive question too: re-exports keep their link)
- [x] YouTube footage in script import (`youtube.ts`): yt-dlp straight from this Mac, Repack's `PROXY_URL` only when YouTube refuses; H.264 up to 1080p (720p where YouTube offers no more over plain HTTPS), the original sound
- [x] Mixed narration/range paragraphs, "Reuse: <link>" notes, no generated voice for courtroom
- [x] Effects: the light leak (`grade.leak`, plan transitions `light_leak` and `burn`), capitals (`style.uppercase`), `update_clips {person}`, `mute_house_words {words}`; the guides use them
- [x] Server rebuilt and restarted
- [x] Interrogation demo project created and edited (Oct 18: "2 Hours Of Cops Realizing Their Own Colleague Is The KILLER", 2:34:53 with the reused Zelich video; import ~45 min, the agent's edit 55 min over 136 model calls, then a fix-up turn for the Lazarus framing and THE CRIME SEEN watermark)
- [x] Courtroom demo project created and edited (Oct 18: "Corrupt Cop FAKES CRIME — His Own Bodycam BACKFIRES In Court!", 19:26 on `newest.mp3`; the agent's edit 23 min over 50 model calls)
- [ ] Not exported yet (the user reviews first)

Found while making them, fixed in code: yt-dlp needs FFmpeg by its full path; a garbled take transcript is transcribed again and a partial place_voiceovers keeps the other cut-ins; repack_subtitles works out three files' seats at once, and an older subtitle run never saves over a newer one; map_view asked again answers with the media it already made; people far apart in time, or suspects, may keep one colour; the audit flags text under a blur; the house style asks for footage to fill the frame and for other channels' watermarks to go. Left as they are: the courtroom's punch-ins at 2.8× into one pane of a stacked feed are soft (the guide says 1.3–2×).

## Blockers (Oct 17; 1–3 fixed Oct 18)

1. **Both scripts link footage on YouTube; the script import only reads Drive links**, so neither project imports any footage.
   - Interrogation: "Footage 1/2/3" are `t5ljpPTNvCM`, `Si3rfqwM9uo`, `7aU0eYFAj0M`, 2–4 hours each. Ranges link YouTube with `&t=`.
   - Courtroom: everything is from `MeT7tyZqfiw` ("Corrupt Cop Fired After He Ran Roadside Plea Bargains", LawNerds Unite, 33 min).
   - Proposed fix: script import learns YouTube links. yt-dlp downloads to the media drive (the LaCie), the original streams to R2 with a proxy, and the local copy is removed, so the internal disk (~12 GB free) stays clear.
2. **The courtroom Doc puts all narration in the same paragraph as the time ranges.** The importer drops narration that shares a paragraph with ranges. Fix: the parser handles mixed paragraphs, or the Doc is split.
3. **The script import always generates ElevenLabs voice-overs.** Courtroom needs that skipped and the recording placed instead.

## Interrogation

Reference: raw interrogation in 1–3 minute stretches between ~15 narration bridges of 7–30 s.

**Same as bodycam**
- Script import, house voice-overs, `place_voiceovers`
- Footage ranges run first…last word; teasers are complete thoughts
- Cut-ins covered by `cover_cut_in`: each B-roll moment once, never ahead of the story, shots change on the narration's phrases, linear push-ins
- Date cut-in (0:51, "June 05th, 2014", over blurred aerial)
- Research and facts, house words starred and muted, minors never shown, music library and levels
- Mugshot-on-the-left outro layout (39:50)

**Different**
- The room's sound is silent under narration.
- Subtitles: Repack positional everywhere (intro too), no names, no speaker captions. Suspect red by his face; detectives blue/green at the bottom; dark ~75% box.
- Transitions: one warm burn-out flash into and out of every narration (0:15, 0:25, 0:44, 0:50, 14:27, 17:16); hard cuts elsewhere. No drops, shakes, glitches or dips.
- Intro: static punch-ins on the suspect, no opening dip. Photo windows pop up over the footage (0:04, 0:39–0:41, 30:12).
- Name callout: a small typed label with a thin white line from the neck ("Steven Mark Zelich, 54", 1:46).
- B-roll: mostly the interrogation room, in natural colour; victim photos tagged "Name, age" (1:18, 4:08).
- A bridge's last line is sometimes typed over blurred, darkened footage (1:41, 11:27, 17:22).
- Outro: the narration typed in glowing red, a page at a time ("m****r" starred and muted), ending on a full-frame mugshot pushing in (40:10).
- Music only under intro, narration and outro.

**Edit can't do yet** (the guide uses workarounds)
1. YouTube footage in script import (blocker; medium)
2. The Doc's "Reuse: <link>" note, which appends a finished video (easy–medium)
3. A standalone Photo Viewer window over any picture, with name tag; `desktop.rs` already draws it (medium)
4. A standalone Notepad window with typed narration (11:06) (easy–medium)
5. Warm light-leak transition (easy; the guide builds it from exposure + temperature)
6. A monospace font for tags and callouts (easy)
7. Extra censored words for `mute_house_words` (murder, blood, the Doc's "Blur this" words) (easy–medium)
8. Picking clips by speaker in `update_clips`, to recolour one person's subtitles (easy)
9. Typewriter text timed to word times; today it's a fixed stagger per letter (easy–medium)
10. Mugshot with record tags (7:46) (medium)
11. Sections per case for compilations in `get_edit_context` (medium)
12. Low priority: before/after window pairs (20:27), pencil sketches (11:10)

**Written into `styles.ts`**
- `notes`: compilations case by case and the "Reuse" note; "Note to editor: Blur this" means star and mute the word, never blur the picture; no speaker captions or labels; bridges via `cover_cut_in` with `look: false`, `into: "none"`, speed 1, push [1, 1.06], B-roll mostly from the room; pictures, photo windows, name callout and closing line with exact styles; music only under narration.
- Replacement skills: `edit-workflow` (seven stages, case by case), `intro` (static punch-ins, no dip, no captions), `transitions` (a "Bridge flash" adjustment: 12 frames, exposure 0 → 2.6 → 0, temperature 0.35, with sound), `outro` (red typed resolution, then the mugshot), `subtitles` (`watch_footage`, then `repack_subtitles` over the whole timeline with `overlap: true`; never `add_subtitles`, labels or `place_subtitles`), `final-pass` (after `mute_house_words`, add the Doc's "Blur this" mutes to the voice-overs).

**The demo script**
- A ~1h46m compilation of three cases (Lazarus, Hardin, Adams). Its last line, "Up next…", has a "Reuse:" comment pointing at the reference video itself.
- About 40 narration blocks for the house voice, most ending in "…" hooks.
- Ranges use non-breaking hyphens (the parser handles them); notes are first…last words.
- "Blur this" marks words like murder, killer, killed, killing, including in the outcome lines.

## Courtroom

Reference: each case is a ~20 s narrated setup, the hearing in 1–2.5 minute stretches, 10–15 s narration bridges every 2–4 minutes, and a 12–20 s "SENTENCING:" card. It opens on 30 s of teasers (0:00–0:31), then a hook and title card (0:31–0:45). Narration is ~5% of the runtime.

**Same as bodycam**
- Narration covered with desaturated B-roll from the footage, timed to the words (2:48, 6:12, 18:01, 26:23)
- A person's photo framed over a blurred copy (0:46)
- Desktop profile: viewer window + Notepad typing facts (0:53, 13:47)
- End card: photo on the left, black gradient, red glowing text (13:27, 19:42, 46:17)
- White flash with a whoosh, subtitles in an opaque black box bottom middle, blurred monitors

**Different**
- The hearing is edited: punch-ins on a speaker throughout (34:16, 35:23), two-pane livestream grids over a courtroom backdrop (16:00, 40:00), recesses and dead air hard-cut (10:53).
- One transition: a warm orange-to-white light-leak flash into and out of every bridge and into each sentencing card (18:01, 29:13, 31:55). No maps, evidence boards, vertical drops, glitches or shutters.
- Reaction tags typed beside the head ("*HIS PATIENCE FADED*", "*TAKING THE BLAME*"; 6:20, 10:40, 15:42, 29:22) instead of quote callouts.
- Name callouts: white capitals with a white line to the person ("NICOLE HENDERSON", 20:00), not age/role in a red box.
- A cliffhanger title over a blurred freeze frame closes each setup ("UNLEASHING A FEROCIOUS REBUKE FROM THE BENCH...", 14:06).
- End card: "SENTENCING:" with white outcome bullets typed as the narrator reads them.
- Subtitles all capitals, no speaker name or colour. Teaser captions sit beside the speaker's head.

**Edit can't do yet**
1. Light-leak transition: an overlay clip plus a blend mode in the renderer, or a shader (medium; the guide uses a warm colour wash + white flash)
2. All-capitals subtitles: a text option or an `add_subtitles` setting (small)
3. Desktop viewer playing a clip from a chosen point, with a name under the picture; `desktop_profile` always starts its media at 0 (small)
4. Split screen over a courtroom backdrop: backdrop image + a layout op (small–medium)
5. Cliffhanger title in one step; possible by hand today (small)
6. Curved arrow and a red keyword in a callout (medium)
7. Teaser caption look: opaque box beside the head as a `caption_speakers` option (small)
8. Typed text in a box: the box probably appears full size before the letters type (small)

**Written into `styles.ts`**
- `notes` (win over the house style where they differ): the shape, and only dead air cut inside a hearing stretch; recorded voice-overs (check each recording's transcript against the script, place only one that reads this script, the recording's wording wins, extras stay off, it replaces generated ones; never generate or ask for narration); the hearing's picture (punch-ins on lines that land, grids scaled to fill, other channels' branding cropped or blurred); bridges via `cover_cut_in` with hearing shots and no vertical drop; reaction tag, name callout, setup (date title, no map, desktop profile titled "Court Viewer"), cliffhanger title, with exact styles; subtitle names removed in one `update_clips`; music only under narration; the audit's repetitive-transitions warning on the flashes is intended.
- Replacement skills: `edit-workflow` (seven stages, starting with placing the recording; research on the people and the outcome), `transitions` (the flash recipe and its sound), `outro` (the sentencing card, typed bullets, ending on the last word).

**The recordings**
- `newest.mp3` (118.6 s, male narrator): reads the whole McCluskey script, all 7 cut-ins in Doc order. Cut-in 4 is worded differently: "Command staff stood firm on squad standards. But McCluskey dropped a revelation about his own sergeant." **Use this one.**
- `judges.mp3` (115.5 s): a different case (Judge Simpson, a mother evicting her 22-year-old daughter), narrator not judge. From ~103.4 s it reads a chatbot's note aloud ("Two things while you're in here…"), which must be cut if it's ever used. Not used in this demo.
- Attachments: `~/.t3/userdata/attachments/…-dc2032a2-…-mp3.mp3` (newest), `…-5288ad67-…-mp3.mp3` (judges).

**The source footage**
- A re-upload: "LNU" logo on every frame, their banners ("COMING UP", "THE PICTURE ON THIS VIDEO WILL BE JUMPY"), Teams screens, two stacked feeds with black side bars, low and jumpy quality. The cut would be ~19.5 min.

## Open questions

Recommendations in **bold**.

1. YouTube import, or will the four videos go on Drive? **Build YouTube import.**
2. Build the light-leak transition, all-capitals subtitles and one-step recolouring of a speaker's subtitles before the demos? **Yes.** Other gaps keep their workarounds.
3. Subtitles as in the references (courtroom: all caps, no names or colours; interrogation: no names, suspect red; Repack's code makes suspects yellow)? **Follow the references.**
4. Interrogation "Blur this" words: starred on screen and muted in the narration? **Both** (the reference mutes "murder").
5. Courtroom source's "LNU" logo: **crop if it's in a corner, else blur.**
6. Courtroom end card for a suspension: **"RULING:"** rather than "SENTENCING:".
7. Interrogation B-roll under narration at speed 1 (couldn't tell from 1 fps samples; bodycam uses 0.5)? **Speed 1** unless the team says otherwise.
8. `judges.mp3`: for a later Judge Simpson video?

## Phase 2 plan

1. Build YouTube import (and mixed narration/range paragraphs; skip voice generation for courtroom), plus the effects chosen in question 2. Update the guides to drop the workarounds those replace.
2. `just check`, then rebuild the dev server once (`just serve-build-rust`) and restart it when nothing is exporting.
3. Create both projects from the Docs with their style set (interrogation, courtroom); cloud on, so footage originals go to R2 and only proxies stay local.
4. Courtroom: place `newest.mp3` with `place_voiceovers`.
5. In each project's agent panel: "start the editing workflow". Review, fix in code and teach the guide where it falls short, export.
