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
- **A page that draws nothing is refused, not captured as a white card** (only the archive's bar drawn), with what to do.
- **Archived pages were captured before they'd loaded.** The archive serves an old page slowly (its scripts and pictures one by one), and tonight it also throttled and refused connections: the 2007 Sankei article was still loading after a minute and was captured at 15 s with no article on it, and the archived channel page looked blank (I first took that for YouTube not replaying; it was the wait). An archive link now waits up to 90 s for the page and up to a minute more while it's still loading, and Chrome's own error page is refused. On the next try the channel page came through whole (651 subscribers, 303 videos, the "3 a.m." and pet-loss videos, the "18 years" thumbnail), and the Sankei article with 「軽いレイプものを撮るんでね」 cropped.
- A whole-page screenshot gets 90 s, not 20 (an old archived site timed out); a page with no title gives the URL asked.
Tests: `evidence_capture.test.ts`.

## Blocked on the team (found on the scratch project)
- **11 of the 13 Drive files the comments link are private** to marck8131@gmail.com: neither the public link nor Sphe's sign-in can see them (Drive API: 404 to that account). Only `ryu_x_post_3am_EN.png` and the channel screenshot are shared. The rest (the English blog post, the archived thumbnails, the silhouette, the Rokusaisha and Sankei screenshots, the first X post in English…) need "anyone with the link can view", or sharing with the team. The agent will list each as note_link_unused, "can't be had".

### 9. capture_evidence couldn't capture a PDF page
**Broke.** Eight comments ask for a highlight on a page of a court paper ("Statement of Decision page 3, lines 11-12, highlight 'considerable, calculated steps…'", the Aylo agreement's page 39). capture_evidence answered "The requested text/element is not on the loaded page": headless Chrome shows a PDF to no one.
**Fix.** A PDF link is drawn in the capture's Chrome with pdf.js (pinned, from jsdelivr; Chrome is already what captures need, on a Mac and Linux alike, where poppler isn't on the team's Macs): the phrase found on the page given (`page`, new) or the first page holding it, cropped to its lines with one whole line either side; the whole page with no phrase. On the real PDFs: page 3 lines 11–12, page 20 lines 6–7 and page 36 lines 2–4 of the Statement of Decision came out as the comments name them, and the Aylo agreement's page 39 whole. Tests: `evidence_capture.test.ts`.

### 10. Horror's desktop had no windows for what the story's people saw
**Broke.** Fourteen of the Doc's Animation 1 comments ask for windows the old desktop couldn't draw: "retro Internet Explorer window opening his blog post… slow scroll", "old Internet Explorer opens the archived Craigslist San Diego homepage, slow scroll", "retro Windows XP dialog box popping up over his channel page: 'This account has been terminated'", "retro email window (Outlook Express style), new message from 'Jonathan'", "retro instant-messenger chat window", "retro forum window", "a Windows XP dialog box: 'Message blocked'". The desktop had a Video Player, Paint, Notepad and a File Viewer; the horror guide itself names "Windows XP-style dialog boxes, the old Internet Explorer".
**Fix.** Five more XP windows on the same desktop and camera (`desktop.rs`, `desktop_screen.ts`): `browser` (Internet Explorer: the page's capture, its address in the bar, `scroll: true` for a slow scroll: Edit makes the page a video scrolling a screenful every six seconds, eased, and paces it to the window's time, `horror_look.scrollingPages`), `dialog` (XP's error box, its message typed by the icon, OK under it), `email` (Outlook Express with its toolbar; "From:"/"Subject:" lines bold, then the message, typed on), `messenger` (the chat typed a line at a time over its typing box and Send) and `forum` (a message board's posts). The apply_edit_plan description and the horror cut-ins skill say when each is used. Rendered on a scratch project with the archived channel page and the comments' words: the page scrolls down the channel under its address, each window's words type on as it opens, nothing overlaps. Tests: `desktop.rs` (`the_story_windows_draw…`), `edit_plan.test.ts` ("horror's desktop shows what the story's people saw…").

## The edit (Nov 9)
The voice-over's credit came in on Nov 9: Retry voiced and transcribed the 26 cut-ins in 14 min 53 s, and the agent got "Start the editing workflow." By then the 11 Drive files were shared too; the agent had tried them while still private and stood in the pages' Japanese originals online (Rokusaisha, the Sankei verdict's copy, Bunshun), so it's told once its turn ends.

### 11. The horror workflow asked for check_shots over a whole case
**Broke.** check_shots over case 1 was refused: "check at most 120 s at a time". The cut-ins and final-pass skills say two minutes at a time; the workflow's cut-ins step said "check_shots over the case".
**Fix.** `edit-workflow.md`: "check_shots over the case, two minutes at a time".

### 12. Words on the voice were timed by hand, and plans kept being refused for it
**Broke.** Four of the agent's plans in cases 1 and 2 were refused with `motion "words" needs words_at`: "8 ARRESTED" with no words_at, others a frame outside the title or a count off. Each time it read the word times out of get_edit_context and wrote them in again.
**Why.** Edit has the voice's word times (they time the desktop's notes and profile lines already) but asked the agent to copy them for Animation 9.
**Fix.** `hearWords` (`edit_tools.ts`) puts each word of a horror `commentary_text {motion: "words"}` at the frame the voice says it (`edit_review.wordFrames`: in order inside the title's frames, a number as it's said, a word it doesn't say between its neighbours), unless the plan's own words_at fit. Only a title over none of its words is refused, saying so. The cut-ins skill and the tool's description no longer ask for words_at. Also two type errors in the desktop test of fix 10. Test: `edit_review.test.ts`.

### 13. LAist's sign-in gate came back on another article
**Broke.** Cut-in 10's "highlight 'his wish to be an actor'" on LAist's standoff article: capture_evidence twice returned LAist's "just log in to read them" form, not the article, and the agent went to the Wayback copy.
**Why.** Fix 8 took a gate's shadow root off only when its host was fixed, absolute or sticky (the article of Nov 8). On this one the host is a static, 0-pixel div in the article body, and the gate (`allegro-content-gate`) draws its form over the words from inside it.
**Fix.** `UNWALL`: a shadow root of a few words of sign-in is a gate wherever its host sits; one with no such words (a player) stays. Both LAist articles capture clean. Test: `evidence_capture.test.ts`.

### 14. Animation 11's icons lost their words, their counts, and half their pictures
**Broke.** Twenty-one of the Doc's comments are Animation 11 icons ("eight retro person icons, label '8 arrested, December 2004'", "a plane-ticket icon labeled 'Flight to San Diego'", "a plane icon flying off screen", "22 simple person icons appearing one by one"). Of the 12 icons the agent placed in cases 1 and 2, one had its words: it wrote `label`, `count` and `sub`, and Edit read only `name`, dropping the rest without a word, so "8 arrested" was one unlabeled person. Edit drew five icons; for a plane, a ticket, a sword or a glass the agent tried names Edit refused, then put a document.
**Fix.** `horror_graphics.icon`: `label` (the comments' word; `name` still works), `sub` (a smaller line under it), `count` (that many in rows, appearing one by one), `exit` left/right/up (off screen over its last frames), and a key it doesn't know is refused naming what it takes. Eight more icons drawn the same way: building, sword, image, ticket, plane, envelope, door, glass. The cut-ins skill and the tool's description say so. Test: `horror.test.ts`.

### 15. The agent's context filled with the whole audit after every plan, and it stopped half done
**Broke.** The second turn ended with "I've finished the final pass, but several case items from your comments still aren't done" and a long list: the Drive files imported but not placed, the icons not redone, 22 strips, black stretches. Claude Code had compacted the agent's conversation 40 times in two hours, every minute by the end.
**Why.** Every apply_edit_plan answered with the whole project's audit: 44 KB on this edit (26 unused note links, 19 uncovered stretches, 18 strips, 12 placeholders…), of which the plan's own results were 197 bytes, a plan every minute or two.
**Fix.** apply_edit_plan's audit gives the issues within two seconds of what the plan changed (each clip added, removed or changed, where it was and is), the rest counted by kind (`elsewhere`), which review_edit lists in full. Test: `edit_tools.test.ts`.

### 16. A desktop flashed its bare wallpaper as it opened
**Broke.** At 21:21 and 21:28 the agent's desktops showed the wallpaper alone for 2 and 3 frames: its first window opened at start + 2 or 3 (open: false, no zoom from a player to cover it), and it spent a plan butting them up.
**Fix.** `desktop_screen.readSpec`: a first window within half a second of the desktop's start opens at the start. Test: `edit_plan.test.ts`.

### 17. Japanese came out as blank boxes
**Broke.** "Animation 10: … typewriter on the right: 'Ryu Kuriyama' / '栗山龍'": the agent's text showed three boxes for the kanji, so it took the name out.
**Why.** None of Edit's bundled faces has a kanji or kana, and a text was laid out and drawn in its one face.
**Fix.** `edit-render/src/text.rs`: a letter its face has none of is measured and drawn from the fallback face, Noto Sans JP Bold (SIL OFL), cut to kana, full-width forms and the 6,355 JIS X 0208 kanji (2.2 MB); kerning only between letters of one face. Bundled with the others for export and fetched by the browser's preview (`playback.ts`). Test: `text.rs`'s fallback test.

### 18. Every highlight was captured as a strip the horror audit refused
**Broke.** The second turn ended with 22 `horror_screenshot_strip`s "need full-page recaptures": capture_evidence with a phrase crops to the phrase's paragraph (LAist's 696x174, a court paper's two lines), and horror's audit refuses a picture under 220 px tall as "a line cut out of a page". The agent then had to recapture the page and read the words' boxes for highlight_evidence off the picture by eye.
**Fix.** In a horror project, a phrase's capture is the page round it (`aroundCrop`: at least 1,000 px wide round the text's column, 1,000 tall, the phrase in the middle), web pages and PDFs alike, and comes with `phrase_rects`: the phrase's lines' exact boxes in the picture (the words' range in the page; a PDF's text runs cut to the phrase's share of their letters), the rects highlight_evidence takes, and a focus. Checked on LAist's standoff article and the Statement of Decision's page 3. Test: `evidence_capture.test.ts`.

### 19. A desktop with a window too wide said its pictures "weren't prepared"
**Broke.** Turn 3's redone email/dialog/forum desktop was refused with "desktop's pictures weren't prepared (run it through apply_edit_plan)", though it was. Its forum window asked for width 0.7 (the limit is 0.6): working out the frames to draw, that error was swallowed, so no frames were drawn, and the op said the wrong thing.
**Fix.** The desktop op (and a cover_cut_in desktop shot) reads its windows before looking for its frames, so a window the plan got wrong gives its own error. Test: `edit_plan.test.ts`.

### 20. A plan after a highlight was refused for its revision
**Broke.** Three of turn 3's plans in 20 minutes were refused "revision conflict … refresh get_edit_context": the agent planned, highlighted the card it had just placed (highlight_evidence saves the project), and planned again on the first plan's revision, then re-read the context to try again.
**Fix.** highlight_evidence answers with the revision it saved, and a plan holds over highlight marks added since its revision (new marker clips on tracks of their own), as it already did over sounds, starring and smoothing. Test: `plan_rebase.test.ts`.

### 21. look_at_media past a file's end said only "failed to fill whole buffer"
**Broke.** The agent looked at 55–160 s of the FBI most-wanted clip, a 53 s range imported from 0:27–1:20 of its video, timed by the video's own clock: twice "could not decode … failed to fill whole buffer".
**Fix.** look_at_media refuses a start past the file's end saying how long it is and that an imported range starts at 0, and ends a look at the file's end. Test: `edit_tools.test.ts`.

### 22. An archive link with a year landed on the site refusing the archive, then on a parked page
**Broke.** Block 17's "IE window opening the archived modeling sites": the agent's `web/2016/http://www.modelingworks.com/` drew nothing ("the Wayback Machine is slow or refusing just now"). It wasn't slow: every capture of ModelingWorks.com from 2014 on is the site's 403 to the archive, and the archive sends a partial date to whatever it holds nearest. Its nearest good-sized capture (July 2013) is a parked domain's "Related Searches" page.
**Fix.** A Wayback link with a partial date (web/2016/…) stands for the good capture nearest that date, as an open one (web/*/) already did; an exact timestamp is kept. A parked domain's page ("Related Searches", "this domain may be for sale"…) is refused as not the site, saying the archive has no capture of the site then. The archive was refusing this machine's connections by then, so the live check waits. Tests: `evidence_capture.test.ts`.
