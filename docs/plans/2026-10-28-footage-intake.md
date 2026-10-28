# Footage intake that doesn't get stuck

Oct 28. The import is where most of our recent patches went (the bundled qjs for yt-dlp, resuming partial edits, missing compilation cases, archived exports fetched back). Each one fixed a failure after someone hit it. This plan walks the whole intake, from pasting a link to an edit the agent can work on, lists every way it can fail that the code shows today, and proposes to prevent it, recover from it, or say it plainly.

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

## The model to move to

Most of the above comes from three decisions: an import is **one job**, it ends **done or failed**, and laying out is **a one-way door**. Replace them with:

- **Sources, not a job.** A project has a list of sources (each Drive file, YouTube video, folder entry, uploaded file). Each source has a durable state on the server: `checking → waiting → fetching → cutting → hearing → ready`, or `needs you` with a reason and its remedies. A source moves forward on its own, independently of the others.
- **"Needs footage" is a normal project state, not a failure.** Whatever is ready is laid out. Each missing source keeps its place in the script (its blocks know where they go). When it arrives, it's placed into that slot with the insertion machinery `case_insertion.ts` already has: a clean boundary, later work shifted intact.
- **Remedies, the same for the user and the agent:**
  - **Retry.** Shown only when the reason says a retry can help.
  - **Use another link.** A Drive file, YouTube, or a file from this Mac; the new link replaces the source's file for the same blocks.
  - **Skip.** The source's blocks are dropped, and the edit closes the gap.
- **The agent gets the same verbs.** `import_media` accepts links and starts a background source; a `replace_source` tool takes "this is case 1's footage"; and `get_edit_context` lists sources that need you, so the agent edits around them, or asks.

## Order

1. **Bugs, hours each:**
   - Retry that silently fails (12): show the error.
   - Updates wait for imports (10).
   - Stall timeouts (5).
   - Edit's own yt-dlp, kept current (4).
   - Hold off idle sleep (9).
   - Parallel downloads on (7).
   - Honest Doc errors (2).
2. **Authenticated Drive reads, public link as fallback (1).** Removes a whole class of "isn't shared" and quota failures.
3. **Progress you can trust (14).** Small, and it tells us where the time actually goes.
4. **Preflight checklist (3, 8, 16).**
5. **Sources and "needs footage" (11, 12, 13, 15).** The big one: durable per-source jobs, late placement, the remedies, the Drive-link import moved onto it, the agent's tools.
6. **A fault-injection test**, so we stop learning failures from the team. Fake Drive, YouTube and relay endpoints that stall mid-body, answer 403/429/5xx, cut short, or send the virus-scan page, plus a server killed mid-import. An end-to-end import must end with every healthy source ready and each broken one in "needs you" with the right reason.

Each step teaches the agent its part (the `edit-workflow` skill: what "needs footage" means and when to ask), as AGENTS.md asks.

## Open questions

- **YouTube behind a sign-in:** may Edit use the editor's Chrome cookies (`--cookies-from-browser`) when they choose to, or do we only ask for another link?
- **With footage missing:** should the agent start the edit around the gap, or wait until the user decides?
- **Skip:** does it drop the source's blocks outright, or leave a marked gap for later?
