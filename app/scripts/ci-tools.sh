#!/usr/bin/env bash
# Check's tools, in one folder that actions/cache keeps between runs, so a
# Check installs nothing from a package mirror: `just` (pinned by SHA-256),
# the FFmpeg Edit ships (scripts/ffmpeg.sh, pinned the same way) and, on
# Linux, Vulkan's software device for the renderer's tests (hosted runners
# have no GPU), as the .deb files apt fetched once for this runner image.
# Nov 11: Ubuntu's mirror stopped resolving and apt failed six Checks in a
# row on all four Linux parts (5 minutes of retries each); Homebrew is the
# same kind of outside dependency for the Mac.
#
#   scripts/ci-tools.sh <target> <dir>   then put <dir>/bin on PATH
set -euo pipefail
target="$1"
mkdir -p "$2/bin"
dir="$(cd "$2" && pwd)"

JUST=1.45.0
case "$target" in
  aarch64-apple-darwin) just_target=aarch64-apple-darwin just_sha=5bcffd1e4b2b24f71a2acff52a604e9da03615679c0b3045a8c921c95cf1532c ;;
  x86_64-unknown-linux-gnu) just_target=x86_64-unknown-linux-musl just_sha=dc3f958aaf8c6506dd90426e9b03f86dd15e74a6467ee0e54929f750af3d9e49 ;;
  *) echo "no CI tools for $target" >&2; exit 1 ;;
esac
if ! "$dir/bin/just" --version 2>/dev/null | grep -qx "just $JUST"; then
  work="$(mktemp -d)"
  curl -fsSL --retry 5 --retry-all-errors -o "$work/just.tar.gz" \
    "https://github.com/casey/just/releases/download/$JUST/just-$JUST-$just_target.tar.gz"
  echo "$just_sha  $work/just.tar.gz" | shasum -a 256 -c - >/dev/null
  tar -xzf "$work/just.tar.gz" -C "$dir/bin" just
  rm -rf "$work"
fi

# A matching copy is kept as it is (ffmpeg.sh checks it).
scripts/ffmpeg.sh "$target" "$dir/ffmpeg"
ln -sf "$dir/ffmpeg/ffmpeg" "$dir/bin/ffmpeg"
ln -sf "$dir/ffmpeg/ffprobe" "$dir/bin/ffprobe"

if [[ "$target" == *-linux-* ]]; then
  debs="$dir/debs"
  # Fetched once per runner image (GitHub's ImageVersion), then installed from here; another image's are fetched again.
  image="${ImageOS:-}-${ImageVersion:-}"
  if [ "$(cat "$debs/.fetched" 2>/dev/null)" != "$image" ]; then
    rm -rf "$debs"
    mkdir -p "$debs/partial"
    apt=(sudo apt-get -qq -o Acquire::Retries=5 -o Acquire::http::Timeout=30)
    "${apt[@]}" update
    "${apt[@]}" -o Dir::Cache::archives="$debs" install -y --download-only mesa-vulkan-drivers libvulkan1
    sudo chown -R "$(id -u)" "$debs"
    echo "$image" > "$debs/.fetched"
  fi
  if compgen -G "$debs/*.deb" >/dev/null; then sudo dpkg -i "$debs"/*.deb >/dev/null; fi
fi
"$dir/bin/just" --version
"$dir/bin/ffmpeg" -hide_banner -version | head -1
