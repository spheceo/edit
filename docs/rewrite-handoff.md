# Rewrite handoff: continuing on the PC (WSL 2)

The plan is `docs/rewrite-plan.md` (the contract); setup is `docs/pc-setup.md`. This file says
where the rewrite stands and what to run next.

## Where it stands (main, Oct 17)

| Package | State |
|---|---|
| WP0 native engine | **Done.** `crates/edit-engine` (the Rust that stays, moved out of `crates/edit`, which still builds and runs on it unchanged), `crates/edit-native` (napi-rs v3 addon, every §1.3 binding, typed `index.d.ts`), `packages/edit-types` (ts-rs, `just types`). Spike notes: `docs/rewrite-spike.md`. |
| WP1 TS foundation | **Done.** `apps/server`: store, http, mcp registry, diag, relay, media Processor, import, `seams.ts`, the native wrapper and an in-memory stub. Root Bun workspace. |
| WP5 subtitles core | **Done.** subtitles, speakers, people, seats (TS half), faces placement, `captions_core.ts` (`transcript_of`, `hex`, `subtitle_name`, `caption_size`), `rust.ts` (Rust rounding/formatting/f32 helpers). |
| WP7 editing tools and plans | **In progress on the Mac.** Don't start it on the PC. |
| WP2 shell, server core, shipping | To do (PC). |
| WP3 cloud | To do (PC). |
| WP4 script, voice, research | To do (PC). |
| WP6 captions, watching, review | To do (PC). |
| WP8 media sources, sound, agent | To do (PC). |

The Rust server (`crates/edit`) is still what runs Edit; it stays the parity reference until
the switch-over (plan §5).

## Things every package must know (decided during WP0/WP1/WP5)

- **Native callbacks:** wrap every progress/log callback passed to the addon in `try/catch`;
  a callback that throws becomes an `uncaughtException` in Bun.
- **`ProjectInput`** is one object type on the Rust side (`ProjectArg` in `index.d.ts`); the
  TS wrapper keeps the `{ref} | {json}` union. A `"stale project"` answer re-sends as JSON
  (`withProject` does it).
- **Live projects are frozen:** `store.get` returns a frozen project; `checkout` gives a copy
  to change. Rev check, `projectCommit` and the write run back to back with no `await`.
- **Errors:** a plain `Error` is a normal failure passed on as is; engine errors (TypeError,
  RangeError…) are crashes ("… crashed (…); this is a bug in Edit"). A crash inside an MCP
  tool comes back as error content.
- **Agent-visible text is a contract:** port error strings verbatim; use `stableStringify`
  (sorted keys) for JSON-as-text; use `src/rust.ts` for Rust's rounding (half away from zero),
  `{:.N}` formatting (ties to even) and f32 arithmetic where numbers end up in project files.
- **Seams:** cross-package calls go through `apps/server/src/seams.ts`. Fill your package's
  entries with the real modules (keep the signatures; the compiler checks them). Additions
  made since the plan:
  - `Agents.ask` (model, effort, instructions, input, schema, timeout): **WP8 implements it**;
    speakers uses it to name voices.
  - `seams.subtitles.routes(router)` and `seams.speakers.watch(app)`: **WP2 calls both** when
    it wires the server (the second replaces `speakers::watch` in main.rs).
  - **WP6** imports `transcript_of`, `hex`, `subtitle_name`, `caption_size` from
    `captions_core.ts` through the captions seam; don't port them again.
  - Faces are corners `[x0, y0, x1, y1]` (shares of the picture), not `[x, y, w, h]`.
- **Deliberate divergence:** the TS seats cache reads `null` as infinity, so it's actually
  reused (Rust never read it back; being fixed in Rust too). Expect fewer gateway calls from TS
  in parity runs.
- **Shipping:** `bun build --compile` leaves the binary's signature invalid; `codesign -s - -f`
  is required (plan §4).

## On the PC

1. Set up per `docs/pc-setup.md` (WSL, Rust, Bun, Claude Code, clone).
2. `git pull` on main, `bun install` at the root.
3. The addon on Linux: `just native debug` builds it (macOS-only code is cfg-gated; GPU tests
   skip without a GPU or with `EDIT_NO_GPU=1`). Without it, tests use the stub, which is fine
   for most packages.
4. One worktree and one Claude Code session per package; run these five at once (they only
   meet through `seams.ts`):

```bash
cd ~/code/edit && git pull
for wp in wp2-shell wp3-cloud wp4-script-voice wp6-captions-watch wp8-media-sound-agent; do
  git worktree add ../edit-$wp -b rewrite/$wp origin/main
done
```

Then in each `../edit-<wp>`: `claude`, and paste the prompt below with the package filled in.

```
You're working on Edit. Read AGENTS.md, docs/rewrite-plan.md (the contract) and
docs/rewrite-handoff.md (decisions since the plan) fully first. You own work package <WP>
from plan section 3. Build on what's on main: apps/server (start with src/seams.ts,
src/native/index.ts, src/rust.ts), crates/edit-native, packages/edit-types. Port the
package's modules, REST routes and MCP tools faithfully — behaviour, error text (agents read
it), output formatting — and fill your package's entries in seams.ts. Every Rust #[test] in
those modules gets a same-named bun:test. Use other packages only through seams.ts. Don't
start agents of your own. Check with `bun run --cwd apps/server typecheck` and
`bun run --cwd apps/server test`. Commit as you go with normal messages and no
Co-authored-by or other attribution trailers; push to branch rewrite/<wp-name>, never main.
Finish with: what's done, what isn't, contract gaps (native functions or seams you needed),
and what must be checked on the Mac.
```

| Session | `<WP>` | Branch |
|---|---|---|
| 1 | WP2 shell, server core, shipping (main.ts, CLI, app window helper, update, media drive CLI/move, generic routes, build + release) | `rewrite/wp2-shell` |
| 2 | WP3 cloud (cloud, cloud_projects, cloud_media) | `rewrite/wp3-cloud` |
| 3 | WP4 script, voice, research | `rewrite/wp4-script-voice` |
| 4 | WP6 captions, watching, review, footage search | `rewrite/wp6-captions-watch` |
| 5 | WP8 media sources, sound, agent (broll + map page, library, drive, agent bridge; implements `Agents.ask`) | `rewrite/wp8-media-sound-agent` |

WP3 and WP4 share a seam (`script.Excerpt`, `safe_name`, `clock`, `duration_of`, `cut`,
`resolve`, `keyframe_before`, `spans`): agree it in the first hour (WP4 owns it).

## Coming back to the Mac

Push the branches. On the Mac they're merged into main in this order: WP2, WP8, WP6, WP4, WP3
(WP7 lands from the Mac). Then:

1. `just check` (fmt, clippy, Rust tests, types/`index.d.ts` drift, native tests, web and
   server typecheck/tests).
2. The parity harness (plan §5): Rust at tag `parity-base` against the TS server on the same
   fixture home; on macOS this also covers AVFoundation, Vision, VideoToolbox and the window.
3. Dogfood on the reference project, Mom & Teen (a cloud project, so any machine can open it).
4. Switch-over and deletion of `crates/edit` (plan §5.7).
