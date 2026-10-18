# Edit — local, agent-driven video editor

_default:
    @just --list

# Build the WASM preview engine into apps/web/src/engine/pkg
wasm:
    cargo build -p edit-wasm --target wasm32-unknown-unknown --release
    wasm-bindgen --target web --out-dir apps/web/src/engine/pkg target/wasm32-unknown-unknown/release/edit_wasm.wasm

# TypeScript types from the Rust model and the engine's options (ts-rs) into
# packages/edit-types/src/generated: run after changing edit-core's model or
# the engine's export options, plans or probes, and commit the result.
types:
    #!/usr/bin/env bash
    set -euo pipefail
    out="$PWD/packages/edit-types/src/generated"
    rm -rf "$out"
    TS_RS_EXPORT_DIR="$out" TS_RS_LARGE_INT=number \
        cargo test -q -p edit-core -p edit-engine --features edit-core/ts,edit-engine/ts export_bindings >/dev/null
    bun packages/edit-types/scripts/index.ts

# The native addon (crates/edit-native/edit-native.node and its index.d.ts),
# for the Bun server; `just native debug` for a quick unoptimised one.
native profile="release":
    #!/usr/bin/env bash
    set -euo pipefail
    cd crates/edit-native
    [ -d node_modules ] || bun install --frozen-lockfile
    if [ "{{profile}}" = release ]; then bun run build; else bun run build:debug; fi

# The native addon's smoke tests under Bun (builds it first; GPU tests skip
# without one, or with EDIT_NO_GPU=1), and its types
native-test: (native "debug")
    cd crates/edit-native && bun test && bun run typecheck

# The addon embedded in a `bun build --compile` binary, run from elsewhere
# with the .node out of the way (what shipping it inside `edit` relies on)
native-compiled: (native "debug")
    #!/usr/bin/env bash
    set -euo pipefail
    dir="$(mktemp -d)"
    trap 'mv -f crates/edit-native/edit-native.node.away crates/edit-native/edit-native.node 2>/dev/null || true; rm -rf "$dir"' EXIT
    bun build --compile crates/edit-native/test/compiled/main.ts --outfile "$dir/edit-compiled"
    codesign -s - -f "$dir/edit-compiled"
    mv crates/edit-native/edit-native.node crates/edit-native/edit-native.node.away
    mkdir "$dir/home"
    (cd "$dir" && ./edit-compiled "$dir/home")

# Install the Bun workspace's dependencies (apps/*, packages/*; first run only)
web-install:
    @if [ ! -d apps/web/node_modules ] || [ ! -d apps/server/node_modules ]; then bun install; fi

# Build the UI into apps/web/dist (embedded into the binary)
web: wasm web-install
    bun run --cwd apps/web build

# Build everything and serve on :7700 (the Bun server, apps/server)
serve: web (native "debug")
    bun apps/server/src/main.ts serve

# Build everything and open the desktop app (its own server on :7700, or a
# window onto the one already running there, e.g. `just dev`'s)
app: web (native "debug") window
    bun apps/server/src/main.ts app

# The desktop window helper (crates/edit-window, Tauri): `edit app` runs it
window profile="debug":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "{{profile}}" = release ]; then cargo build -p edit-window --release; else cargo build -p edit-window; fi

# Edit.app (target/release/bundle/macos): the window helper (crates/edit-window)
# is the app, with the Bun `edit` and FFmpeg in its Resources; opened, it runs
# `Resources/edit serve`. Like `release`, it doesn't update itself.
bundle: web ffmpeg (native "release")
    #!/usr/bin/env bash
    set -euo pipefail
    dir="$PWD/target/ffmpeg/$(rustc -vV | sed -n 's/^host: //p')"
    mkdir -p target/bundle-edit
    bun apps/server/scripts/embed.ts --native crates/edit-native/edit-native.node
    bun build apps/server/src/embedded.gen.ts --compile --outfile target/bundle-edit/edit
    codesign -s - -f target/bundle-edit/edit
    edit="$PWD/target/bundle-edit/edit"
    # FFmpeg goes into Edit.app/Contents/Resources beside edit (apps/server/src/tools.ts).
    cd crates/edit-window && bunx @tauri-apps/cli@2 build --bundles app \
        --config "{\"bundle\":{\"resources\":{\"$dir/ffmpeg\":\"edit-ffmpeg\",\"$dir/ffprobe\":\"edit-ffprobe\",\"$edit\":\"edit\"}}}"

# The FFmpeg Edit ships with, for this Mac (target/ffmpeg/<target>)
ffmpeg:
    #!/usr/bin/env bash
    host="$(rustc -vV | sed -n 's/^host: //p')"
    scripts/ffmpeg.sh "$host" "target/ffmpeg/$host"

# Release binary (package/edit) with the UI, addon and window helper embedded,
# as the release workflow builds it (doesn't update itself; see `publish`)
release: web (native "release") (window "release")
    #!/usr/bin/env bash
    set -euo pipefail
    target="${CARGO_TARGET_DIR:-target}"
    mkdir -p package
    bun apps/server/scripts/embed.ts --native crates/edit-native/edit-native.node --window "$target/release/edit-window"
    bun build apps/server/src/embedded.gen.ts --compile --outfile package/edit
    codesign -s - -f package/edit
    echo "built package/edit"

# The dev server's binary: the Bun server compiled with the UI and the addon
# embedded (the addon in `[profile.serve]`: release speed, no LTO,
# incremental), without the desktop window, built on the internal disk
# (EDIT_BUILD_DIR, default ~/edit-build) and swapped into EDIT_SERVE_BIN
# (default /tmp/run/edit) by rename, so a running server isn't disturbed.
# Restart the server yourself. `just serve-build-bin` skips the UI rebuild.
serve-build: web serve-build-bin

serve-build-bin:
    #!/usr/bin/env bash
    set -euo pipefail
    dir="${EDIT_BUILD_DIR:-$HOME/edit-build}"
    export CARGO_TARGET_DIR="$dir/target" CARGO_BUILD_BUILD_DIR="$dir/build"
    start=$SECONDS
    (cd crates/edit-native && { [ -d node_modules ] || bun install --frozen-lockfile; } \
        && bunx napi build --profile serve --dts index.d.ts && codesign -s - -f edit-native.node)
    bun apps/server/scripts/embed.ts --native crates/edit-native/edit-native.node
    dest="${EDIT_SERVE_BIN:-/tmp/run/edit}"
    mkdir -p "$(dirname "$dest")"
    bun build apps/server/src/embedded.gen.ts --compile --outfile "$dest.new"
    codesign -s - -f "$dest.new"
    mv -f "$dest.new" "$dest"
    echo "built $dest in $((SECONDS - start)) s; restart the server to run it"

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
    trap 'git checkout -- Cargo.toml Cargo.lock apps/web/package.json apps/server/package.json' ERR
    sed -i '' "s/^version = \"$current\"/version = \"$version\"/" Cargo.toml
    sed -i '' "s/\"version\": \"$current\"/\"version\": \"$version\"/" apps/web/package.json apps/server/package.json
    cargo update --workspace -q
    git commit -q -m "Release $tag" Cargo.toml Cargo.lock apps/web/package.json apps/server/package.json
    trap - ERR
    git tag "$tag"
    git push origin main "$tag"
    echo "Pushed $tag. GitHub Actions builds and publishes it (~10 min):"
    echo "  https://github.com/spheceo/edit/actions/workflows/release.yml"

# The Bun server on :7700 (restarted on TS changes, and when the addon is
# rebuilt on engine changes) plus Vite with hot reload on :5173. Over
# Tailscale, open http://<machine>:5173 (redirects to HTTPS).
dev: wasm web-install (native "debug")
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p apps/web/dist
    if command -v infisical >/dev/null; then
        for name in GOOGLE_DRIVE_CLIENT_ID GOOGLE_DRIVE_CLIENT_SECRET GOOGLE_DOCS_REFRESH_TOKEN AI_GATEWAY_API_KEY PROXY_URL; do
            if [ -z "${!name:-}" ] && value="$(infisical secrets get "$name" --projectId=cdf4a0c5-eca4-4415-af3a-40871af285f3 --env=dev --plain --silent 2>/dev/null)"; then
                export "$name=$value"
            fi
        done
    fi
    # bun --watch restarts the server on its own files and on the addon it loads.
    bun --watch apps/server/src/main.ts serve &
    SERVER=$!
    # The engine and its bindings: a new addon (the server restarts onto it).
    cargo watch -q --postpone -w crates/edit-core -w crates/edit-render -w crates/edit-engine -w crates/edit-native/src -s 'just native debug' &
    NATIVE=$!
    # The browser engine shares edit-core/edit-render: rebuild it too (Vite reloads it).
    cargo watch -q --postpone -w crates/edit-core -w crates/edit-render -w crates/edit-wasm -s 'just wasm' &
    ENGINE=$!
    trap 'kill $SERVER $NATIVE $ENGINE 2>/dev/null || true' EXIT INT TERM
    bun run --cwd apps/web dev

# Format, lint and test
check: types
    cargo fmt --all --check
    cargo clippy --workspace --all-targets -- -D warnings
    cargo test --workspace
    # The generated TS types are committed: they must match the Rust.
    git diff --exit-code -- packages/edit-types
    test -z "$(git status --porcelain -- packages/edit-types)"
    just native-test
    # So is the addon's index.d.ts (napi writes it as it builds).
    git diff --exit-code -- crates/edit-native/index.d.ts
    cargo clippy -p edit-wasm --target wasm32-unknown-unknown -- -D warnings
    bun run --cwd apps/web typecheck
    bun run --cwd apps/web test
    bun run --cwd apps/server typecheck
    bun run --cwd apps/server test
