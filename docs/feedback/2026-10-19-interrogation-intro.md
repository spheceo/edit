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

## Round 2: the user's notes on the rebuilt intro (Oct 19)

### The teasers' captions aren't Red Thread's
"The style of the caption isn't what Red Thread has. What we want is sort of a glow on the text, just as we do with bodycam, and we want a drop shadow on the background… the red but it's not a red background, it's the red text. We still have the glow for that as well."
- Cause: intro_captions made small boxed lines (80% black, no glow) and put the emphasis lines on a red box; the round-1 notes read "white on black… the lines that matter in red" as boxes.
- Teach: the intro skill and intro_captions' description say bodycam's caption look, red words for emphasis.
- Code: intro_captions takes `captions.captionStyle` (bodycam's speaker captions: Montserrat, glow 46 at 0.5 in the text's colour, 45% box, wide soft shadow), white or `RED_TEXT` words.
- Test: intro_graphics.test.ts checks the red is the text's, the glow and the shadow.

### The text slam's glow is "too contracted"
"Just use the normal glow style that we usually have for our text, like the bodycam."
- Code: text_slam and timeline_bar use the house glow (radius 46, strength 0.5) instead of 14–16 at 0.35.

### Names misheard: "John Rutten", "John Bruton" for John Ruetten
"When we do subtitles, just like in Repack, we perform research and find articles. We then extract things like subject names, locations… We then send it over to Scribe so that it hears the right thing… It is unbelievably important that we do this for all subtitles."
- Cause: Edit never told Scribe any names (Repack does: case-names.ts). The project's 14 saved articles say "Ruetten" 61 times.
- Teach: NAMES FIRST (skills_text.ts, in the shared subtitles skill, the interrogation's own and subtitle-video): research the case and add_article before watch_footage.
- Code: names.ts lists the case's people and places from its saved articles and script narration (Gemini Flash, each word checked against the sources, surnames too, at most 100, cached by the sources' hash); `captions_core.transcriptOf` (watch_footage, add_subtitles, repack_subtitles, house words, caption_speakers) hears a file again with the names when its transcript wasn't given them (once per set of names; the names it had are kept; a failure keeps the old transcript); script imports transcribe with them; footage imported before any research is transcribed at once but not watched in the background, since the watch would be paid twice. The relay forwards `keyterm` query params as Scribe's `keyterms` fields; a refusal is asked once without them.
- Tool: watch_footage reports `names_heard`, or `no_case_names` with what to do.
- Tests: names.test.ts (the filter, end to end: no research → no re-hearing; articles saved → heard again once with the names), transcribe.test.ts (names sent, refusal), relay.test.ts (forwarded as fields, bad ones refused).

### The disclaimer
"Completely remove the disclaimer… unless we, as the users, specifically ask for it."
- Teach: the prologue's countdown now ends on its last picture; op disclaimer only when asked (the skill and the tool's description).
