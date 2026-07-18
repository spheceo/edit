#!/bin/bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="debug"

case "${1:-}" in
    "")
        ;;
    --release)
        PROFILE="release"
        ;;
    -h|--help)
        echo "Usage: ./scripts/run-macos.sh [--release]"
        exit 0
        ;;
    *)
        echo "Unknown option: $1" >&2
        echo "Usage: ./scripts/run-macos.sh [--release]" >&2
        exit 2
        ;;
esac

command -v codesign >/dev/null || {
    echo "Required build tool is missing: codesign" >&2
    exit 1
}
command -v open >/dev/null || {
    echo "Required launch tool is missing: open" >&2
    exit 1
}

cd "$PROJECT_DIR"
if [[ "$PROFILE" == "release" ]]; then
    cargo build --release
else
    cargo build
fi

TARGET_ROOT="${CARGO_TARGET_DIR:-$PROJECT_DIR/target}"
if [[ "$TARGET_ROOT" != /* ]]; then
    TARGET_ROOT="$PROJECT_DIR/$TARGET_ROOT"
fi
BINARY="$TARGET_ROOT/$PROFILE/kuro"
APP="$TARGET_ROOT/$PROFILE/Kuro.app"
CONTENTS="$APP/Contents"
MACOS_DIR="$CONTENTS/MacOS"

rm -rf "$APP"
mkdir -p "$MACOS_DIR"
cp "$PROJECT_DIR/packaging/macos/Info.plist" "$CONTENTS/Info.plist"
cp "$BINARY" "$MACOS_DIR/Kuro"
chmod 755 "$MACOS_DIR/Kuro"
codesign --force --deep --sign - "$APP"

echo "Launching development bundle: $APP"
open -n "$APP"
