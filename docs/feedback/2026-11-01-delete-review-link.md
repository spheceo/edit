# Delete a review link (Nov 1)

Sphe: "we need to be able to delete a review link", for scripts and for edits. Nothing could: there was no delete in Edit, the relays didn't allow one, and the `reviews` Convex module had none. (Repack's dashboard has `reviewPage:remove`, by review id, for any app. It's left as it is: see Open.)

## What was built

- **Convex** (accounts `0fbb13e`): `reviews:remove {app, sourceId}`. It deletes the app's review, every version, note and reply, so the link opens nothing (`reviewPage:page` answers null). Every R2 file its versions name (the shared file, the poster, and the keys in their meta: `fullKey`, `preview.key`, `wordsKey`…) is queued as `review-file` cleanup and returned to the caller. It's refused while a Ready for changes is being fixed or shared, unless that computer has gone quiet (`FIX_STALE_MS`). A source with no review answers `removed: false`, so a second try is harmless. Deployed to dev (determined-heron-867) and prod (unique-shrimp-228). It's additive: nothing calls it until the relay ships.
- **Relay** (`f5a5c900`): `reviews:remove` is in `REVIEW_CALLS` (always as Edit's review) and `WRITER_FUNCTIONS` (as Writer's). Both relays allow it only to someone with `review.share`, or to an admin. Tests are in `relay.test.ts`. Dev is deployed; prod goes out with a nightly's tag.
- **Edit** (`f5a5c900`):
  - **Delete link** appears in the Share dialog (edits) and beside Copy in the script Review dialog. It's asked first in the dialog itself, not with `window.confirm` (WKWebView has none). The confirmation says it can't be undone: reviewers lose the page and every note on it.
  - On the server, `reviews.removeLink` (`DELETE /api/projects/{id}/review`) and `writer/reviews.removeLink` (`DELETE /api/writer/scripts/{id}/review`) call `reviews:remove`. They delete what's under `edit/reviews/<id>/` or `writer/reviews/<id>/`, and forget the link here: `reviews.json` for an edit; for a script, its `review`, `review-text.json` and its notes.
  - It's refused while the link is sharing, being fixed for a Ready for changes, or Claude is on the script. No share starts while a delete runs.
  - Other Macs forget a deleted link at their next look (`poll`). That covers a link that was shared before `reviews:open` was read and is missing from the whole list.
  - The exports on disk stay.

## Tried on the dev server

- The three test links were deleted in the app's own Review dialog: "TEST share a" (v1–v3), "TEST share b" (v1–v3) and "TEST share c" (v1). Each time the dialog went back to "Share for review" and the topbar to Share.
- The server log shows 4, 4 and 2 R2 files deleted under `writer/reviews/<id>/`.
- Dev's `reviewPage:page` (what the review page reads) answered `open` for all three before, and null after, which the page shows as "This link opens nothing". `reviews:open` lists no TEST review.
- Note that feedback.spheceo.com reads prod's Convex, so dev links already said "This link opens nothing" there before the delete. It can't serve as this check.
- The three test scripts were then deleted from Home's row menu. The cloud has each one marked deleted.
- **Not tried end to end: the edit Share dialog's delete.** No dev edit has a review link, and making one means exporting and sharing a whole edit. The edit path is covered by `reviews_delete.test.ts`, and runs the same Convex and relay call the scripts used.

## Fixed on the way

1. **Home kept a deleted script's row until a reload.** This came up while deleting "TEST share c" from Home's ⋯ menu: the script was gone on the server ("That script is missing"), but its row stayed.
   - Root cause: Home's list of scripts is the cloud's (`/api/writer/handoff` → `writer:listScripts`). The delete is queued, and reaches the cloud on the next sync, so the list Home re-read right after still had it.
   - Fix: the list leaves out scripts this Mac has queued for deletion (`writer/cloud.beingDeleted`). Commit `1af37824` (the helper is in `f5a5c900`).
   - Verified: a test in `writer_handoff.test.ts`, then "TEST share b" and "TEST share a" deleted from Home on the fixed build. Each row went at once.
2. **"v1 to v1" in the confirmation and the log** for a link with one version. It now reads "every note on it" (and "v1" in the log). Fixed in `f5a5c900`, seen in the dialog for c.
3. **My poll change broke `reviews_ready.test.ts`.** Its mock's `reviews:open` listed nothing, so the project's link was forgotten mid-fix.
   - The poll now never forgets a link that's sharing or being fixed here.
   - The mock now lists the review it shares, as Repack would.

## Checks

- `just check` passed in full on the delete.
- After the last changes it stopped at `cargo fmt --check` on `crates/edit-window/src/main.rs`. That's another session's uncommitted work (with `update.ts` and `lib/update.ts`), left alone and not committed.
- The JS steps of `check` then passed on the final tree: web typecheck and tests, server typecheck, lint, and server tests (1041 pass, 0 fail).
- The accounts repo's `bun run check` passed (263 tests).

## Open

- **Prod relay**: `reviews:remove` reaches prod with the next nightly's tag. Until then the installed app's Delete link answers that the relay refuses the call.
- ~~**Edit's R2 delete is admin-only.**~~ Done (2e0e9b94): the relay lets anyone with `review.share` delete and list one project's `edit/reviews/<project>/` keys once `reviews:get` says its review is gone, within the project's kinds. Dev relay deployed; prod with the next nightly.
- **Does dev's cleanup ever run?** No: Repack's housekeeping (`storage-cleanup.ts` `drainCleanup`) drains prod mamagi's `cleanup` queue only, so on dev a queued review file stays. It no longer matters for Edit's deletes, which delete the files themselves now; the queue only catches what a failed delete leaves.
- **`reviewPage:remove`** (Repack's dashboard) returns only each version's file and poster. It leaves the keys in their meta (`fullKey`, words) behind on R2. It could share `reviews:remove`'s key collection and queue its cleanup.
- ~~**`window.confirm` still guards Script mode's other actions**~~ Done (d226c6d8): `askConfirm` and one `ConfirmHost` in Script mode's root ask in Edit's own dialog; no `window.confirm` is left in the web app.
- **The edit-side delete, end to end** (Nov 1, after): a test edit (one 19 s clip) shared from its Share dialog (exported on Modal, review copy made in the cloud, v1 at a feedback.spheceo.com link), then Delete link, asked first in the dialog: "review link deleted (1 versions, 0 notes and replies; 5 files deleted)", the dialog back to its first Share, `/api/projects/<id>/review` null. The test project was deleted after, from this Mac and the cloud.
