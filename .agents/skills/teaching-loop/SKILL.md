---
name: teaching-loop
description: Teach Edit's in-app agent from the team's feedback by experiment, not by handing it the notes. Fresh from-scratch edits of test videos, round after round, judged against a private answer key, the skills and the harness improved between rounds, a holdout video last. Use when there's a round (or several) of the team's feedback to make stick, a new style to teach, or the user asks for a teaching loop, an experiment, or "rounds".
---

# The teaching loop

What it's for: the next edit shouldn't get the same notes. The agent never sees the team's comments; it learns from short skills, better tools and audits, and each round shows whether that worked. Loop 2 (Oct 21–22, `docs/feedback/2026-10-22-teaching-loop-2.md`) is the worked example: read it first, and its `~/edit-experiments/loop2/LOG.md`.

## The user's rules
- Never show the agent the feedback; teach through skills. Reword where most of it is already there; **smaller skills are better** (big, verbose skills contradict themselves and confuse it). A rule can always apply or apply by context; leave creative freedom where the feedback doesn't forbid it. Quote the team so the reason travels with the rule.
- Improving the harness counts as much as the text: tools that let it edit like a person, audits that name what the team catches, defaults that are right in code.
- One video at a time (thorough, and the dev Mac has 8.6 GB). At most ~10 rounds; stop after two rounds without improvement. No exports: the final projects and the findings are the result.
- If Claude Code hits its usage limit, wait for the reset (round.py does); don't switch models.
- Cheap services are fair game: Codex (computer use, delegate_task) may sign in as the user to check existing credit or free tiers and put keys in Infisical (project `cdf4a0c5-eca4-4415-af3a-40871af285f3`, env `dev`). **Never buy anything.**
- Run to the end on your own: every wait bounded, every background job watched (Monitor), nothing that can hang.
- A trial that hits a bug in Edit or the harness: fix the root cause, verify it, log it in `LOG.md`, and run that trial again on the fix; never score around a broken tool (the `in-app-agent` skill: the whole flow, no shortcuts).

## Before round 1
0. **The lessons inbox** (Nov 1): what the agents noted from the team between loops (`note_lesson`, kept in mamagi prod). `edit lessons` lists the open ones by part, each with the team's words, who and where (`--all` adds the closed ones: a note that's back after it was taught means that teaching didn't hold); it asks the installed Edit (prod, :7700), never `just dev`'s (dev's Convex has its own, empty inbox). Each open lesson is a row for the key, or a one-off to drop.
1. **The answer key** (private: `$LOOP/keys/<style>.md`, never in the repo or the agent's reach): every pattern from the feedback as one row: the pattern, the team's words, how it's checked (A = audit or project data, F = frames, J = judgement). Loop 2's are in `~/edit-experiments/loop2/keys/`.
2. **The test videos**: one or more per style the feedback touches, with a Doc script each; plus one **holdout** never used in the loop.
3. **Limits and credit** (loop 2 lost hours to these): the relay's daily transcription and map allowances (`app/apps/relay/wrangler.toml`, deploy with `npx wrangler deploy`), the AI Gateway's credit (a test call: `curl https://ai-gateway.vercel.sh/v1/chat/completions` with `AI_GATEWAY_API_KEY`), free disk. Without gateway credit: `EDIT_AI_PROVIDER=gemini` in `/tmp/run/serve.sh` (`app/apps/server/src/gemini.ts`, Gemini's free tier with xAI behind it for pictures).
4. **Bases**: `scripts/base.sh <key> <style> <fps> "<name>" "<doc url>"` per video (and the holdout): a fresh import (footage, transcripts, voice-over), recorded in `$LOOP/base/bases.json`. Look at each once (clip count, voice-overs on their cut-ins, its first get_edit_context's size).

`LOOP` is the working folder (default `~/edit-experiments/loop`; use a new one per loop). Scripts are in `scripts/` here. Run trials on the trial server (`just trial-server start`, :7710, its own data folder, no `bun --watch`: other sessions' saves can't restart it mid-trial) with `EDIT_URL=http://127.0.0.1:7710`; restart it between rounds to take new code. A base made on another server is opened there first (`POST /api/projects/<id>/cloud/open`). Without `EDIT_URL` they use the dev server on :7700.

## A round
1. Teach and fix (below), commit, then rebuild and restart: `just serve-build-bin` in `app/`, `scripts/restart.sh`. Never restart while a trial runs.
2. `scripts/run_round.sh R<n> <video>...` (in the background): each video in turn: `round.py` copies its base, sends "Start the editing workflow." and waits (follow-ups, usage limits, stalls, a 150-minute cap), then `score2.py` and `frames.py`. `scripts/next-round.sh R<n> R<n+1> <video>...` chains the next round after it (rebuild, restart, run).
3. Judge each trial when it lands: `score2.py`'s numbers (`summary.py` puts every round side by side), the **frame sheets** by eye (`$LOOP/rounds/R<n>/<video>/frames/`), the agent's own summary (what it says it left and why: often the best pointer to a harness gap), and the server log (`~/.edit/logs/edit.log`: tool failures, rate limits, the follow-ups).
4. Log it in `$LOOP/LOG.md` (the source of truth if the conversation is compacted): what each trial got right and wrong against the key, and what you'll change.

## What to change between rounds, in this order
1. **Did the agent see what it needed?** The biggest losses in loop 2 were the agent working blind: an audit of 819 unsubtitled lines (250k characters every reply), a narrowed context with no clips in it. Measure a tool's reply size when a trial goes oddly.
2. **Do the audits agree with the rules?** An audit that contradicts a skill ("one photo per person" against repeated_picture; three music audits at odds) gets ignored or freezes the agent. Fix the audit.
3. **Is it right by default in code?** (levels, timing offsets, where a cut lands, what a search leaves out). A default beats a rule.
4. **Is there a tool for it?** When the agent says it can't ("the editing tools have no way to insert time"), that's the next tool.
5. **Then the text**: the smallest change to the skill for that part (the style's version first; the core only for what every part needs). Read the agent's own words for how it misread a rule ("never a zoom on every clip" became "no punch-ins").

The agent's turn ends with flags it hasn't fixed → Edit already follows up by itself (agent.ts, up to three times while each pass cuts the flags by a fifth): a flag that keeps coming back after that is a tool or audit problem.

## The holdout and the write-up
- When the loop stops: one from-scratch edit of the holdout, judged against the same key. One clean shot; no teaching from it.
- Close every inbox lesson the loop took: `edit lessons taught <id> <the skill, audit or code and its commit>`, or `edit lessons drop <id> <why>` (a one-off, or against what the team wants elsewhere). Never close one the loop didn't measure.
- Write it up in `docs/feedback/<date>-<name>.md` (rounds, the table, what changed by kind with commits, what's open for the user) and update the agent memory. Everything else stays under `$LOOP`.
- Say plainly what the measures can't: nothing was heard or judged for taste; the team's review of a fresh edit is the real test.
