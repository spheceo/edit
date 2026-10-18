# Feedback: Mom & Teen Daughter Buries Newborn in Bucket (v3, Oct 17, JJ on Frame.io)

Project `p1792073727044-316` (cloud). The comments came as an exported text (the link was a signed-in one, not a share link); timeline as exported at 14:27 = history `1792249847026.json` (unchanged at these points now).

| # | Time | JJ | What was there | Cause | Teach | Code / tool |
|---|---|---|---|---|---|---|
| 0 | 0:01 | add the officer's "Yeah, there it is. God damn it."; "It is really important that we ensure that the intro and all clips in the video are exactly according to the script" | range 4:32–4:38 "start…it" cut at 277.49 (the "it" of "there it is"), the clip ended 277.2 | an older import's cut (today's `align` finds 278.44); nothing checked a range played whole | core: THE SCRIPT IS THE EDIT | audit `off_script` (each range found again in the transcript; > 0.25 s unplayed) |
| 1 | 0:05 | "come on baby" is said here | caption "Come on. Come out here." | caption words not checked against the transcript | core: captions say exactly what's said | audit `text_not_said` |
| 2 | 0:09 | not a fan of this transition (in general, the user says) | vertical drop into cut-in 1 | the intro rule asked for drops | intro/transitions/cut-ins: never the drop unless asked | `cover_cut_in` into defaults to none |
| 3 | 0:16 | make a dissolve | hard cut between cut-in 1's two shots | allowed, never done | cut-ins: shots of different moments dissolve | `cover_cut_in` dissolves (12 frames) by default |
| 4–5 | 0:19, 0:22 | more clips; "2 clips for this entire cut in is simply not enough" | 13 s, 2 shots | as Mom Leaves 5 Kids | (taught there: a shot every 2–4 s) | `long_broll_shot` |
| 6 | 0:27 | "all blurrings must always be under the subtitles" | child-privacy blur on a track above the intro captions | `text_under_blur` only fired where the box seemed to cover the words | core: words never under a blur | `liftTextOverBlurs` after every plan, caption_speakers and add_subtitles; the audit flags any blur above text in time |

Also applied here: subtitle and caption colours by role (the team's FOIA subtitle guide), as for every project.
