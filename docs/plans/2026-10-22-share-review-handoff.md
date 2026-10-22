# Writer → Edit → Repack: sharing, review and handoff (plan, Oct 22)

The user's direction: **Writer** is where scripts are written, **Edit** where videos are edited and subtitled, and **Repack** becomes mainly the sharing and review hub, since it's a web app with links. Repack keeps its own script and subtitle features. One idea should travel from footage to script to edit without anyone downloading, transcribing or retyping anything twice.

Three agents build it, one per repo: Repack's thread, Writer's thread, and Edit's (the coordinator, which owns this plan). Each commits in its own repo. **Only Repack's thread pushes Convex**: every function and the schema live in `repack/apps/web/convex/`, and parallel pushes have dropped each other's tables before. Edit and Writer ask it for the functions they need, using the contracts below.

The user's decisions:
- **Reviewers:** anyone with the link comments under a name they type, no account.
- **What's shared:** Edit shares the exported video, comments pinned to timecodes, replacing Frame.io. Writer shares the script, comments anchored to its text.
- **Fixing:** when the app is open, its agent fixes new feedback by itself. The app marks the ranges the agent changed for each note, and hovering shows the note, so you can check the agent did what was asked even after forgetting what you said.
- **Deploying:** Convex and Repack may be deployed. Railway is paused: check every 15 minutes for an hour, and if it's still paused, leave the changes ready but not deployed.

## What exists (Oct 22 reports)
- **Repack:**
  - Script share links (`script_shares`, `/s/[token]`) with guest names (`guestMark()`, httpOnly cookie, names up to 60 characters).
  - Notes inside clips, with no done state. No player for a finished video, and no presigned uploads.
  - Convex tables `editProjects`, `editLocks` and `editMedia` (Edit) and `writerScripts` (Writer). Each app reaches Convex through its own Cloudflare relay with the service token.
- **Edit:**
  - Cloud projects with locks, and a footage registry by source (`drive:<id>`, `drive:<id>#a-b`, `youtube:<id>`, `sha256:<hex>`).
  - R2 under `edit/originals|excerpts|proxies|analysis/…`, with the transcripts and the watcher's answers in `analysis`.
  - Modal exports that pass through R2. `read_review` for Frame.io. An agent that accepts plain text.
- **Writer:**
  - Tauri: Rust does the work, React is the UI. Scripts are folders synced to `writer/scripts/<id>/` through `writer-relay`, footage and transcripts included.
  - Scribe v2 with no keyterms, in roughly 2-hour pieces.
  - Joined Drive cases keep only a 480p proxy: their originals are deleted.
  - Agents run through the user's Claude CLI, one structured answer per turn. Revising from comments is manual and has no anchors.

## 1. Reviews (Repack owns them; both apps use them)

**Tables** (Repack's Convex):
- `reviews`: `{app: "writer"|"edit", sourceId, title, token, access: "open"|"closed", currentVersion, createdBy, updatedAt}`. Indexes: `by_token`, `by_source`, `by_app_updated`.
- `reviewVersions`: `{reviewId, n, sourceRev, kind: "video"|"script", key, meta, createdAt}`.
  - `key` is the app's own R2 key: `edit/reviews/<reviewId>/v<n>/video.mp4` (plus `poster.jpg`), or `writer/reviews/<reviewId>/v<n>/script.json`. Each relay already presigns its own prefix, so no new upload rights are needed.
  - `meta` for Edit: `{fps, durationMs, clipMap}`, where `clipMap` is the clips under each stretch of the export, so a note's time still finds its moment after later edits. For Writer: the blocks' ids and texts.
- `reviewNotes`: `{reviewId, version, parentId?, anchor, text, author, guest, status: "open"|"done", doneInVersion?, changedRanges?, fixSummary?, attempt?, createdAt, updatedAt}`.
  - `anchor` is `{kind: "time", ms, endMs?}` or `{kind: "text", blockId, start, end, quote}`.
  - `attempt` is `{by, at}`: the durable marker that stops a note being fixed twice.

**Functions** (each relay forces its own `app`):
- `reviews:publish({app, sourceId, title, kind, key, meta})` → `{reviewId, token, url, version}`. It makes the review the first time, and a new version (same token) after that.
- `reviews:open({app})` → the open-note counts per `sourceId`, for badges.
- `reviews:changes({app, since})` → notes created or changed since then.
- `reviews:claim({noteIds, by})` → the notes not already claimed, for the agent run.
- `reviews:resolve({noteId, version, changedRanges, fixSummary})`, and `reviews:reply`.

**Guest page:** `/r/[token]`, live through a public Convex query keyed by the token.
- Writes go through Next routes that reuse `guestMark()` and the name rules, with a per-guest rate limit and a cap on notes per review.
- Video: a plain `<video>` on a presigned GET, with markers on the seek bar and comments pinned to the current time (with an optional end). Script: the text, with highlights.
- The app's icon and name ("Edit" / "Writer") in the header, and a version switcher.
- Each note shows open or done; a done note shows its fix summary and the version that fixed it.

**Repack's dashboard:** a list of every review, with its app's icon and the open count.

## 2. Feedback back in the apps (Edit and Writer, the same way)

- **Polling:** while the app runs, it asks `reviews:changes` every 30–60 s (the relays speak HTTP, not subscriptions). Every project or script with open notes gets a badge and a count on its card, and a feedback list inside it.
- **Fixing automatically:** a new note waits 2 minutes after the reviewer's last note (so one sitting is fixed together). Then the app claims the open notes and starts its agent with them.
  - One run per project at a time. Never on a project someone else holds (Edit's lock), never twice for a note (`claim`), and only while the app is open.
  - Runs use the user's own Claude plan, so they add no metered spend.
  - A setting turns it off.
- **Per-note marks:** the agent works note by note and says when each is done (Edit: a `feedback_done {note, summary}` tool; Writer: in its structured answer). The app diffs the project or script since the note began, which gives the changed ranges: timeline frames for Edit, block and word ranges for Writer. It stores them with the note and sends `reviews:resolve`.
  - The UI draws them as bands: on Edit's timeline ruler, and on Writer's text.
  - Hovering a band shows the reviewer's words, who said them, the agent's summary and the version.
  - A note the agent couldn't fix stays open, with its reason as a reply.
- **Re-share:** Share again publishes v(n+1) under the same link. The page shows what's still open, and what's done since the last version.

## 3. Writer → Edit handoff

- **One footage registry.**
  - Writer registers each recording it downloads in Edit's `editMedia` under the same sources (`drive:<id>`, `youtube:<id>`), and uploads the original to `edit/originals/…` before making its proxy.
  - It stops deleting the originals of joined cases: they're the full-quality footage Edit cuts from.
  - `writer-relay` gets the rights for `edit:getMedia`/`putMedia` and the `edit/originals/` and `edit/analysis/` prefixes.
  - Either app downloads a recording once; the other finds it.
- **One transcription.** Edit's is the better one: Scribe pieces plus the whole file's voices, the case's names as keyterms (`names.ts`), and a split for bodycam.
  - Writer calls Scribe with exactly Edit's parameters and keyterms.
  - It writes each recording's words in Edit's transcript format to the shared `edit/analysis/<source>/transcript.json`, as well as in its own format.
  - Either app transcribes a recording once.
  - Writer's positional word IDs (`w00000`) stay its own: Edit reads times, not IDs.
- **The script.**
  - Writer's "Send to Edit" marks a script ready (`writer:handoff`, a flag on `writerScripts`).
  - Edit's home screen lists ready scripts with Writer's icon, and one click makes the Edit project. Edit's relay gets read-only `writer:listScripts`/`getScript`.
  - Writer's clips (`startMs`/`endMs` on the joined clock, with `parts[]` naming each recording) become Edit's script blocks: footage ranges over `drive:<id>#a-b` excerpts, and narration with its voice-over.
  - The footage comes from the registry, and the words are sliced from the shared transcript, so nothing is downloaded or heard again.
  - The Google Doc route stays as it is.
- **"edit:" comments.**
  - A Writer clip note (or commentary editor note) starting `edit:` is an instruction for the editor. Writer's agent can be told to add one ("edit: a blue waveform for this 911 call").
  - The handoff carries them as notes on Edit's script blocks.
  - Edit's agent follows them for that section over its usual plan, through `get_edit_context`'s script notes and one rule in the edit-workflow skill. The audit lists any not yet acted on.

## 4. Edit's dashboard
- **Feedback:** each project card shows its open feedback count, with Repack's mark.
- **Complete, not exported:** shown when a whole edit has finished (its last agent turn ran edit-workflow or final-pass with no fixable flags left, or the user marked it done) and no export holds its current revision. Edit records each export's revision in `exports.json`.

## Order
1. **Repack:** the tables, functions and `/r/[token]`, with app icons. Convex pushed. Railway when its pause lifts.
2. **Edit and Writer, in parallel:** sharing, polling, auto-fixing and the change bands. Edit's dashboard. Relay rights (Edit deploys its relay, Writer its own).
3. **Handoff:** the shared registry and transcripts (Writer), and the "From Writer" import (Edit). Then "edit:" comments end to end.
4. **The test:** a Writer script shared, commented, fixed and handed to Edit; Edit edits it, follows an `edit:` note, and shares a video; a note on the video is fixed by Edit's agent, and the band shows it.
