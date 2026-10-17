#!/usr/bin/env bash
# How long the TypeScript server takes from start to answering /api/health,
# from source (what a change costs: Bun has no compile step), on a throwaway
# home and port.
set -euo pipefail
cd "$(dirname "$0")/.."
home="$(mktemp -d)"
port=7798
bun apps/server/src/main.ts serve --port "$port" --home "$home" >/dev/null 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null || true; rm -rf "$home"' EXIT
for _ in $(seq 1 600); do
    curl -sf "http://127.0.0.1:$port/api/health" >/dev/null && exit 0
    sleep 0.05
done
echo "the server didn't answer" >&2
exit 1
