#!/bin/bash
# usage: mcp.sh <tool> '<json args>'
curl -s -m 600 localhost:7700/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}"
