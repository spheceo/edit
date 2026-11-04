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

## Not fixable here

- **Five of the 22 posts can't be had without an Instagram sign-in:**
  - two are picture-only (`Ct-LPuCAqpo`, the carousel `DU1cnBjEqH7`),
  - two are login-walled (`DT3Z6AFDto7`, `DOGeXt8Dpmc`),
  - and the Doc's `DT9 gaQ0DfEI` link has a space in its text.

  The import's "go on without" covers them. Instagram cookies from Chrome would get them, but that needs a Keychain prompt on the Mac.
