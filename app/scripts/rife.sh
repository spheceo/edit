#!/bin/sh
# Fetches RIFE for Linux's slow-motion smoothing (apps/server/src/rife.ts):
# rife-ncnn-vulkan (MIT, nihui; runs on any Vulkan GPU) and the RIFE v4.6
# model, from its 20221029 release, pinned by SHA-256. Its zip carries every
# model (431 MB); only the program and v4.6 (~20 MB) are kept. A release
# embeds them in `edit` (apps/server/scripts/embed.ts --rife), and a dev run
# reads them from app/rife.
#
#   scripts/rife.sh x86_64-unknown-linux-gnu <out-dir>
#
# A Mac smooths with VideoToolbox's frame-rate conversion: nothing to fetch.

set -eu

TARGET="$1"
OUT="$2"
VERSION="20221029"

case "$TARGET" in
  x86_64-unknown-linux-gnu)
    ZIP="https://github.com/nihui/rife-ncnn-vulkan/releases/download/$VERSION/rife-ncnn-vulkan-$VERSION-ubuntu.zip"
    SUM="1e2c7ee7fa7daa326542d50622f0afedc80cf6f1858bda411d16385ffa5cdf68"
    FOLDER="rife-ncnn-vulkan-$VERSION-ubuntu"
    ;;
  *)
    echo "no RIFE build for $TARGET" >&2
    exit 1
    ;;
esac

mkdir -p "$OUT"
# Already there (same version): nothing to do.
if [ -x "$OUT/rife-ncnn-vulkan" ] && [ -f "$OUT/rife-v4.6/flownet.bin" ] && [ "$(cat "$OUT/.version" 2>/dev/null)" = "$TARGET $VERSION" ]; then
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fSL --retry 3 --retry-delay 10 --retry-all-errors --progress-bar -o "$TMP/rife.zip" "$ZIP"
ACTUAL="$(sha256sum "$TMP/rife.zip" | cut -d' ' -f1)"
if [ "$ACTUAL" != "$SUM" ]; then
  echo "$ZIP: checksum mismatch: expected $SUM, got $ACTUAL" >&2
  exit 1
fi
unzip -q "$TMP/rife.zip" "$FOLDER/rife-ncnn-vulkan" "$FOLDER/rife-v4.6/*" "$FOLDER/LICENSE" -d "$TMP"
rm -rf "$OUT/rife-v4.6"
mv "$TMP/$FOLDER/rife-v4.6" "$OUT/rife-v4.6"
install -m 755 "$TMP/$FOLDER/rife-ncnn-vulkan" "$OUT/rife-ncnn-vulkan"
cp "$TMP/$FOLDER/LICENSE" "$OUT/LICENSE"
echo "$TARGET $VERSION" >"$OUT/.version"
echo "RIFE $VERSION (v4.6) for $TARGET in $OUT"
