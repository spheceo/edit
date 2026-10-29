#!/bin/zsh
# Edit.app around a release's programs, then what ships of it: the update zip
# (what an installed Edit.app updates from, apps/server/src/update.ts) and the
# drag-to-Applications disk image.
#
#   scripts/package-app.sh <target> <package dir> <out dir>
#
# <package dir> holds edit, edit-ffmpeg, edit-ffprobe and qjs-<target> (the
# release workflow's package/). Writes <out>/Edit-<target>.zip (+ .sha256) and
# <out>/Edit-Apple-Silicon.dmg.
#
# Signing: with MACOS_CERTIFICATE (a Developer ID Application .p12, base64) and
# MACOS_CERTIFICATE_PASSWORD, every program is signed with it under the hardened
# runtime; with NOTARY_KEY (an App Store Connect API key .p8, base64),
# NOTARY_KEY_ID and NOTARY_ISSUER too, the disk image is notarised and the
# ticket stapled to it and the app. Without them, everything is signed ad hoc.
set -euo pipefail
here=${0:A:h}
root=${here:h}
target=${1:?usage: package-app.sh <target> <package dir> <out dir>}
pkg=${2:A}
out=${3:A}
case "$target" in
  aarch64-apple-darwin) human=Apple-Silicon ;;
  *) echo "no Mac app for $target" >&2; exit 1 ;;
esac
mkdir -p "$out"
work=$(mktemp -d)
# One path per entry, spaces kept ("Application Support").
keychains=("${(@f)$(security list-keychains -d user | sed -E 's/^[[:space:]]*"(.*)"$/\1/')}")
# Puts the search list back as it was (on a Mac, not just CI) and removes the signing keychain.
trap 'rm -rf "$work"; if [[ -n "${keychain:-}" ]]; then security list-keychains -d user -s "${keychains[@]}"; security delete-keychain "$keychain" 2>/dev/null; fi; true' EXIT

echo "==> Edit.app ($target)"
(cd "$root/crates/edit-window" && bunx @tauri-apps/cli@2.12.4 build --target "$target" --bundles app --config \
  "{\"bundle\":{\"resources\":{\"$pkg/edit-ffmpeg\":\"edit-ffmpeg\",\"$pkg/edit-ffprobe\":\"edit-ffprobe\",\"$pkg/qjs-$target\":\"qjs-$target\",\"$pkg/edit\":\"edit\"}}}")
built="${CARGO_TARGET_DIR:-$root/target}/$target/release/bundle/macos/Edit.app"
app="$work/Edit.app"
ditto "$built" "$app"

identity=-
runtime=()
if [[ -n "${MACOS_CERTIFICATE:-}" ]]; then
  echo "==> Signing with the Developer ID"
  keychain="$work/signing.keychain-db"
  # No pipes cut short here: under pipefail a reader that stops early fails the script (SIGPIPE, 141).
  password=$(openssl rand -hex 16)
  print -rn -- "$MACOS_CERTIFICATE" | base64 --decode >"$work/certificate.p12"
  security create-keychain -p "$password" "$keychain"
  security set-keychain-settings -lut 3600 "$keychain"
  security unlock-keychain -p "$password" "$keychain"
  security import "$work/certificate.p12" -k "$keychain" -P "${MACOS_CERTIFICATE_PASSWORD:-}" -T /usr/bin/codesign
  security set-key-partition-list -S apple-tool:,apple: -s -k "$password" "$keychain" >/dev/null
  security list-keychains -d user -s "$keychain" "${keychains[@]}"
  identity=$(security find-identity -v -p codesigning "$keychain" | sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' | sed -n 1p)
  [[ -n "$identity" ]] || { echo "no Developer ID Application identity in MACOS_CERTIFICATE" >&2; exit 1; }
  runtime=(--options runtime --timestamp)
fi
# Inside out: the programs in Resources, then the app (its own executable and seal).
codesign --force "${runtime[@]}" -s "$identity" --entitlements "$here/dmg/edit.entitlements" "$app/Contents/Resources/edit"
codesign --force "${runtime[@]}" -s "$identity" "$app/Contents/Resources/edit-ffmpeg" "$app/Contents/Resources/edit-ffprobe" "$app/Contents/Resources/qjs-$target"
codesign --force "${runtime[@]}" -s "$identity" "$app"
codesign --verify --deep --strict "$app"
# qjs must start as signed too: it is yt-dlp's JavaScript runtime, and a copy
# that can't run leaves YouTube imports with no video and no plain reason.
[[ "$("$app/Contents/Resources/qjs-$target" --version </dev/null 2>&1)" == 0.* ]] || { echo "the signed qjs-$target didn't start" >&2; exit 1; }
echo "==> qjs starts as signed"

# The signed server must start and answer before anything ships: a Bun-compiled
# binary can hang at start under the hardened runtime (Writer's, Bun 1.4.4, Oct 23),
# which only this signing shows.
echo "==> The signed server starts"
server="$app/Contents/Resources/edit"
limit=30
perl -e 'alarm shift; exec @ARGV' "$limit" "$server" --version || { echo "the signed edit didn't answer --version within ${limit}s" >&2; exit 1; }
home="$work/smoke-home"
mkdir -p "$home"
EDIT_KEYCHAIN_FILE="$home/keychain.json" EDIT_ADOPT_SHELL_ENV=1 EDIT_NO_BROWSER=1 EDIT_CLAUDE_MAINTENANCE=0 "$server" serve --home "$home" --port 7797 >"$work/smoke.log" 2>&1 &
smoke=$!
answered=0
for _ in $(seq 1 $((limit * 2))); do
  if curl -fsS -m 2 http://127.0.0.1:7797/api/health 2>/dev/null | grep -q '"name":"edit"'; then answered=1; break; fi
  sleep 0.5
done
kill "$smoke" 2>/dev/null || true
wait "$smoke" 2>/dev/null || true
(( answered )) || { echo "the signed edit serve didn't answer within ${limit}s:" >&2; cat "$work/smoke.log" >&2; exit 1; }

dmg="$out/Edit-$human.dmg"
"$here/make-dmg.sh" "$app" "$dmg"
if [[ "$identity" != - ]]; then
  codesign --force --timestamp -s "$identity" "$dmg"
  if [[ -n "${NOTARY_KEY:-}" && -n "${NOTARY_KEY_ID:-}" && -n "${NOTARY_ISSUER:-}" ]]; then
    echo "==> Notarising (a few minutes)"
    print -rn -- "$NOTARY_KEY" | base64 --decode >"$work/notary.p8"
    xcrun notarytool submit "$dmg" --key "$work/notary.p8" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER" --wait
    xcrun stapler staple "$dmg"
    # The image's ticket covers the app inside it: staple it to the app the updater downloads too.
    xcrun stapler staple "$app"
  fi
fi

zip="$out/Edit-$target.zip"
rm -f "$zip"
ditto -c -k --keepParent "$app" "$zip"
(cd "$out" && shasum -a 256 "${zip:t}" >"${zip:t}.sha256")
echo "==> ${zip:t}, ${dmg:t}"
