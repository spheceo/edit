# "Helpful" Wife Has No Idea: JJ's notes (Oct 20)

JJ reviewed the A/B Claude (Opus 5.5) export of the Sabrina Limon comp (project `p1792500688717-0`, 74:02, exported 18:04 SAST). Frame.io's times are six hours behind this Mac's clock (US Eastern): "uploaded 12:32PM" is 18:32 here, after the export, so it's that edit and not the morning comp (which never exported). The tell: comment 007 asks for a map, and that edit's summary says "today's map allowance had run out, so the date bridge has no map". 25 comments, every one after 1:28 on a narration bridge.

This round was taught differently (the user's idea): the in-app agent isn't handed the notes. We teach the lessons, then give a fresh agent a copy of the reviewed edit with only "the team sent this back; find what they'd flag and fix it", score what it fixes against these notes, and teach again where it misses (never giving it the answers). The last test is a from-scratch edit of a video never used in the loop: "Comp: 18-Year-Old Shoots 3 Teens".

## What the references do

JJ: "watch through a lot of Dr. insanity and watching through Red Thread interrogations… Red Thread are really good at having sound design and also having different visual effects on the screen". Gemini 3.8 Flash watched four whole videos in five-minute windows ($1.42): Red Thread's "Girlfriend Stabs Boyfriend To Death" (youtu.be/39RAUicSsT0, the one JJ linked) and "Wife Orders Hitman To Kill Her Husband" (KFnT0ANNRfU), Dr Insanity Interrogation's "This Genius Murdered His Entire Family" (YH3qC1Z_Qzo) and Dr Insanity's "Rich Mass Killer Realizes She's Been Caught 8 Years Later" (hALTeHQ_wh0). What every one of them does:

- The room fills the 16:9 frame. The raw tape plays clean: no punch-ins, effects or music; only subtitles, and dissolves or jump cuts to skip lulls.
- Under the narrator, everything changes: the room goes black and white with darkened, blurred edges and a visible push-in; what's said is shown literally (satellite maps, File Viewer windows of each person with a name label, website and document captures, quoted text with highlights, mugshots for sentencing, text slams with sub hits).
- Music only under narration, one bed across a section, cutting out to room tone the instant the tape comes back; section changes land on bass drops, whooshes and hits.
- People are introduced as framed photos with their names (Dr Insanity's File Viewers, Red Thread's photo cards with white name bars).

## Patterns

### 1. Black bars (004, 007, 014, 019)
"Just to make it clear, throughout this entire video, we need to do so that there are no black bars on the footage." Also on the photos ("there are too many black bars here") and inside the Windows screen's Video Player.
- Cause: the tapes are 720×480 (3:2) and footage was placed at the renderer's "scale 1 = fit the frame", so pillarboxed; the teasers' 1.35 punch-in moved x far enough to show an edge; photos sat on black "photo backing" solids under the film look (which the old bare_still check counted as designed). The core rule FOOTAGE FILLS THE FRAME existed; nothing checked it.
- Teach: core EVERY PICTURE FILLS THE FRAME (raw, teasers, bridges, photos, windows).
- Code: `framing.ts`: script imports and cover_cut_in place footage filled, the file's own black edges found by cropdetect (`borders-v1.json`, warmed when media is processed) and cropped past; the desktop's Video Player crops its footage to its screen.
- Tool: the audit's `letterboxed` (one issue per file) and op `fill_frame` (every such clip at once, pushes kept, x/y kept inside the picture).

### 2. Zooms: teasers too wide and static (001, 002, 010)
"We must also utilize zooms more", "we must be more zoomed in" (on the teasers and the prologue's room).
- Cause: the interrogation intro asked for a "STATIC PUNCH-IN… scale ~1.3, no scale keyframes" (1.14× of a filled frame on these tapes).
- Teach: teasers punched in close (head and shoulders, often 1.8–2.5× the filled frame) and moving (a push, a harder punch-in on the line that lands), a new framing each teaser.

### 3. Bridges that show what's said (005, 008, 013, 017, 018, 020, 022, 023)
"We say a lot of things right here in the voiceover that we could literally show." "I don't like that we just play the same footage here for so long. I need to see some more going on on the screen, at least some zooms and some different effects."
- Cause: this morning's round sent the comp "back to the cut-in guide: footage first… mostly the room's footage (speed 1, one zoom across the bridge)" after the Windows screen took over every bridge; the interrogation notes then said the room carries the bridges, natural colour, push [1, 1.08]. The A/B edit's bridges were 70% plain room ("Sabrina listening" for 30 s); the audit's 32 long_broll_shot were ignored because the style told it to do exactly that.
- Teach: interrogation notes THE BRIDGES SHOW WHAT'S SAID (sentence by sentence: people in File Viewers with names, places on the map, records, quotes, text slams; a new picture every 2–4 s; the room only for lines about the room, and then treated: black and white, soft edges, a visible push, punch-ins; nothing plain past ~4 s); the general FOOTAGE FIRST now says an interrogation is the exception.

### 4. Photos nobody can place, watermarked, letterboxed (003, 004, 009)
"This photo doesn't make any sense. When I watch this as a viewer, I have no idea what this is." "We need to remove the previous watermark of 'Dateline'." "…ensure that it occupies the full screen."
- Teach: a person's photo comes as they're named and says who they are on screen; full frame or in a designed graphic; another outlet's mark cropped past or blurred.
- Code / tool: `watermarks.ts`: Gemini looks at each found photo on the timeline once (`marks-v1.json`, ~$0.001 a photo); the audit's `watermarked_picture` gives the box to crop past or blur. On the A/B edit it found "#DATELINE" and "NBC Peacock logo and #DATELINE" on the two photos JJ flagged (and a mugshot's CDC number).
- Code: apply_edit_plan's description now lists photo_inset (a photo with the name typed above it), map_pin and split_screen, which the agent couldn't see.

### 5. The name ID (003 reply, 011)
"We need to add her name next to her in a different way", "a black box identification where we have a line and then a box pops up next to her face… and then we can maybe have her husband pop up next to her".
- Cause: the interrogation intro (from the Oct 19 Red Thread study) put the name "in big faint letters top left"; the house NAME CALLOUT (box + leader) was only in the notes, for the bridges.
- Teach: the prologue's room introduces the person questioned with THE NAME CALLOUT; the people the narration ties them to pop up beside them (photo inset / File Viewer with names).

### 6. Music changing for no reason (012)
"We suddenly change the music right here… we only need to change the music if there is some switch in what we hear."
- Cause: the bodycam lesson (Mom Leaves 5 Kids: "only the first 10–20 seconds of a song") became music_bed_long at 25 s for every style; under the 44-second prologue the agent swapped songs mid-sentence to satisfy it.
- Teach: one bed per section; changes only where what we hear changes, on a cut and heard.
- Code / tool: an interrogation bed may run 90 s; the audit's `music_change_mid_narration`.

### 7. Music level and mood (016, 021, 023, 024)
"We need to turn down the music here." "This is simply too slow and too almost emotional… this sounds like funeral music." "Change the music here as well." "I don't feel this music fits in right here."
- Cause: every bed sat ~9.8 LU under the narration (the skill said ~14 under the speech; nothing checked it once level_footage moved the speech); beds were picked per bridge for variety, some sad (Drifting Off, Long Term and Ashes, Reflections).
- Teach: music-and-sound MOOD (tension that moves for facts and suspicion; sad only for grief), ~16 LU under the narration.
- Tool: the audit's `music_loud` with the volume that fixes it.

### 8. Sound design that marks the structure (003, 006, 015)
"If you just listen to the sound design of this, this doesn't really work… a riser or something like that that suggests that we are about to start our first cut." "We need to be able, as viewers, to know and feel that, 'Okay, now the video starts.'"
- Cause: the tape rolled with the prologue's music fading on under the room, no hit; the first hook came in on a shutter.
- Teach: into the first hook a riser and a hit with the music changing; THE TAPE ROLLS: riser over the countdown's last seconds, a deep hit on its first frame, the music cut dead.
- Tool: the audit's `tape_start_unmarked`.

### 9. Dead air in the teasers (000)
"Dead space like this must be removed": a 1.6 s pause inside the first teaser.
- Teach: teasers are tight (general and interrogation intro).
- Tool: the audit's `dead_air` (pauses ≥0.9 s inside teaser clips, the frames to remove_time).

### One-off
- 007/009 the map: the relay's map allowance (15 sessions a day per connection) had run out during the A/B runs. Worth raising for days of full edits.

## Open questions for the user
- The relay's daily map allowance (15 per connection, 30 total) ran out on a day of A/B edits; raise it?
- The bodycam style keeps the 25-second song limit (Mom Leaves 5 Kids' "only the first 10–20 seconds"); JJ's "only change the music if there's a switch in what we hear" may apply there too.

## The trials
