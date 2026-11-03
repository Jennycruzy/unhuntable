#!/usr/bin/env bash
# usage: ol.sh <keyfile> METHOD path [json]
set -e
K=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['api_key'])" "${UNHUNTABLE_PRIVATE:-$HOME/unhuntable-private}/keys/$1")
if [ "$2" = GET ]; then curl -s -H "Authorization: Bearer $K" "https://api.outlayer.ai$3"
else curl -s -X "$2" -H "Authorization: Bearer $K" -H "Content-Type: application/json" -H "X-Idempotency-Key: $(python3 -c 'import uuid;print(uuid.uuid4())')" -d "$4" "https://api.outlayer.ai$3"; fi
echo
