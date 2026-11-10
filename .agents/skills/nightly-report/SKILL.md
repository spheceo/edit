---
name: nightly-report
description: Write the end-of-day changelog Sphe sends to the team: what each nightly since the last report changed, in plain English, and the plans for tomorrow. Use when Sphe asks for the nightly report, the changelog, the end-of-day report, or "something I can send to the team" after a release.
---

# The end-of-day nightly report

Sphe pastes it to the team (JJ, Marc, Marius) as it is. They use Edit all day and know nothing of the code. It's returned in the chat, in one code block so it copies clean; never saved to a file, never published.

## What goes in

1. **The nightlies since the last report**, oldest first. Their dates and what's in each: `gh release list --limit 5`, `git log --format='%h %s' nightly-<N-1>..nightly-<N>`, and `bun scripts/nightly-notes.ts nightly-<N-1> nightly-<N> ""` (from `app/`) for the one-line list. The day's audit or plan in `docs/plans/` says what was found, measured and left.
2. **Plans For Tomorrow**: what's next from the session, and whatever Sphe says he wants on it. Ask him if he hasn't said. Say plainly what a nightly did not change when the team might assume it did.

## The team's rules (Sphe, Nov 10, 2026)

- **Only what they can see with their own eyes**: a button that works now, a wait that's gone, a cost that dropped, a new choice on screen. Everything else (a check added, a crash fixed, a test repaired, anything that needs the code to picture) goes in one closing line per nightly: "And other bug fixes and performance improvements."
- **As few bullets as possible.** One sentence each. A change that needs background (a new way something works) gets up to three sentences in its bullet: what happens now, why it matters, the number. Never a section of its own.
- **Certain or not, said in the verb.** Tested or measured: "X is Y." Fairly confident but not proven on everyone's Mac: "X should be Y." Nothing weaker goes in.
- **Real numbers, only ones we verified**, and only ones that mean something to them: minutes waited, hours paid for, times it failed. "17 minutes on one video, almost 3 hours on another" is good; frame counts, milliseconds, gigabytes and percentiles confuse and come out.
- **Sphe's voice**: "In my test", never "in our test" or "we".
- Count things as they are: one agent is "agent", not "agents".

## The shape

- Title: `Software Changelog - Edit`. "Changelog" is one word. A plain dash, never an em dash.
- Headings in Title Case with spaces ("Nightly 70", "Plans For Tomorrow"): no capitals throughout, no markdown marks.
- One blank line above each heading and one below it. No date line.
- "Please update to nightly-N." under the title, and nothing on how.

```
Software Changelog - Edit

Please update to nightly-70.

Nightly 69

- Transcription is no longer paid for twice on the same footage. On one Mac that was about 56 extra hours of transcription in five days.
- If Edit restarts or updates in the middle of an import, export or share, the work should carry on by itself afterwards.
- And other bug fixes and performance improvements.

Nightly 70

- You can share a video the moment its export finishes. Before, Share stayed locked while the export uploaded in the background: 17 minutes on one video, almost 3 hours on another.
- Playback in Edit.app is smooth, and jumping around the timeline is near-instant once a project's footage is on your Mac.
- The agent wastes less time. It was rejecting its own changes (14 times in one edit) and fixing overlapping subtitles one pair at a time (10 failed tries in 75 seconds). Both are fixed.
- Script imports should cost far less in transcription. Your Mac now listens to the recordings itself first, using Apple's free built-in speech recognition, and only the moments chosen for the script are sent for paid transcription. In my test on a case with five and a half hours of recordings, that took paid transcription from about 12 hours to under 1.
- And other bug fixes and performance improvements.

Plans For Tomorrow

- Script mode playback: move it onto the same player as Edit mode, so both get the same speed and every future improvement together. Script mode playback is unchanged in nightly-70.
- Finish the base for the FOIA footage-requesting agent.
```

## After the block

A few lines to Sphe, outside the block, that he doesn't send: where each number came from (measured this session, read off a teammate's report, or taken from an earlier session's record and not checked again), and which bullets nobody tried by hand. He decides which to stand behind.
