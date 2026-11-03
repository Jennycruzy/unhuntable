#!/usr/bin/env bash
# usage: hl.sh <shard: A|B> '<input json>'
set -e
D=${UNHUNTABLE_PRIVATE:-$HOME/unhuntable-private}/keys
W=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['wallet_id'])" "$D/outlayer-mainnet-shard$1.json")
P=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['payment_key'])" "$D/trial-mainnet-shard$1.json")
curl -s -X POST https://api.outlayer.ai/call/connectors.outlayer.near/hyperliquid -H "X-Payment-Key: $P" -H "X-Wallet-Id: $W" -H 'Content-Type: application/json' -d "{\"input\": $2}"
echo
