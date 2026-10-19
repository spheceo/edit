# Feedback: Corrupt Cop FAKES CRIME — His Own Bodycam BACKFIRES In Court! (Oct 18, Marc on Frame.io)

Project `p1792325414706-2` (cloud, courtroom style). The export reviewed is the project as saved at 17:38 on Oct 18 (exported 18:22–18:36). 10 comments, read from the exported comments text. Times are the export's = the timeline's (30 fps).

## Patterns

| Comments | What the edit did | Cause | Teach | Code / tool |
|---|---|---|---|---|
| 0 "it's unclear who 'Garland Copeland' is… say something like 'defense attorney'"; 2 "text could be a bit bigger here and closer to his head… make the whole background darker so we have a sort of 'spotlight' effect"; 7 "text is really small here, it should be bigger" | Name callouts were the name alone at 44 px, far from the head, on a white courtroom; the reaction tag 44 px | The courtroom NAME CALLOUT rule said name only, ~44, and that it "replaces the age-and-role label and the body vignette" | Callouts say who the person is to the story (the role; the name above it once the narration names them; the role alone in the teasers), ~64 px, close to the head, with the spotlight (body vignette); reaction tags ~64 | audit `small_text` (courtroom callouts/tags/labels under 60 px at 1080p) |
| 1 "let the clip play a bit longer here so he finishes the 'sir'" | The hearing clip ended inside "sir" | nothing checked cuts against the words | final pass: fix every cut_mid_word | audit `cut_mid_word` (footage sound cut inside a word, with where the word ends) |
| 4 "Text needs to be more synced overall" | The desktop profile's lines typed one after another across 60% of it | desktop_profile spaces lines evenly unless given line_at, and the agent didn't give it | lines type as the narration says them | `desktop_profile` now times its lines from the narration under it by default; audit `profile_line_off_speech` |
| 6 "Maybe we can have a light leak transition here?" (the cliffhanger card) | The cliffhanger came in on its blur alone | the courtroom transitions rule: "Into a cliffhanger title the blur itself is the move" | the flash into every cliffhanger title, its blur keying up under it | |
| 8 "these images randomly pop up… a bit annoying for viewers" | A B-roll shot ran across the court stream's switch from the witness to a page of a document | B-roll shots weren't held to one picture | each B-roll shot sits between its footage's cuts | audit `broll_crosses_cut` (`seats.cutsOf`, cached cuts) |
| 9 "Subscribe should be blurred here. This could appear throughout the video" | The source channel's subscribe button showed bottom left | the logo redaction covered the corner logo only; nothing could see the button | blur every source_cta stretch | new: words on screen (`screen_text.rs`, Vision text recognition, cached per file); audit `source_cta` with the box to blur |

## One-offs

- 3 "Love this!" (the date title): keep.
- 4 "nevertheless I love the UI graphics" (the desktop profile): keep.
- 5 "Here we can tease the bodycam footage a bit": taught (TEASE WHAT'S COMING in the courtroom's narration bridges); applied here.
