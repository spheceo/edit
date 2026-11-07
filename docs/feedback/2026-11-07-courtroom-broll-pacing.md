# Courtroom B-roll cut every second: JJ's note

JJ, Nov 7 (Discord), on courtroom edits, comps and single cases: "I don't like how we move around in the B-roll footage almost every second… it's the same footage that we keep zooming in and out of and clipping in on when we don't really have anything else to show. In those cases, it's significantly better to just stay on the same piece of B-roll footage and then zoom in on it."

## Why it happened

The house rule for footage B-roll (cut-ins skill: a new shot every 2–4 s, and the audit's `long_broll_shot` flagging anything held past 4.5 s) applied to courtroom too. A courtroom's B-roll is the hearing's own fixed cameras, so the agent filled each bridge with punch-ins on the same picture. The courtroom notes asked for "2–4 shots… whom the narration names, punched in, then whoever reacts", and the worked edit showed bridges of 5–8 shots and a setup of 17.

## The fix

- Courtroom notes, NARRATION BRIDGES: HOLD THE SHOT, with JJ's words. Open on the person the narration names, punched in, and stay there under a push you can see move (push [1, 1.25]). Cut only to a picture that's new, each shot held 5 s or more, so a bridge is one to three shots. The same goes for the hook and the setup. The walkthrough and the cut-ins skill say so too.
- Audit: `long_broll_shot` no longer flags courtroom. A new `broll_recut` (courtroom only, onscreen.ts) flags two back-to-back B-roll shots of one camera picture (the same file with none of its cuts between them) when either runs under 5 s. It's on the FIXABLE list.

## Still to do

Not run through the in-app agent yet: this machine has no courtroom project. Next courtroom edit on a Mac with this build: check that the bridges hold their shots and `broll_recut` comes back empty.
