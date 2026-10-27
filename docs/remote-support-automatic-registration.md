# Automatic remote-update registration

Nightly-25 removes the terminal activation requirement.
On first startup with an authorized Edit account, the app saves its device ID and
owner before contacting Convex, registers the device and starts the authenticated
live subscription. First sign-in after a signed-out startup works the same way.
Installing and opening Edit while signed in is sufficient.

This is an activation default, not an automatic update or agent request.
Updates still require an authenticated admin command and retain the existing
release verification, idle checks and durable recovery journal. No new model
calls, exports or background agent turns start during registration.

The new Convex `register.onlyIfNew` option creates a missing device but returns
an existing device's preference unchanged. A lost first-registration response
can therefore be retried without reversing a cloud revocation. The client keeps
its enrollment marker until acknowledgement and stores a revoked response as
disabled locally. Local disables and account changes during registration are
checked before saving its result. Existing saved preferences, including an
explicit disable or corrupt/unreadable preference file, are not overwritten by
the automatic default. Only explicit `edit remote enable` can re-enable a saved
disable.

The compatible Convex change must be deployed before the new receiver ships.
Older nightlies continue working with their previous explicit activation flow;
publishing a new default does not change nightly-24's binary in place.

Validation covers stable identity before network access, signed-out startup,
saved disables, account ownership, corrupt preferences, acknowledgement loss,
cloud revocation and disable/sign-out during registration. Existing update
execution, overlap, recovery and local operator authorization checks still run.

The full server typecheck and suite pass: 730 passed, 7 skipped, 0 failed.
Repack's full check and the in-memory backend authorization/revocation harness
pass. The compatible backend (`3805995`) is deployed to the shared Convex
deployment. A live test rebuilt and opened the signed-in local editor with no
existing preference file: its device registered as enabled, its enrollment
marker cleared, and the actual admin CLI listed it in the live inventory.
No enable command, update request or agent turn was sent for that test.
