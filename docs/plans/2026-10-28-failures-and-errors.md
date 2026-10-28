# Edit that doesn't get stuck: failures, prevention and plain errors

Oct 28. Most of our recent patches fixed a failure after someone hit it: the bundled qjs for yt-dlp, resuming partial edits, missing compilation cases, archived exports fetched back. This plan walks the whole flow, from pasting a link through the agent's edit to the export and review, and lists every way it can fail that the code and the logs show. For each one it proposes to **prevent** it, **recover** from it, or, when it genuinely can't be helped, **say** it in plain words with what to do.

The user's brief: "look at EVERY way an error can come up … rewrite all errors to be way more beginner friendly … only when we've tried to handle/fix all ways in which the app can fail; if some specific scenarios genuinely fail, then we show a friendly error."

## Done (Oct 28)

- **Plain errors everywhere a person looks** (`packages/edit-types/src/problems.ts`, `ProblemView`).
  - One `explain(error, doing)` gives a short title, what to do, and one button (Sign in, Sign in to Claude, Try again).
  - The original words sit behind Details and Report.
  - Every toast, the import panel, export activity, the preview, transcripts, the agent's chat and the editor's crash screen use it.
  - Its rules come from the messages in the logs; a message already written for people is shown as it is, anything else gets "Couldn't <what you were doing>".
  - The agent still gets the precise words, since it needs them to fix its own work.
- **The import's Retry says why it can't** instead of quietly doing nothing (12, the message; the hole itself is still open, below).
- **Imports don't freeze or fail for nothing:**
  - Docs and Drive files are read with the team's Google sign-in first (1). The sign-in is never sent past a redirect.
  - Doc errors are honest (2).
  - A minute of silence drops and resumes a Drive download (5).
  - A yt-dlp that says nothing for 10 minutes is stopped and tried again (5).
  - Edit's own yt-dlp is used and kept current, and refreshed and retried when YouTube outdates it (4).
  - Downloads run three at a time (7).
  - Updates wait for imports (10).
  - The Mac is kept awake while an import, export, upload or agent turn runs (9).
- **YouTube with the editor's sign-in from Chrome** (6):
  - A refused video is asked again with Chrome's signed-in profile (never through the proxy).
  - Settings → YouTube explains the set-up step by step, with a Check that brings up the Mac's Keychain dialog while the instructions are on screen.
- **Footage that can't be fetched waits for the person** (12, 15):
  - Edit tries a failed file again by itself, after a minute and after five more, when the failure might pass.
  - Still missing: nothing is laid out with a hole. The import waits ("Waiting for you") with the two answers the team asked for, "Do we just proceed without it? Do you have a replacement?": **I have a replacement** (a Drive or YouTube link of the same recording) or **Go on without it** (its ranges leave the script).
  - The agent hears it in `get_edit_context`'s `import`, asks the person the same, and answers with `replace_footage` / `skip_footage` (the `edit-workflow` skill).
  - The voice-over step tries again by itself too.
- **Retry only where the person's action changes the answer** (the team: "not give users a lot of retry options … if we have retried and saying retry won't help, don't give that option"):
  - Try again is offered only after sharing a file, setting up the YouTube sign-in, or freeing space.
  - The import's job-level Retry is gone.
  - Error wording no longer says "try again" where Edit retries itself.
- **The log keeps real failures**: background smoothing of a clip that changed or went away is a skip, not an error (it was 600+ of the log's errors).

## What the code does today

A script import is one job held in memory (`script.ts` `Jobs`, `start`):

1. Read the Doc anonymously, as its public link (`fetchDoc`).
2. Fetch each footage file **one after another** (`EDIT_PARALLEL_DOWNLOADS` has been opt-in since Oct 19): Drive through the relay's cloud copy or this Mac; YouTube with yt-dlp on this Mac, then up to R2.
3. Cut excerpts, transcribe, lay out whatever arrived, then voice it.
4. End as `done` or `failed`.

Once any block is placed, the project counts as **laid out**, and that can't be undone: `start` returns null and the resume route answers 409 ("Re-cut to lay it out again"), and a Re-cut clears the layout.

A Drive link pasted in the media browser (`/import-drive`, `drive_import.ts`) is a single HTTP request held open for the whole download. It fetches the files one after another, reports no progress (`drive_import.ts:68` passes `() => {}`), and if any one file fails, the whole import fails.

## Failure catalogue

Each item: what goes wrong, the evidence, and the fix (**prevent** it, **recover** from it, or **say** it plainly).

### Reading the script and its links

1. **A private Doc or Drive file fails, though Edit has the team's Drive token.** `library.accessToken()` covers all of Drive, and folder listing already uses it. Docs (`fetchDoc`) and file downloads (`resolve`/`download`) still go through the anonymous public link. Even in cloud mode, `driveOriginal` calls the anonymous `resolve` (`cloud_media.ts:777`) before handing the file to the relay, which *does* use the token, so an unshared file fails before the relay is ever asked. **Prevent:** read Docs through Drive's export API and files through `files.get` + `alt=media` with the token; use the public link only as a fallback. This also gets past the virus-scan page and the anonymous "Too many users" quota.
2. **Every Doc failure says "Share it so anyone with the link can view"** (`script.ts:153`), including timeouts, Google 429s and 5xxs. **Say:** tell those cases apart; only a 401/403 or a sign-in redirect means sharing.
3. **Problems surface an hour in, not at paste time.** A private, age-restricted, members-only, region-locked, deleted or still-live YouTube video, an empty Drive folder, or a Google Doc linked where footage should be: each is only found when its turn comes in the serial queue. **Prevent:** a preflight before the project is made. One cheap check per source (Drive `files.get`; `yt-dlp -J` without downloading) shows a checklist: name, length, size, ✓ or the reason it won't work, with "Import anyway" for the rest.

### Downloading

4. **yt-dlp goes stale.** `ytdlp()` prefers any yt-dlp on PATH (on this Mac, Homebrew's 2026.08.19, two months old) over Edit's own copy, and Edit's copy is fetched once and never updated. YouTube breaks old yt-dlp versions every few weeks, and the qjs fix was one such break. **Prevent:** always run Edit's own copy (`EDIT_YTDLP` stays as the override); update it in the background once a day (checksum-verified, as now); when a failure looks like an extractor error, update and retry once.
5. **A dead connection hangs forever.** The local Drive fetch reads the body with no idle timeout (`script.ts:1175`), and a whole YouTube download has no timer (only ranges get 12 min). A Wi-Fi change or a half-open TCP connection leaves the bar frozen. **Prevent:** the stall rule the cloud stream already has (`cloud.Stall`): no bytes for 60 s → abort and resume from the partial file.
6. **YouTube videos behind a sign-in can't be fetched at all** (age-restricted, members-only). **Recover:** the source is marked "needs you" with its remedies (see 12). Optionally, yt-dlp's `--cookies-from-browser chrome`, opt-in per video. That's an open question below.
7. **Files are fetched one after another.** Ten files take the sum of their times. **Prevent:** parallel by default (3 at a time, as the semaphore already allows), largest first.
8. **No space check.** YouTube downloads go to local scratch even in cloud mode, and local mode keeps whole Drive files. Free space is only measured for the Storage view (`storage.ts:184`). **Prevent:** preflight compares the sizes against free space and says so before starting.
9. **The Mac can sleep mid-import.** Nothing holds off idle sleep (no `caffeinate` or IOPMAssertion anywhere). **Prevent:** hold an idle-sleep assertion (`caffeinate -i -w <server pid>`, or the addon) while any import, export or upload runs.
10. **An update restarts the server mid-import.** `installUpdate` waits for exports and Drive uploads (`routes.ts:400`) but not script imports or Drive-link imports, and remote updates don't wait for them either. **Prevent:** count imports as running work.
11. **After a restart, only the browser resumes an import**, and only when that project is opened (`web/src/lib/store.ts:493`). Close the window or open another project, and it sits. The Drive-link import isn't a job at all. **Prevent:** every import becomes a durable job in `jobs.ts` (as `case` already is), resumed by the server at start-up.

### Partial failure

12. **One failed file leaves a hole that can't be filled.** The rest is laid out, `laidOut` is set, and the panel's **Retry** gets a 409 and quietly stops spinning (`ScriptPanel.tsx:225` has no catch, so nothing is shown). The only way out is a Re-cut, which clears the layout. `insert_compilation_case` can't fill the hole either: it adds a *new* case, and it requires the original to be laid out first.
13. **The Drive-link import is all-or-nothing**, and its files are fetched one after another with no progress.

### Progress you can trust (the "stuck at 5%")

14. **The numbers can sit still while work is happening.** `import_progress.ts` gives every file an equal share whatever its size, counts each file's download as 60% of its share, and scales the footage part to 85%. Ten files, with the first one 60% downloaded, show 5%. With serial downloads it stays near there for the first file's whole duration. On top of that, several phases report nothing:
   - The relay's cloud copy counts only finished 64 MiB parts, four at a time.
   - A YouTube upload to R2 after its download shows a full bar.
   - A whole-file proxy encode (`cloud_media.ts:1044`, no `onCut` calls) sits at 60%.
   - Transcription is a fixed 88% and voicing a fixed 97%.

   This Mac's logs don't hold the team's runs, so I can't say which of these the 5% was; the fix below makes that visible next time. **Say:**
   - Weight by bytes (or seconds of footage).
   - Report every phase.
   - Show speed, ETA and "last activity 12 s ago", so slow and stuck look different.
   - After 3 minutes with nothing moving, say so and say what Edit is doing about it (retrying, switching route).

### The agent and footage

15. **The agent can't take a link.** `import_media` takes absolute paths only. `import_broll` takes YouTube ranges for commentary. `insert_compilation_case` adds a new case to a laid-out compilation. Nothing lets the agent hear "here's the footage for case 1" and act on it.

### Later stages, from the logs

16. **Daily allowances are found mid-import.** On Oct 21 the import was laid out again ~25 times in 20 minutes, each time failing its voice-over on the transcription allowance (429). On Oct 22 thirty watch windows failed in seconds on "no Gemini model left today". **Prevent:** preflight estimates the hours an import will need against what's left today, and says so before starting. A job that fails on an allowance waits for the reset instead of retrying.

### Beyond the import: every other stage

From the code and this Mac's logs (`~/.edit/logs`, Oct 16–28; the team's runs are on their Macs).

17. **Daily allowances fail one request at a time.**
    - The logs: 764 transcriptions failed on a used-up allowance, plus 2,929 "busy, asking again"; 475 watch windows failed on "no Gemini model left today", plus 1,422 retries; 75 failed on the AI gateway's credit.
    - Each piece of work asks, fails, and logs, and nothing resumes after the reset.
    - **Prevent:**
      - Once a service says its day is used up, Edit remembers that until the reset and asks no more.
      - It shows one notice ("Transcription resumes at 2:00").
      - It resumes the waiting work by itself after the reset.
      - The import's preflight estimates the hours it needs against what's left.
      - The relay warns an admin before the AI gateway's credit runs out.
18. **Signed out, the background keeps polling.** Reviews (136) and archives (103) failed on "Sign in to Edit" over and over. **Prevent:** while signed out, the background loops pause and one Sign in prompt shows; they resume on sign-in.
19. **An export that can't start is refused, not queued.**
    - "An export is already running" was refused 115 times, and "a map view is still rendering" 62.
    - **Prevent:** the export joins the queue and starts when the map is drawn or the other export finishes, saying so.
    - **Prevent:** preflight checks the export's estimated size against the disk's free space.
20. **The agent's turn ends on a Claude limit or sign-in.** Sign-in is handled (Settings → Claude). A usage limit ends a full edit midway. **Recover:** the turn is saved with "resumes at <time>" and carried on by itself after the reset, as a restart's turn already is.
21. **The preview.**
    - "Decoding failed: HTTP …" 452 times (the R2 CORS cause was fixed Oct 24), the graphics adapter missing 27, wgpu validation errors 17, React's "maximum update depth" 27.
    - **Say:** now plain. **Prevent:** each is a bug to fix by its own report; the update-depth loop and the validation error need their causes found.
22. **Errors travel by copy and paste.**
    - The Report dialog copies text ("Nothing is sent anywhere"), and a teammate pastes it to whoever fixes Edit.
    - **Recover:** a Send button that puts the report (log, timings, the error) on the relay for the team's support page, so the person sees "Sent: we'll look" and nothing to copy.
    - This sends logs off the Mac: it's the user's call.

## A full run-through (Oct 28, nightly-29)

The new Doc ("Cop Beats a HANDCUFFED Teen in His Patrol Car", courtroom, 5 YouTube videos, the user's recording) taken from paste to a review link the way a teammate would: <https://feedback.spheceo.com/r/E4l2mySUxtylewfsxVZFWA>.

- **Import:** 7 minutes, no errors: five videos at once, cut, transcribed, laid out and voiced.
- **Research:** 4 minutes, 6 articles. **The edit:** about 30 minutes, 24½ minutes long.
- **Export and share:** 13 minutes.

What it hit, and what changed:

- **The export failed** reading past the end of a 2.8 s smoothed render. In the final pass the agent had set a clip's `source_in` to 60 s, in the original's clock, after background smoothing had swapped the clip onto its render.
  - Plans and `update_clip(s)` now refuse a clip that plays past its media.
  - The agent fixed it (and another like it) when told.
  - The same "failed to fill whole buffer" is 20+ times in older logs.
- **After a restart**, resumed smoothing read its footage before the sign-in was back (401) and kept two shots unsmoothed. Resuming now waits for the sign-in.
- **The watcher's windows** failed within a second on the AI gateway's "too many at once". The next try now waits.
- **A YouTube download's bar** went back (89% → 85%) as its sound began. Now the whole size from the start.
- **The agent's chat** showed a red alert when the agent worked around a step itself (a site's bot check), and the restart note stayed red after the agent carried on. Both are fixed.
- **Still open:**
  - "Making the review copy" sat 3+ minutes with no percentage (14).
  - JJ's courtroom voice waits for the voice to use (below).

**JJ (Oct 28):** "I selected the courtroom edit option, but the voice was the one from bodycam."
- Edit had one house voice for every style. A courtroom's narration was meant to be the team's own recording, and JJ's project had none, so the house voice stayed.
- A style can now name its narrator: `voice: <ElevenLabs voice id>` in `agent/styles/<style>/notes.md`'s frontmatter. Only the id is missing.

## The model to move to

Most of the above comes from three decisions: an import is **one job**, it ends **done or failed**, and laying out is **a one-way door**. Replace them with:

- **Sources, not a job.** A project has a list of sources (each Drive file, YouTube video, folder entry, uploaded file). Each source has a durable state on the server: `checking → waiting → fetching → cutting → hearing → ready`, or `needs you` with a reason and its remedies. A source moves forward on its own, independently of the others.
- **"Needs footage" is a normal project state, not a failure.** Whatever is ready is laid out. Each missing source keeps its place in the script (its blocks know where they go). When it arrives, it's placed into that slot with the insertion machinery `case_insertion.ts` already has: a clean boundary, later work shifted intact.
- **Remedies, the same for the user and the agent:**
  - **Retry.** Shown only when the reason says a retry can help.
  - **Use another link.** A Drive file, YouTube, or a file from this Mac; the new link replaces the source's file for the same blocks.
  - **Skip.** The source's blocks are dropped, and the edit closes the gap.
- **The agent gets the same verbs.** `import_media` accepts links and starts a background source; a `replace_source` tool takes "this is case 1's footage"; and `get_edit_context` lists sources that need you, so the agent edits around them, or asks.

## Order (what's left)

1. **Progress you can trust (14).** Small, and it tells us where the time actually goes.
2. **Allowances as one notice, resumed after the reset (17), and signed-out pauses (18).** These were most of the log's failures.
3. **Exports queue instead of refusing (19), and the disk check.**
4. **Preflight checklist (3, 8, 16, 17).**
5. **The rest of "needs footage" (11, 13):**
   - imports resumed by the server after a restart, not only when the project is opened;
   - a replacement from a file on this Mac (today: a Drive or YouTube link);
   - the media browser's Drive-link import as a job, with the same waiting and answers.
6. **The agent's turn carried on after a Claude limit (20).**
7. **A fault-injection test**, so we stop learning failures from the team:
   - fake Drive, YouTube and relay endpoints that stall mid-body, answer 403/429/5xx, cut short, or send the virus-scan page;
   - a server killed mid-import.

   An end-to-end import must end with every healthy source ready and each broken one in "needs you" with the right reason.

Each step teaches the agent its part (the `edit-workflow` skill: what "needs footage" means and when to ask), as AGENTS.md asks.

## Open questions

- **YouTube behind a sign-in:** answered (Oct 28): Chrome's sign-in by default, with instructions. Done.
- **With footage missing:** answered (Oct 28): wait, and ask "Do we just proceed without it? Do you have a replacement?". Done.
- **Retry options:** answered (Oct 28): none where Edit retries itself or retrying can't help. Done.
- **Skip:** removes the footage's ranges from the script; the narration around it stays (done). Say if a marked placeholder is wanted instead.
- **Send a report:** may a report go from the Mac to the relay for the team (22)?
