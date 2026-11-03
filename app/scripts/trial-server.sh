#!/usr/bin/env bash
# The trial server: a second Edit on this Mac for the in-app agent's trials and
# the teaching loop (the user, Oct 31), on its own port and data folder, run
# from this checkout WITHOUT bun --watch, so other sessions' saves never restart
# it mid-trial; restart it on purpose between trials to pick up new code.
# EDIT_TRIALS=1 keeps it out of the team's work (review fixes, Writer jobs, idea
# runs, first prompts, remote support): this Mac's id is the fixing computer's.
# Its own sign-in (one Keychain item per data folder): the first start prints a
# code and link; approve it once in the browser.
#
#   app/scripts/trial-server.sh start|stop|restart|status|code|log
#   (or `just trial-server start` …)
#
# EDIT_TRIAL_PORT (7710) and EDIT_TRIAL_HOME (~/.edit-trials) override.
set -uo pipefail

PORT="${EDIT_TRIAL_PORT:-7710}"
HOME_DIR="${EDIT_TRIAL_HOME:-$HOME/.edit-trials}"
APP="$(cd "$(dirname "$0")/.." && pwd)"
PIDFILE="$HOME_DIR/trial-server.pid"
LOG="$HOME_DIR/logs/trial-server.out"

running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }
healthy() { curl -s -m 3 "http://127.0.0.1:$PORT/api/health" >/dev/null; }

start() {
  if running; then echo "trial server already running (pid $(cat "$PIDFILE")) on :$PORT"; return 0; fi
  mkdir -p "$HOME_DIR/logs"
  (
    cd "$APP" || exit 1
    # The dev server's keys (`just dev`): Drive and Docs, the YouTube proxy.
    if command -v infisical >/dev/null; then
      for name in GOOGLE_DRIVE_CLIENT_ID GOOGLE_DRIVE_CLIENT_SECRET GOOGLE_DOCS_REFRESH_TOKEN PROXY_URL; do
        if [ -z "${!name:-}" ] && value="$(infisical secrets get "$name" --projectId=979fe56c-c4d0-4809-b64f-5ebc75eeaf05 --env=dev --path=/edit-relay --plain --silent 2>/dev/null)"; then
          export "$name=$value"
        fi
      done
    fi
    # Dev talks to dev: its own relay (edit-relay-dev: Infisical dev's keys, dev's Convex and R2). Installed builds use the live one.
    export EDIT_RELAY_URL="${EDIT_RELAY_URL:-https://edit-relay-dev.sphe-g-personal.workers.dev}"
    export EDIT_TRIALS=1 EDIT_HOME="$HOME_DIR" EDIT_CLOUD_HOLDER="$(scutil --get LocalHostName 2>/dev/null || hostname)-trials"
    nohup bun apps/server/src/main.ts serve --port "$PORT" --home "$HOME_DIR" >> "$LOG" 2>&1 &
    echo $! > "$PIDFILE"
  )
  for _ in $(seq 1 90); do healthy && break; sleep 2; done
  if healthy; then echo "trial server up on http://127.0.0.1:$PORT (data in $HOME_DIR, log $LOG)"; else echo "trial server didn't answer on :$PORT: see $LOG"; return 1; fi
  signed_in || code
}

stop() {
  if ! running; then echo "trial server not running"; rm -f "$PIDFILE"; return 0; fi
  local pid; pid="$(cat "$PIDFILE")"
  kill "$pid"
  for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid"
  rm -f "$PIDFILE"
  echo "trial server stopped"
}

signed_in() { curl -s -m 5 "http://127.0.0.1:$PORT/api/account" | grep -q '"signed_in":true'; }

# The latest sign-in code and link Edit printed (a new one comes when it runs out).
code() {
  if signed_in; then echo "signed in"; return 0; fi
  grep -iE "code|https://" "$LOG" | grep -iE "accounts|device|sign" | tail -3
}

status() {
  if running && healthy; then
    echo "trial server running (pid $(cat "$PIDFILE")) on http://127.0.0.1:$PORT, data in $HOME_DIR"
    signed_in && echo "signed in" || echo "not signed in: $0 code"
  else
    echo "trial server not running"
  fi
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  code) code ;;
  log) tail -n "${2:-40}" "$LOG" ;;
  *) echo "usage: $0 start|stop|restart|status|code|log"; exit 2 ;;
esac
