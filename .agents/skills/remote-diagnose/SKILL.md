---
name: remote-diagnose
description: Diagnose a problem on a teammate's Mac (JJ's, Marc's…) from this one. List the team's Macs, read their latest reports, ask a Mac read-only questions (its log by time and pattern, system, processes, network, work under way, a project, files in Edit's data folder, Edit's own GET routes), and, only when needed, unstick, restart or update it. Use whenever Sphe or a teammate reports something going wrong in Edit on another computer, or a fix needs checking there.
---

# Diagnosing a teammate's Mac

Everything goes through `app/apps/server/scripts/remote.ts`, run from `app/`. It signs in as the admin signed in to `~/.edit-dev` (`--home` for another data folder) and talks straight to the team's (prod) Convex and relay; no Edit needs to be running here. `--dev` talks to dev instead, where the dev server on :7700 is a device (`kenobi`): use it to try a new question before it ships.

```sh
bun apps/server/scripts/remote.ts devices                 # every Mac: build, started, last report
bun apps/server/scripts/remote.ts latest                  # each Mac's "needs attention", one block each
bun apps/server/scripts/remote.ts latest mathiass         # one Mac's whole latest report
bun apps/server/scripts/remote.ts ask mathiass help       # what can be asked
bun apps/server/scripts/remote.ts ask mathiass log since=2h level=warn
bun apps/server/scripts/remote.ts ask mathiass log since=1d grep=pieces|upload lines=2000
bun apps/server/scripts/remote.ts ask mathiass work       # jobs, uploads, pieces, imports, agent turns
bun apps/server/scripts/remote.ts ask mathiass project p1793748290029-143711
bun apps/server/scripts/remote.ts ask mathiass get /api/projects/<id>/media/<m>/status
bun apps/server/scripts/remote.ts history mathiass        # what was sent and how it went
```

A Mac is named by any part of its name (`devices` lists them). Answers print and are kept in `/tmp/edit-remote/`.

## How to go about it
1. **Read before asking.** `latest <mac>` is free and works when their Mac is off: what needs attention, problems grouped with counts, the log's end. Most problems are named there.
2. **Ask narrowly.** A question must fit in about 85 characters (it rides the database's 120-character target), so ask `log since=… grep=…` rather than whole files, and widen in steps. The log keeps five rotations (about a week).
3. **The Mac must be on with Edit open** for `ask`, `diagnostics`, `probe` and the rest. If it isn't taken within `--wait` seconds (180 by default), the script says when that Mac last sent a report. Commands wait 10 minutes in the cloud.
4. **Questions are read-only.** `ask` never changes their work, settings or projects, and sign-in files are refused. The answers are scrubbed of URLs and tokens and go to `edit/reports/remote/`, which only an admin reads.
5. **What changes something says so: ask Sphe first** unless he asked for it. `unstick` (retries syncs and imports, stops agent turns quiet for 15 min, cleans the cache when the disk is full); `restart` (only when nothing's running); `update-when-idle` (waits for 20 min without use; prefer this to `update`); `resume <id>`.
6. **Fix it in code and ship it.** A diagnosis ends in a fix in the product (and a test), as AGENTS.md says, not in hand-edits on their Mac.

## Good to know
- `ask` needs a build with `remote_ask.ts` (after nightly-53). On an older build, `latest`, `diagnostics`, `probe` and `history` still work.
- Their `latest` report is pushed every 5 minutes when what needs attention changes, else hourly, while Edit is open.
- A new question goes in `remote_ask.ts` (read-only, tested in `test/remote_ask.test.ts`); try it with `--dev` before it ships.
