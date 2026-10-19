<h1 align="center">Edit</h1>

Edit is a local, agent-driven video editor for macOS. The editor runs in its own window (or any WebGPU browser); Codex or Claude Code connect over MCP and edit the project you're looking at — their changes appear live and undo with ⌘Z.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/spheceo/edit/main/install.sh | sh
edit          # open the editor
edit mcp      # how to connect Claude Code / Codex
```

Later versions install themselves from the editor. The built-in agent panel needs [Codex](https://github.com/openai/codex) (signed in); maps and research need Chrome.

## Development

Requirements: Rust, Bun, FFmpeg on `PATH`, `wasm-bindgen-cli` matching `crates/edit-wasm` (`cargo install wasm-bindgen-cli --version 0.2.129`), and macOS 26+ for WebGPU in the window.

```sh
just dev      # server on :7700 + Vite hot reload on :5173
just app      # build everything, open the desktop app
just check    # fmt, clippy, tests, typecheck
just publish  # release the next patch version
```

```text
agent/                     what the agent is taught: instructions and skills, in Markdown
app/                       all the code and its build config (`just` works from the root)
app/apps/server            the server (Bun): API, media jobs, export, MCP, agent
app/apps/web               React UI
app/apps/relay             Cloudflare Worker holding API keys
app/crates/edit-core       project model + frame evaluation (native and WASM)
app/crates/edit-render     wgpu compositor shared by preview and export
app/crates/edit-engine     native media, render and export engine
app/crates/edit-native     the engine as a Bun addon (napi-rs)
app/crates/edit-wasm       the compositor in the browser
app/crates/edit-window     the desktop window (Tauri)
```

Data lives in `~/.edit` (`EDIT_HOME` overrides); exports default to `~/Movies/Edit/`. From another device, `tailscale serve --bg http://127.0.0.1:7700` (WebGPU needs HTTPS).

[AGENTS.md](AGENTS.md) and [app/AGENTS.md](app/AGENTS.md) have the details.
