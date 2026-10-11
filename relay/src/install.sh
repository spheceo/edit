#!/bin/sh
# Edit installer, served by Edit's relay.
#
#   curl -fsSL __RELAY__/install.sh | sh
#
# Downloads the newest `edit` for this machine, checks its SHA-256 and puts it
# in ~/.local/bin (or $EDIT_INSTALL_DIR). Later versions install themselves
# from the editor (or `edit update`).

set -eu

RELAY="__RELAY__"
PREFIX="${EDIT_INSTALL_DIR:-$HOME/.local/bin}"

# Releases are built on an Apple Silicon Mac (`just publish`); that's the
# only build there is.
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64) TARGET="aarch64-apple-darwin" ;;
  *)
    echo "Edit only has a build for Apple Silicon Macs so far (this is $(uname -s)/$(uname -m))." >&2
    exit 1
    ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -fsSL --retry 3 -o "$TMP/latest.json" "$RELAY/v1/releases/latest?target=$TARGET"
TAG="$(sed -n 's/.*"tag":"\([^"]*\)".*/\1/p' "$TMP/latest.json")"
SHA="$(sed -n 's/.*"sha256":"\([^"]*\)".*/\1/p' "$TMP/latest.json")"
if [ -z "$TAG" ] || [ -z "$SHA" ]; then
  echo "No Edit release for $TARGET yet." >&2
  exit 1
fi

echo "Installing Edit $TAG..."
curl -fSL --retry 3 --progress-bar -o "$TMP/edit.tar.gz" "$RELAY/v1/releases/download/$TAG/edit-$TARGET.tar.gz"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$TMP/edit.tar.gz" | cut -d' ' -f1)"
else
  ACTUAL="$(shasum -a 256 "$TMP/edit.tar.gz" | cut -d' ' -f1)"
fi
if [ "$ACTUAL" != "$SHA" ]; then
  echo "Checksum mismatch: expected $SHA, got $ACTUAL." >&2
  exit 1
fi

mkdir -p "$PREFIX"
tar -xzf "$TMP/edit.tar.gz" -C "$TMP"
chmod +x "$TMP/edit"
mv "$TMP/edit" "$PREFIX/edit"

echo
echo "Edit $TAG is in $PREFIX/edit."
case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) echo "Add it to your PATH (e.g. in ~/.zshrc):  export PATH=\"\$PATH:$PREFIX\"" ;;
esac
command -v ffmpeg >/dev/null 2>&1 || echo "Edit needs FFmpeg for importing and export: brew install ffmpeg (or your package manager)."
echo
echo "Start it with:  edit serve"
echo "Updates show up in the editor; one click installs and restarts."
