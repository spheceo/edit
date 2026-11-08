# Real Crimes Behind Adult Videos: a horror video from its Doc, Nov 8

Sphe's Doc (https://docs.google.com/document/d/1GIw2TVCO3MwvciNrNq1LJ7gxHfdFG7vAB0zH9Qm7GiE/edit) is a finished 29.5-minute horror script in three cases, with 280 comments of edit directions (Animations 1–13, X posts, Drive screenshots, archive.org and news pages, YouTube ranges). Sphe: "all the website import stuff and ESPECIALLY comments are so important we need to implement every single one perfectly, ensuring that for areas where we need to watch an attatched video, we donload and do frame by fram analysis". Run on the trial server (:7710, `~/.edit-trials`, dev relay) from the `horror-script-run` worktree.

## Fixes

### 1. A script that opens on narration lost everything before its first range
**Broke.** The import kept 24 blocks and 182 of the 280 comments: the cold open, all of Case 1 (Kuriyama) and Case 2 up to Herbert Wong were gone, with the narration beside the first range ("He was taken to the hospital. He did not survive…"). The chapter titles ("The trial", "Case 3: GirlsDoPorn", "Ending"…) were voiced as narration, and so was "Total time = 29.5min".
**Why.** `script.parse` took everything before the first timestamp as the Doc's heading (Writer's title, "Total Duration:" lines). A horror Doc opens on its voice-over, and its footage comes late. Titles and producer's lines were plain paragraphs.
**Fix.** The voice-over starts at the first range or at the first paragraph of narration (a sentence of eight words or more, ended as one), whichever comes first. A Doc heading, or a short all-bold line not ended as a sentence, is a chapter title: never voiced, it starts a cut-in of its own and leaves `Chapter title (on screen, not voiced): …` and its comments on it. A "Total time / Duration / Runtime:" line is never voiced. Now 37 blocks, all 280 comments kept. Tests: `script.test.ts` ("a script that opens on narration keeps it…", "a Writer Doc's heading lines still aren't narration").
