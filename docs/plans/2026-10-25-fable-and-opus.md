# Fable 5.1, Opus 5.5, or both (plan, Oct 25; experiments not run yet)

The user: "do you think using fable 5.1 instead of opus 5.5 could in theory improve the models compliance to our rules and be more creative? … Fable 5.1, although it's a much older model, is literally a bigger model … with a lot of the things that we try to force the agents to do through code and stuff like this, maybe Fable could do it better." And: "we may have to have a collaboration between fable 5.1 and opus 5.5 or we go full fable 5.1 but maybe experiments can help us decide."

Nothing is decided. This sets out what we expect, the options, and the experiment to choose between them. The experiment runs at the end of next week at the earliest.

## Why it might work
- **Most of our rules are taste, not code.** The skills hold editorial judgment the team learnt edit by edit: when a cut-in lands, when the music should change, what's funny, how long a shot may run. Benchmarks measure coding and agentic task completion, which is where Opus 5.5 leads, and they say little about taste. A bigger model usually carries more nuance and world knowledge, and that could show up as better creative choices.
- **Many soft rules at once.** The core plus a loaded skill is a lot of rules that pull against each other. A bigger model might weigh them better instead of following the loudest one.

## Why it might not
- **Doing what it's told over a long run** (every stage, the tools as told, one look per stage, no re-checking) comes mostly from post-training, not from size. Newer models are trained much harder on tool use and on staying on task across hundreds of calls. That's the "compliance" we care about, and here I'd bet on Opus 5.5, even though Fable is bigger.
- **Speed.** Round trips are what made full edits take hours (AGENTS.md). Our best Claude Code edits so far took 21.6 and 40.5 min on Opus. A bigger, slower model could undo that even if each step is better.
- **The skills are tuned on Opus.** Four teaching loops shaped the wording to how Opus reads it. Fable would be judged on another model's prompts, so give it a round or two of tuning before concluding anything.
- **What code enforces doesn't move.** Audits, defaults and mutes act the same under either model; that's why they're in code. The question is only about the judgment calls the code can't make.

## What I expect
Fable makes the better creative choices; Opus runs the workflow more reliably and faster. If that's right, the answer is a collaboration, not a swap.

## Options
1. **Stay on Opus 5.5.** Today's default (`app/apps/server/src/claude.ts`, `DEFAULT_MODEL = "opus"`).
2. **Full Fable 5.1.** Pick it in the agent panel (it lists Claude Code's models), with skills re-tuned if the first rounds call for it.
3. **Collaboration.** Opus 5.5 drives the turn and the tools; Fable 5.1 makes the judgment-heavy calls. Candidates, roughly in order of how much taste they need:
   - **Planner:** reads the context and writes the edit plan (story, moments, cut-in ideas, music beats); Opus carries it out.
   - **Critic:** watches the finished cut at final-pass and writes notes the way the team would; Opus fixes them.
   - **Per-stage chooser:** asked only at creative decisions (which cut-in, which track, where the joke lands).

   Each one costs a hand-off: context passed between models, and one more slow model in the loop. The critic is the cheapest to try, since it's one call at the end. This needs code, e.g. a sub-agent on Fable inside the Opus turn or a tool that asks Fable, and should be built only once the experiment says it's worth it.

## The experiment
Use the teaching-loop setup (`.claude/skills/teaching-loop`): the same test videos, the same build and private answer key, from-scratch edits, blind scoring, and a holdout last.

- **Arms:** Opus 5.5 · Fable 5.1 · Fable 5.1 after 1–2 rounds of skill tuning · one collaboration (critic first, planner if the critic helps).
- **Scored separately** (one combined score would hide the trade we expect):
  1. **Compliance:** rule breaks before the audits catch them, audit failures per edit, stages skipped or done twice.
  2. **Creativity and taste:** hits against the answer key on creative calls, plus a blind side-by-side ("which cut would the team ship?").
  3. **Time and cost:** minutes per full edit, round trips, tokens.
- **Runs:** at least two per arm per video. Runs vary, and one edit per arm proves nothing.
- **What decides it:**
  - Fable wins on taste but loses on compliance or time → collaboration.
  - Fable wins or ties on all three → full Fable.
  - Fable doesn't win on taste → stay on Opus; the gap is in the skills, not the model.

## Open questions
- Is Fable 5.1 offered under the user's Claude Code plan at the speed we need, and what does a full edit cost on it?
- Which counts for more if they disagree: the answer key, or the team's blind pick?
- Do we test with the team's next round of feedback, so the "creative" score is fresh and not something already taught?
