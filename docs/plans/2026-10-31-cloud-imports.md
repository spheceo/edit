# Imports in the cloud, Oct 31

Sphe, Oct 31: "why can't we just do something big to fix this once and for all, no matter how long it takes". Then: "on Modal we'll probably need to use the proxies as the default, but for everything else we probably won't need it".

## Why

Over the last 300 commits about 40 fixed an import that stopped or froze: YouTube, Drive, transcription 524s, preview encodes, resumes. Each fix held, but the next import failed somewhere new, because imports run on the teammates' Macs. Those Macs sit on home Wi-Fi, sleep, restart for updates, run older nightlies, and sometimes two of them work on the same script at once. Every one of those is a way to fail, and patching them one at a time never ends. Kroger (Oct 31) is the pattern: one dropped connection at 5% stopped the import on three Macs.

The cure: the Macs stop doing imports. An import runs in the cloud as durable steps that save after each step and retry until they finish. A Mac starts it, shows its progress, and does only what has to run on the person's own Claude Code.

## What moves to the cloud, and what stays

| Step | Today | In the cloud |
|---|---|---|
| Read the Doc, Trello and links | Mac (relay for Trello) | Workflow step on the relay (it already holds the Google sign-in and Trello) |
| Drive recording → R2 original | relay's `DriveToR2` Workflow, else the Mac streams it | `DriveToR2` only, never the Mac |
| YouTube video → R2 original | yt-dlp on the Mac (fixed today: 8c25e077) | yt-dlp on **Modal, through the DataImpulse proxy by default** (YouTube blocks datacenter addresses), 720p (`PROXY_FORMAT`) |
| Excerpts (a range of a recording) | FFmpeg on the Mac reading R2 | Modal FFmpeg, R2 to R2 |
| Proxy and preview pieces | Mac's VideoToolbox (Kroger's 43-min piece: 497 s) | Modal (`edit-proxies` exists: `apps/worker/proxy.py`), no proxy needed |
| Transcription (Scribe pieces + whole) | Mac calls the relay piece by piece | Workflow steps on the relay calling Scribe directly, one step per piece |
| Bodycam IDs, speakers, watch | Claude Code on the Mac | **stays on the Mac** (the person's own Claude Code: Anthropic's terms) |
| Writing the script, first build | Claude Code on the Mac | **stays on the Mac** |

Only the YouTube step uses the proxy. Drive, R2, Scribe and Modal's own reads go straight.

## How it's built

1. **One import job per script, a Cloudflare Workflow on the relay** (`ImportJob`, next to `DriveToR2`). Its id is the script and the revision of its sources, so asking again finds the same job; a changed Doc makes a new one. Each step is `step.do` with retries and backoff: a failure retries that step only, for up to 12 hours (minutes apart, then longer), and survives relay deploys, Mac sleeps and restarts.
2. **Heavy steps on Modal**: `edit-imports` (`apps/worker/imports.py`), with functions `youtube_original` (yt-dlp + proxy, its own resume, then a multipart upload to presigned R2 URLs), `excerpt` and `preview`. The Workflow calls a Modal web endpoint with `MODAL_WORKER_TOKEN` (already on the relay) and polls; a function that dies is called again with the same inputs, and steps are written to be safe to run twice (fixed R2 keys, registry checked first).
3. **The job's state in Convex** (`edit:importJobs`: steps, bytes, percent, the step it's on, the last error, who started it), written by the Workflow. Every Mac reads the same record, so Home shows the same progress everywhere, and two Macs can't run one import twice: the second just watches.
4. **The Mac**: New project and Retry call `POST /v1/cloud/jobs/import`, then follow the record. When the cloud part is done it runs the Claude steps from the cloud copies (nothing downloaded but the small preview), as a local queue that also retries by itself. Restarts pick up from `jobs.json` as today.
5. **What people see**: "stopped" only for what no retry can fix: a video taken down or private, a Drive file they can't open, a Doc that's gone. It comes with the one action that fixes it (Replace…, a link to share the file). Everything else stays "Importing" and keeps trying. After 12 hours of failed tries the import reports to the team's reports (remote support), not to the person.

## Making sure it holds

- **Canaries**: every 3 hours a scheduled job imports one of each kind (a YouTube video, a Drive recording, a Doc with ranges, a Trello compilation, a pasted script) under `edit/test/`. A canary that fails pings Sphe and lands in the reports, so the team never finds a failure first.
- **Faults on purpose**: tests that kill a Modal function mid-upload, make a Workflow step throw, and have Scribe answer 524. Each one must end in a finished import with no duplicate pieces in R2.
- **Old failures as tests**: every import failure in `~/.edit/reports-inbox` since Oct 20 is a case the new path must get through (Kroger, the 524 that stopped a 6.7-hour import, Axon full-range previews, Predator Tutor's sync loop).

## Order of work

1. Catalogue: every distinct import failure from the reports and the log, with its source. Half a day.
2. `edit-imports` on Modal: the YouTube original through the proxy, excerpt, preview; tests on real videos (Kroger first). One day.
3. `ImportJob` Workflow + Convex record + `/v1/cloud/jobs/import`; DriveToR2 and transcription as its steps. One to two days.
4. The Mac side: start, follow, Claude steps after; Home and the import dialog read the record. One day.
5. Canaries and fault tests. Half a day.
6. Trial server (`EDIT_CLOUD_IMPORTS=1`) through the whole flow on real scripts, then a nightly with it on for everyone. The Mac path stays as a fallback for one week, then it's deleted (one path, not two).

About five days in all. Edit-mode script imports (`script.ts`: Doc → edit) move the same way after, since they share the steps.

## Costs to check

- Proxy: $1/GB at 720p, about 0.3–0.5 GB for a 25-minute video, so ~$0.40 a YouTube video. 1080p through the proxy would roughly double that.
- Modal: CPU minutes for yt-dlp and FFmpeg, cents per import.
- Workflows: within the Workers plan.

## Open questions for Sphe

1. 720p through the proxy for YouTube, or pay for 1080p?
2. Should canary failures go to you directly (push notification) or only to the reports?
3. During the fallback week, should a Mac fall back to the old path by itself when the cloud job can't start, or always wait for the cloud?
