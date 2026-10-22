#!/bin/bash
# Restarts the dev server on the newest /tmp/run/edit and waits until it answers (max 3 min).
OLD=$(lsof -tiTCP:7700 -sTCP:LISTEN | head -1)
[ -n "$OLD" ] && kill $OLD
for i in $(seq 1 30); do lsof -tiTCP:7700 -sTCP:LISTEN >/dev/null || break; sleep 1; done
nohup /tmp/run/serve.sh >> /tmp/run/serve.log 2>&1 &
for i in $(seq 1 90); do curl -s -m 3 localhost:7700/api/health >/dev/null && { echo "server up after $((i*2))s"; exit 0; }; sleep 2; done
echo "SERVER DID NOT COME BACK"; exit 1
