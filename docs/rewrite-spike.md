# Spike: napi-rs v3 under Bun (WP0 item 6)

Run on 2026-10-17 on kenobi (M1, macOS 26.3, Bun 1.4.0, rustc 1.99.0, napi 3.14.2,
napi-derive 3.6.12, napi-build 2.6.0, @napi-rs/cli 3). The spike was a throwaway
cdylib (`napi = { features = ["napi8", "tokio_rt", "serde-json"] }`); everything it
proved is now exercised for real by `crates/edit-native/test/*.test.ts`.

## What works

| Feature | Result |
|---|---|
| Sync `#[napi] fn` | Works. |
| `#[napi] async fn` on napi's tokio runtime, work in `spawn_blocking` | Works; returns a real `Promise`. Eight 200 ms calls at once finish in ~210 ms, so they run in parallel on tokio's blocking pool, not on Bun's work pool. |
| `Err(Error::from_reason(msg))` | Sync: thrown `Error`; async: rejected `Promise`. `e.message` is exactly `msg` (no prefix), so the agent-visible strings carry over unchanged. |
| `#[napi(catch_unwind)]` on a sync fn | The panic becomes a thrown `Error` whose message is the panic payload (`"boom"`). The default panic hook still prints to stderr. |
| Panic inside `spawn_blocking` | Surfaces as a `JoinError`, which we map to a rejection (`"crashed (task 40 panicked with message \"async boom\")"`). |
| `Buffer` in and out, sync and async | Works, including a 32 MiB `Buffer` returned from an async fn, and `#[napi(object)]` structs with `Buffer` fields inside a `Vec`. |
| `ThreadsafeFunction` progress from a blocking thread (`NonBlocking`) | All calls arrive. Calls queued just before the promise resolves can land a tick after it, so a caller that needs "100 %" must not rely on ordering between the last progress call and the resolution (export already emits `done` from the resolution, not from progress). |
| Weak TSFN (`ThreadsafeFunction<T, (), T, Status, false, true>`) | Doesn't keep the process alive: a native thread still reporting every 20 ms for 20 s doesn't stop Bun exiting. A weak log sink stored in a `static` and called from plain std threads delivers every line. |
| `serde_json::Value` arguments and returns | Round-trips (`1` stays `1`, `2.5`, `null`). |
| `#[napi] struct` with `#[napi(factory)]`, a sync `cancel()` and an `async fn wait(&self)` | Works: `cancel()` from a `setTimeout` makes `wait()` reject with `"cancelled"`. This is the `ExportJob` shape. |
| `index.d.ts` | `bunx @napi-rs/cli@3 build --release --platform --no-js` builds and writes accurate types (`Promise<…>`, `Buffer`, classes, JSDoc from `///`). `ts_args_type` is needed for callback parameters. |
| `bun test` | Loads the addon like `bun run` does. |

## `bun build --compile` with an embedded `.node`

- `require("./edit-native.node")` (a static string) is enough: `bun build --compile` embeds the addon. The binary still works with the original `.node` removed from disk and run from another directory.
- At run time Bun writes it to `$TMPDIR/.bun-<uid>-<content hash>.node` (mode 600) and `dlopen`s it. The file is **not** removed at exit; it's named by content hash, so each version leaves one file (≈ the addon's size) that macOS's temp cleaner removes later. Acceptable; noted for the size budget.
- The cdylib from cargo is already ad-hoc linker-signed on arm64, and the extracted copy keeps that signature, so `dlopen` works (the binary isn't hardened-runtime, so no library validation).
- **The compiled binary's signature is invalid as Bun 1.4.0 leaves it** (`codesign -v`: "code or signature have been modified"). It still ran locally, but Gatekeeper/AMFI may refuse it on another Mac. `codesign -s - -f edit` afterwards fixes it and the embedded payload survives re-signing (re-checked: all tests pass after signing). So plan section 4 step 4's `codesign -s - -f package/edit` is required, not optional.
- Files written by `edit` itself (the extracted addon, `<home>/bin/Edit`) carry no quarantine attribute: Edit is not a quarantine-aware app, and installs/updates download with curl.

## Conventions adapted (plan section 1.2)

1. **TSFN type.** "NonBlocking and unref'd" is written as the type `ThreadsafeFunction<T, (), T, Status, false, true>` (`CalleeHandled = false`, `Weak = true`). `ThreadsafeFunction::unref` is deprecated in napi 3; don't call it.
2. **Callbacks must not throw.** A JS exception inside a TSFN callback is reported as `uncaughtException` (Bun would exit without a handler); the native side carries on. `apps/server/src/native/index.ts` must wrap every callback it passes in `try/catch` and log through `diag`.
3. **Panics in async fns.** `#[napi(catch_unwind)]` only covers sync entry points. Async entry points do their work in `spawn_blocking` around `edit_engine::util::catch` (today's `guard::catch`), so a panic becomes `"<what> crashed (...); this is a bug in Edit"` exactly as now; a `JoinError` is mapped the same way as a backstop.
4. **Progress ordering.** As above: a job's completion comes from its promise; progress values are advisory.
5. **Signing.** Always re-sign after `bun build --compile` (see above).

Nothing else in section 1.2 needed changing: errors as `Error.message`, async on napi's tokio runtime (not `AsyncTask`), `Buffer`s for images, and the JSON-string boundary for rich types all behave as the plan assumes.
