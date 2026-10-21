#!/bin/sh
# Edit installer.
#
#   curl -fsSL https://raw.githubusercontent.com/spheceo/edit/main/install.sh | sh
#
# Downloads the newest `edit` from GitHub Releases, checks its SHA-256 and
# puts it in ~/.local/bin (or $EDIT_INSTALL_DIR), with the FFmpeg it ships
# with beside it (edit-ffmpeg, edit-ffprobe: they don't shadow your own). Later versions install themselves from
# the editor (or `edit update`).
#
# A particular version (to pin one, or to go back to the one before), or the
# newest nightly (pre-releases between versions; the editor offers each new one):
#
#   curl -fsSL https://raw.githubusercontent.com/spheceo/edit/main/install.sh | EDIT_VERSION=v0.0.12 sh
#   curl -fsSL https://raw.githubusercontent.com/spheceo/edit/main/install.sh | EDIT_VERSION=nightly sh

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
VERSION="${EDIT_VERSION:-}"
if [ "$VERSION" = nightly ]; then
  # Newest first; drafts aren't listed without a login.
  VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=30" |
    sed -n 's/.*"tag_name": *"\(nightly-[0-9]*\)".*/\1/p' | head -1)"
  [ -n "$VERSION" ] || { echo "No nightly is out yet; leave EDIT_VERSION unset for the latest release." >&2; exit 1; }
fi
case "$VERSION" in
  "" | latest) BASE="https://github.com/$REPO/releases/latest/download" ;;
  v* | nightly-*) BASE="https://github.com/$REPO/releases/download/$VERSION" ;;
  *) BASE="https://github.com/$REPO/releases/download/v$VERSION" ;;
esac
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Installing Edit${VERSION:+ $VERSION}..."
if ! curl -fSL --retry 3 --progress-bar -o "$TMP/$ARCHIVE" "$BASE/$ARCHIVE"; then
  [ -z "$VERSION" ] || echo "Is $VERSION a release? They're listed at https://github.com/$REPO/releases" >&2
  exit 1
fi
curl -fsSL --retry 3 -o "$TMP/$ARCHIVE.sha256" "$BASE/$ARCHIVE.sha256"
EXPECTED="$(cut -d' ' -f1 <"$TMP/$ARCHIVE.sha256")"
ACTUAL="$(shasum -a 256 "$TMP/$ARCHIVE" | cut -d' ' -f1)"
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "Checksum mismatch: expected $EXPECTED, got $ACTUAL." >&2
  exit 1
fi

mkdir -p "$PREFIX" "$TMP/unpacked"
tar -xzf "$TMP/$ARCHIVE" -C "$TMP/unpacked"
[ -f "$TMP/unpacked/edit" ] || { echo "The download has no edit in it." >&2; exit 1; }
# Every program in the archive goes in (edit last). Older releases had no
# FFmpeg; Edit then uses the one on PATH.
for path in "$TMP"/unpacked/*; do
  tool="$(basename "$path")"
  [ -f "$path" ] && [ "$tool" != edit ] || continue
  case "$tool" in
    edit-ffmpeg | edit-ffprobe) chmod +x "$path" ;;
    *) [ -x "$path" ] || continue ;;
  esac
  mv "$path" "$PREFIX/$tool"
done
chmod +x "$TMP/unpacked/edit"
mv "$TMP/unpacked/edit" "$PREFIX/edit"

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
