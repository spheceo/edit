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

# Releases have Apple Silicon Mac builds (no Intel since Oct 29) and x86-64 Linux builds.
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64) TARGET="aarch64-apple-darwin" ;;
  Darwin/x86_64)
    echo "Edit only has Apple Silicon Mac builds (this Mac is Intel)." >&2
    exit 1
    ;;
  Linux/x86_64) TARGET="x86_64-unknown-linux-gnu" ;;
  *)
    echo "Edit has Apple Silicon Mac and x86-64 Linux builds (this is $(uname -s)/$(uname -m))." >&2
    exit 1
    ;;
esac
LINUX=""
[ "$(uname -s)" = Linux ] && LINUX=1

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
if command -v shasum >/dev/null 2>&1; then ACTUAL="$(shasum -a 256 "$TMP/$ARCHIVE" | cut -d' ' -f1)"; else ACTUAL="$(sha256sum "$TMP/$ARCHIVE" | cut -d' ' -f1)"; fi
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
if [ ! -x "$PREFIX/edit-ffmpeg" ] && ! command -v ffmpeg >/dev/null 2>&1; then
  if [ -n "$LINUX" ]; then echo "Edit needs FFmpeg for importing and export: sudo apt install ffmpeg"; else echo "Edit needs FFmpeg for importing and export: brew install ffmpeg"; fi
fi
# The agent panel runs on Claude Code (the default) or Codex: one of them is enough.
if ! command -v claude >/dev/null 2>&1 && ! command -v codex >/dev/null 2>&1; then
  echo "The agent panel needs Claude Code (or Codex; pick in Settings → Agent):"
  echo "  curl -fsSL https://claude.ai/install.sh | bash, then claude auth login"
fi
# Map shots and research open pages in Chrome (apps/server/src/broll.ts); on Linux it's Edit's window too.
if [ -n "$LINUX" ]; then
  if [ ! -x /opt/google/chrome/chrome ] && ! command -v google-chrome >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1; then
    echo "Edit's window, map shots and research need Google Chrome (its .deb, not the snap): https://www.google.com/chrome/"
  fi
  # NVENC for exports and imports: NVIDIA's driver 610 or newer (scripts/ffmpeg.sh).
  if command -v nvidia-smi >/dev/null 2>&1; then
    driver="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1)"
    if [ -n "$driver" ] && [ "${driver%%.*}" -lt 610 ] 2>/dev/null; then
      echo "Exports and imports use the NVIDIA card with its driver 610 or newer (this one is $driver): pick a newer one in Software & Updates → Additional Drivers"
    fi
  fi
  "$PREFIX/edit" launcher || true
fi
echo
if [ -n "$LINUX" ]; then
  echo "Open Edit from your apps, or start it with:  edit app"
else
  echo "Start it with:  edit serve"
fi
echo "Updates show up in the editor; one click installs and restarts."
