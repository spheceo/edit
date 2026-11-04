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

## Not fixable here

- **Five of the 22 posts can't be had without an Instagram sign-in:**
  - two are picture-only (`Ct-LPuCAqpo`, the carousel `DU1cnBjEqH7`),
  - two are login-walled (`DT3Z6AFDto7`, `DOGeXt8Dpmc`),
  - and the Doc's `DT9 gaQ0DfEI` link has a space in its text.

  The import's "go on without" covers them. Instagram cookies from Chrome would get them, but that needs a Keychain prompt on the Mac.
