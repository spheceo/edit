#!/bin/bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_ROOT="$PROJECT_DIR/.build/macos-bundle"
FFMPEG_SOURCE="$BUILD_ROOT/ffmpeg-8.1"
FFMPEG_PREFIX="$BUILD_ROOT/ffmpeg-install"
CARGO_TARGET="$BUILD_ROOT/cargo-target"
APP_BUNDLE="$PROJECT_DIR/dist/Kuro.app"
CONTENTS="$APP_BUNDLE/Contents"
MACOS_DIR="$CONTENTS/MacOS"
FRAMEWORKS_DIR="$CONTENTS/Frameworks"
RESOURCES_DIR="$CONTENTS/Resources"

for tool in git make pkg-config install_name_tool otool codesign; do
    command -v "$tool" >/dev/null || {
        echo "Required build tool is missing: $tool" >&2
        exit 1
    }
done

if [ -e "$APP_BUNDLE" ]; then
    echo "$APP_BUNDLE already exists. Move or remove it before bundling again." >&2
    exit 1
fi

mkdir -p "$BUILD_ROOT" "$PROJECT_DIR/dist"

if [ ! -d "$FFMPEG_SOURCE/.git" ]; then
    git clone --depth 1 --branch release/8.1 https://github.com/FFmpeg/FFmpeg.git "$FFMPEG_SOURCE"
fi

if [ ! -f "$FFMPEG_PREFIX/lib/pkgconfig/libavfilter.pc" ]; then
    mkdir -p "$FFMPEG_PREFIX"
    (
        cd "$FFMPEG_SOURCE"
        if [ -f Makefile ]; then
            make distclean
        fi
        ./configure \
            --prefix="$FFMPEG_PREFIX" \
            --enable-shared \
            --disable-static \
            --disable-programs \
            --disable-doc \
            --disable-debug \
            --disable-gpl \
            --disable-nonfree \
            --disable-version3 \
            --disable-autodetect \
            --disable-avdevice \
            --disable-network \
            --enable-avcodec \
            --enable-avformat \
            --enable-avfilter \
            --enable-avutil \
            --enable-swresample \
            --enable-swscale \
            --enable-videotoolbox \
            --enable-audiotoolbox \
            --enable-pic \
            --extra-cflags="-mmacosx-version-min=12.0" \
            --extra-ldflags="-mmacosx-version-min=12.0"
        make -j"$(sysctl -n hw.logicalcpu)"
        make install
    )
fi

PKG_CONFIG_PATH="$FFMPEG_PREFIX/lib/pkgconfig" \
DYLD_LIBRARY_PATH="$FFMPEG_PREFIX/lib" \
MACOSX_DEPLOYMENT_TARGET=12.0 \
CARGO_TARGET_DIR="$CARGO_TARGET" \
cargo build --manifest-path "$PROJECT_DIR/Cargo.toml" --release

mkdir -p "$MACOS_DIR" "$FRAMEWORKS_DIR" "$RESOURCES_DIR"
cp "$CARGO_TARGET/release/kuro" "$MACOS_DIR/Kuro"
cp "$PROJECT_DIR/packaging/macos/Info.plist" "$CONTENTS/Info.plist"
cp "$PROJECT_DIR/packaging/THIRD_PARTY_NOTICES.md" "$RESOURCES_DIR/THIRD_PARTY_NOTICES.md"
cp "$PROJECT_DIR/assets/icons/LICENSE-HUGEICONS.md" "$RESOURCES_DIR/LICENSE-HUGEICONS.md"
cp "$FFMPEG_SOURCE/COPYING.LGPLv2.1" "$RESOURCES_DIR/COPYING.LGPLv2.1"
chmod 755 "$MACOS_DIR/Kuro"

bundle_dependencies() {
    local binary="$1"
    local dependency
    local basename
    local bundled

    while IFS= read -r dependency; do
        case "$dependency" in
            "$FFMPEG_PREFIX"/*)
                basename="$(basename "$dependency")"
                bundled="$FRAMEWORKS_DIR/$basename"
                if [ ! -f "$bundled" ]; then
                    cp -L "$dependency" "$bundled"
                    chmod 755 "$bundled"
                    install_name_tool -id "@rpath/$basename" "$bundled"
                    bundle_dependencies "$bundled"
                fi
                install_name_tool -change "$dependency" "@rpath/$basename" "$binary"
                ;;
        esac
    done < <(otool -L "$binary" | tail -n +2 | awk '{print $1}')
}

install_name_tool -add_rpath "@executable_path/../Frameworks" "$MACOS_DIR/Kuro"
bundle_dependencies "$MACOS_DIR/Kuro"

codesign --force --deep --sign - "$APP_BUNDLE"

echo "Created self-contained bundle: $APP_BUNDLE"
echo "For distribution, sign it with your Developer ID and submit it for notarization."
