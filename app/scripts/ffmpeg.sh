#!/bin/sh
# Fetches the FFmpeg that ships with Edit (ffmpeg + ffprobe, static, signed):
# Martin Riedl's macOS builds, pinned by version and SHA-256.
#
#   scripts/ffmpeg.sh <aarch64-apple-darwin|x86_64-apple-darwin> <out-dir>
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
    ;;
  x86_64-apple-darwin)
    BASE="https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_$VERSION"
    FFMPEG_SHA="7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4"
    FFPROBE_SHA="2322438ed2f6319a691291b247d09c69dcaa3a982460d1f269a7e1af335cfdfd"
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
trap 'rm -rf "$TMP"' EXIT
for tool in ffmpeg ffprobe; do
  case "$tool" in
    ffmpeg) SHA="$FFMPEG_SHA" ;;
    ffprobe) SHA="$FFPROBE_SHA" ;;
  esac
  # The host has had outages (Cloudflare 521): keep trying for a few minutes.
  curl -fSL --retry 6 --retry-delay 20 --retry-all-errors --progress-bar -o "$TMP/$tool.zip" "$BASE/$tool.zip"
  ACTUAL="$(shasum -a 256 "$TMP/$tool.zip" | cut -d' ' -f1)"
  if [ "$ACTUAL" != "$SHA" ]; then
    echo "$tool.zip checksum mismatch: expected $SHA, got $ACTUAL" >&2
    exit 1
  fi
  unzip -oq "$TMP/$tool.zip" -d "$TMP/$tool"
  mv "$TMP/$tool/$tool" "$OUT/$tool"
  chmod +x "$OUT/$tool"
done
echo "$TARGET $VERSION" >"$OUT/.version"
echo "FFmpeg $VERSION for $TARGET in $OUT"
