# Remote support rollout — 27 October 2026

## Released and deployed

The current release is
[nightly-24](https://github.com/spheceo/edit/releases/tag/nightly-24), source
`0e4b21638c7f20a75bf2f691ad91681ed17aeb64`. It adds the narration source-boundary
fix found during recovery to the rollout below. Its
[workflow](https://github.com/spheceo/edit/actions/runs/40481183426) passed for
Apple Silicon and Intel, including app packaging, and published all ten assets.
The downloaded Apple Silicon archive passed SHA-256 verification, printed
`edit nightly-24`, and served health/diagnostics from an isolated temporary home
with diagnostics identifying `nightly-24`. The local development server was
also rebuilt and restarted onto the corrected source while idle.

Edit [nightly-23](https://github.com/spheceo/edit/releases/tag/nightly-23)
contains the remote-update receiver, the reviewed recovery/authentication fixes,
YouTube-caption support already on main, and the missing-case insertion feature.
Its source is `88571f6f802c088424a1025cc584865a6fe0a5ad`.
The [release workflow](https://github.com/spheceo/edit/actions/runs/40477536910)
passed for Apple Silicon and Intel and published both archives, app update zips
and disk images. The downloaded Apple Silicon archive passed its published
SHA-256 check, printed `edit nightly-23`, and served health and diagnostics from
an isolated temporary home. Diagnostics identified `nightly-23`; health reports
the underlying package version (`0.0.0`), as designed by the existing route.

| Service | Source | Deployed version |
| --- | --- | --- |
| Accounts | `55d4d51` | `14385193-97f6-401d-82ff-906fcc5bc2b3` |
| Feedback | `e61fc47` | `aff1b8a0-20ef-421d-a1fb-7acae9e114f1` |
| Repack Convex | `6d798d3`, generated API `7b8e8ea` | Shared `descriptive-rabbit-484` deployment |
| Edit relay | Edit nightly source above | `3766465c-d797-4dc5-85e2-3b072116a212` |

Accounts shipped first, with its existing static assets retained after
Cloudflare's asset-session API failed twice. Feedback then shipped the legacy
session refresh needed to obtain the new signed `app_id` claim. Convex was
published only after those identity changes. The Edit relay's support-config
route is deployed. All source changes were committed and pushed.

## Verification

- Full Edit server typecheck passes, including the previously invalid case
  insertion fixture. Its media now includes the required `name`.
- Server suite: 725 passed, 7 skipped, 0 failed. The full run also caught and
  corrected the new tool's missing default-project schema description.
- Web typecheck passes; 145 tests in 21 files pass.
- Accounts: 233 tests in 8 files pass.
- Feedback: full check passes, including 161 tests in 13 files. The checked-in
  Writer types were synchronized with Writer's additive type changes.
- Repack's full check passes (135 existing warnings).
- A real authenticated Convex WebSocket subscription received an update request.
  The first claim succeeded, a duplicate claim was rejected, and a terminal
  receipt was visible. This transport test explicitly recorded that **no app
  update was executed**. Its temporary device is disabled.
- The rebuilt local editor's actual `edit remote devices` CLI authenticated
  successfully. A browser-Origin request to the operator API was refused with
  HTTP 403. The inventory still contained only the disabled verification device.
- Deployed Accounts' sign-in page and existing `site.js` both returned HTTP 200;
  Feedback's sign-in page also returned 200.

This verifies release packaging, identity, transport, exclusive claiming and
receipts. It does not verify another Mac replacing its actual running process.

Recovery also exposed a narration-placement defect: the trailing pause could
extend past the recording's end. Placement now clamps its end to available
whole source frames. The existing integration test exercises a recording ending
immediately after its final word; the targeted 25-test suite and full server
typecheck/suite pass (725 passed, 7 skipped, 0 failed).

## JJ's projects: evidence before repair

These are the three projects attributed to JJ in the shared project inventory.
Their original cloud snapshots were copied to the operator's private
`~/.edit/recovery/2026-10-27-jj/` directory before repairs. They were unlocked
when opened through the normal cloud-project API; no forced takeover was used.

| Project | ID / original cloud revision | Observed unfinished result |
| --- | --- | --- |
| Predator Cop Gets 263 Years For Preying On 8 Women During Night Shifts | `p1793025584122-46`, rev 25 | All 121 footage blocks present; 28 generated narration recordings, none placed. Audit finds 27 uncovered narration cards. |
| Off-Duty Officer Accidentally Says Something Only The Killer Would Know | `p1793025553223-34`, rev 27 | All 177 footage blocks present; 25 generated narration recordings, none placed. Audit finds 25 uncovered narration cards and one sliver. |
| “Concerned” Sergeant Thinks He Committed The Perfect Murder Of His Lieutenant Wife | `p1793003918016-1`, rev 99 | All 129 footage blocks present and all 13 narration clips placed. Audit flags three exhausted sources, repeated pictures/plain stills and a moved subtitle, among other flags requiring editorial inspection. |

The first two stopped with prepared narration outside the timeline. Their
three-second narration placeholders are not finished cut-ins. The third is a
substantial existing edit and needs targeted review. Deleted narration cards in
that project are not evidence of lost narration: finished voice-overs replace
them. Mechanical audit counts alone do not establish whether an intentional
graphic, repeated source or layered construction needs changing.

The snapshots do not contain JJ's local agent conversations or diagnostics, so
the original local exception or exact error message remains unknown. There is
no evidence that all three failed for the same reason.

## Repairs saved and work remaining

The normal local Claude Max agents placed all **28/28** Predator Cop narration
clips and **25/25** Off-Duty Officer narration clips using the existing takes.
No replacement narration was generated. The Sergeant edit retained **13/13**
placed narration clips; its recovery agent replaced the letterboxed mugshot
with a full-frame version and alternated existing case photographs in the
audio-only stretches. Inspection of the source confirms that at least some
interview sections really are audio over a still portrait, so repeated-picture
flags cannot all be treated as accidental overlays.

All three recovery turns then stopped with this **current operator-side** error:

> You've hit your weekly limit · resets 4am (Africa/Johannesburg)

This is not evidence of JJ's original local error. No provider was changed and
no paid API fallback was enabled. The saved narration placement remains useful.

Further repairs were applied directly through Edit's normal revision-checked
timeline tools:

- Trimmed 12 narration clips by 1–4 frames to remove tails beyond their source
  files, preserving spoken material and the remaining timeline positions.
- Slowed the Sergeant map player to 0.75x so its 10-second source covers its
  existing 400-frame window without running past its end.
- Merged Off-Duty Officer's one-frame subtitle continuation into the preceding
  line, preserving its words and the next speaker's start.
- Ran track tidying. No forced cloud takeover, reset, export or sharing occurred.

The pure mechanical audit now finds **zero exhausted sources in all three** and
no remaining one-frame sliver in Off-Duty Officer. The shared inventory confirmed
cloud revisions 30 (Predator Cop), 30 (Off-Duty Officer) and 104 (Sergeant) after
these saves. Local edit revisions are a different counter.

These projects are **not certified as finished**. Predator Cop still has 28
narration cards without complete visual coverage; Off-Duty Officer has 25.
Full review also finds incomplete subtitle coverage. Both need the remaining
house-style visual, subtitle, sound and final-review stages. Sergeant still
needs editorial review of its repeated/plain stills, subtitle placement and
transitions; its counts include intentional audio-only material and designed
graphics. No final movie was exported. Resume instructions are in
[the recovery handoff](jj-recovery-handoff-2026-10-27.md).

## Machine access and remaining feature scope

JJ has not registered a receiver in the live support inventory, and no
owner-shared JJ endpoint was found in the available tailnet. His Mac has not
been updated or restarted by this rollout. He needs to install nightly-23 by
the normal updater/installer, remain signed in and running, and opt in with
`edit remote enable` once. Later update commands can use Convex without
Tailscale. A closed app cannot receive them.

The repairs in this rollout run against the unlocked shared project copies on
the operator's Edit, using its existing Claude Max login and ordinary project
locks. Saved changes can synchronize back to JJ. This is not a remote agent
command on his Mac. Convex-triggered agent turns remain disabled pending an
enforceable spending limit; the remote-agent part of the original request is
not implemented.
