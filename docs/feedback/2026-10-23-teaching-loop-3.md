# Teaching loop 3: JJ's Oct 22 bodycam round, without breaking interrogation (Oct 22–23)

The brief (the user, Oct 22 night): run the teaching loop on the two bodycam videos JJ reviewed that evening (Mom Leaves 5 Kids v4, Mom & Teen v6; saved in `~/edit-experiments/foia/ROUND-2026-10-22-evening.md`). "We need to be very careful to not have regressions in the Interrogation side."

How it ran (the teaching-loop skill):
- **Each trial:** a fresh copy of a base project, then "Start the editing workflow." on Opus 5.5 (Claude Code, medium). The agent never saw the notes.
- **The videos:** Mom Leaves 5 Kids (mom5, a fresh import) and Mom & Teen (momteen). Helpful Wife (hw), the interrogation video loop 2 got clean, ran every round as the control.
- **The holdout:** Serial Predator, a bodycam video, never taught from.
- **The answer key:** private, in `~/edit-experiments/loop3/keys/`. It has rows N1–N16 from JJ's notes, plus loop 2's rows.
- **The log:** `~/edit-experiments/loop3/LOG.md`. Every trial's project, chat, score and frames are under `rounds/`.

## What changed, by kind

### Code: right by default
- **The desktop camera pans at one zoom** across a Windows screen's windows, instead of zooming in on one and back out for the next. The team: "I don't feel it looks too good that we zoom in and then zoom out again." (d68a1e0)
- **Notepad lines never start together.** In round 1 each line waited for the one before to finish typing; round 5 showed that pushed lines past their words (6 of 9 late). Now the line before moves earlier, as far as the window's opening allows (ff5cb11). The team: "this text doesn't appear at the same time in the Notepad".
- **"actual image" is dropped as a window's label.** Only a picture filling the screen carries it: "remove actual image text on all these photo / video viewers… (throughout the entire project)". (d68a1e0)
- **Subtitles spell the case's names as the case spells them.** A capitalised word in mid-sentence that's one letter off a case name is corrected: "Cornelius" becomes the script's "Corneliuz" ("misspelling of name"). (b1b09a1)
- **"child" is muted and starred in a neglect case**, as in "risk of injury to a c****" ("mute child"). (b1b09a1)
- **Edit's follow-up asks about a single whole-edit flag** (a wide teaser, the intro's length or ending, too few Windows screens). Before, it only asked once an edit had three or more flags (93f8e24).
- **Courtroom subtitles can be white:** the core's one-colour-per-person check no longer refuses them (3adc283).
- **Deleting a project removes its renders** (smoothed slow motion, map shots). The loop's deleted trials had left 8 GB (b416804).

### Audits: so the follow-up catches it
- **`intro_long`** (95cbd6b, 888c34d): a bodycam intro's teasers past 40 s. It counts only the teaser footage, not a cut-in's narration between teasers.
- **`intro_no_arrest`** (89313cb): a bodycam intro that doesn't end on the arrest when the footage has one. It names the arrest line's time.
- **`windows_underused`** (888c34d): fewer than one Windows screen per six cut-ins.
- **`desktop_sparse`** (71201ef): a Windows screen with fewer than three windows. Mom & Teen's round 4 screens were each a lone Notepad: "have more images pop up".
- **`actual_label_in_window`** (d68a1e0): an "actual image" text added over a window by hand.

All five are fixable in Edit's follow-up. Every one except `actual_label_in_window` is bodycam only, so interrogation's audit is unchanged.

### Teaching
All of it is short and quotes the team. Most is in skills only bodycam reads.
- **Bodycam only** (the house intro, transitions, outro, subtitles and workflow, which interrogation overrides with its own):
  - the intro is ~30 s of the strongest emotional moments, mostly the suspect, ending on the arrest, and its teasers are shaped first;
  - a clean transition into and out of a graphic;
  - the charges worded as the narration says them, with house words starred and the sentence as the last line, coming in behind a dip;
  - names as the script spells them.
- **Shared with interrogation** (cut-ins):
  - Windows screens busy (3–5 windows, never a lone Notepad) and placed where the narration lists findings;
  - no "actual image" label in a window;
  - board notes that read without the narration ("cleared means what here?");
  - tight blurs that follow the face;
  - an illustrative stand-in for someone with no photo.

## Results

Edit minutes are the agent's time, follow-ups included. "Text early" counts on-screen text and Notepad lines that come up 0.3 s or more before their words, out of those matched.

| video | round | min | text early | clicks | long shots | desktops | what the key says |
|---|---|---|---|---|---|---|---|
| mom5 | R1 | 31.9 | 6/10 (0 late) | – | 0 | 2 | intro ~67 s with calm shots; "Cornelius"; "child" not starred |
| mom5 | R2 | 29.7 | 2/3 | – | 0 | 2 | intro 40 s (intro_long fired); names and charges right |
| mom5 | R3 | 21.5 | 0/1 | – | 0 | 0 | intro ends on the arrest; no desktop |
| mom5 | R4 | 17.0 | 8/11 (0 late) | – | 0 | 2 | everything in the key that can be measured |
| mom5 | R5 | 23.9 | 15/18 (2 late) | – | 0 | 4 | busy desktops |
| mom5 | R6 | 15.3 | 2/3 | – | 0 | 2 | clean |
| momteen | R1 | 16.9 | 0/1 | – | 0 | 1 | one desktop, no Notepad; calm intro |
| momteen | R2 | 12.8 | 14/15 (0 late) | – | 0 | 3 | 12 Notepad lines |
| momteen | R3 | 16.4 | 2/7 (2 late) | – | 0 | 2 | |
| momteen | R4 | 13.4 | 10/17 (0 late) | – | 1 | 3 | each desktop a lone Notepad |
| momteen | R5 | 20.4 | 2/9 (6 late) | 9/9 | 0 | 1 | Notepad lines pushed late (fixed) |
| momteen | R6 | 15.8 | 14/17 (0 late) | 6/6 | 0 | 3 | clean |
| hw | R1 | 26.9 | 10/25 (5 late) | 69/69 | 0 | – | teasers 1.0, no centred text |
| hw | R2 | 26.1 | 20/22 (0 late) | 81/81 | 0 | – | |
| hw | R3 | 19.7 | 21/25 (3 late) | 51/55 | 1 | – | a wide teaser left unasked (follow-up fixed) |
| hw | R4 | 21.9 | 22/28 (2 late) | 60/60 | 0 | – | |
| hw | R5 | 27.3 | 22/28 (0 late) | 51/51 | 0 | – | |
| hw | R6 | 24.4 | 12/13 (0 late) | 107/107 | 0 | – | |
| **holdout** | – | **16.8** | **19/22 (0 late)** | 6/6 | 0 | 2 (8 and 10 windows) | opens on the cuffing, ends on an arrest line; charges with the sentence |

- **Mom Leaves 5 Kids** got JJ's notes right from round 4:
  - a ~30 s intro of the mother, ending on the arrest;
  - busy desktops with staggered Notepad lines;
  - "Corneliuz";
  - "Risk of injury to a c****" with "Sentence: 5 years' probation";
  - no "actual image" in a window.
- **Mom & Teen's desktops** went from one lone Notepad (R1) to three busy screens (R6), with its text early and none late.
- **Helpful Wife** held up every round: teasers punched in (one dip in R3, now caught by the follow-up), every pop-up clicked, no centred text, no cuts mid-word. No regression.
- **The holdout**, a clean first shot in 16.8 minutes:
  - the intro opens on the cuffing and ends on the arrest line;
  - two busy Windows screens;
  - text early 19 of 22, none late;
  - the charges with the sentence, starred;
  - "[ACTUAL PHOTO]" only on a full-frame photo.

What the measures can't say: nothing was heard (music, sound) or judged for pace and taste. Whether the boards read well, the blurs are tight and the B-roll matches its words (rows N6, N7, N13, N14) was barely tested, because the test footage rarely called for them. The team's review of a fresh edit is the real test.

## Open for the user
- **Intro punch-ins on bodycam** are rare (teaser zoom 0–0.5) in this loop, as in loop 2. Nothing in JJ's notes asks for them, so I didn't push it.
- **Mom & Teen's intro** is short but calm: its script's teasers are thin on the suspects, and there was no arrest line to end on.
- **Speaker labels** weren't re-checked this loop.
