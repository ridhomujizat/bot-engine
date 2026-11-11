#!/usr/bin/env bash
# Download a bot export (.tgz) from a legacy server through its admin API.
#   export-legacy.sh <base-url> <bot-id> <out.tgz>
# Env: EMAIL, PASSWORD (a collaborator login on that server). The archive contains the bot's action code
# (often with credentials and production URLs): keep it out of repositories.
set -euo pipefail
BASE="${1:?usage: export-legacy.sh <base-url> <bot-id> <out.tgz>}"; BOT="${2:?bot id}"; OUT="${3:?out.tgz}"
: "${EMAIL:?set EMAIL}" "${PASSWORD:?set PASSWORD}"
JWT="$(curl -fsS -X POST "$BASE/api/v1/auth/login/basic/default" -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json,sys; print(json.dumps({"email":sys.argv[1],"password":sys.argv[2]}))' "$EMAIL" "$PASSWORD")" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["payload"]["jwt"])')"
curl -fsS -H "Authorization: Bearer $JWT" "$BASE/api/v1/admin/workspace/bots/$BOT/export" -o "$OUT"
echo "$OUT ($(tar -tzf "$OUT" | wc -l | tr -d ' ') entries)"
