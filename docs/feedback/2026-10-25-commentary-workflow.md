# Internet Janitor commentary workflow

The requested test is the latest Writer draft of **The Disturbing Rise of N3on**, revision 11: 82 narration blocks and 20 source excerpts, in the authored order. Its voiced base is 33:25. The goal is a complete agent edit and a playable Feedback review, with reusable workflow improvements exercised on fresh projects.

## Sources and prior progress

- [Writer review, version 3](https://feedback.spheceo.com/r/ERD8i_JXywawF8ybNCTCog).
- [Internet Janitor Editing Rules & Processes](https://docs.google.com/document/d/1XBDdsfyZIxfM-kAsg5aZvxMRliib9_KGONDe_6eDNrA/edit?tab=t.0), the primary house guide supplied after the research.
- `/Volumes/External/Edit/research/commentary-2026-10-19/`: source verification, captions, an After Effects composition inventory, moodboard, supplied assets, and 18 rendered motion references in an Edit project. This was reference research, not a trained commentary workflow or an existing full N3on edit.
- Trial evidence, the guide's embedded images, source-search receipts, scores and frame sheets are under `/Volumes/External/Edit/experiments/commentary-2026-10-25/`. Its answer key stays private and is never given to the editing agent.

## Teaching, defaults and checks

| Pattern from the guide | Workflow teaching | Code or tool | Check and limit |
| --- | --- | --- | --- |
| Relevant, varied B-roll rather than a few speech snippets | Map the narration's people, event, period and action to inspected pictures; keep source clocks and excerpt clocks separate | Batched YouTube search, timed caption reading, bounded cloud excerpt import, saved visual observations | Coverage and repeated-source audits catch mechanical gaps; only inspecting the pictures establishes relevance |
| Smooth animated evidence cards and restrained editorial type | Stable phrase layout, selective emphasis, strong eased arrivals, gentle movement | Soft glyph-opacity reveal, reusable card/chapter/profile compositions, rounded borders and glow | Native rendered samples and short audiovisual motion reviews; counts alone do not judge taste |
| Real evidence and red Multiply markers | Capture actual page pixels; a missing post remains unresolved | Phrase/selector page capture; screenshot-coordinate highlights inherit their card's motion; shared Multiply/Screen renderer | Missing phrases fail explicitly; inspect captures for consent pages and unrelated UI |
| Music only under narration; source speech audible | Work from narration and actual source-audio spans, then review their boundary | Narration-only grain/vignette avoids source clips and duplicate texture; music-over-source audit | Structural checks plus heard samples, not a claim that every second was heard |
| “Remove these words” precisely and silently | Apply commentary's additional house words and fully starred display forms | Style-aware house-word detection and existing precise mute tools | Existing censor audits and review; visual censorship still needs picture inspection |
| Complete the whole essay | Chapter-sized contexts and atomic plans, authored ending, whole-video final pass | Commentary style, Writer handoff, chapter outline, style-specific audit and trial scorer | All 82 voiceovers must survive; picture coverage must extend through the ending |

The style lives in `agent/styles/commentary/`, with overrides for research, workflow, intro, cut-ins, transitions, outro, subtitles, music and final pass. It does not inherit police-template editing requirements. Core renderer features work in both native exports and browser preview.

Writer handoff now accepts commentary and retains anchored notes, source links, quote-verification requests, interleaving and the reversed cold-open source order. It generates and aligns the house voice during import. The original Writer draft is unchanged.

## Observed harness failures and repairs

An initial source request began downloading a roughly 5 GB whole stream for a short excerpt. It was stopped, its owned temporary partial removed, and commentary import changed to bounded source ranges. The first affected source became a 29 MB excerpt. There is no whole-stream fallback for commentary B-roll.

R1 stopped deliberately after 8.3 minutes, before composing pictures: a B-roll batch exceeded Claude Code's five-minute idle timeout. The agent started an overlapping smaller request while the first download continued. One earlier request also exceeded the documented 240-second range cap and was correctly refused. The repair adds the existing four-minute background-result collector to `import_broll`, an explicit 15-minute client idle timeout, shared download/publication for identical source spans across overlapping requests, and two source downloads at a time. The research skill explains how to collect a running batch without starting another one.

Rendered QA caught another episode's arrest title and portrait in the original supplied wallpaper. The bundled version now has entirely blank folders and paper, edited with the built-in image tool. The original research asset is untouched. The wallpaper is decorative artwork, never evidence. Evidence crop padding was tightened to avoid partial adjacent lines, and card borders strengthened to match the guide.

Importing a QA image directly from the external volume stalled the daemon in a filesystem open. Staging the exact image in Edit's home succeeded. Product capture, generated graphics and source imports use Edit's own home. Bun's embedded wallpaper is materialized to a real file before native image I/O.

## Validation and checkpoints

- `c78dec6`: cloud streaming, commentary handoff/style, sourcing, effects, audits and harness.
- `1acd5fd`: materialize embedded wallpaper before native import.
- `816a782`: long-import recovery/reuse and rendered-QA refinements.
- Before trials: server 625 pass / 7 skip; web 142 pass; native 33 pass; core 36 pass; GPU renderer 10 pass / 1 benchmark ignored. TypeScript and Rust clippy checks passed.
- Import-recovery changes: 42 targeted tests passed, including concurrent excerpt requests producing one download/encode and leaving no scratch file; server TypeScript passed.
- Actual YouTube discovery/caption reads, real-page capture, card/highlight rendering and audiovisual motion review were exercised. The motion review is advisory: one sample mistook the real captured documentation page for an application overlay. Its assertions require human/agent inspection.
- The completed base has 98 cloud-streamed media entries. Cache inspection after the full import found zero persistent local playback-preview MP4s. Temporary encoding inputs are removed after cloud acknowledgement; originals and paid analysis are preserved.

## Trials and final review

R2 exposed a second infrastructure delay before composition: a 117 KB overview displayed no timeline clips, and the agent read every chapter’s detailed timing before requesting 36 ranges. Four-minute collection waits serialized across three batches. The repaired overview stays within 36 KB, retains a chapter map and source clips, and provides complete notes/timing in a chapter view. B-roll now acknowledges background work in 1.5 seconds and points to completed ranges as they arrive. The workflow sources and composes one chapter at a time. Commentary flags now participate in automatic repair passes, including the import’s actual solid-card placeholders. R3 will exercise these changes from the unchanged voiced base; the holdout and final share receipt follow after completion.

The supplied guide specifies Akwe Pro Bold. The linked download is marked personal use; this build is for internal style evaluation. The team's commercial and app-distribution licence must be verified before shipping a public application containing it. No font purchase or application release was performed. The guide's conditional Mazzard H Bold variant for MrBeast footage also requires a licensed font before that variant can be treated as complete.
