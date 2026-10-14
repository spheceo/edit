#!/bin/sh
# Edit installer.
#
#   curl -fsSL https://raw.githubusercontent.com/spheceo/edit/main/install.sh | sh
#
# Downloads the newest `edit` from GitHub Releases, checks its SHA-256 and
# puts it in ~/.local/bin (or $EDIT_INSTALL_DIR), with the FFmpeg it ships
# with beside it (edit-ffmpeg, edit-ffprobe: they don't shadow your own). Later versions install themselves from
# the editor (or `edit update`).

set -eu

REPO="spheceo/edit"
PREFIX="${EDIT_INSTALL_DIR:-$HOME/.local/bin}"

# Releases have Mac builds only (Apple Silicon and Intel).
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64) TARGET="aarch64-apple-darwin" ;;
  Darwin/x86_64) TARGET="x86_64-apple-darwin" ;;
  *)
    echo "Edit only has Mac builds so far (this is $(uname -s)/$(uname -m))." >&2
    exit 1
    ;;
esac

ARCHIVE="edit-$TARGET.tar.gz"
BASE="https://github.com/$REPO/releases/latest/download"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Installing Edit..."
curl -fSL --retry 3 --progress-bar -o "$TMP/$ARCHIVE" "$BASE/$ARCHIVE"
curl -fsSL --retry 3 -o "$TMP/$ARCHIVE.sha256" "$BASE/$ARCHIVE.sha256"
EXPECTED="$(cut -d' ' -f1 <"$TMP/$ARCHIVE.sha256")"
ACTUAL="$(shasum -a 256 "$TMP/$ARCHIVE" | cut -d' ' -f1)"
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "Checksum mismatch: expected $EXPECTED, got $ACTUAL." >&2
  exit 1
fi

mkdir -p "$PREFIX"
tar -xzf "$TMP/$ARCHIVE" -C "$TMP"
for tool in edit edit-ffmpeg edit-ffprobe; do
  # Older releases had no FFmpeg; Edit then uses the one on PATH.
  [ -f "$TMP/$tool" ] || continue
  chmod +x "$TMP/$tool"
  mv "$TMP/$tool" "$PREFIX/$tool"
done

echo
echo "$("$PREFIX/edit" --version) is in $PREFIX/edit."
case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) echo "Add it to your PATH (e.g. in ~/.zshrc):  export PATH=\"\$PATH:$PREFIX\"" ;;
esac
[ -x "$PREFIX/edit-ffmpeg" ] || command -v ffmpeg >/dev/null 2>&1 || echo "Edit needs FFmpeg for importing and export: brew install ffmpeg"
command -v codex >/dev/null 2>&1 || echo "The agent panel needs Codex: npm install -g @openai/codex, then codex login"
echo
echo "Start it with:  edit serve"
echo "Updates show up in the editor; one click installs and restarts."
