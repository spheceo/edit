# Compilation imports and exact reuse — joint review

Prepared October 26, 2026. Edit changes are committed locally on `main`. No release,
nightly, deployment, push or PR was made for this work.

## What to review

Edit's New project and Attach script inputs now accept mixed labeled paste and
rich clipboard hyperlinks: Google Docs, Drive folders/files, YouTube and Trello
cards. Preview resolves the inputs before any project script is saved. Numbered
cases preserve order, labeled attachments fill missing slots, duplicate smart-card
representations are removed, and trailing footage/reference sections stay out.
The same recording can still appear in distinct numbered cases. An unreadable
Doc, empty folder or refused card fails the import instead of silently losing it.

In a compilation, a Doc rebuilds its existing footage ranges and finished cut-in
words. Those blocks are tagged as reused scripts and skip automatic cue trimming
and realignment. A standalone unmarked Doc retains Edit's normal script-import
behavior. Only an explicitly supplied finished recording marked `REUSE` becomes
a whole untouched video. The workflow skill records this distinction.

Direct folder imports expand every name-ordered video as a whole source. Writer
handoffs instead use its already-joined full-resolution master: the folder URL is
provenance, while `mediaSource` and `originalKey` select the precise shared source
and clock. Edit checks that the uploaded registry original matches that key;
there is no first-recording fallback. Missing uploads fail with a retry message.

## Shared Writer contract

Canonical input is ordered source URLs, with `REUSE <url>` for reuse. Docs are
scripts; finished video reuse requires an explicit video input.

- `reuses[].url` is the original input URL and matches `clips[].reuse` and
  `parts[].reuse`.
- `reuses[].after` counts newly imported cases preceding the reuse. Edit consumes
  the built clip order and its explicit reuse transition, rather than treating
  `after` as an index into every case. Missing transitions fail visibly.
- `script` is the full Google Doc URL; `scriptTitle` is its title.
- `scriptText` is full plain text, including timestamp ranges, inline `<URL>`
  targets, paragraphs and finished cut-in words. `narration` is transition context
  and is never used to reconstruct the case.
- A selected case from an earlier compilation carries its exact original section.
  Missing selected-section text requires a fresh Writer sync; fetching the entire
  earlier compilation would insert the wrong material. Older direct-Doc records
  without text can fetch their original Doc.
- Folder `parts[].mediaSource = sha256:<64-hex hash>` and
  `parts[].originalKey = edit/originals/sha256/<hash>/<index>.mp4` identify the
  full-resolution composite master. `parts[].url` remains the Drive folder URL.

## File map

- `app/apps/server/src/compilation_input.ts`: mixed paste, card extraction, fixed
  Writer relay reader, source resolution and Writer plain-text reconstruction.
- `script_tools.ts`: preview/attach entry points use that resolver.
- `writer_handoff.ts`: exact Doc reuse and shared master metadata.
- `script.ts`, `project.ts`: whole-source duration, reused-script tagging and cue
  alignment protection.
- `cloud_media.ts`, `seams.ts`: registered master lookup and identity checking.
- `app/crates/edit-core/src/model.rs`, generated ScriptBlock type and web
  `lib/edit.ts`: shared hash source validation in native and browser engines.
- Web `Home.tsx`, `ScriptPanel.tsx`, `lib/import-input.ts`, `lib/api.ts`: multiline
  input, rich links, generic source preview and unknown whole-source duration.
- `agent/skills/edit-workflow.md`: reuse behavior taught to the editing agent.

## Verification

Full `just check` passed on `main`: 681 server tests (7 optional tests skipped),
145 web tests, 115 workspace Rust tests (5 optional tests ignored), 33 rebuilt
native-addon tests, formatting, workspace/WASM Clippy, all typechecks and the
clean-git generated-type checks. The web build also rebuilt WASM successfully.
Final focused import/handoff/real-FFmpeg tests passed 22 tests. Review added
coverage for the relay's duplicate thumbnail URL, a single reused Doc reached
through Trello, and explicit reuse supplied by a duplicate attachment label.

Integration review also reproduced an existing render-cache test failure: a
one-cut trim can move a content anchor below the minimum chunk length, so its
assumption that every later chunk stays reusable was incorrect. A separate
test-only commit trims at an established chunk boundary and verifies every
remaining chunk is reused, with the existing pixel/audio verification retained.
The targeted real export regression passed; rendering behavior is unchanged.

Coverage includes the screenshot's four-case shape, labeled attachments,
checklists/comments, distinct cases sharing a recording, mixed single-line paste,
full Doc text, explicit finished-video reuse, legacy direct-Doc fallback, missing
selected-section rejection and composite-master clocks/registry key matching.
A local HTTP relay fixture verifies Edit's bearer and refusal propagation. A real
FFmpeg integration test imports a complete seven-minute recording followed by a
reused Doc, then verifies the full source duration, original ranges, cut-in words
and video source offsets on the laid-out timeline. External services and speech
are mocked; no paid import or generation was run.

## Review sequence

1. Review Writer on `main` at
   `/Users/siphesihlembuyisa/Documents/code/writer`
   and its `docs/compilation-import-review.md`. It includes the input fixes,
   serialization, folder master, subtitles in Split view, timeline zoom and the
   narrow read-only Trello relay audience change.
2. Review Repack's separate commits `cac0959` (reply lifecycle) and `308d247`
   (source extraction) in
   `/Users/siphesihlembuyisa/Documents/code/repack` on `main`.
   Its `docs/audits/compilation-extraction-review.md` records validation and scope:
   extraction supports mixed sources, but downstream Repack paid import remains
   YouTube-only. Its full check is blocked by four existing formatting errors in
   unrelated files; changed-file checks and regression tests passed.
3. Review Edit's diff, then use a development build with both current native and
   WASM engines. No existing server was restarted for this work.
4. Paste the screenshot's card or its rich description in New project. Expect
   folder, YouTube, reused Doc, YouTube in order. Try a missing case supplied as a
   labeled attachment, duplicate smart-card text and a trailing Footage reference.
   Repeat through Attach script on a new blank project.
5. In a test project, import a folder with multiple recordings. Verify every file
   plays in name order. A reused Doc must retain its original source timestamps
   and cut-in words after import and after Re-cut/realignment. Explicitly mark a
   finished video as `REUSE`; verify the complete video plays and subtitles are
   not added over it.
6. Hand off a built Writer compilation containing one new folder case plus a
   reused Doc and an earlier selected compilation case. Compare the stored full
   script text, Edit's blocks and the original Docs. Seek across a folder-master
   join and confirm it uses the shared master clock. A missing master or section
   must give a visible error instead of importing substitute footage.
7. After a separately approved Writer relay rollout, test authenticated Trello
   reads using Edit's normal signed-in account. The relay permits admin or `use`
   plus an `edit.*` grant on the two GET endpoints only. No Trello credentials are
   added to Edit. Before rollout, production Trello imports may be refused.

Live authenticated Drive/Docs/Trello imports, cross-machine cloud handoff and
desktop pointer/video interactions remain manual integration review. No claim is
made that these unreleased changes are installed on either user's Mac.
