# What the FOIA agents left (Oct 22): Mom & Teen v4, Mom Leaves 5 Kids v2

After teaching loop 2, both FOIA edits got JJ's notes through their in-app agents (`feedback`), with three steers on Mom & Teen. Each agent listed what it couldn't fix; the user asked for those fixed "here and also in the future". Each was a tool or a default the agent was missing, not a rule.

## Clipped words (cut_mid_word: 13 on Mom & Teen, 14 on Mom Leaves 5 Kids; 7 on the loop's holdout)
- Cause: the agent could take time out (remove_time) but not put it in: "the editing tools have no way to insert time". A cut 0.1–0.4 s short of a word's end can't be lengthened without breaking everything after it. Four of Mom Leaves 5 Kids' were the transcriber's mistake (a "word" lasting 8–17 s).
- Code: `insertTime` (project.ts), the reverse of remove_time: what's after moves on; beds and B-roll across the cut play on with their keyframes; the subtitle on the cut holds to the word; a flash or whoosh goes with the cut. cut_mid_word skips words over 2 s.
- Tool: `extend_clip` (no arguments: every flagged cut), carrying on to the pause when the next word is already under way, and naming the spans to subtitle and mute again. cut_mid_word names it and now counts in Edit's follow-up. On a copy of Mom Leaves 5 Kids: 11 → 0, 2.7 s added.
- Teaching: final-pass's "cut_mid_word → extend_clip".

## Notepad lines after their words (text_late, Mom & Teen ~2:22, 9:36, 15:50)
- Cause: a Windows screen opening from the footage zooms out for ~1.8 s before any window may open, and the narration named the first note as the screen started (or before). Mom Leaves 5 Kids' agent had fixed its own by hand with `open: false`.
- Code: desktop_screen.ts: when a note's time (from its words or given) comes before the zoom out allows, the zoom out hurries (to 1 s); with no time for that, the screen opens on its windows. Pictures wait for the quickest zoom out.

## A short line squeezed out of the subtitles (Mom Leaves 5 Kids' "it was.", 27:06)
- Cause: add_subtitles left out a line of two words with under 0.25 s before the next speaker, while the audit flagged it as unsubtitled: the two disagreed.
- Code: captions.ts gives it a lead into the quiet before it (up to LEAD_MS), leaving it out only with no room. "blaming everybody." (27:09) was the agent's hand-made line; add_subtitles over the span puts it back.

## The uploader's logo inside a desktop's Video Player (Mom Leaves 5 Kids' CI8, 15:40)
- Cause: the agent blurred the Code Blue Cam logo across the tapes, but in a Video Player the footage moves with the desktop's camera, and the agent said a blur couldn't follow it.
- Code: the desktop blurs every mark watermarks.ts found on the footage where a player plays it, with keyframes following the camera.

## Found while applying them
- add_subtitles over a span dropped the subtitle across each edge (replaced, not remade): both agents re-subtitled whole stretches to get them back. It now widens the span over them.
- A line relabelled on its own (Mom & Teen's two "Female Sergeant:" lines under the officer's voice, note 022: "think this should be called 'female sergeant' and then make her pink") went back to "Officer:" on every re-run; now kept. Her pink held only while her cast entry had no role: with the officer voices under her label she became an official, and officials are never pink (Oct 17's "officer in hot pink" note). Her role is now "other" in the cast. Decided (the user): "if its a female officer i guess we can make her pink": a woman official whose label or name says so gets pinks of her own (speakers.ts `WOMAN_OFFICIAL`); men officials still never are.

## Not for code
- Note 039 (Mom & Teen, 16:18): "lets use an illustrative image we create based on what hannan looks like and then just make her younger and blur her face fully": Edit makes no images.
- Note 027's wallpaper folder (`18JpoLwuHSxvgfYsLrR9bNW0Xd815swwJ`): its blue-windows-bg is the one Edit has used since Oct 20 (`WALLPAPER_DRIVE_ID`); the agent couldn't open the link and didn't know. The folder also has a red-windows-bg.png.
