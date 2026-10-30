#!/usr/bin/env bash
# The engine's Mac binaries: the Node addon (crates/edit-native/edit-native.node)
# and the window helper (target/<target>/release/edit-window), both signed ad
# hoc, with copies of both in engine/. Run from app/ by the release and by
# engine-cache.yml, which keeps engine/ by a hash of the Rust sources so a
# release without Rust changes reuses it (not target/: rust-cache prunes the
# workspace's own outputs there before a later step could save them).
set -euo pipefail
target="$1"
stamp="$(mktemp)"
(cd crates/edit-native && bun install --frozen-lockfile \
  && bunx napi build --release --target "$target" --dts index.d.ts \
  && codesign -s - -f edit-native.node)
# C and Objective-C built for a newer macOS than Edit's oldest (13.0,
# .cargo/config.toml) bind newer classes strongly: the addon then
# won't load there and the window stays black (nightly-13 on 15.3).
newer="$(find "target/$target/release/build" -path '*/out/*.a' -newer "$stamp" \
  -exec sh -c 'otool -l "$1" | awk -v f="$1" "/ minos / && \$2+0 > 13 {print f\": macOS \" \$2}"' _ {} \; | sort -u)"
if [ -n "$newer" ]; then echo "built for a newer macOS than 13.0:"; echo "$newer"; exit 1; fi
cargo build --release --locked -p edit-window --target "$target"
codesign -s - -f "target/$target/release/edit-window"
mkdir -p engine
cp crates/edit-native/edit-native.node "target/$target/release/edit-window" engine/
