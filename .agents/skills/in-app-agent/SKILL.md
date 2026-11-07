---
name: in-app-agent
description: Run a project through Edit end to end as a real user would and improve Edit's in-app agent from what breaks and from the team's feedback. Use when Sphe hands you a project or video to take through Edit, passes on the team's notes about an edit, script, idea or thumbnail the agent made, asks for a trial, or when you change anything in `agent/` (instructions.md, the skills).
---

# Improving the in-app agent

## Take the project through Edit, as a user would
When Sphe hands you a project, take it through Edit end to end as a real user would, in order, through the app's own screens, tools, and in-app agent. Never skip a step, edit the project by hand, do a tool's job for it, or drop a feature to finish faster.

If something breaks, stop there:
1. Find the root cause.
2. Fix it in the product: the code, a skill, an audit, or a tool.
3. Verify it with a test and by running the failed step again.
4. Commit, then carry on from that step on the fixed build.

When only Sphe can unblock a fix, stop and ask. Log each fix in `docs/feedback/<date>-<project>.md`, and also in the teaching loop's `LOG.md` when the run is a trial.

## A round of feedback
A round of feedback is a chance to make the next edit better, not just this one. For each pattern in the notes, decide:
- how to teach it,
- what should be right by default,
- what audit or tool stops it coming back.

Quote the team's words in the rule when they carry the reason. Then apply it through the in-app agent on the new build.

Lessons noted between rounds are an inbox, not memory the agent reads back. The skills, the code, and the audits are what teach it.

## Teaching loops and trials
We run teaching loops and trial experiments now and then, not all the time: when enough feedback has built up to make it worth training the agent. To make a lesson stick across videos, use the `teaching-loop` skill.

## Changing `agent/`
`agent/` is what the in-app agent is taught. It is read into the binary at build time, so under `just dev` the server has to restart before a change shows up.
- Keep the team's wording.
- A new rule goes in the skill for that part of the edit. Only what every part needs goes in `instructions.md`.
- The core and the skills ask for one context read, one plan, and one look per stage. Say what to check, never "check with render_frame".
