#!/usr/bin/env bash
# The preview engine for the UI (apps/web/src/engine/pkg), with the
# wasm-bindgen in Cargo.lock. Run from app/ by the release and by
# engine-cache.yml, which keeps it by a hash of the Rust sources.
set -euo pipefail
version="$(grep -A1 '^name = "wasm-bindgen"$' Cargo.lock | sed -n 's/^version = "\(.*\)"/\1/p')"
command -v wasm-bindgen >/dev/null && [ "$(wasm-bindgen --version)" = "wasm-bindgen $version" ] \
  || cargo install wasm-bindgen-cli --version "$version" --locked
cargo build -p edit-wasm --target wasm32-unknown-unknown --release
wasm-bindgen --target web --out-dir apps/web/src/engine/pkg target/wasm32-unknown-unknown/release/edit_wasm.wasm
