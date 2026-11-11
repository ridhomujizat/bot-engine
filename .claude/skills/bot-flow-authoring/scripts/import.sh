#!/usr/bin/env bash
# Import (overwrite) a bot archive into a running bot-engine through the admin API.
#   import.sh <bot.tgz> [bot-id]       bot id defaults to bot.config.json "id" inside the archive
# Env: BASE (default http://localhost:3000), EMAIL and PASSWORD (required)
set -euo pipefail
TGZ="${1:?usage: import.sh <bot.tgz> [bot-id]}"
BASE="${BASE:-http://localhost:3000}"; : "${EMAIL:?set EMAIL}" "${PASSWORD:?set PASSWORD}"
RESP="$(mktemp)"; trap 'rm -f "$RESP"' EXIT
ID="${2:-$(python3 - "$TGZ" <<'PY'
import json, sys, tarfile
t = tarfile.open(sys.argv[1])
m = next(m for m in t.getmembers() if m.name.rstrip('/').split('/')[-1] == 'bot.config.json' and not m.name.split('/')[-1].startswith('._'))
print(json.load(t.extractfile(m))['id'])
PY
)}"
JWT="$(curl -fsS -X POST "$BASE/api/v1/auth/login/basic/default" -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json,sys; print(json.dumps({"email":sys.argv[1],"password":sys.argv[2]}))' "$EMAIL" "$PASSWORD")" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["payload"]["jwt"])')"
code="$(curl -sS -o "$RESP" -w '%{http_code}' -X POST "$BASE/api/v1/admin/workspace/bots/$ID/import?overwrite=true" \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/tar+gzip' --data-binary "@$TGZ")"
if [[ "$code" != 200 ]]; then echo "import failed ($code): $(cat "$RESP")" >&2; exit 1; fi
echo "imported $ID -> $BASE/studio/bots/$ID/flows"
