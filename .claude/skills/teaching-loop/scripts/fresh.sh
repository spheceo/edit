#!/bin/bash
# usage: fresh.sh <name> <style> <fps> <doc url>  → new project from its Doc, waits for the import; prints the id last
NAME=$1; STYLE=$2; FPS=$3; URL=$4
P=$(curl -s -m 60 -X POST localhost:7700/api/projects -H 'Content-Type: application/json' -d "$(python3 -c 'import json,sys; print(json.dumps({"name":sys.argv[1],"style":sys.argv[2],"width":1920,"height":1080,"fps":int(sys.argv[3])}))' "$NAME" "$STYLE" "$FPS")" | python3 -c "import json,sys; print(json.load(sys.stdin)['project']['id'])")
echo "project $P"
curl -s -m 300 -X POST localhost:7700/api/projects/$P/script -H 'Content-Type: application/json' -d "{\"url\":\"$URL\"}" | head -c 300; echo
T0=$SECONDS
while [ $((SECONDS-T0)) -lt 5400 ]; do
  S=$(curl -s -m 20 localhost:7700/api/projects/$P/script/job | python3 -c "
import json,sys
j=json.load(sys.stdin); j=j.get('job',j)
if j is None: print('NONE'); sys.exit()
print(j.get('state'), j.get('step',''), (j.get('error') or '')[:200])" 2>/dev/null)
  case "$S" in done*|failed*|NONE*|error*) echo "$S after $((SECONDS-T0))s"; break;; esac
  sleep 20
done
echo $P
