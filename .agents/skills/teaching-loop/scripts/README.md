Scripts for the teaching loop (see ../SKILL.md). `LOOP` (env) is the working folder, default ~/edit-experiments/loop.

- base.sh — fresh import of a video's Doc, recorded as a base (fresh.sh does the import)
- run_round.sh — one round over the videos given: round.py, score2.py, frames.py per video
- next-round.sh — waits for a round to end, rebuilds and restarts the dev server, runs the next
- round.py — one trial: copy the base, "Start the editing workflow.", wait it out (limits, stalls, follow-ups), save
- score2.py — measures against the answer keys' patterns (text timing, centred text, zooms, clicks, audit flags)
- frames.py / sheet.sh — frame sheets rendered from the project (no export)
- summary.py — every round's measures side by side
- restart.sh — restart the dev server (/tmp/run/serve.sh) and wait for it
- mcp.sh — call one of Edit's tools over :7700/mcp
