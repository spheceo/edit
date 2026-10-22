#!/bin/bash
# usage: run_round.sh <round> <video>...  → each video's trial in turn (round.py), then its score (score2.py) and frame sheets.
# Waits (max 3 h) for a video's base to appear in bases.json. Skips a video already saved for this round.
R=$1; shift
S="$(cd "$(dirname "$0")" && pwd)"; L=${LOOP:-$HOME/edit-experiments/loop}
for V in "$@"; do
  for i in $(seq 1 540); do python3 -c "import json,sys; sys.exit(0 if '$V' in json.load(open('$L/base/bases.json')) else 1)" && break; sleep 20; done
  if [ -f "$L/rounds/$R/$V/project.json" ]; then echo "$R $V already done"; continue; fi
  echo "== $R $V start $(date)"
  python3 $S/round.py $V $R > $L/rounds/$R-$V.log 2>&1
  P=$(python3 -c "import json; print(json.load(open('$L/rounds/$R/$V/meta.json'))['project'])")
  python3 $S/score2.py $P $L/rounds/$R/$V/score.json > $L/rounds/$R/$V/score.txt 2>&1
  python3 $S/frames.py $P $L/rounds/$R/$V/frames > $L/rounds/$R/$V/frames.log 2>&1
  echo "== $R $V done $(date) $(grep -o 'saved.*' $L/rounds/$R-$V.log)"
done
echo "== $R all done $(date)"
