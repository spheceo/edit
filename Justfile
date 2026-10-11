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

# Releases go up a patch at a time (v0.0.1, v0.0.2, …). Builds on this Mac
# (Apple Silicon is the only target); installs pick it up through the relay.
# Ship the next patch version: check, bump, build, tag, upload to GitHub Releases
publish: check web
    #!/usr/bin/env bash
    set -euo pipefail
    [ "$(uname -s)/$(uname -m)" = "Darwin/arm64" ] || { echo "publish from an Apple Silicon Mac"; exit 1; }
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
    # EDIT_RELEASE turns on self-update (crates/edit/src/update.rs).
    EDIT_RELEASE=1 cargo build -p edit --release --locked
    [ "$(target/release/edit --version)" = "edit $version" ] || { echo "built the wrong version"; false; }
    out="target/publish"
    name="edit-aarch64-apple-darwin.tar.gz"
    rm -rf "$out" && mkdir -p "$out"
    tar -czf "$out/$name" -C target/release edit
    (cd "$out" && shasum -a 256 "$name" > "$name.sha256")
    git commit -q -m "Release $tag" Cargo.toml Cargo.lock web/package.json
    trap - ERR
    git tag "$tag"
    git push origin HEAD "$tag"
    # Draft until the upload is done, so updaters never see a half-uploaded release.
    gh release create "$tag" --draft --title "Edit $tag" --generate-notes "$out/$name" "$out/$name.sha256"
    gh release edit "$tag" --draft=false --latest
    echo "Published $tag. Running copies offer it within ~10 minutes."

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
