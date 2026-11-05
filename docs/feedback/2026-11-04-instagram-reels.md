# Instagram Reels With Disturbing Backstories: the first horror edit

Sphe's test for the new horror style (the team's "Horror High Quality - Editing Rules & Processes" guide), Nov 4. Inputs: Marc's script Doc (narration plus about 30 Instagram and X links) and the narrator's 10:41 recording on Drive. Decisions: a vertical reel stands over a blurred, darkened copy of itself; the ban list applies to the narrator too ("yeah i think so lets go with that").

## Fixes on the way

1. **No horror style.** Added `Style::Horror`, made it an essay like commentary (`isEssay`), and added `agent/styles/horror` (notes and nine skills in the guide's words). Edit applies the analog look by itself:
   - `commentary_look` covers every frame, with chromatic aberration and an unsharp mask added to the shared grade.
   - Screenshots get a retro copy.
   - Reels get blurred backdrops.
   - `horror_look_missing` audits the look.
2. **Edit's Google sign-in couldn't read Marc's Doc.** Used the dialog's own fallback: pasted its text.
3. **A plain-text paste with only post links wasn't a script.** Posts are now footage: `post:<link, base64url>`, downloaded whole by yt-dlp without a sign-in and laid out where they're linked. Their links are never voiced. Bare footage links in a paste are read as links.
4. **The intro's "(0:00-0:01) + (0:58-1:03)" had no links,** and it bound to the only Drive file, which was the recording. Unlinked ranges are now a note on the next narration, and posts never claim them.
5. **The recording had no way in before the agent starts.** The New project voice-over box was gone, and the first message goes out when the import is done, so the edit would be timed to the stand-in voice. Now "Voice-over: <Drive link>" in the script is its recording, fetched before the voice-over is placed. The Script box says so for recording-narrated kinds.
6. **edit-core refused `post:` files** ("without path separators"). The link is now base64url, and validate accepts `post:`.
7. **A refused script left an empty project behind** on every try. Now removed.
8. **Posts reached R2, then failed cutting** with "no proxy key". `proxyKey` now knows `post:`.

9. **A restart cut off the first import,** leaving an empty project whose first message would wait forever. Every import is now a durable job.
10. **The page refused the project:** its copy of the script-file rule only knew Drive, YouTube and shared masters. It now matches edit-core.
11. **The paused import had nothing to press anywhere.** The Downloads tab is gone. The Viewer now lists each missing file with its answers, plus "Go on without them" (one call; one at a time, the second skip was refused).
12. **Unreachable posts were retried for 8 minutes.** Picture-only and sign-in-only posts now say so plainly and wait for the person at once.
13. **Three cut-ins got the stand-in voice while 4 minutes of the recording went unused.** The narrator rewrote parts of the script, and read a last case the Doc doesn't have. Placement now:
    - places unmatched cut-ins by order (the recording between their neighbours' readings, several split at pauses),
    - runs the last cut-in to the end of the recording,
    - and lets stand-ins step aside when the recording is there.
14. **The agent called `commentary_look` as a tool**, and the look never went on. The teaching and the audit now name it as an `apply_edit_plan` operation.
15. **`cover_cut_in` cropped the reels to fill** and added its own film look. In horror it now fits tall reels, which get the blurred backdrop, and adds no look.

## Round 2 (Nov 5): the guide to the letter

Sphe asked whether the first draft followed the guide exactly. It didn't, so I re-read the guide, downloaded its 16 reference images and 31 of its 32 linked moments, and studied them frame by frame. Then I built what the draft lacked:

16. **The guide's animations didn't exist:**
    - Titles in the references' looks:
      - Styks' bold over a blurred picture (Animations 2 and 7);
      - Sirius' Arial dates, serif places, VHS name tags on black, and words on the voice (9);
      - yellow typed quotes (13).
    - A red highlighter with torn edges and a glow (4).
    - Pages filling the frame, close on the words read (6, and the guide's own frames).
    - Icons drawn by Edit over a word (11), a picture beside typed words (10), and a CC Lens.
    - An XP desktop, with Internet Explorer on an old YouTube player (1).
    - Faces as mosaics.

    New pieces: VT323, Tinos and Arimo bundled, `grade.lens`, and `blur.mosaic`.
17. **The draft's screenshots were thin strips** (one headline, 817×75) and an Instagram sign-in wall. Now capture_evidence takes the whole page, and the audit flags `horror_screenshot_strip`.
18. **Two rules weren't checked:** "The same clip never repeats" (now `horror_repeated_clip`, any shared second), and competitor footage (left out of B-roll searches and refused at import).
19. **The fade through black was 24–36 frames.** The references fade about 0.75 s each way, so it's now 40–48.
20. **The web page wouldn't load:** Vite had cached `@edit/types` from before its `./models` export. Touching `vite.config.ts` made it re-read.

21. **look_at_media failed on a frame at a video's very end** ("failed to fill whole buffer": an 8.0 s map sampled at 8.0 s). The audit hit the same thing on slowed copies. The reader now backs off a second and holds the last frame.
22. **Cut-in 18 was refused three times** ("m22 runs out at 13.84 s"). In horror, a picture shot became a Photo Viewer desktop that opened by carrying on the post before it, which had just ended. A horror picture shot is now Animation 5 (the picture in its white outline over a blurred copy of itself). A desktop's player never plays past its footage.
23. **v2's first pass:** 6 screenshots, none highlighted, and a quarter of the B-roll stock (modern phones, a vintage TV). The audit now flags `horror_unhighlighted_screenshot` and `horror_stock_heavy`.
24. **"Edit crashed during the imports"** was me: commits to `apps/server/src` restarted the dev server mid-turn four times, and the background imports died with it. Don't touch server code while the agent works on a dev project.

25. **The agent gave up on its B-roll imports after about five minutes** while YouTube was still downloading them (one to four minutes a video). `wait {for: ["import"]}` now waits for them, and the "still working" answer tells it to wait rather than give up.
26. **Every YouTube range from 0 s failed** with "did not cover its requested source range": the download came back a fraction of a second short. `import_broll` now takes what's there and says where it ends.
27. **Stills shown as screenshots** (an anime figure, TV static) got the retro grid and were waiting for a highlight. The skill and the audit now say any picture that isn't a page of words is `photo: true`.
28. **Photo cards with nothing under them sat on black.** They now stand over a blurred copy of their own picture. A page given no focus is framed on its middle and top.

v2 was shared from prod Edit (14:41): https://feedback.spheceo.com/r/c8ydd2_h4ArYqtMEkISUxA.

## Not fixable here

- **Five of the 22 posts can't be had without an Instagram sign-in:**
  - two are picture-only (`Ct-LPuCAqpo`, the carousel `DU1cnBjEqH7`),
  - two are login-walled (`DT3Z6AFDto7`, `DOGeXt8Dpmc`),
  - and the Doc's `DT9 gaQ0DfEI` link has a space in its text.

  The import's "go on without" covers them. Instagram cookies from Chrome would get them, but that needs a Keychain prompt on the Mac.
- **A review shared from the dev server can't open.** Dev Convex (`determined-heron-867`) has `REVIEW_SITE_URL=https://feedback.spheceo.com`, but that site reads only prod, so the dev link said "This link opens nothing." Instead, the finished export was shared from prod Edit (nightly-55) as its own project: https://feedback.spheceo.com/r/YqGI5rhpT4qw_VuT_QKpig. The fix is a dev review site (the feedback worker on dev Convex) with dev's `REVIEW_SITE_URL` pointed at it. That's new infrastructure, so it waits for Sphe.
