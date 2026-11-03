#!/bin/bash
# usage: next-round.sh <previous round> <next round> <video>...  → when the previous round is all done:
# rebuild the dev server from the repo, restart it, then run the next round on the videos given.
P=$1; N=$2; shift 2; L=${LOOP:-$HOME/edit-experiments/loop}; S="$(cd "$(dirname "$0")" && pwd)"
REPO="$(git -C "$S" rev-parse --show-toplevel)"
for i in $(seq 1 720); do grep -q "$P all done" $L/rounds/$P-queue.log 2>/dev/null && break; sleep 30; done
(cd "$REPO/app" && just serve-build-bin > /tmp/loop-build.log 2>&1); tail -1 /tmp/loop-build.log
"$S/restart.sh" || exit 1
printf '\n## Round %s (code and teaching to %s)\n' "${N#R}" "$(git -C "$REPO" log --oneline | head -1 | cut -c1-7)" >> $L/LOG.md
"$S/run_round.sh" $N "$@" > $L/rounds/$N-queue.log 2>&1
