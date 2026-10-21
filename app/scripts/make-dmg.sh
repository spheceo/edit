#!/bin/zsh
# Wraps an Edit.app in the drag-to-Applications disk image.
#   scripts/make-dmg.sh <Edit.app> <output.dmg>
# dmgbuild lays out the window without scripting Finder; it's installed once into its own
# Python environment in ~/Library/Caches/edit/dmgbuild. The background is drawn by
# scripts/dmg/background.swift (1x and 2x, joined into one TIFF so Retina screens get the sharp one).
set -euo pipefail
here=${0:A:h}
app=${1:?usage: make-dmg.sh <Edit.app> <output.dmg>}
out=${2:?usage: make-dmg.sh <Edit.app> <output.dmg>}

venv="$HOME/Library/Caches/edit/dmgbuild"
if [[ ! -x "$venv/bin/dmgbuild" ]]; then
  echo "==> Installing dmgbuild (once)"
  python3 -m venv "$venv"
  "$venv/bin/pip" install -q dmgbuild
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
swift "$here/dmg/background.swift" "$work" >/dev/null
tiffutil -cathidpicheck "$work/background.png" "$work/background@2x.png" -out "$work/background.tiff" 2>/dev/null

rm -f "$out"
"$venv/bin/dmgbuild" -s "$here/dmg/settings.py" \
  -D app="$app" -D background="$work/background.tiff" -D icon="$app/Contents/Resources/icon.icns" \
  "Edit" "$out" >/dev/null
echo "==> $out ($(du -h "$out" | cut -f1))"
