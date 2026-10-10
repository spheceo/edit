# Edit — local, agent-driven video editor

_default:
    @just --list

# Build the WASM preview engine into web/src/engine/pkg
wasm:
    cargo build -p edit-wasm --target wasm32-unknown-unknown --release
    wasm-bindgen --target web --out-dir web/src/engine/pkg target/wasm32-unknown-unknown/release/edit_wasm.wasm

# Install web dependencies (first run only)
web-install:
    @if [ ! -d web/node_modules ]; then bun install --cwd web; fi

# Build the UI into web/dist (embedded into the binary)
web: wasm web-install
    bun run --cwd web build

# Build everything and serve on :7700
serve: web
    cargo run -p edit -- serve

# Release binary with the UI embedded
release: web
    cargo build -p edit --release

# Server on :7700 (rebuilt and restarted on Rust changes) plus Vite with hot
# reload on :5173. Over Tailscale, open http://<machine>:5173 (redirects to HTTPS).
dev: wasm web-install
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p web/dist
    cargo watch -q -w crates/edit -w crates/edit-core -w crates/edit-render -x 'run -q -p edit -- serve' &
    SERVER=$!
    # The browser engine shares edit-core/edit-render: rebuild it too (Vite reloads it).
    cargo watch -q --postpone -w crates/edit-core -w crates/edit-render -w crates/edit-wasm -s 'just wasm' &
    ENGINE=$!
    trap 'kill $SERVER $ENGINE 2>/dev/null || true; pkill -f "target/debug/edit serve" 2>/dev/null || true' EXIT INT TERM
    bun run --cwd web dev

# Format, lint and test
check:
    cargo fmt --all --check
    cargo clippy --workspace --all-targets -- -D warnings
    cargo test --workspace
    cargo clippy -p edit-wasm --target wasm32-unknown-unknown -- -D warnings
    bun run --cwd web typecheck
    bun run --cwd web test
