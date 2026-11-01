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
