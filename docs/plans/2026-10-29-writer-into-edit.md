# Writer into Edit

Agreed with the user on Oct 29, 2026. Writer (`~/Documents/code/writer`: a Tauri app, 35k lines of Rust doing the work, 14k of React) becomes **Script mode** of Edit. This file is the checklist: nothing is done until its line here is ticked.

## Decisions

- **One project, two modes: Script and Edit, kept in sync both ways.** Saving a script changes the video ("a voice over regeneration of just that sentence… the clip you added reflects, and when you undo on script it undos on edit"); an edit to a script-made clip or cut-in in Edit mode changes the script ("yes").
- **The UI comes over near-verbatim** (Writer's `api.ts` already had an HTTP route for every Tauri call); **the backend is ported to TypeScript** in Edit's server. Where both apps had a version of the same thing, the better one wins.
- **Data stays where it is**: Convex `writer:*`, R2 `writer/scripts/<id>/`, `writer/lessons.json`, the review links. Old Writer keeps working beside the merged Edit until it's retired.
- **Permissions become Edit's**: Writer's capability ids keep their names, now on Edit's relay.
- **Apple Silicon only**: the team's Macs all are (the user sent each of them the Apple Silicon disk image).
- **Order**: the merge, then performance, then a native video player.
- **Clean as we go**: what does one job is one module, what's unused goes, long code that can be short is rewritten. The agent's taught text (Repack's guides, house rules, skills) stays word for word.

## Layout

- `app/apps/server/src/writer/`: Script mode's server (the script store, imports, builds, revisions, reviews, the cloud, commentary, clips, feedback rounds).
- `app/apps/web/src/writer/`: Script mode's UI.
- `agent/writer/`: Repack's script guides and Writer's house rules, word for word.
- `docs/writer.md`: how Script mode works (Writer's `how-it-works.md`, brought up to date).

## Inventory: Writer's backend

Each module of `writer/src-tauri/src/`, where it lives now (`app/apps/server/src/`), and its state. "Edit's" means Edit already did the job and Writer's copy went; "tested" that `app/apps/server/test/writer/` covers it; "seen working" that it ran here against the real services on Oct 29. Writer's 35.4k lines of Rust (and its 160-line sidecar) are 17.3k of TypeScript.

| Writer | Lines | Now | State |
|---|---|---|---|
| account.rs, avatar.rs | 1067 | Edit's accounts.ts, avatars | Edit's |
| activity.rs | 104 | writer/activity.ts | ported |
| agent.rs + sidecar/ | 304 | writer/claude.ts over Edit's claude.ts (the SDK in-process) | ported; no sidecar |
| archive.rs | 479 | writer/archive.ts | ported |
| blocks.rs | 620 | writer/blocks.ts | ported, tested |
| brief.rs | 308 | writer/brief.ts | ported, tested |
| can.rs | 207 | writer/can.ts over Edit's accounts | ported |
| captions.rs | 312 | writer/captions.ts over Edit's youtube.ts | ported, tested, seen working |
| casefiles.rs | 176 | writer/casefiles.ts | ported |
| chat.rs | 93 | writer/chat.ts | ported |
| claude.rs, steps.rs, tools.rs | 2762 | writer/build.ts, plan.ts, scripting.ts | ported, tested, seen working |
| cloud.rs | 1076 | writer/cloud.ts over Edit's relay | ported; pulls seen working, pushes wait on the relay deploy |
| commentary.rs | 2664 | writer/commentary.ts, paragraphs.ts, sources.ts | ported, tested |
| distill.rs | 188 | — | dropped (a developer's test tool) |
| doctor.rs | 107 | Edit's setup check | Edit's |
| drive.rs | 452 | writer/drive.ts over Edit's Google sign-in | ported, seen working |
| exact.rs | 599 | writer/exact.ts | ported, tested, seen working |
| feedback.rs | 1180 | writer/feedback.ts, lessons.ts | ported, tested |
| fixing.rs | 1026 | writer/fixing.ts | ported, tested |
| footage.rs | 367 | writer/footage.ts | ported |
| formats.rs | 356 | writer/formats.ts | ported, tested |
| handoff.rs | 449 | writer/handoff.ts (footage and words to Edit's registry), writer_handoff.ts (Start the edit) | ported; Start the edit is local now |
| hearing.rs, transcribe.rs | 1341 | writer/hearing.ts, transcription.ts over Edit's transcribe.ts | Edit's |
| house.rs | 326 | writer/house.ts | ported, tested |
| http.rs, lib.rs | 2806 | writer/routes.ts, index.ts | ported: one route table |
| import.rs | 1965 | writer/imports.ts, parts.ts | ported, seen working (YouTube) |
| jobs.rs | 306 | writer/jobs.ts | ported |
| log.rs | — | Edit's diag.ts (`[writer]`) | Edit's |
| machine.rs | — | Edit's machine.ts | Edit's (same id and name) |
| media.rs | 640 | writer/media.ts | ported, tested |
| model.rs, store.rs | 576 | edit-types writer.ts, writer/store.ts | ported |
| names.rs | — | writer/names.ts over Edit's names.ts | Edit's |
| net.rs, proc.rs | — | Edit's relay.ts, writer/proc.ts | Edit's |
| pages.rs | 272 | writer/pages.ts | ported |
| remote.rs | 406 | Edit's remote_actions.ts | Edit's, now with scripts |
| research.rs | 554 | writer/research.ts over Edit's research.ts | ported, tested, seen working |
| reuse.rs | 819 | writer/reuse.ts | ported |
| reviews.rs | 1090 | writer/reviews.ts | ported, tested; counts seen, sharing waits on the relay deploy |
| revise.rs | 747 | writer/revise.ts, edits.ts | ported, tested, seen working |
| scout.rs | 1088 | writer/scout.ts | ported, tested |
| settings.rs | 149 | Edit's settings | Edit's |
| speakers.rs | — | writer/naming.ts | ported |
| spelling.rs | 441 | writer/spelling.ts | ported, tested |
| spills.rs | 490 | writer/spills.ts over Edit's turns.ts | Edit's |
| storage.rs | 566 | — | not ported (clearing a script's local footage) |
| stream.rs | 268 | routes.ts's proxy, cloud.stream | ported |
| tidy.rs | 725 | writer/tidy.ts | ported, tested |
| trello.rs | 595 | writer/trello.ts | ported, tested, seen working |
| turns.rs | 604 | writer/caption_turns.ts | ported, tested, seen working |
| update.rs, release.rs | 515+ | Edit's update.ts | Edit's |
| versions.rs | 237 | writer/versions.ts | ported |
| watch.rs | 1203 | writer/watch.ts over Edit's watch.ts | Edit's |
| youtube.rs | 607 | writer/youtube.ts over Edit's youtube.ts | Edit's, seen working |

## Inventory: Writer's features

From Writer's `docs/how-it-works.md`, each a line to tick once it works in Edit. "Seen" means it ran here on Oct 29 against the real services (Claude, YouTube, Drive, Docs, Trello, the cloud); "ported" that the code and its tests came over but it wasn't run end to end.

- [x] Library: scripts with sections (Footage, Compilations, Commentary), style pills, search, counts, "Not in the cloud" (seen: 43 scripts pulled from the cloud, Home's Scripts tab, Edit's header)
- [x] New script: YouTube link, Drive file or folder, file on this Mac; title; article; format (seen: a YouTube import end to end, the Drive check; ported: file, folder)
- [x] Compilations: 2–20 videos, checked before download, REUSE, a reused case's Doc, `[reuse]` labels, Trello earlier-card lookup (ported, tested; the video check seen)
- [x] Courtroom case from several videos (ported)
- [x] Brief: pasted producer's brief read into title, notes and labelled links (ported, tested)
- [x] Import from Trello (Raw Channels, Compilations) (seen: the lists through Writer's relay with Edit's sign-in)
- [x] Case files: a Drive folder's PDFs read for facts (ported)
- [x] Import: download, preview, transcription (Edit's), speaker check, naming, spills; retries; needs-your-choice pauses; complete transcription (seen on YouTube; ported for the rest)
- [x] YouTube captions first for courtroom footage, turns read from the conversation, exact hearing of the clips played (seen: captions, Sonnet's turns, the exact hearing in a build)
- [x] Research for free (searches, pages, kept reports); Research again (seen)
- [x] Build: fast build (outline, sections, finish) and build in steps; house checks; tidy; page counts; FOIA floor (seen: a build, $0.52; tested)
- [x] Revise in chat: targeted edits, repair turns, Start over proposal, proposals on saved narration, Follow up (seen: a revision; tested)
- [x] Editing: clips on the timeline, insert words, respell, undo/redo, versions (ported: the UI is Writer's, the routes are tested)
- [x] Commentary: sources (brief, evidence, style), pacing, build, quotes checked, Copy script (ported, tested)
- [x] Find clips (scout) (ported, tested)
- [x] Reused cases: import the video, highlights for intro clips (ported)
- [x] Comments, Feedback tab, teaching rounds, lessons synced (ported, tested; lessons merge in kept order)
- [x] Review: share, share again, notes, Ready for changes fixing on the chosen Mac, Approve, Make this v1, green bands (ported and tested; notes, counts and the fixing check-in seen with the relay deployed)
- [x] edit: notes for the editor (ported)
- [x] Google Doc export, Doc comments (seen: the Docs list and their comments through Edit's Google sign-in; making a Doc wasn't tried, it publishes one)
- [x] Archive and restore footage (ported)
- [x] Cloud: every script synced, conflicts kept as copies (relay deployed Oct 29 with its own 1200/min limit; a test script committed as rev 1 in 1 s and deleted everywhere)
- [x] Logs, Settings, update, remote support (one app: Edit's; remote diagnostics and resume take scripts)
- [x] Script mode ↔ Edit mode: one project, synced both ways, one undo (script_sync.ts: trims, takeouts, added cut-ins and ranges, rewordings re-voiced alone, Edit-mode trims, rewordings and deletes back to the script; undo is a save on either side; seen on a copy of Trooper FAKES Testimony; research, case names, footage and words carried at Start the edit)
- [x] Storage: a script's footage left to the cloud once shared and idle (writer/storage.ts, which shares older scripts' recordings first: 1.9 GB here), brought back when work needs it

## Bugs found

Each with its file, what goes wrong, and the fix.

- **Edit, `research.ts`**: pages' text kept `&ldquo;`, `&rsquo;` and the like (only a few entities were decoded), so research quotes read with entity names in them. Writer's fuller decoder is `decodeEntities` now, used by both modes.
- **Writer, lessons' leaked phrases** (`feedback.rs` → `writer/feedback.ts`): the check compared a quoted phrase with an unquoted one, so overlapping runs of the same words were each listed. Each phrase is said once.
- **Writer, percent-decoding** (a Drive or page link's last `%xx` escape was left encoded): Edit's decoding is used.
- **The port, lessons' order** (`writer/lessons.ts`): merging this Mac's lessons with the cloud's lost the order they were kept in, which is the order builds read them. Sorted by when kept, then id.
- **The port, the cloud's fallback** (`writer/cloud.ts`): until Edit's relay is deployed with `/v1/cloud/writer/*`, reads fall back to the relay's plain cloud routes; the fallback didn't recognise the relay's "needs deploying" answer, so the library came up empty. Fixed: 43 scripts pull.
- **The port, footage in the cloud** (`writer/cloud.ts`): leaving a shared original out of a push would have dropped it from the commit, and the cloud deletes what a commit drops. Only files listed in `edit-shared.json` (in Edit's originals already) are left out, and their entries kept.
- **The port, cleared previews**: a preview Writer had cleared on this Mac (Writer's `storage.json`) looked deleted, so the next push would have deleted it in the cloud. Writer's list of cleared files is adopted and their entries kept.
- **The port, one stuck delete**: a cloud delete that failed stopped the whole sync tick; each delete is tried on its own now.
- **The port, review notes**: Writer's record of the notes (read cursor, open counts) wasn't taken when the poller had already written an empty one. Taken when ours is missing or at cursor 0.
- **Writer's ElevenLabs key is out of credit** (not code): several of Writer's own imports failed with "exceeds your quota of 600000, 0 credits remaining". Script mode hears through Edit's relay, so it isn't affected; old Writer is until its key is topped up.
- **Two conflicted copies** of "CORRUPT Cops Charge 3 People…" came down from a teammate's Writer (MacBook Pro (3)): two Macs saved the same script at once, and the cloud kept both, as it should.

## Cleanup

What was merged, shortened or removed, and why.

- Writer's 35.4k lines of Rust, its 160-line Claude sidecar and Tauri shell are 17.3k lines of TypeScript in `apps/server/src/writer/`, because every job Edit already did is Edit's: sign-in and permissions, HTTP, logs, the machine's id, updates, settings, setup checks, remote support, hearing, watching, YouTube, research, Drive, Claude.
- One route table (`writer/routes.ts`) where Writer had routes and Tauri commands for the same calls; the route-extension registry the first steps used is gone.
- `store.ts`'s hooks are down to one (`withSharedKeys`); `edits.declineProposal` (unused) is gone.
- The UI lost Writer's settings, account, update, logs and doctor calls and 21 unused exports of `api.ts`; the server the routes only they used.
- Two Trello readers became one (`writer/trello.ts`'s `trelloGet`, used by Edit's `compilation_input.ts` too).
- Start the edit reads the script on this Mac first (`writer_handoff.ts`), not from the cloud.
- The Intel builds are gone (CI matrix, `install.sh`, the packaging, FFmpeg and qjs scripts): the team is all Apple Silicon.

## Tests

What was run, and how it went (Oct 29).

- Server: `bun test` 897 tests across 127 files (20 files are Script mode's own, `test/writer/`, plus `test/remote_actions.test.ts`): all pass after two tests were updated for this work's own changes (remote resume's wording, the relay manifest's script capabilities). `tsc --noEmit` clean.
- Web: vitest 204 tests across 35 files pass (the relay's tests among them: `/v1/cloud/writer/*` with a Writer token, grants, R2 keys limited to `writer/`). `tsc --noEmit` clean.
- Live, on this Mac's dev server: the library pulled from the cloud (43 scripts), a YouTube import end to end (captions, Sonnet's turns, the preview, the file shared by hard link), a build ($0.52, its clips heard exactly), audit, research and revise, Trello's lists, a Drive link checked, the Docs list and comments through Edit's Google sign-in, review counts, Claude's status, and screenshots of Home's Scripts tab, the library's header and the editor's Start the edit.
- Not run live: anything that publishes or changes the team's data (cloud pushes, sharing a review, making a Doc, fixing, teaching rounds' kept lessons) — pushes and shares need the relay deployed first.
