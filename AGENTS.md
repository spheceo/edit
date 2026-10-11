# Agent notes

## Git commits

Never add a `Co-authored-by` trailer (Cursor, agents, or otherwise). Commit as the user only: `git add`, `git commit`, and `git push` with a normal message body — no co-authors, no extra attribution trailers.

## Layout

- `crates/edit-core` — project model and frame evaluation. Pure Rust, no I/O; compiles natively and to WASM. Timeline times are integer frames; `source_in` is seconds. `Project::validate` is the contract every writer (UI, MCP) must satisfy.
- `crates/edit-render` — the wgpu compositor. The browser preview and the export both call `Renderer::render`; never add an effect to only one side. Shaders live in `src/shaders/`.
- `crates/edit-wasm` — wasm-bindgen wrapper; `just wasm` writes `web/src/engine/pkg` (generated, gitignored).
- `crates/edit` — `edit serve`: REST + websocket events, FFmpeg media jobs, native frame renders, export, MCP at `/mcp` (`?project=` scopes a connection to one project), and `agent.rs`, the Codex app-server bridge behind the agent panel.
- `assets/sfx/` — sound effects compiled into the `edit` binary (`crates/edit/src/sfx.rs`), so every install has them; written on first use to `~/.edit/sfx/<name>-<hash>.wav` (a new version is a new file, so old projects keep theirs). Each ships with a "hit" marker (media markers) that `add_sound_effect` lines up on the cut. `shutter.wav` is the first shutter from https://youtu.be/R24UqkKj90w, trimmed to 0.17 s.
- `relay/` — Cloudflare Worker (`edit-relay`) that holds API keys and rate-limits paid calls, and serves releases and the installer (see Releases). Edit installs never get keys. Deploy from `relay/` with `bunx wrangler deploy`.
- `web/` — React UI. Per-frame work (playhead, timeline canvas, preview) runs outside React; see `src/lib/playback.ts`.

When the model changes, update `edit-core`, `web/src/lib/types.ts`, the param tables in `web/src/lib/edit.ts`, and the model description in `crates/edit/src/mcp.rs` together.

## Checks

`just check` (fmt, clippy `-D warnings`, tests, typecheck). The render test in `crates/edit-render/tests` needs a GPU; it writes PNGs to `target/render-tests/` for eyeballing.

Preview/export parity can be verified in a browser: `window.__edit.preview.engine.render(frame)` then read the canvas, and compare with `GET /api/projects/{id}/frame/{frame}.png` — graphics-only frames are byte-identical.

## Releases and self-update

Bump `version` in the workspace `Cargo.toml`, commit, then `git tag vX.Y.Z && git push origin main vX.Y.Z`. `.github/workflows/release.yml` builds the UI once, then `edit-<target>.tar.gz` (+ `.sha256`) for macOS arm64/x64 and Linux x64, and publishes the draft release when all are up.

The repo is private, so installs never talk to GitHub: the relay serves `/v1/releases/latest?target=`, `/v1/releases/download/<tag>/<asset>` and `/install.sh` using a read-only `GITHUB_TOKEN` secret. `crates/edit/src/update.rs` checks the relay, and the editor's "Update to vX" button (`web/src/lib/update.ts`) downloads, verifies, swaps the binary and execs it in place; the page reloads when the new version answers. Only builds made with `EDIT_RELEASE=1` (CI) update themselves, so dev builds never replace `target/`. Removing a target from the matrix breaks updates and `install.sh` for that platform.

## Brand

`assets/brand/edit-mark.svg` (three clips forming an E, cut by a playhead; made for dark backgrounds) and `edit-icon.svg` / `edit-icon-1024.png` (app icon). For a future macOS dock icon keep the squircle baked into the PNG at ~82% of the canvas with even transparent padding and a corner radius of ~22.37% of the shape side.
