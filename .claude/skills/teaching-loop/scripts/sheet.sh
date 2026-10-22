#!/bin/bash
# usage: sheet.sh <project id> <out dir> <frame>...  → renders each frame from the project (no export) and tiles them 4x4 into <out>/sheet_NN.jpg in the order given
P=$1; O=$2; shift 2; mkdir -p "$O"; rm -f "$O"/f_*.jpg "$O"/sheet_*.jpg; i=0
for f in "$@"; do
  i=$((i+1)); n=$(printf %03d $i)
  curl -s -m 120 -o "$O/raw.png" "localhost:7700/api/projects/$P/frame/$f.png" && ffmpeg -nostdin -loglevel error -y -i "$O/raw.png" -vf scale=640:-1 -q:v 4 "$O/f_$n.jpg"
done
rm -f "$O/raw.png"
ffmpeg -nostdin -loglevel error -y -pattern_type glob -i "$O/f_*.jpg" -vf tile=4x4 -q:v 4 "$O/sheet_%02d.jpg"
ls "$O"/sheet_*.jpg
