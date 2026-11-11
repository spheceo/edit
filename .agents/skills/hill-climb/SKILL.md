---
name: hill-climb
description: Reach a goal in Edit's code that a command can score (faster, smaller, fewer failing tests, an audit, "make X stable", a port) in small steps, keeping each gain and undoing each loss, with a script that keeps the score. Use for "hill climb", "climb this", "keep going until it passes", or to resume or report on a climb. Not for the in-app agent's taste (edits, scripts, thumbnails): that is the teaching-loop skill.
---

# Hill climb

You work toward a goal in many small steps, each scored by a command with no
human in the loop. `scripts/climb.py` keeps the score: you edit, it runs the
check, commits a win or undoes a loss, and writes the log. Never write a
score down yourself, and never decide a step "basically" passed.

`CLIMB` below is the absolute path of `scripts/climb.py` next to this file.
Write the full path into each command; shell variables may not survive.

## Where

Only in a worktree Sphe made for the climb. An undone step runs `git reset
--hard` and deletes untracked files, and other sessions work in the main
checkout, so `climb.py` refuses to run there. No worktree yet: ask for one.
The climb gets its own branch, `climb/<name>`, one commit per kept step, and
Sphe opens the pull request when we're happy with it.

The check runs on tests and fixtures only: never the team's data (`~/.edit`),
prod's cloud or the live relay, and never a dev server you'd have to kill.

## Resume

`python3 "$CLIMB" list`. A climb for this goal exists: run `status <name>`,
read `.hill-climb/<name>/notes.md`, and go to "Climb". "Continue" after a
crash or a compaction means this.

## Build the check

The climb is only as good as its check. Ask what you would run to see the
goal is met, and make it print a number. Use the strongest form that fits:

1. **Exact:** tests pass, or outputs match a reference. Count failures or matches.
2. **A count of the work:** round trips, queries, bytes, frames decoded,
   allocations, tokens. Steady and fast, so prefer it to a clock.
3. **A clock:** only when no count fits. Init with `--runs 3` and `--paired`.

| Goal | Score |
| --- | --- |
| Bug or feature | Failing tests written from the report or the spec, before the fix |
| Audit, "make X stable" | Failing tests, one per finding; add one per new finding and `relock` |
| Speed or size | A count behind the time; the timed run as `--holdout` |
| Port | Outputs that match the old code on fresh random input |
| Several goals | Each one's value over its bar; print the worst, `--target 1` |

`--score '<regex>'` reads the score from a runner's own summary, so no
wrapper is needed. It takes the last matching line and adds every number it
captures there; a passing run with no match scores 0.

| Runner | `--score` |
| --- | --- |
| `bun test` (server, native) | `'^\s*(\d+) fail$'` |
| `vitest run` (web) | `'(\d+) failed'` |
| `cargo test` | `'(\d+) failed;'` |

Without `--score`, the check's last line must be the score as a bare number.
Repeat `--check` to run several at once; their scores add.

Test the check before you trust it, in one call where you can:

- **It can fail:** break the code on purpose and see the score worsen, then `git checkout -- <file>`.
- **It is steady:** run it 3 times. If it drifts, swap the clock for a count,
  or init with `--runs 3`, `--paired` and a `--min-gain` above the drift (`3%` scales as the score shrinks).
- **It can't be gamed:** vary the input each run and compare with the
  reference. Try one cheat by hand, like hard-coding the answer, and confirm a guard catches it.
- **It is fast:** under 2 minutes a step. Score a sample or a count per
  step; the full suite is a guard, the slow real run the holdout.
- **The bar is reachable:** work out the floor the current design allows. A
  bar below it goes to Sphe with a reachable one, or the design change.

**Guards** are commands that must exit 0 after every kept step: the tests
that pass today (kept apart from the new failing ones, so a crash can't
pass as fewer failures), `bun run typecheck` in the packages you touch, the
Rust tests of a crate you change. List what the code you'll change touches
(callers, the Mac and Linux paths, saved projects, the preview and the
export both calling `Renderer::render`) and guard each. `just check` is the
milestone check, not a per-step guard.

**Holdout:** cases the climb never trains on, under `.hill-climb/<name>/holdout/`,
passed as `--holdout`. Don't open them again. Visible score up and holdout
flat means overfitting: stop and say so.

**Lock** the check, guards, tests, fixtures and holdout with `--lock`. The
script refuses to score while a locked file changed. New check files under a
lock become the climb's first commit; anything else uncommitted stops init.

## The card

Send Sphe one Markdown message (not a code block) and nothing else to decide:

> ### Climb card: `export-speed`
> **Goal:** a 10-minute export 2x faster, same frames
>
> | Score | Now | Bar |
> | --- | --- | --- |
> | Frames re-encoded, lower is better | **18,000** | **9,000** (2x) |
>
> | Setting | Value | Why |
> | --- | --- | --- |
> | Check | `bun test test/export-count.test.ts` | Counts encoded frames |
> | Guards | `bun test test/export.test.ts`, `bun run typecheck` | Same output |
> | Holdout | the timed export of 3 sample projects | Catches overfitting |
> | Runs, min gain | 1, 0 | A count doesn't drift |
> | Locked | `test/export-count.test.ts`, `test/fixtures/export` | |
> | Branch | `climb/export-speed` | |
>
> **Needs your answer:** none. Reply **go** to start, or change a line.

Ask for "go" with the question tool. If Sphe already said go ("yolo", "full
send"), skip the card, put it at the top of the report, and start. After go,
don't ask what you can find out or decide yourself; Sphe reads only the
card, a question, and the report. Set `--max-hours` or `--max-steps` only
when Sphe names a limit (soft unless `--hard`).

```
python3 "$CLIMB" init export-speed --goal "10-minute export 2x faster" \
  --check "cd app/apps/server && bun test test/export-count.test.ts" \
  --direction min --target 2x --guard "cd app/apps/server && bun test test/export.test.ts" \
  --guard "cd app/apps/server && bun run typecheck" --holdout ./.hill-climb/export-speed/holdout/run.sh \
  --lock app/apps/server/test/export-count.test.ts --lock .hill-climb/export-speed/holdout
```

## Climb

Each step is one idea, one change, one `try`:

1. Read `status`. Don't retry an idea the log undid unless you can say what
   differs. Try one idea at most twice; if you still believe in it, the check
   can't see it: make it finer and `relock --why "..."`.
2. Make one change for one reason and put your guess in the idea, like
   `"cache the probe (expect -10%)"`. A guess far off means your model of the
   code is wrong: profile before the next step.
3. `python3 "$CLIMB" try "<idea>"`. It commits a win or resets the tree.
   The step's output is in `.hill-climb/<name>/last.txt`, the best's in `best.txt`.
4. While a long check runs, don't edit the tree. Run `try` in the
   background and wait for its finish notice, never a sleep loop.
5. Every 5 steps, a few lines in `notes.md`: what works, what doesn't, what next.

Every 10 kept steps, look at the real thing: open the app, play the
export, read the output. If score and goal drift apart, fix the check.

**Helpers** (subagents, on Opus 5.5) may read, or draft a patch in their own
worktree; only you write in the climb tree, since `try` resets it. Good
moments: mapping the code while setup installs, ideas from the log during a
long check, the blocker review, the final review.

**Never cheat the check.** Each of these is a failed climb even if `try`
keeps it: special-casing the check's inputs, hard-coding expected outputs,
skipping or weakening tests, hiding errors, making the benchmark do less,
leaving files that slow the other side of a paired run, reading the
holdout. If the only way forward is one of these, the check is wrong: say so.

**Keep everything working.** Every 10 kept steps and at the bar, run `just
check` and the holdout; find a break with `git bisect run <command>`. Fix
it with `try --fix "<what broke>"`, which keeps a repair that holds the
score. Before the report, review `git diff <start>..HEAD` whole, or have a
helper do it fresh: removed tests, swallowed errors, a feature turned off, a
changed default, a saved project that no longer opens.

## When it stalls

`status` prints PLATEAU after 5 steps with no gain. Measure before you
guess: where the time goes, whether the check is flaky or too coarse, what
tool or data would change the next ten steps, what bigger idea the small
steps can't reach. Log it with `review "<found>"`; fix what you can (a
faster check, a finer count). Ask Sphe only for what only Sphe can give.

At BAR REACHED the holdout runs; a flat holdout is not a win. With `--after
raise`, set a bigger version of the same claim: `raise 2x --why "..."`.

Stop when the bar is met and the card says stop, `try` says the budget is
used, `status` says STUCK, the holdout disagrees, or the next step needs
Sphe and no other idea is left.

## The report

Scannable in ten seconds: a headline, one table, short bullets.

> ### Climb `export-speed`: bar reached
> **18,000 → 7,200** frames re-encoded, 2.5x (bar 9,000, step 23)
>
> | | |
> | --- | --- |
> | Holdout | 94 s → 41 s, moved with the score |
> | Steps | 11 kept of 30 |
> | Safety | Guards on every kept step; `just check` and final review clean |
> | Branch | `climb/export-speed`, 11 commits |
>
> **What worked** · reuse unchanged chunks: −6,000 · …
> **Tried and undone** · …
> **Your move** · `git log --oneline <start>..climb/export-speed`

Headline status: bar reached, budget spent, stuck, holdout disagrees, or
needs you. Delete `.hill-climb/<name>/data/` and anything big first.

## Commands

| Command | Does |
| --- | --- |
| `init <name> --goal --check --direction min\|max` | Baseline, branch, card. Also `--score` (one, or one per check), `--guard`, `--target` (number or `2x`), `--after stop\|raise`, `--runs`, `--paired`, `--min-gain`, `--timeout`, `--holdout`, `--lock`, `--max-hours`, `--max-steps`, `--hard`, `--here` (no new branch) |
| `try "<idea>" [--fix]` | Score the edit, keep or undo it |
| `status [name]` | Score, trail, last steps, PLATEAU or STUCK |
| `holdout --why "..."` | Run the holdout now |
| `raise <bar> --why "..."` | A harder bar after reaching this one |
| `relock --why "..."` | Accept a fixed check and measure again |
| `review "<found>"` | Log a blocker review |
| `budget [--hours N] [--steps N] [--off]` | More hours or steps from now, or no limit |
| `drop [name]` | Abandon the climb, keep its branch, put the check files back |
| `list` | Climbs in this checkout |

The script refuses to commit a file over 10 MB; big inputs go under
`.hill-climb/<name>/data/`, which git ignores.
