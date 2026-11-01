#!/bin/sh
# Fetches the FFmpeg that ships with Edit (ffmpeg + ffprobe, static, signed):
# Martin Riedl's macOS builds, pinned by version and SHA-256. When his site is
# down (a Cloudflare 521 held up v0.0.0), osxexperts.net's static builds
# instead, pinned the same way (same encoders; ad hoc signed).
#
#   scripts/ffmpeg.sh aarch64-apple-darwin <out-dir>
#
# Bumping the version: take the new release's folder and the .sha256 beside
# each zip from https://ffmpeg.martin-riedl.de (macOS, release), and check
# codecs.txt still lists h264_videotoolbox, libx264, libx265, prores_ks,
# libmp3lame and libopus.

set -eu

TARGET="$1"
OUT="$2"
VERSION="9.0.2"

case "$TARGET" in
  aarch64-apple-darwin)
    BASE="https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_$VERSION"
    FFMPEG_SHA="c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924"
    FFPROBE_SHA="fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6"
    # FFmpeg 9.0
    FALLBACK_FFMPEG="https://www.osxexperts.net/ffmpeg9arm.zip d0c06c5c68ce48af3143b262f7a9118a7c9f67de1e237fcc24ffb14df9c67af9"
    FALLBACK_FFPROBE="https://www.osxexperts.net/ffprobe9arm.zip 0c94fbdd8917022f28115eca512196cf4648732bc9e5db9ec8896c7e519d02aa"
    ;;
  *)
    echo "no FFmpeg build for $TARGET" >&2
    exit 1
    ;;
esac

mkdir -p "$OUT"
# Already there (same version): nothing to do.
if [ -x "$OUT/ffmpeg" ] && [ -x "$OUT/ffprobe" ] && [ "$(cat "$OUT/.version" 2>/dev/null)" = "$TARGET $VERSION" ]; then
  exit 0
fi

TMP="$(mktemp -d)"
# Marked when the fallback was used, so a cached copy is fetched again next time.
MARK=""
trap 'rm -rf "$TMP"' EXIT
# fetch <url> <sha256> <zip>: downloads and checks it; fails on either.
fetch() {
  curl -fSL --retry 3 --retry-delay 10 --retry-all-errors --progress-bar -o "$3" "$1" || return 1
  ACTUAL="$(shasum -a 256 "$3" | cut -d' ' -f1)"
  if [ "$ACTUAL" != "$2" ]; then
    echo "$1: checksum mismatch: expected $2, got $ACTUAL" >&2
    return 1
  fi
}
for tool in ffmpeg ffprobe; do
  case "$tool" in
    ffmpeg) SHA="$FFMPEG_SHA" FALLBACK="$FALLBACK_FFMPEG" ;;
    ffprobe) SHA="$FFPROBE_SHA" FALLBACK="$FALLBACK_FFPROBE" ;;
  esac
  if ! fetch "$BASE/$tool.zip" "$SHA" "$TMP/$tool.zip"; then
    echo "$tool: $BASE is unreachable; using ${FALLBACK%% *}" >&2
    fetch ${FALLBACK} "$TMP/$tool.zip" || exit 1
    MARK=" (fallback)"
  fi
  unzip -oq "$TMP/$tool.zip" -d "$TMP/$tool"
  mv "$TMP/$tool/$tool" "$OUT/$tool"
  chmod +x "$OUT/$tool"
done
echo "$TARGET $VERSION$MARK" >"$OUT/.version"
echo "FFmpeg$MARK for $TARGET in $OUT"
