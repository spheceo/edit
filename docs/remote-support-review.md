# Remote support implementation review

2026-10-27. Reviewed Edit's committed receiver (`e6f89ba9`), Repack's Convex
commands (`0d5c30e`) and Accounts' token claim (`55d4d51`). The initial
implementation had substantive correctness and authorization defects. It had
not been validated against a live second machine.

## Findings and corrections

| Finding | Correction |
| --- | --- |
| The local operator API borrowed the host's account for any allowed network caller. A visitor to an admin's Tailscale-exposed Edit could request fleet updates. | Check the real socket peer and reject network, forwarded and browser requests. The CLI still connects directly over loopback. |
| Adding the Edit JWT provider also made those tokens acceptable to Feedback's issuer-only identity guard. | Require the signed `app_id: feedback` in Feedback as well as `app_id: edit` in support. Accounts must roll out first and existing Feedback tokens must refresh. |
| Disable waited for cloud authentication and a successful network mutation. Sign-out did not close the existing Convex connection. | Persist local revocation first, unsubscribe and close the socket; retry cloud cancellation later. Observe session changes and recheck the current owner before starting work. |
| Convex's forced-token-refresh argument was ignored. A cached token could leave the subscription without a scheduled renewal. | Honor forced renewal and use the SDK's initial token reuse option. |
| The receiver released its lock when downloading began. Another command could replace or delete the first command's single recovery file. Convex only blocked pending commands, not claimed ones. | Hold one active update locally through its outcome, retain delivered commands until they can be processed, and reject overlapping claimed updates in Convex. |
| A cloud claim could succeed before any local journal existed. Lost failure acknowledgements could later be reported as success after an unrelated upgrade. | Atomically journal before claiming and persist the exact terminal outcome before reporting it. Recover interrupted older claims without replaying them. Bound RPC waits. |
| An update only checked activity when accepted. Work begun during the download could be interrupted by the eventual restart. | Pass an idle guard to the updater and recheck it immediately before exec. |

## Validation and remaining scope

Regression coverage exercises command overlap, ambiguous claims, lost terminal
acknowledgements, interrupted older claims, local revocation and sign-out during
delivery, forced token refresh, socket-peer authorization and a real local HTTP
connection. The existing update, HTTP server and account tests are also run.
Convex authorization, claim exclusion, revocation, idempotent completion and
cross-app identity separation are checked using an in-memory handler harness;
the Repack repository's normal checks are run separately.

The full Edit typecheck still has the pre-existing uncommitted
`case_insertion.test.ts` fixture error (missing media `name`). A check excluding
only that file passes; those unrelated changes are not part of this review.

This review does not deploy services, publish a nightly or test a remote Mac's
actual process replacement. Deployment and a controlled two-machine update
smoke test remain required before calling the feature operational. Remote
agent turns remain unimplemented, consistent with the earlier decision to
leave paid remote work unavailable pending an enforceable spending limit.
