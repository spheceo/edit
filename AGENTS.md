# Agent notes

## Git commits

Never add a `Co-authored-by` trailer (Cursor, agents, or otherwise). Commit as the user only: `git add`, `git commit`, and `git push` with a normal message body — no co-authors, no extra attribution trailers.

## Layout

- `crates/edit-core` — project model and frame evaluation. Pure Rust, no I/O; compiles natively and to WASM. Timeline times are integer frames; `source_in` is seconds. `Project::validate` is the contract every writer (UI, MCP) must satisfy.
- `crates/edit-render` — the wgpu compositor. The browser preview and the export both call `Renderer::render`; never add an effect to only one side. Shaders live in `src/shaders/`.
- `crates/edit-wasm` — wasm-bindgen wrapper; `just wasm` writes `web/src/engine/pkg` (generated, gitignored).
- `crates/edit` — `edit` / `edit app` opens the editor in a Tauri window (`app.rs`: the same server runs in-process and the window loads `http://127.0.0.1:7700`, so everything below works unchanged; links out open in the browser; WKWebView has no `window.confirm`/`alert`, so don't use them in the UI, and its WebGPU validates more strictly than Chrome's: a viewport outside the target drops the whole frame). `edit serve` is the same thing headless: REST + websocket events, FFmpeg media jobs, native frame renders, export, MCP at `/mcp` (`?project=` scopes a connection to one project), and `agent.rs`, the Codex app-server bridge behind the agent panel.
- `assets/sfx/` — sound effects compiled into the `edit` binary (`crates/edit/src/sfx.rs`), so every install has them; written on first use to `~/.edit/sfx/<name>-<hash>.wav` (a new version is a new file, so old projects keep theirs). Each ships with a "hit" marker (media markers) that `add_sound_effect` lines up on the cut. `shutter.wav` is the first shutter from https://youtu.be/R24UqkKj90w, trimmed to 0.17 s.
- `crates/edit/src/library.rs` — the team's sound library: the "Music & SFX Library" folder in Google Drive is the source of truth (a folder per category under Music / Sound effects, plus an index .txt of per-file notes and a usage-guide Doc). Edit lists it through the Drive API and downloads a sound on first use to `~/.edit/library/<music|sfx>/<checksum>/`; nothing is bundled. It needs `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET` and `GOOGLE_DOCS_REFRESH_TOKEN`; while testing, `just dev` borrows Repack's from Infisical (only those three). The UI's Library tab and the agent's `list_library` / `add_from_library` use it.
- `relay/` — Cloudflare Worker (`edit-relay`) that holds API keys (ElevenLabs transcription and voices; Google Maps for `map_view`, whose page in `crates/edit/src/map_page.html` loads 3D tiles through it) and rate-limits paid calls. Edit installs never get keys. Deploy from `relay/` with `bunx wrangler deploy`.
- `crates/edit/src/voice.rs` — voice-over projects, kept apart from video projects for now (`~/.edit/voice/<id>/`, UI at `/v/<id>`, `web/src/components/VoiceEditor.tsx`): script lines spoken by an ElevenLabs voice through the relay (`/v1/speech`, `/v1/voices`) into takes to choose between; "Play all" / "Download" join the chosen takes. A project can start from a video project's cut-ins. The relay uses `ELEVENLABS_SPEECH_KEY` (else `ELEVENLABS_API_KEY`) and caps characters per IP and per day.
- `web/` — React UI. Per-frame work (playhead, timeline canvas, preview) runs outside React; see `src/lib/playback.ts`.

Projects are `~/.edit/projects/<id>.json`, written atomically. Before a save replaces one, the previous version is copied to `projects/history/<id>/<ms>.json` (at most every 10 minutes, the last 30 kept); deleting moves it (and its chat) to `projects/deleted/`. A project file that won't load is listed with its `problem` and never written over.

FFmpeg ships with Edit: releases put `edit-ffmpeg` / `edit-ffprobe` beside `edit` (and `just bundle` into Edit.app's Resources), fetched by `scripts/ffmpeg.sh` (Martin Riedl's signed static macOS builds, pinned by version and SHA-256); `crates/edit/src/tools.rs` finds them, else uses FFmpeg on PATH (dev). Always run FFmpeg through `tools::ffmpeg()` / `tools::ffprobe()`. Users still install Codex (and sign in) and have Chrome; the home screen's setup card (`/api/setup`) says what's missing.

Diagnostics (`crates/edit/src/diag.rs`, `web/src/lib/diagnostics.ts`): the server logs what failed and times every request, agent tool call and turn, media job, script import step, render and export (`diag::record` / `time_on` / `time_async`); lines go to `~/.edit/logs/edit.log` and `GET /api/diagnostics` (version, recent log, per-operation timings). The UI notes its own errors, failed requests, request round-trips and preview waits, and "Report a problem" (⋯ menu, error toasts, the crash screen, a preview stuck on "Loading frame…") joins both into one text to copy. When something new can fail or take a while, time it and log the failure with what it was working on.

When the model changes, update `edit-core`, `web/src/lib/types.ts`, the param tables in `web/src/lib/edit.ts`, and the model description in `crates/edit/src/mcp.rs` together.

## Checks

`just check` (fmt, clippy `-D warnings`, tests, typecheck). The render test in `crates/edit-render/tests` needs a GPU; it writes PNGs to `target/render-tests/` for eyeballing.

Preview/export parity can be verified in a browser: `window.__edit.preview.engine.render(frame)` then read the canvas, and compare with `GET /api/projects/{id}/frame/{frame}.png` — graphics-only frames are byte-identical.

## Releases and self-update

Versions go up a patch at a time (v0.0.1, v0.0.2, …), never minor or major. With everything committed on `main`, `just publish` runs the checks, bumps the patch in `Cargo.toml` / `Cargo.lock` / `web/package.json` (committed as "Release vX.Y.Z"), and pushes it with its `vX.Y.Z` tag. `.github/workflows/release.yml` then builds the UI once, builds `edit-<target>.tar.gz` (+ `.sha256`) for `aarch64-apple-darwin` and `x86_64-apple-darwin` (cross-compiled on the Apple Silicon runner), and publishes the draft release when both are up. Running the workflow by hand makes a test build (workflow artifacts, no release). Adding a target means a matrix entry plus `install.sh` and `asset_target()` in `update.rs`; removing one breaks updates for that platform.

The repo is public: installs read GitHub Releases directly, no token. `install.sh` (`curl -fsSL https://raw.githubusercontent.com/spheceo/edit/main/install.sh | sh`) fetches the latest archive; `crates/edit/src/update.rs` checks `releases/latest` (GitHub's own SHA-256 digest, or the `.sha256` beside the archive), and the editor's "Update to vX" button (`web/src/lib/update.ts`) downloads, verifies, swaps the binary and execs it in place; the page reloads when the new version answers. Only builds made with `EDIT_RELEASE=1` (the release workflow) update themselves, so dev builds never replace `target/`.

## Brand

`assets/brand/edit-mark.svg` (three clips forming an E, cut by a playhead; made for dark backgrounds) and `edit-icon.svg` / `edit-icon-1024.png` (app icon). For a future macOS dock icon keep the squircle baked into the PNG at ~82% of the canvas with even transparent padding and a corner radius of ~22.37% of the shape side.
