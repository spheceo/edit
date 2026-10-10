<h1 align="center">Edit</h1>

Edit is a local, agent-driven video editor. A Rust binary serves the editor to your browser; projects and media never leave your machine. Codex or Claude Code connect over MCP and edit the same project you're looking at — their changes appear live and undo with ⌘Z.

```sh
just serve            # build everything, serve on http://localhost:7700
edit mcp              # how to connect Claude Code / Codex
```

Requirements: Rust, Bun, FFmpeg (`ffmpeg` and `ffprobe` on `PATH`), `wasm-bindgen-cli` matching `crates/edit-wasm` (`cargo install wasm-bindgen-cli --version 0.2.129`), and a WebGPU browser (Chrome, Edge, Arc, Safari 26+).

## How it fits together

```text
crates/edit-core     project model + frame evaluation (shared, compiles to WASM)
crates/edit-render   wgpu compositor: video, text, glow, grade, solids
crates/edit-wasm     the compositor in the browser (WebGPU)
crates/edit          `edit serve`: API, media jobs, native render + export, MCP
web/                 React UI (Vite, Tailwind, motion)
relay/               Cloudflare Worker holding API keys (transcription)
```

- **Exact effects.** The preview runs `edit-render` as WASM on WebGPU; export and agent frame grabs run the same crate natively. Text is rasterized on the CPU by shared code, so a frame renders to identical pixels in both.
- **Clean scrubbing.** Imports get an all-intra H.264 proxy (every frame a keyframe, ≤1080p, tagged BT.709), so the browser lands on any frame in ~10 ms. Export always reads the originals.
- **Built-in agent.** The Codex panel drives `codex app-server` with the user's own `codex login`. Edit injects its MCP server per chat (`/mcp?project=<id>`, tools pre-approved) and turns off the user's other MCP servers, apps and plugins; the sandbox is read-only, so the agent can only change the edit. Models are cached in `~/.edit/agent/models.json` (refreshed daily), chats in `~/.edit/agent/chats/`.
- **Agents.** `POST /mcp` exposes `get_project`, `add_text`, `add_clip`, `update_clip`, `set_keyframes`, `render_frame`, `contact_sheet`, `export` and more. See `crates/edit/src/mcp.rs` for the model description agents receive.

## Transcription

Edit never holds API keys. It extracts mono 32 kbps Opus (~14 MB/hour) and
posts it to `relay/`, a Cloudflare Worker that forwards to ElevenLabs Scribe v2
(word timings + voice numbers) and streams the answer back. The relay caps
spend with a burst limit, a daily quota per IP and a global daily cap.
Transcripts are cached per source file in `~/.edit/cache`, so footage is paid
for once. `EDIT_RELAY_URL` points Edit at another relay.

```sh
cd relay && bunx wrangler deploy
bunx wrangler secret put ELEVENLABS_API_KEY   # once
```

## Remote use

`edit serve` binds `127.0.0.1` and this machine's Tailscale IP. WebGPU only runs on secure pages, so from another device use Tailscale Serve:

```sh
tailscale serve --bg http://127.0.0.1:7700   # then open https://<machine>.<tailnet>.ts.net
```

## Development

```sh
just dev     # server on :7700 + Vite hot reload on :5173
just check   # fmt, clippy, tests, typecheck
```

Data lives in `~/.edit` (`EDIT_HOME` overrides): `projects/*.json` and `cache/` (proxies, thumbnails, waveforms). Exports default to `~/Movies/Edit/`.
