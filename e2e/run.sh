#!/usr/bin/env bash
# bot-engine vs legacy end-to-end run (see e2e/README.md).
#
#   1. fresh stack: postgres 16, redis, legacy engine (image from LEGACY_IMAGE), two bot-engine replicas
#   2. legacy bootstraps its own schema; admin user created through legacy's API
#   3. bots_e2e_go gets legacy's schema (pg_dump --schema-only) and the admin login row, so
#      bot-engine runs on the real legacy tables and verifies legacy's password hash
#   4. the e2e-worker bot (legacy export layout, packed as .tgz) is imported into both servers
#   5. optional: a client test suite (E2E_CLIENT_TESTS_DIR, build tag e2e) runs against legacy and both replicas
#   6. stack is removed (docker compose down -v), also on failure
#
# Env: LEGACY_IMAGE (required) legacy engine image. E2E_KEEP=1 keeps the stack up after the run.
#      E2E_CLIENT_TESTS_DIR=<path> runs that module's ./e2e/... tests. E2E_TEST_RUN=<regex> selects tests.
set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$E2E_DIR/.." && pwd)"
COMPOSE=(docker compose -f "$E2E_DIR/docker-compose.yml" -p bot-engine-e2e)

LEGACY_PORT="${E2E_LEGACY_PORT:-53100}"
GO_A_PORT="${E2E_GO_A_PORT:-53101}"
GO_B_PORT="${E2E_GO_B_PORT:-53102}"
PG_PORT="${E2E_PG_PORT:-55433}"
MOCK_PORT="${E2E_MOCK_PORT:-18080}"
EMAIL="e2e@example.com"
PASSWORD="e2e-pass-123"
BOT_ID="e2e-worker"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/bot-engine-e2e.XXXXXX")"

if [[ ! -f "$E2E_DIR/legacy.env" ]]; then
  echo "[e2e] create e2e/legacy.env from e2e/legacy.env.example (legacy engine settings) first" >&2
  exit 2
fi
: "${LEGACY_IMAGE:?set LEGACY_IMAGE to the legacy engine image}"
export LEGACY_IMAGE

if ! command -v go >/dev/null 2>&1 && [[ -z "${E2E_IN_NIX:-}" ]]; then
  # Go toolchain comes from the flake; run the whole script inside its devshell.
  exec nix develop "$ROOT" -c env E2E_IN_NIX=1 bash "$0" "$@"
fi

cleanup() {
  local rc=$?
  if [[ -z "${E2E_KEEP:-}" ]]; then
    "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
  else
    echo "[e2e] E2E_KEEP set: stack left running (docker compose -p bot-engine-e2e down -v to stop)"
  fi
  rm -rf "$WORK"
  exit $rc
}
trap cleanup EXIT

wait_http() { # url, label
  for _ in $(seq 1 180); do
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' "$1" || true)"
    if [[ "$code" != "000" && "$code" != "503" ]]; then return 0; fi
    sleep 1
  done
  echo "[e2e] timeout waiting for $2 ($1)"; return 1
}

login() { # base -> prints jwt
  curl -fsS -X POST "$1/api/v1/auth/login/basic/default" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["payload"]["jwt"])'
}

echo "[e2e] fresh stack"
"${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
"${COMPOSE[@]}" up -d --wait postgres redis

echo "[e2e] legacy (official image) bootstraps its schema"
"${COMPOSE[@]}" up -d legacy-engine
wait_http "http://127.0.0.1:$LEGACY_PORT/api/v1/auth/login/basic/default" "legacy"
curl -s -o /dev/null -X POST "http://127.0.0.1:$LEGACY_PORT/api/v1/auth/register/basic/default" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"
LEGACY_JWT="$(login "http://127.0.0.1:$LEGACY_PORT")"

echo "[e2e] pack and import bot $BOT_ID into legacy"
tar -czf "$WORK/$BOT_ID.tgz" -C "$ROOT/testdata/bots" "$BOT_ID"
curl -fsS -X POST "http://127.0.0.1:$LEGACY_PORT/api/v1/admin/workspace/bots/$BOT_ID/import" \
  -H "Authorization: Bearer $LEGACY_JWT" -H 'Content-Type: application/tar+gzip' \
  --data-binary "@$WORK/$BOT_ID.tgz" >/dev/null

echo "[e2e] copy legacy schema to bots_e2e_go, plus the admin login row"
"${COMPOSE[@]}" exec -T postgres pg_dump -U e2e --schema-only bots_e2e_legacy > "$WORK/schema.sql"
"${COMPOSE[@]}" exec -T postgres psql -U e2e -q -v ON_ERROR_STOP=1 bots_e2e_go < "$WORK/schema.sql" >/dev/null
"${COMPOSE[@]}" exec -T postgres pg_dump -U e2e --data-only -t strategy_default bots_e2e_legacy > "$WORK/users.sql"
"${COMPOSE[@]}" exec -T postgres psql -U e2e -q -v ON_ERROR_STOP=1 bots_e2e_go < "$WORK/users.sql" >/dev/null

echo "[e2e] build bot-engine image and start two replicas"
"${COMPOSE[@]}" build bot-engine-a bot-engine-b >"$WORK/build.log" 2>&1 || { cat "$WORK/build.log"; exit 1; }
"${COMPOSE[@]}" up -d --no-deps bot-engine-a bot-engine-b
wait_http "http://127.0.0.1:$GO_A_PORT/health" "bot-engine A"
wait_http "http://127.0.0.1:$GO_B_PORT/health" "bot-engine B"

echo "[e2e] import bot into bot-engine (replica A; B reads the same tables)"
GO_JWT="$(login "http://127.0.0.1:$GO_A_PORT")"
curl -fsS -X POST "http://127.0.0.1:$GO_A_PORT/api/v1/admin/workspace/bots/$BOT_ID/import" \
  -H "Authorization: Bearer $GO_JWT" -H 'Content-Type: application/tar+gzip' \
  --data-binary "@$WORK/$BOT_ID.tgz" >/dev/null

echo "[e2e] optional client test suite"
if [[ -n "${E2E_CLIENT_TESTS_DIR:-}" ]]; then
  export E2E_LEGACY_URL="http://127.0.0.1:$LEGACY_PORT"
  export E2E_GO_A_URL="http://127.0.0.1:$GO_A_PORT"
  export E2E_GO_B_URL="http://127.0.0.1:$GO_B_PORT"
  export E2E_GO_DB_DSN="host=127.0.0.1 port=$PG_PORT user=e2e password=e2e dbname=bots_e2e_go sslmode=disable"
  export E2E_MOCK_ADDR="0.0.0.0:$MOCK_PORT"
  export E2E_MOCK_URL="http://host.docker.internal:$MOCK_PORT"
  export E2E_BOT_ID="$BOT_ID" E2E_EMAIL="$EMAIL" E2E_PASSWORD="$PASSWORD"
  cd "$E2E_CLIENT_TESTS_DIR"
  go test -tags e2e -count=1 -timeout 60m -v ${E2E_TEST_RUN:+-run "$E2E_TEST_RUN"} ./e2e/...
else
  echo "[e2e] E2E_CLIENT_TESTS_DIR not set: client test suite skipped"
fi
