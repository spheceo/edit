# Real Crimes Behind Adult Videos: a horror video from its Doc, Nov 8

Sphe's Doc (https://docs.google.com/document/d/1GIw2TVCO3MwvciNrNq1LJ7gxHfdFG7vAB0zH9Qm7GiE/edit) is a finished 29.5-minute horror script in three cases, with 280 comments of edit directions (Animations 1–13, X posts, Drive screenshots, archive.org and news pages, YouTube ranges). Sphe: "all the website import stuff and ESPECIALLY comments are so important we need to implement every single one perfectly, ensuring that for areas where we need to watch an attatched video, we donload and do frame by fram analysis". Run on the trial server (:7710, `~/.edit-trials`, dev relay) from the `horror-script-run` worktree.

## Fixes

### 1. A script that opens on narration lost everything before its first range
**Broke.** The import kept 24 blocks and 182 of the 280 comments: the cold open, all of Case 1 (Kuriyama) and Case 2 up to Herbert Wong were gone, with the narration beside the first range ("He was taken to the hospital. He did not survive…"). The chapter titles ("The trial", "Case 3: GirlsDoPorn", "Ending"…) were voiced as narration, and so was "Total time = 29.5min".
**Why.** `script.parse` took everything before the first timestamp as the Doc's heading (Writer's title, "Total Duration:" lines). A horror Doc opens on its voice-over, and its footage comes late. Titles and producer's lines were plain paragraphs.
**Fix.** The voice-over starts at the first range or at the first paragraph of narration (a sentence of eight words or more, ended as one), whichever comes first. A Doc heading, or a short all-bold line not ended as a sentence, is a chapter title: never voiced, it starts a cut-in of its own and leaves `Chapter title (on screen, not voiced): …` and its comments on it. A "Total time / Duration / Runtime:" line is never voiced. Now 37 blocks, all 280 comments kept. Tests: `script.test.ts` ("a script that opens on narration keeps it…", "a Writer Doc's heading lines still aren't narration").

### 2. An age-restricted YouTube video failed with the sign-in on Linux
**Broke.** `EMW5MH4VYsY` (the cliff fall, 0:03–0:34) failed: "Sign in to confirm your age", with the YouTube sign-in from Chrome tried and refused too, though Chrome on mandalorian is signed in.
**Why.** yt-dlp picks Chrome's keyring from the desktop session's variables, and a server started outside one (the trial server from a shell, T3, ssh) has none: it guessed "basictext" and decrypted none of the cookies ("Extracted 0 cookies from chrome (54 could not be decrypted)").
**Fix.** `youtube_signin.keyring`: on Linux the cookie source names the keyring (`chrome+gnomekeyring:<profile>`, KWallet under KDE). By hand with it, the same yt-dlp read all 54 and got the video (age limit 18). Tests: `youtube_signin_keyring.test.ts`, `youtube.test.ts`.

### 3. A Drive file a comment links couldn't be brought in
**Broke.** The comments attach 26 Drive files: the channel's screenshot, the English blog post, the X posts in English, archived thumbnails, article screenshots ("Show the Youtube channel screenshot from drive here, zoom in slowly into the top left corner"). No agent tool imported a Drive link: `import_broll` took any non-YouTube https link as a post and asked yt-dlp for its video, and `capture_evidence` would have photographed Drive's viewer page.
**Fix.** `import_broll` takes a Drive file link and fetches it as the script import fetches Drive (the team's sign-in, the virus-scan page, resuming); a picture comes back as image media (kind, width, height) for a commentary_card. Test: `import_broll_drive.test.ts`.

### 4. Nothing checked that a comment's source reached the edit
**Why it matters.** 280 directing comments, most naming a source: a YouTube range to crop, a Drive screenshot, an article to highlight, an archived page to scroll, an X post. Sphe: "ESPECIALLY comments are so important we need to implement every single one perfectly". No audit looked at the notes, so a link the agent skipped left no trace, and Edit's follow-ups never asked for it.
**Fix.** `note_links.ts`: the audit's `note_link_unused` (essay styles) lists each link of a directing note whose source no clip shows: "not brought in", or "brought in, not on the timeline", with the note, its words and the fix. A note that's only a link (the writer's source for the line) isn't asked for. Sources are matched from `research/<project>/broll.json`: import_broll's ranges (a range starting inside the one imported), Drive files, posts, capture_evidence pages (now with the URL asked, so an archived page's `web/*/…` matches its snapshot), and tweet_reference's posts (now kept, shown when a commentary_tweet carries their words). It's in the follow-up's fixable flags. Test: `note_links.test.ts`.
**Verified.** After fix 2, all seven YouTube videos came down on the resumed import, the age-restricted one included.

### 5. The horror workflow didn't say a directing comment is the shot
**Why.** The workflow skill was written for internet-mystery scripts whose links are posts: the agent sources "what the narration needs" itself, and the intro skill opens on a montage of its own choosing. A Doc that directs every line asks for the opposite.
**Fix.** `agent/styles/horror/skills/edit-workflow.md`: each note is the shot for its words, done exactly, with its source, in order; the skills' choices only fill lines with no note; a linked range is imported as given and looked at frame by frame before it's placed (its crop, cut and blur set from what's seen); Drive links, pages and X posts each have their tool; chapter-title notes are commentary_chapter; nothing is left in note_link_unused but what can't be had, said with why.

## Blocked
- **The voice-over (Nov 8, 21:13).** The import's last step speaks the 26 cut-ins (21,105 characters) with the house ElevenLabs voice through the dev relay, and the dev key's quota is spent: "This request exceeds your quota of 1334160. You have 15 credits remaining, while 1048 credits are required". Waiting on Sphe: credit on that account, or the narrator's recording (a "Voice-over: <Drive link>" line in the Doc, which the import places instead).

### 6. A horror edit could start over silent cut-ins
**Why.** The import stopped after three tries at the voice-over (21:19), with the script laid out, so the project counts as imported (`script.unfinished` is false once laid out). The house and commentary workflows say to `generate_voiceover` when the import couldn't; horror's didn't.
**Fix.** The horror workflow's first step: cut-ins with no voice-over get `generate_voiceover` first, unless the user gave the narrator's recording; never edit over silent cards.

### 7. An import stopped at its voice-over couldn't be carried on
**Broke.** Retrying the import (the editor's Retry, `POST /script/job`) answered "this script's import finished: Re-cut to lay it out again", and after a restart `unfinished` was false with all 26 cut-ins silent. The only way back was a Re-cut, which lays the whole edit out again.
**Why.** A laid-out script counted as finished whatever its cut-ins held (`script.laidOut`), in `start`, `unfinished` and the route alike.
**Fix.** `script.unvoiced`: laid out with untouched import cards that have no voice-over (`narrationRecovery`'s "missing"; never a cut-in edited on purpose). Such an import is unfinished, and starting it again (Retry, a restart's recovery, remote support) runs only the voice-over step (`voiceOnly`, the import's own `voiceCutIns`), the edit untouched. A spent quota now stops the retries at once ("quota", as "used up" did): it was asked twice more, minutes apart. Test: `script_tools.test.ts` ("an import stopped at its voice-over is carried on from there").

### 8. capture_evidence: white crops, sign-in gates, the archive's calendar
Checked on a scratch project (`Scratch: horror tool check`) with the comments' own links, while the voice-over waited for credit.
- **A phrase scrolled into view was cropped from an undrawn part of the page: a white picture.** LAist's "threats he made at industry gatherings" came back blank. The crop was the phrase's place in the window, and Chrome's clip takes the page's coordinates; a phrase near the top of a page worked by luck. The crop now adds the page's scroll.
- **LAist's gate.** Once cropped right, the paragraph was under "Want to read more? … just log in", then blurred. The gate is drawn in a shadow root (its words never in the page's text, its 6,000 characters of CSS past the length cap) and comes in as the page is scrolled. `UNWALL` reads shadow roots' words (not their styles), clears the blur and fade a gate leaves, and runs again after the scroll to the phrase. The paragraph now comes through clean, all three of the comments' phrases on it.
- **A Wayback link that leaves the date open** (`web/*/youtube.com/@Ryu-Kuriyama`, `web/*/beginmodeling.com`: four in the comments) opened the archive's calendar. It now stands for the newest good capture at least half the size of the largest (`pickCapture`), so a parked domain's last captures (beginmodeling.com's 541 bytes in 2025) never stand for the site.
- **A page that draws nothing is refused, not captured as a white card.** Archived YouTube pages don't replay (every capture of the channel: a title, no words), so comment [g]'s scroll through the archived channel can't be had from the archive; the error says so, and the channel screenshot on Drive (comments [a], [o]) is the source there.
- A whole-page screenshot gets 90 s, not 20 (an old archived site timed out); a page with no title gives the URL asked.
Tests: `evidence_capture.test.ts`.

## Blocked on the team (found on the scratch project)
- **11 of the 13 Drive files the comments link are private** to marck8131@gmail.com: neither the public link nor Sphe's sign-in can see them (Drive API: 404 to that account). Only `ryu_x_post_3am_EN.png` and the channel screenshot are shared. The rest (the English blog post, the archived thumbnails, the silhouette, the Rokusaisha and Sankei screenshots, the first X post in English…) need "anyone with the link can view", or sharing with the team. The agent will list each as note_link_unused, "can't be had".

### 9. capture_evidence couldn't capture a PDF page
**Broke.** Eight comments ask for a highlight on a page of a court paper ("Statement of Decision page 3, lines 11-12, highlight 'considerable, calculated steps…'", the Aylo agreement's page 39). capture_evidence answered "The requested text/element is not on the loaded page": headless Chrome shows a PDF to no one.
**Fix.** A PDF link is drawn in the capture's Chrome with pdf.js (pinned, from jsdelivr; Chrome is already what captures need, on a Mac and Linux alike, where poppler isn't on the team's Macs): the phrase found on the page given (`page`, new) or the first page holding it, cropped to its lines with one whole line either side; the whole page with no phrase. On the real PDFs: page 3 lines 11–12, page 20 lines 6–7 and page 36 lines 2–4 of the Statement of Decision came out as the comments name them, and the Aylo agreement's page 39 whole. Tests: `evidence_capture.test.ts`.
