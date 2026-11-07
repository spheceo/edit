#!/bin/sh
# Fetches qjs (QuickJS-ng) for the packaged Edit: yt-dlp's JavaScript runtime,
# so YouTube extraction works on a Mac with nothing installed. It is ~1 MB,
# so unlike deno it ships beside edit (Justfile, release workflow). The
# builds are QuickJS-ng's own macOS ones from their GitHub releases. They
# are static: the check below refuses any that would need a library a
# Mac doesn't ship with.
#
#   scripts/fetch-quickjs.sh aarch64-apple-darwin <out-dir>
#   scripts/fetch-quickjs.sh x86_64-unknown-linux-gnu <out-dir>
#
# The fetch lands as <out-dir>/qjs-<target>, the sidecar name beside edit.
# Bumping the version: take the new release's qjs-darwin-<arch> and
# qjs-linux-<arch> assets and their SHA-256 (the release lists each one's).
# The Linux builds are static-pie: no library to check.

set -eu

TARGET="$1"
OUT="$2"
VERSION="0.17.0"

case "$TARGET" in
  aarch64-apple-darwin)
    ASSET="qjs-darwin-arm64"
    SUM="8be3ddfe3397d2e692e4e1e8972ee9d032a0a580505d2f8b4ea528cf1b651c11"
    ;;
  x86_64-unknown-linux-gnu)
    ASSET="qjs-linux-x86_64"
    SUM="0bfc02511a9f549c28b53880d988fc7cd5d361e90c5e8afdfcd7dc6774ceace5"
    ;;
  *)
    echo "no qjs build for $TARGET" >&2
    exit 1
    ;;
esac

mkdir -p "$OUT"
# Already there (same version): nothing to do.
if [ -x "$OUT/qjs-$TARGET" ] && [ "$(cat "$OUT/.qjs-version" 2>/dev/null)" = "$TARGET $VERSION" ]; then
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
URL="https://github.com/quickjs-ng/quickjs/releases/download/v$VERSION/$ASSET"
echo "Fetching qjs from $URL"
curl -fsSL --retry 3 --retry-delay 10 --retry-all-errors --progress-bar -o "$TMP/qjs" "$URL"
if command -v shasum >/dev/null 2>&1; then ACTUAL="$(shasum -a 256 "$TMP/qjs" | cut -d' ' -f1)"; else ACTUAL="$(sha256sum "$TMP/qjs" | cut -d' ' -f1)"; fi
if [ "$ACTUAL" != "$SUM" ]; then
  echo "$URL: checksum mismatch: expected $SUM, got $ACTUAL" >&2
  exit 1
fi
if [ "$(uname -s)" = Darwin ] && otool -L "$TMP/qjs" | tail -n +2 | grep -vE '^[[:space:]]*(/usr/lib/|/System/Library/)'; then
  echo "qjs needs libraries outside macOS, so it can't be bundled." >&2
  exit 1
fi
install -m 755 "$TMP/qjs" "$OUT/qjs-$TARGET"
echo "$TARGET $VERSION" >"$OUT/.qjs-version"
# Only a binary for this machine can be run to check it.
case "$(uname -s)/$(uname -m)/$TARGET" in
  Darwin/arm64/aarch64-apple-darwin | Linux/x86_64/x86_64-unknown-linux-gnu) "$OUT/qjs-$TARGET" --version ;;
esac
echo "qjs $VERSION for $TARGET in $OUT"
