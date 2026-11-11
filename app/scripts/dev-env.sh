# The dev server's environment, for `just dev` and `just dev-server` (sourced).
# Dev's own data folder: ~/.edit is the installed Edit's (prod), and a cloud
# project cached there must never sync into dev. Dev talks to dev: its own
# relay (edit-relay-dev: Infisical dev's keys, dev's Convex and R2); installed
# builds use the live one.
if command -v infisical >/dev/null; then
    for name in GOOGLE_DRIVE_CLIENT_ID GOOGLE_DRIVE_CLIENT_SECRET GOOGLE_DOCS_REFRESH_TOKEN PROXY_URL; do
        if [ -z "${!name:-}" ] && value="$(infisical secrets get "$name" --projectId=979fe56c-c4d0-4809-b64f-5ebc75eeaf05 --env=dev --path=/edit-relay --plain --silent 2>/dev/null)"; then
            export "$name=$value"
        fi
    done
fi
export EDIT_HOME="${EDIT_HOME:-$HOME/.edit-dev}"
export EDIT_RELAY_URL="${EDIT_RELAY_URL:-https://edit-relay-dev.sphe-g-personal.workers.dev}"
# The server and the headless Chromes it starts open many files; macOS's default is 256.
ulimit -n 65536 2>/dev/null || ulimit -n "$(ulimit -Hn)" 2>/dev/null || true
