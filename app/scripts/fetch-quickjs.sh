#!/bin/sh
# Fetches qjs (QuickJS-ng) for the packaged Edit: yt-dlp's JavaScript runtime,
# so YouTube extraction works on a Mac with nothing installed. It is ~1 MB,
# so unlike deno it ships beside edit (Justfile, release workflow). The
# builds are QuickJS-ng's own macOS ones from their GitHub releases. They
# are static: the check below refuses any that would need a library a
# Mac doesn't ship with.
#
#   scripts/fetch-quickjs.sh <aarch64-apple-darwin|x86_64-apple-darwin> <out-dir>
#
# The fetch lands as <out-dir>/qjs-<target>, the sidecar name beside edit.
# Bumping the version: take the new release's qjs-darwin-<arch> assets and
# their SHA-256.

set -eu

TARGET="$1"
OUT="$2"
VERSION="0.17.0"

case "$TARGET" in
  aarch64-apple-darwin)
    ARCH="arm64"
    SUM="8be3ddfe3397d2e692e4e1e8972ee9d032a0a580505d2f8b4ea528cf1b651c11"
    ;;
  x86_64-apple-darwin)
    ARCH="x86_64"
    SUM="9e5e101b4fd13cda3204222ca9f8be35412c41dcdef3745829633b7a67245412"
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
URL="https://github.com/quickjs-ng/quickjs/releases/download/v$VERSION/qjs-darwin-$ARCH"
echo "Fetching qjs from $URL"
curl -fsSL --retry 3 --retry-delay 10 --retry-all-errors --progress-bar -o "$TMP/qjs" "$URL"
ACTUAL="$(shasum -a 256 "$TMP/qjs" | cut -d' ' -f1)"
if [ "$ACTUAL" != "$SUM" ]; then
  echo "$URL: checksum mismatch: expected $SUM, got $ACTUAL" >&2
  exit 1
fi
if otool -L "$TMP/qjs" | tail -n +2 | grep -vE '^[[:space:]]*(/usr/lib/|/System/Library/)'; then
  echo "qjs needs libraries outside macOS, so it can't be bundled." >&2
  exit 1
fi
install -m 755 "$TMP/qjs" "$OUT/qjs-$TARGET"
echo "$TARGET $VERSION" >"$OUT/.qjs-version"
# Only a binary for this Mac can be run to check it.
if [ "$(lipo -archs "$OUT/qjs-$TARGET" 2>/dev/null)" = "$(uname -m)" ]; then
  "$OUT/qjs-$TARGET" --version
fi
echo "qjs $VERSION for $TARGET in $OUT"
