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
- **Clean scrubbing.** Imports get a light H.264 preview proxy (≤1080p, a keyframe every half second, no B-frames, tagged BT.709) plus a separate AAC sound file, so the preview streams comfortably over Wi-Fi. Scrubbing coalesces requests and displays decoded pictures; playback keeps one decoder running and cues upcoming cuts. The playhead is remembered per project in this browser. Export always reads the originals.
- **Built-in agent.** The Codex panel drives `codex app-server` with the user's own `codex login`. Edit injects its MCP server per chat (`/mcp?project=<id>`, tools pre-approved) and turns off the user's other MCP servers, apps and plugins; the sandbox is read-only, so the agent can only change the edit. Models are cached in `~/.edit/agent/models.json` (refreshed daily), chats in `~/.edit/agent/chats/`.
- **Agents.** `POST /mcp` exposes `get_project`, `add_text`, `add_clip`, `update_clip`, `set_keyframes`, `render_frame`, `contact_sheet`, `export` and more. See `crates/edit/src/mcp.rs` for the model description agents receive.

## Transcription

Edit never holds API keys. It extracts mono 32 kbps Opus (~14 MB/hour) and
posts it to `relay/`, a Cloudflare Worker that forwards to ElevenLabs Scribe v2
(word timings + voice numbers) and streams the answer back. The relay caps
requests with a burst limit and atomic daily byte reservations per IP and across
everyone. Byte quotas are a proxy for duration; they are not a guaranteed monetary
cap for arbitrary uploaded audio.
Transcripts are cached per source file in `~/.edit/cache`, so footage is paid
for once. `EDIT_RELAY_URL` points Edit at another relay.

```sh
cd relay && bunx wrangler deploy
bunx wrangler secret put ELEVENLABS_API_KEY   # once
```

For a private relay, also set the Worker secret `CLIENT_TOKEN` and set the same
value as `EDIT_RELAY_TOKEN` in the environment running Edit. The shared public
relay needs duration verification and an upstream spending limit before its byte
quotas can be treated as a hard spending guarantee.

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

## Sound library

Music and sound effects come from the team's "Music & SFX Library" folder in Google Drive ([03] Media / Repack): a folder per mood or kind, an index of notes per file and a usage guide the agent reads. Edit downloads a sound the first time it's used (Library tab, or the agent's `add_from_library`). `just dev` reads the Google sign-in from Infisical. To add a sound, put it in the right folder in Drive and give it a note in the index.

Still missing, taken out of the guide and index until there's a real file (12 Oct 2026):

- **Gunshot:** there was only a YouTube reference (no audio). Needs a licensed pistol shot, for when the narration describes a shooting.
- **Typewriter:** listed, never added.
- **Upbeat music:** nearly every track is dark or tense, so lighter cases have little to choose from.

The guide's "Pulse" link was a touchscreen-tapping sound, not a heartbeat. It now sits under Clicks as "Touchscreen taps".

## Test cases to revisit

- **911 audio waveform:** [this Doc](https://docs.google.com/document/d/1kQewvwefZeotaWWz1g78VDYVoI3ku8TrJDL2p-4EQlo/edit?tab=t.0) has a 911 call to test the glowing waveform against. It should lie almost flat when the sound is low, with a little movement, and spike on speech and loud sounds.
