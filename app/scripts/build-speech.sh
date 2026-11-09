#!/bin/sh
# Builds edit-speech (scripts/edit-speech.swift), the on-device word
# source apps/server/src/mac_speech.ts runs. macOS only; it needs the macOS 26
# SDK (SpeechTranscriber): the Command Line Tools' or Xcode 26's, found if the
# selected one is older (GitHub's runners keep several Xcodes).
#
#   scripts/build-speech.sh <out file>
#
# `just speech` builds target/speech/edit-speech, as a dev run does on demand;
# the release puts it beside edit and into Edit.app's Resources.

set -eu

OUT="$1"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$HERE/scripts/edit-speech.swift"

[ "$(uname)" = Darwin ] || { echo "edit-speech is built on a Mac only" >&2; exit 1; }
sdk_major() { xcrun --sdk macosx --show-sdk-version 2>/dev/null | cut -d. -f1; }
if [ "$(sdk_major || echo 0)" -lt 26 ] 2>/dev/null; then
  for xcode in /Applications/Xcode_26*.app /Applications/Xcode-26*.app /Applications/Xcode.app; do
    [ -d "$xcode" ] || continue
    DEVELOPER_DIR="$xcode/Contents/Developer"; export DEVELOPER_DIR
    [ "$(sdk_major || echo 0)" -ge 26 ] && break
    unset DEVELOPER_DIR
  done
fi
[ "$(sdk_major || echo 0)" -ge 26 ] || { echo "edit-speech needs the macOS 26 SDK (Xcode 26 or its Command Line Tools)" >&2; exit 1; }

mkdir -p "$(dirname "$OUT")"
# Into a file of its own first, so a server running the older one never sees half a binary.
xcrun swiftc -O -parse-as-library -target arm64-apple-macos13 "$SOURCE" -o "$OUT.next"
codesign -s - -f "$OUT.next" 2>/dev/null  # ad hoc: a Mac runs nothing unsigned
mv -f "$OUT.next" "$OUT"
echo "built $OUT"
