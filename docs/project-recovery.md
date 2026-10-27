# Resume an existing Edit project

An imported project can have some subtitles or narration and still be missing
most of its editing. Previously, import resume refused a laid-out script, and
`generate_voiceover` refused as soon as any cut-in had narration. Re-running the
ordinary subtitle stage replaced existing lines and reset their positions.

The agent panel now offers **Resume edit** for script projects. The same flow is
available by asking “resume this edit” in chat. The request loads `resume-edit`,
reads current context and `recover_project`, fills safe missing prerequisites,
and continues only unfinished stages across every case. It never uses Re-cut,
reset or reimport to recover an edit. Finished opening work, graphics, music,
source trims, labels and whole-video reuse remain part of the current edit.

`recover_project` is read-only by default. `prepare:true` fills missing footage
transcripts and untouched narration placeholders, and reports failures alongside
successful work. Its output includes narration status, transcript provenance,
cached subtitle coverage and removed/unplaced blocks. It does not certify
speaker checks or later stage completion from clip counts. The agent must use
the ordinary cached watcher, inspect doubtful results, then continue the house
workflow from evidence of what remains.

Narration recovery reuses the import's saved voice project and chosen takes,
speaks only missing lines, imports only those lines, and places them only on the
unchanged target cards. Completed voice-overs keep their IDs, audio, speed,
trims, gain and mutes. Untouched placeholders take the narration's length and
ripple following clips/markers/segments as a normal placement does. Requests
running together share one generation. A user edit made while a take is being
spoken is checked again before placement. Removed, redesigned or locked cards,
removed voice-overs and untracked recordings require review; recovery never
assumes that deletion means failure. A source block missing amongst completed
work is reported for placement review rather than appended or re-cut blindly.

`add_subtitles missing_only:true` adds lines with no overlap with existing
subtitles/captions, including those on other or hidden tracks. It respects
non-footage segments and whole-video reuse. Existing clip objects, wording,
labels, colours, timing, positions, keyframes and audio mutes stay intact; a
speaker-normalisation change that would modify old clips refuses the atomic
update instead. A partially covered line may need a narrower requested span.
Deliberate subtitle deletions cannot be inferred from coverage alone: the agent
must establish that a gap is unfinished. New text is starred as usual, and
pending audio mutes are reported for `mute_house_words` after final text changes.

For missing YouTube transcripts, the common media processor applies the same
caption-first route to older local and cloud projects, using saved provenance
and excerpt offsets. Already completed local/shared transcripts win, including
analysis supplied after the processor first cached a pending status. Caption
fetching now checks original English and English-region tracks and supplies
Edit's JS runtime to yt-dlp. A usable completed track survives a failure fetching
a later track. Line-only, missing or inaccessible captions retain the resumable
Scribe fallback. Caption-turn labels still require the normal visual speaker
and cast pass; an unfinished check is never presented as verified.

Writer is unchanged. Its shared contract remains full source provenance and
source clocks, with `model: "youtube-captions"` explicit for caption words.
The screenshot's incomplete visual speaker checks are separate from successful
transcription; both the recovery guidance and watcher regression preserve that
distinction.

## Validation

Offline regressions cover partially voiced imports, reuse of unplaced takes,
concurrent/repeated recovery, intentional removals/designs/recordings, changes
made during generation, read-only recovery, completed transcript reuse, manual
subtitle/mute preservation, captioned segments, English caption variants on an
older cloud project, and caption turns passing through normal visual cast
verification with a reusable receipt. The normal real-FFmpeg Scribe fallback
is covered too. No live project or paid production request was used.

Final `just check` passed: 738 server tests (7 optional integrations skipped),
145 web tests, 33 native-addon tests, 115 Rust tests (5 optional tests ignored),
formatting, workspace/WASM Clippy, generated-type checks and all typechecks.
The production web build passed. Initial full-check failures were the expected
tool-count and skill-list assertions for the new tool/skill; both catalogs were
updated and the complete check rerun passed.
