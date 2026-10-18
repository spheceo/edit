# Feedback: Mom Leaves 5 Kids Home Alone (Oct 17, JJ on Frame.io)

Project `p1792238170893-0` (cloud). Review: https://next.frame.io/share/5e79ec78-86c6-4daf-a8c8-a3ba41294bcc/print/comments/56e0673d-f441-4963-95cb-cd5c9ed47afe (38 comments, read with `read_review`). Times are the export's = the timeline's (30 fps).

## Patterns (one cause, many comments)

| Comments | What the edit did | Cause | Teach | Code / tool |
|---|---|---|---|---|
| 4, 8, 10, 15, 17, 27, 30, 33, 34, 36, 37, 38 "change the music" | "Nothing Much" under 10 cut-ins and "Covert Affairs" under 4, each from 0:00; one song for the whole 68 s intro | The skill said change beds only at scene changes and let "one track running on" be the exception | music-and-sound: a song's good stretch is short (often its first 10–20 s); a bed per cut-in, none repeated; the intro changes music at its first cut-in | audit `music_bed_long` (>25 s), `music_repeated` (one song in ≥3 places) |
| 14 "the music stops all of a sudden" | Cut-in 2's bed ended 6.3 s before its narration | nothing checked it | a bed never stops under the narration | audit `music_stops_mid_narration` |
| 5, 6, 13, 22, 29, 32, 36 "more clips" (6's "sped up" = pacing, the user confirms), "cut here", "better footage" | B-roll shots median 5.5 s, 25 of 36 over 4 s, max 11 s, all at 0.5× | the skill said "each a few seconds", "speed about 0.5" | cut-ins: a new shot every 2–4 s on each thing named, never past ~4.5 s; 0.75–1× where the narration moves | audit `long_broll_shot` |
| 18, 20, 35 blurred B-roll | censored footage as B-roll | the censor check only started with the audit and was still pending for all 16 files at the final pass | final pass: never finish on `censor_check_pending`; thin/blurred footage → words on screen (claim list, quote, board) | censor check starts when a file's preview is made (`censorWarm`) and pauses during exports |
| 18 "when we cut out blood fully … seems like a mistake" | "blood" muted whole in the narration | a whole-word mute in a voice is a dropout | (mute rule) | narration mutes keep the word's first sound ("bl-", like "bl**d" on screen) |
| 30 "'hit her' should not be blurred" | "hit" muted (neglect list) where it isn't violent | no way to keep one occurrence | | `mute_house_words keep: [seconds]` → a "not muted" media marker every later run respects |
| 17, 37 "VO slightly faster, ~5%" | house voice at 1.1 | | | house voice speed 1.15 (new edits); this edit: `speed_voiceover 1.05` |
| 21 "herself*, regenerate the VO" | narration said "the neighbor himself" | no tool to speak one cut-in again | narration word wrong → revoice | `revoice_cut_in {cut_in, text}`: speaks it again, fits the take to the cut-in by speed |
| 19, 25, 39 "the paper thing", "notepad" | footage / an evidence card | the board had no heading | cut-ins: thin footage → an evidence board titled whose account or which record | `evidence_board title` |
| 26 "CT Mirror means what?" | label "18 prior investigations · CT Mirror" | an outlet's abbreviation on a label | labels say what is shown; no source names | |
| 3 "freeze on 'this mother'" | other footage | | the first cut-in after a teaser freezes on the person just seen (same footage at 0.05×) | |
| 12 "image of the 12-year-old … phone … dialling sound" | place label only | | a call named over a place: a small framed picture of the caller (or a phone) and a dialling sound | |

## One-offs (apply only)

- 1: start 1 s later (00:00:01:07). 2 + reply: the first teaser becomes the new Doc's (1:21–1:23) + (1:25–1:28) (https://docs.google.com/document/d/17K5Ct4Kp48lV-F-6dTEh5iKZI8WAFwPmZR2LOjSrFDQ); the old one is (1:17–1:23) + (1:03–1:12).
- 7 (00:00:45:15): "why is this yellow? I think this is a medical person": the doctor in a suspect's yellow. The team's FOIA subtitle guide (https://docs.google.com/document/d/1iKyhCFvqXXDzWWUw_EVydoZdy2kHPoxsVLeF7lSnYHI) colours by role, and the user made it the rule for every subtitle: `people.ts` now colours by role (a colour kept only while it's the role's), `update_clips {person, role}` sets a story role (the mother as suspect), white allowed for bystanders and witnesses (edit-core).
- 9: zoom in on the mother (01:02).
- 11: music too loud at 1:10 (cut-in 2's bed at -12 dB; the others about -22).
- 16: find a picture of Corneliuz (2:55).
- 24: remove the subtitle "I don't think-" (13:18).
- 28: 16:14 "What's going on at the PD?" isn't an officer: relabel.
- 31: 20:05 "fault. It's your" isn't what's said: check the transcript.

## Process notes

- Frame.io's share pages are rendered by scripts and its API refuses anonymous calls; headless Chrome's `--dump-dom` with a ~25 s virtual-time budget reads the print view (`read_review` does exactly that).
- Applied through the in-app agent (the feedback skill), after the server with these changes was built.
