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

Each module of `writer/src-tauri/src/`, where it lives now, and its state. "Edit's" means Edit already did the job and Writer's copy goes.

| Writer | Lines | Now | State |
|---|---|---|---|
| account.rs, avatar.rs | 1067 | Edit's accounts.ts, avatars.ts | |
| activity.rs | 104 | writer/activity.ts | |
| agent.rs + sidecar/ | 304 | Edit's claude.ts (the SDK in-process) | |
| archive.rs | 479 | writer/archive.ts | |
| blocks.rs | 620 | writer/blocks.ts | |
| brief.rs | 308 | writer/brief.ts | |
| can.rs | 207 | writer/can.ts over Edit's accounts | |
| captions.rs | 312 | Edit's youtube_captions.ts + writer/captions.ts | |
| casefiles.rs | 176 | writer/casefiles.ts | |
| chat.rs | 93 | writer/chat.ts | |
| claude.rs, steps.rs, tools.rs | 2762 | writer/build.ts, writer/plan.ts | |
| cloud.rs | 1076 | writer/cloud.ts over Edit's cloud.ts | |
| commentary.rs | 2664 | writer/commentary.ts | |
| distill.rs | 188 | writer/distill.ts | |
| doctor.rs | 107 | Edit's setup | |
| drive.rs | 452 | Edit's drive_import.ts / script.ts | |
| exact.rs | 599 | writer/exact.ts | |
| feedback.rs | 1180 | writer/feedback.ts | |
| fixing.rs | 1026 | writer/fixing.ts | |
| footage.rs | 367 | writer/footage.ts | |
| formats.rs | 356 | writer/formats.ts | |
| handoff.rs | 449 | gone (one app: the registry is Edit's) | |
| hearing.rs, transcribe.rs | 1341 | Edit's transcribe.ts | |
| house.rs | 326 | writer/house.ts | |
| http.rs, lib.rs | 2806 | writer/routes.ts | |
| import.rs | 1965 | writer/import.ts | |
| jobs.rs | 306 | writer/jobs.ts | |
| log.rs | — | Edit's diag.ts | |
| machine.rs | — | Edit's machine.ts | |
| media.rs | 640 | Edit's media + writer/media.ts | |
| model.rs, store.rs | 576 | writer/model.ts, writer/store.ts | |
| names.rs | — | Edit's names.ts | |
| net.rs, proc.rs | — | Edit's relay.ts, tools.ts | |
| pages.rs | 272 | writer/pages.ts | |
| remote.rs | 406 | Edit's remote support | |
| research.rs | 554 | writer/research.ts over Edit's research.ts | |
| reuse.rs | 819 | writer/reuse.ts | |
| reviews.rs | 1090 | writer/reviews.ts | |
| revise.rs | 747 | writer/revise.ts | |
| scout.rs | 1088 | writer/scout.ts | |
| settings.rs | 149 | Edit's settings | |
| speakers.rs | — | writer/speakers.ts | |
| spelling.rs | 441 | writer/spelling.ts | |
| spills.rs | 490 | Edit's turns.ts | |
| storage.rs | 566 | Edit's storage + writer/storage.ts | |
| stream.rs | 268 | Edit's http files | |
| tidy.rs | 725 | writer/tidy.ts | |
| trello.rs | 595 | writer/trello.ts | |
| turns.rs | 604 | writer/turns.ts | |
| update.rs, release.rs | 515+ | Edit's update.ts | |
| versions.rs | 237 | writer/versions.ts | |
| watch.rs | 1203 | Edit's watch.ts | |
| youtube.rs | 607 | Edit's youtube.ts | |

## Inventory: Writer's features

From Writer's `docs/how-it-works.md`, each a line to tick once it works in Edit.

- [ ] Library: scripts with sections (Footage, Compilations, Commentary), style pills, search, counts, "Not in the cloud"
- [ ] New script: YouTube link, Drive file or folder, file on this Mac; title; article; format (Interrogation, Bodycam, Courtroom)
- [ ] Compilations: 2–20 videos, checked before download, REUSE, a reused case's Doc, `[reuse]` labels, Trello earlier-card lookup
- [ ] Courtroom case from several videos
- [ ] Brief: pasted producer's brief read into title, notes and labelled links
- [ ] Import from Trello (Raw Channels, Compilations)
- [ ] Case files: a Drive folder's PDFs read for facts
- [ ] Import: download, preview, transcription (Edit's), speaker check, naming, spills; retries; needs-your-choice pauses; complete transcription
- [ ] YouTube captions first for courtroom footage, turns read from the conversation, exact hearing of the clips played
- [ ] Research for free (searches, pages, kept reports); Research again
- [ ] Build: fast build (outline, sections, finish) and build in steps; house checks; tidy; page counts; FOIA floor
- [ ] Revise in chat: targeted edits, repair turns, Start over proposal, proposals on saved narration, Follow up
- [ ] Editing: clips on the timeline, insert words, respell, undo/redo, versions
- [ ] Commentary: sources (brief, evidence, style), pacing, build, quotes checked, Copy script
- [ ] Find clips (scout)
- [ ] Reused cases: import the video, highlights for intro clips
- [ ] Comments, Feedback tab, teaching rounds, lessons synced
- [ ] Review: share, share again, notes, Ready for changes fixing on the chosen Mac, Approve, Make this v1, green bands
- [ ] edit: notes for the editor
- [ ] Google Doc export, Doc comments
- [ ] Archive and restore footage
- [ ] Cloud: every script synced, conflicts kept as copies
- [ ] Logs, Settings, update, remote support (one app)
- [ ] Script mode ↔ Edit mode: one project, move to Edit, synced both ways, one undo

## Bugs found

Each with its file, what goes wrong, and the fix.

## Cleanup

What was merged, shortened or removed, and why.

## Tests

What was run, and how it went.
