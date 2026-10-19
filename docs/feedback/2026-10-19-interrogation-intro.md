# Interrogation intro: learnt from Red Thread Interrogations and Red File (Oct 19)

The user asked for the interrogation style's intro to be refined against two competitors' openings, leaning on Red Thread:

- Red Thread Interrogations, "Killer Wife Has No Idea Cops Already Know Her Dirty Secret" (youtube.com/watch?v=SpuV6WI86vQ): the tape rolls at 2:12.
- Red File, "'Friendly' Cop Has No Idea Police Already Matched Her DNA After 23 Years" (youtube.com/watch?v=rJYy0pHZDxA): the tape rolls at ~3:32.

Gemini 3.8 Flash (through the relay) watched each first five minutes with sound and listed every beat and graphic; a second pass checked its moments against the frames (its timestamps drift: Red File's ran 20–40 s late after ~1:40), the rest re-picked by hand from contact sheets. A moodboard of the frames with explanations is kept off the repo (the frames are theirs): `~/Documents/Edit moodboards/interrogation-intro/moodboard.html` on the Mac it was made on.

## What they do

- Graphics on screen ~75% (Red Thread) and ~50% (Red File) of the time before the tape rolls, the first at 0:00, never more than ~4–6 s without one; once the tape rolls, nothing but subtitles.
- Red Thread's cold open: teasers under a heavy vignette; small boxed subtitles coming up word by word, white on black, the lines that matter in red, the same for everyone (the user's correction: "they're just all red, and we don't change per subject… the red is for emphasizing important lines, and it shows up one per word"); a framed photo with the name typed above it over the room gone black and white; black-and-white family photos; a document pushed past out of focus; a high-key mugshot with a red flash; a later prison interview as a flash-forward; a red flash into a second of black.
- Red Thread's prologue: "INTERROGATION STARTS IN 01:18" top left the whole way; a flat top-down satellite map (the user: "top-down, so it's just a flat angle") with the house glowing red, "Keller, Texas / October 13th, 2011" at the bottom, her photo pinned to the house with a red line; the victim tagged in yellow; a full-bleed split screen of the two; the room in black and white with only her in colour and her name in big faint letters; a fast-forward glitch; a disclaimer card until the countdown ends.
- Red File's clean pieces: word-by-word red text slams on the story's turns ("THEN THE CASE GOES COLD") and a "1986 ——— 2009" timeline bar.
- Not taken: fake HUDs and reticles, face-recognition boxes, vector body silhouettes, a red bar over a victim's eyes.

## What changed

| | |
|---|---|
| Teach | styles.ts INTERROGATION: THE INTRO AND THE PROLOGUE (density targets), the intro skill rewritten as the cold open and the prologue, subtitles (intro_captions after repack_subtitles), transitions (red flash in the cold open, the glitch only as fast_forward), the workflow's stages, the sounds of the new beats. |
| Code | intro_graphics.ts: intro_captions, photo_inset, countdown, map_pin, split_screen, fast_forward, disclaimer, text_slam, timeline_bar; the red_flash transition; date_title position "bottom" with place; map_view pitch 0 for the top-down map (already there). |
| Tests | test/intro_graphics.test.ts. |
