# Supporting an Edit on another Mac

## Convex remote updates

Nightly-25 and later automatically register signed-in team
devices for remote updates over a live Convex subscription. No terminal setup is
needed: install the new nightly, open Edit and sign in. The app must stay running.
Nightly-24 and earlier required `edit remote enable`; their published binaries
are unchanged. An existing explicit disable or cloud revocation stays off after
updating, restarting or reconnecting. `edit remote disable` revokes access and
cancels queued updates; `edit remote enable` explicitly turns it back on. An admin on
another running, signed-in Edit can run `edit remote devices`, then
`edit remote update <device-id>` and `edit remote history <device-id>`. A request
expires after an hour. Status records distinguish a claimed update from a new
build that actually restarted. No command is replayed after an ambiguous crash.

Registration itself never starts an update or agent turn. Updates remain
explicit admin requests. The update uses the owner's configured release channel, verifies the existing
release signature/checksum and refuses an active export, Drive upload or agent
turn. If work starts during the download, the restart waits for it to finish.
The operator endpoint accepts direct loopback CLI connections only; Tailscale,
proxy and browser requests cannot borrow the host's signed-in admin account.
Disabling support takes effect locally even when offline, with cloud revocation
retried later. Signing out closes the authenticated subscription. It cannot
start a closed app. Remote agent turns are disabled until a
spending limit is implemented and accepted. The Convex functions and the relay
support-config route and the Accounts token claim must be deployed before this
can work, and the owner needs to install the first build containing it by the
usual update path. Deploy Accounts first and refresh Feedback sessions before
deploying Convex: the shared deployment now checks the signed `app_id` for both
Feedback and Edit. Deploy the relay and receiver build after those changes.

`edit support` is a client for an Edit the owner has already shared over
Tailscale. It creates no listener and does not pair devices, change a Mac's
network access, install updates or execute shell commands. The shared Edit keeps
running its normal local agent; its signed-in account grants and cloud-project
locks still apply. This is network access to the owner's app, not an operator
sign-in or a new account permission.

## Existing access and current blocker

The deployed services, original nightly-24 rollout, live transport test and JJ project evidence
are recorded in [the 27 October rollout](remote-support-rollout-2026-10-27.md).
The subsequent [automatic registration change](remote-support-automatic-registration.md)
removes terminal activation for devices that have not explicitly disabled support.

Edit already listens on loopback and its Tailscale address when available, and
its UI, diagnostics and project agent APIs can be used over that connection.
Host/Origin checks protect the local APIs; Tailscale ACLs control which other
devices can reach them. There is no separate per-operator pairing/authentication
layer in the existing server. Do not expose this local app on the public internet.

The inspected tailnet inventory did not identify JJ's Mac, and the live support
inventory contained no JJ receiver at that rollout. Three shared projects have now been
identified and backed up for repair through the operator's normal local Edit.
Their cloud snapshots do not include JJ's local errors. No connection to JJ's
Mac, remote update or remote agent turn has been performed. Installing a local
code change does not update JJ's installed nightly.

## Owner setup and operator commands

On the owner's Mac, keep Edit open. If Tailscale access is already deliberately
configured for this support session, the existing HTTPS setup is:

```sh
tailscale serve --bg http://127.0.0.1:7700
```

The owner shares the HTTPS address shown by Tailscale and grants the operator's
device access through the tailnet's ACLs. Reuse an existing configured endpoint;
do not replace other Serve mappings without checking them. The owner's project
must be on this Mac and writable here; a cloud lock held elsewhere is refused.

On the operator's Mac, with a build containing the support client:

```sh
edit support status --url https://jj.<tailnet>.ts.net
edit support projects --url https://jj.<tailnet>.ts.net
edit support diagnostics --url https://jj.<tailnet>.ts.net
edit support chat <exact-project-id> --url https://jj.<tailnet>.ts.net
edit support ask <exact-project-id> --url https://jj.<tailnet>.ts.net --message-file repair.txt
edit support stop <exact-project-id> --url https://jj.<tailnet>.ts.net
```

Replace the placeholder endpoint with the exact owner-shared address. The client
accepts only a credential-free standard HTTPS Tailscale endpoint. It refuses
redirects, query tokens, arbitrary hosts and proxy paths. `ask` reads a nonempty
text file of at most 64 KiB and sends that one explicit message to the selected
project's existing agent. It does not open that project in the owner's UI, reset
its chat or select a different provider. Checking diagnostics or chat starts no
agent work. A turn explicitly requested through `ask` uses the remote app's
normal provider and its existing account, just as a message typed on that Mac.

Every request has a 30-second deadline and no automatic retries. If an action
loses its acknowledgement, inspect `chat` before deciding whether to send it
again; the first action may have arrived. Output is JSON with credential fields,
signed URLs, bearer tokens and common raw token formats redacted, including old
log text from a remote build. The client stores no credentials or support bundle.

## Writer and a future paired support surface

Writer's current local API binds only `127.0.0.1:1421` and checks local Host and
Origin. This client does not weaken those checks or claim to control Writer.
Writer's development browser view can use its existing owner-configured
Tailscale/Vite setup; the packaged app has no equivalent paired operator UI yet.

A support surface independent of existing tailnet access needs an owner-enabled,
expiring session, one selected project, visible operator identity, narrow
diagnostic/agent-message/stop commands, revocation and an audit receipt. Its
commands should reuse local grants and cloud locks; diagnostics never trigger
repairs, reconnects never replay a turn, and updates/login remain deliberate local
actions. That requires an app/relay rollout and is not silently enabled by this
CLI. Until then the concrete remote path here is an owner-shared Edit endpoint;
JJ's Writer remains a separate access blocker.

## Verification

Offline tests cover endpoint validation, absent/hidden projects, exact explicit
agent payload, no UI project-open side effect, lock refusal, missing
acknowledgement without retry, credential redaction and a non-Edit proxy response.
No live remote or paid service calls are used by these tests.
