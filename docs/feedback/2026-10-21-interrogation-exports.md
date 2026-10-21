# Oct 21: the user's notes on the two interrogation exports, and the first bodycam test since

The user watched the starts of the comp ("18-Year-Old Shoots 3 Teens") and Helpful Wife v2.

## Patterns

1. **Subtitles over silent B-roll** (comp intro: "the subtitles for the video that's playing as B-roll showed up, which is absolutely wrong"). Cause: caption_speakers read the picture, not the sound, so Ava's words under the voice-over were captioned. Code: it captions only words whose footage sound plays. Audit: `subtitle_unheard` (text_not_said skipped a subtitle with nothing heard under it).
2. **Intro speech with no subtitles** (Helpful Wife: "for some areas in the intro subtitles just weren't there at all"). Cause: teasers split for punch-ins left the new halves uncaptioned, and subtitle coverage was only checked after the intro (and never surfaced as an issue). Audit: `unsubtitled_speech`, the intro included, its captions counting.
3. **Vignettes snapping on and off** ("one minute the vignette is there, the other it's not"). 127 of the comp's 210 grade adjustments had no fades; Helpful Wife's teasers had every vignette laid twice. Audit `vignette_snaps` (also lists doubled ones); op `ease_vignettes` fades each uncontinued edge over 12 frames and removes copies. The evidence board's vignette fades by default.
4. **A Notepad line over its window's edge** (screenshot). A line's x is its box's centre; the final pass reworded it and it grew both ways. Code: a left-aligned text reworded keeps its left edge.

## Found on the way

- Long tools (caption_speakers, mute_house_words, add_subtitles, repack_subtitles) outlasted the agent's ~5 min wait and were retried over themselves (26 duplicate captions; a mute that never answered). They now run once per project and arguments; past 4 min they answer "still working" and the next call collects the result.
- A transcript piece came back as gibberish in a dozen scripts (Helpful Wife's m91, 6:39–7:16), the same each time; such a piece is now heard again without the case's names, else the whole file's words stand.
- The bodycam test's police call (an .m4a): excerpt cutting required a picture, the cloud proxy refused sound, and the import laid it as a video clip no frame could decode. All three fixed: it goes in as sound under a black card for the call look.
- `broll_crosses_cut` counted a bodycam's walking as a cut every half second (50 flags); only cuts standing alone count now.
- The relay's daily transcription went from 10 to 30 hours per connection.

## Results

Both interrogation videos re-exported on Modal with the fixes checked on frames. The bodycam test ("Serial Predator Caught After Torturing And Killing Disabled Woman", 17:03) was edited from the Doc with "Start the editing workflow", given one final pass and one correction (the 911 call over a map, not black), and exported on Modal.

## Open

- Bodycam's music_bed_long (the 25 s song limit) conflicts with one bed per narration (JJ's "only change the music when what we hear changes"); the agent kept one bed per narration and the audit still lists 4 long beds.
- Lola's tape in the comp still needs a clean copy (THE INTERROGATOR FILES watermark).

## Second round (the user watched all three)

5. **Map markers off their places** (the outline or dots "just don't seem to be in the right location at all. It's just hovering aimlessly"). Cause: the map page draws at 1.5× (`resolutionScale`), Cesium's `cartesianToCanvasCoordinates` answers in CSS pixels, and the marker was scaled by the drawing buffer's width, so every outline, dot and place-label track sat at two thirds of its place, up and left. Code: scaled by the canvas's CSS width. Tool: map_view's note says CHECK when the marker lands off the middle (the camera aims at the place). Teach: look at each map's first frame once. Every map in the three edits re-rendered (the relay's map allowance raised to 40 per connection, 80 in all, to do it in a day).
6. **Subtitles moving to the speaker** ("they kind of go to the person speaking… They must be locked to the bottom middle", interrogation and bodycam alike). Cause: the house rule "a subtitle never covers a face" moved them. Code: add_subtitles keeps them at the bottom middle, place_subtitles puts moved ones back in an edit (a subtitled video still goes under faces), text_on_face only for captions; audit subtitle_moved. 532 moved back across the three edits.

Also: a map Chrome left running by the 09:38 crash held a gigabyte for two hours; the server now stops orphaned map renders when it starts. Map renders run one at a time at about a quarter of a frame a second on this Mac, the slowest part of a round.

The visual self-check the user asked for: map_view's own CHECK (a marker off the middle) and the skill's one look per map, plus last round's code-side checks (a reworded Notepad line keeps its place; audits for unheard or missing subtitles and snapping vignettes), rather than a look after every change (the instructions keep one look per stage for speed).
