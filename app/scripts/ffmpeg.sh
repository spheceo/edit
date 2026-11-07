#!/bin/sh
# Fetches the FFmpeg that ships with Edit (ffmpeg + ffprobe, static, signed):
# Martin Riedl's macOS builds, pinned by version and SHA-256. When his site is
# down (a Cloudflare 521 held up v0.0.0), osxexperts.net's static builds
# instead, pinned the same way (same encoders; ad hoc signed).
#
#   scripts/ffmpeg.sh aarch64-apple-darwin <out-dir>
#   scripts/ffmpeg.sh x86_64-unknown-linux-gnu <out-dir>
#
# Bumping the version: take the new release's folder and the .sha256 beside
# each zip from https://ffmpeg.martin-riedl.de (macOS, release), and check
# codecs.txt still lists h264_videotoolbox, libx264, libx265, prores_ks,
# libmp3lame and libopus.
#
# Linux: BtbN's static builds (github.com/BtbN/FFmpeg-Builds), the same
# FFmpeg release, from a month-end autobuild (those are kept; the daily ones
# go after a few weeks), pinned by its SHA-256 in that release's
# checksums.sha256. Riedl's Linux builds have no NVENC or CUDA. BtbN's NVENC
# needs NVIDIA's driver 610 or newer (NVENC API 13.1); an older one exports on
# libx264 (apps/server/src/tools.ts, crates/edit-engine/src/export.rs try it).
# Bumping: a newer month-end tag with this FFmpeg version's linux64-gpl (and
# linuxarm64-gpl) tar.xz, and their lines in its checksums.sha256.

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
  x86_64-unknown-linux-gnu)
    TARBALL="https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-31-12-59/ffmpeg-n9.0.2-39-g7adfbe40dc-linux64-gpl-9.0.tar.xz"
    TARBALL_SHA="73e29a56974ae5a651133a04584c7483b21afe941e17dc91d79814a758b608d3"
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

# sha256 <file>: its digest (shasum on a Mac, sha256sum on Linux).
sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi
}

TMP="$(mktemp -d)"
# Marked when the fallback was used, so a cached copy is fetched again next time.
MARK=""
trap 'rm -rf "$TMP"' EXIT
# fetch <url> <sha256> <zip>: downloads and checks it; fails on either.
fetch() {
  curl -fSL --retry 3 --retry-delay 10 --retry-all-errors --progress-bar -o "$3" "$1" || return 1
  ACTUAL="$(sha256 "$3")"
  if [ "$ACTUAL" != "$2" ]; then
    echo "$1: checksum mismatch: expected $2, got $ACTUAL" >&2
    return 1
  fi
}
# Linux: one tarball with both, its bin/ unpacked.
if [ -n "${TARBALL:-}" ]; then
  fetch "$TARBALL" "$TARBALL_SHA" "$TMP/ffmpeg.tar.xz" || exit 1
  mkdir "$TMP/unpacked"
  tar -xJf "$TMP/ffmpeg.tar.xz" -C "$TMP/unpacked" --wildcards '*/bin/ffmpeg' '*/bin/ffprobe'
  for tool in ffmpeg ffprobe; do
    mv "$TMP"/unpacked/*/bin/"$tool" "$OUT/$tool"
    chmod +x "$OUT/$tool"
  done
  echo "$TARGET $VERSION" >"$OUT/.version"
  echo "FFmpeg for $TARGET in $OUT"
  exit 0
fi
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
