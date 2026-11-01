# To do

Ideas and next steps that aren't started yet. Newest at the top.

## e-code: keep it or remove it (get back to this)

**Not decided.** e-code (the agent writing a stretch of the edit as one TypeScript program; `agent/skills/e-code.md`, `edit_script.ts`) stays in as an opt-in: it's used only when the message says "in e-code", nothing else depends on it.

What loop 6 showed (Nov 1, one paired run per style, `~/edit-experiments/loop6/LOG.md`):
- 16-Year-Old (interrogation): e-code 33.6 min (two restarts), audit 26 flags; house tools 26.2 min, 34 flags.
- Welfare Check (bodycam): e-code 30.3 min, 3 flags; house tools 31.3 min, 9 flags.
- Both clean on the team's issues. e-code had about half the sound effects (37 vs 58, 17 vs 34).
- The fresh-eyes sub-agent now runs after every edit and cleans up the kind of leftovers e-code was better at, which narrows its edge.

Next, when the Mac is free:
1. Fix the sound gap in `agent/skills/e-code.md` (ask for each stage's sound in the same program: whooshes on transitions, clicks on pop-ups, beds).
2. Run 3–4 more paired trials per style (house vs e-code, both with the fresh-eyes pass): `run_round.sh` with `EDIT_LOOP_MESSAGE="Start the editing workflow in e-code."`, scored with `score6.py` and `compare.py`.
3. Then decide: make it the default for interrogation and bodycam if it's as good on sound and cleaner; remove it if it still doesn't beat house tools. Commentary, courtroom and shorts have no "IN E-CODE" line in their workflow skills: add one only if it earns its place.

## Exports streamed straight to R2 (discuss again before implementing)

**Not decided: talk it through again before any work starts.** The idea: an export uses as little of this Mac's disk as possible. A 2h35m export needed ~8 GB of chunks in the cache and the file itself, and the internal disk had 2.8 GB free (Oct 18).

- Upload each chunk to R2 as it's encoded, as one part of a single multipart upload, and delete it here straight away: only a chunk or two on the disk at a time.
- Chunks encoded as fragmented MP4 (one shared init segment, then self-contained fragments), so the parts laid end to end are a playable file and R2 puts the export together with no local copy; today's join needs an ordinary MP4, whose index is written after all the video.
- The sound mixed first, as now (small: ~150 MB for 2.5 hours), and muxed into each chunk's fragments.
- The export list points at the R2 file; the browser downloads it through a presigned URL, and a re-export reuses unchanged chunks from R2.
- To weigh: fragmented MP4 plays in browsers, YouTube and Premiere but some old players handle it less well; the Mac's upload speed becomes part of the export's time; it's a sizeable change to the export pipeline (`render.rs`, `chunks.rs`, `exports.ts`, `cloud_media.ts`) and needs careful testing.

## Home screen: group projects by channel

Separate the projects on the home screen by the channel each video is for, so each channel's work is together.

- A project needs to know its channel. Today nothing records it: it could be picked when a project is created (beside its style), or come from the script Doc.
- The home screen would then show a section per channel (or a channel filter beside All / Edits / Subtitled videos and the styles), each with its own Continue and edits.
- Open questions: the list of channels and where it's kept (the cloud, so every Mac shares it), and what a project with no channel shows under.
