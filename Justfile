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

# Release binary with the UI embedded (doesn't update itself; see `publish`)
release: web
    cargo build -p edit --release

# Releases go up a patch at a time (v0.0.1, v0.0.2, …). GitHub Actions
# (.github/workflows/release.yml) builds the Apple Silicon and Intel Mac
# archives from the tag and publishes the release.
# Ship the next patch version: check, bump, tag, push (CI builds and publishes)
publish: check
    #!/usr/bin/env bash
    set -euo pipefail
    [ "$(git branch --show-current)" = "main" ] || { echo "publish from main"; exit 1; }
    [ -z "$(git status --porcelain)" ] || { echo "commit your changes first"; exit 1; }
    current="$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)"
    IFS=. read -r major minor patch <<<"$current"
    version="$major.$minor.$((patch + 1))"
    tag="v$version"
    if git rev-parse -q --verify "refs/tags/$tag" >/dev/null || gh release view "$tag" >/dev/null 2>&1; then
        echo "$tag already exists"
        exit 1
    fi
    # Put the version back if anything fails before the release commit.
    trap 'git checkout -- Cargo.toml Cargo.lock web/package.json' ERR
    sed -i '' "s/^version = \"$current\"/version = \"$version\"/" Cargo.toml
    sed -i '' "s/\"version\": \"$current\"/\"version\": \"$version\"/" web/package.json
    cargo update --workspace -q
    git commit -q -m "Release $tag" Cargo.toml Cargo.lock web/package.json
    trap - ERR
    git tag "$tag"
    git push origin main "$tag"
    echo "Pushed $tag. GitHub Actions builds and publishes it (~10 min):"
    echo "  https://github.com/spheceo/edit/actions/workflows/release.yml"

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
