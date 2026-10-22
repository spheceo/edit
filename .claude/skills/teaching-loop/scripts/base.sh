#!/bin/bash
# usage: base.sh <key> <style> <fps> "<name>" "<doc url>"  → a fresh import of the Doc (footage, transcripts,
# voice-over: what an agent gets), recorded as the base trials copy, in $LOOP/base/bases.json with a snapshot.
K=$1; STYLE=$2; FPS=$3; NAME=$4; URL=$5; L=${LOOP:-$HOME/edit-experiments/loop}; S="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$L/base" "$L/rounds" "$L/keys"
"$S/fresh.sh" "Base: $NAME" "$STYLE" "$FPS" "$URL" > "$L/base/$K.log" 2>&1
P=$(tail -1 "$L/base/$K.log")
case "$P" in p[0-9]*) ;; *) echo "import failed: see $L/base/$K.log"; exit 1;; esac
cp ~/.edit/projects/$P.json "$L/base/$K.base.json"
python3 - "$L/base/bases.json" "$K" "$P" "$NAME" "$STYLE" <<'PY'
import json, os, sys
f, k, p, name, style = sys.argv[1:]
b = json.load(open(f)) if os.path.exists(f) else {}
b[k] = {'id': p, 'name': name, 'style': style}
json.dump(b, open(f, 'w'), indent=1)
PY
echo "$K → $P"
