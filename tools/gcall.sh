#!/usr/bin/env bash
# usage: gcall.sh '<json input>'   — calls 4399fffd…/guard over HTTPS with payment key nonce 1
set -e
O=4399fffd59abe3f29284d29936bf83d41e1344e82c971394660217cf6e8046f7
S=$(python3 -c "import json;print(json.load(open('$HOME/.outlayer/mainnet/payment-keys.json'))['mainnet:$O:payment-key:1'])")
T0=$(date +%s%3N)
R=$(curl -s -X POST "https://api.outlayer.ai/call/$O/${PROJECT:-guard}" -H "X-Payment-Key: $S" -H "Content-Type: application/json" -d "{\"input\": $1}")
T1=$(date +%s%3N)
echo "{\"ts\":\"$(date -u +%FT%TZ)\",\"in\":$1,\"wall_ms\":$((T1-T0)),\"resp\":$R}" >> "${UNHUNTABLE_PRIVATE:-$HOME/unhuntable-private}/g0/guard-calls.jsonl"
echo "$R" | python3 -m json.tool 2>/dev/null || echo "$R"
echo "wall_ms=$((T1-T0))"
