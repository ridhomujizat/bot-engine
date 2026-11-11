#!/usr/bin/env bash
# End-to-end run of the bot-engine visual editor against the real Go backend.
#
#   1. starts a throwaway Postgres 16 (initdb in $E2E_RUN_DIR)
#   2. seeds legacy tables + one login (e2e/e2e-pass-123) via e2e-ui/seed
#   3. builds the editor SPA (ui/ -> internal/web/dist) and the server binary (embeds the SPA)
#   4. starts bot-engine with PG-backed bot content and imports the synthetic fixture bot
#   5. runs the Playwright specs in ui/e2e against http://localhost:$E2E_PORT/studio/
#
# Everything runs inside `nix develop`. Stops the server and Postgres on exit.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v go >/dev/null 2>&1 || ! command -v initdb >/dev/null 2>&1; then
  exec nix develop "$ROOT" -c bash "$0" "$@"
fi

RUN_DIR="${E2E_RUN_DIR:-${TMPDIR:-/tmp}/bot-engine-e2e-ui}"
PG_PORT="${E2E_PG_PORT:-55432}"
PORT="${E2E_PORT:-3917}"
DB_NAME="bots_e2e"
EMAIL="e2e@example.com"
PASSWORD="e2e-pass-123"
BOT_ID="e2e-core"
DSN="postgres://postgres@localhost:${PG_PORT}/${DB_NAME}?sslmode=disable"
BASE="http://localhost:${PORT}"

mkdir -p "$RUN_DIR"
SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$RUN_DIR/server.pid"
  if [[ -f "$RUN_DIR/pgdata/postmaster.pid" ]]; then
    pg_ctl -D "$RUN_DIR/pgdata" -m fast stop >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# A previous run may have left its server or Postgres behind: stop them first.
if [[ -f "$RUN_DIR/server.pid" ]]; then kill "$(cat "$RUN_DIR/server.pid")" 2>/dev/null || true; rm -f "$RUN_DIR/server.pid"; fi
if [[ -f "$RUN_DIR/pgdata/postmaster.pid" ]]; then pg_ctl -D "$RUN_DIR/pgdata" -m fast stop >/dev/null 2>&1 || true; fi

echo "[e2e] postgres on :$PG_PORT (data $RUN_DIR/pgdata)"
if [[ ! -d "$RUN_DIR/pgdata" ]]; then
  initdb -D "$RUN_DIR/pgdata" -U postgres --auth=trust -E UTF8 >"$RUN_DIR/initdb.log" 2>&1
fi
pg_ctl -D "$RUN_DIR/pgdata" -o "-p $PG_PORT -c unix_socket_directories=" -l "$RUN_DIR/pg.log" -w start >/dev/null
psql "postgres://postgres@localhost:${PG_PORT}/postgres?sslmode=disable" -q -c "DROP DATABASE IF EXISTS ${DB_NAME}" -c "CREATE DATABASE ${DB_NAME}"

echo "[e2e] seed tenant schema and login"
(cd "$ROOT" && go run ./e2e-ui/seed -dsn "$DSN" -email "$EMAIL" -password "$PASSWORD")

echo "[e2e] build editor SPA"
(cd "$ROOT/ui" && pnpm install --frozen-lockfile >"$RUN_DIR/pnpm-install.log" 2>&1 && pnpm build >"$RUN_DIR/ui-build.log" 2>&1)

echo "[e2e] build server"
(cd "$ROOT" && CGO_ENABLED=0 go build -trimpath -o "$RUN_DIR/bot-engine" ./cmd/bot-engine)

echo "[e2e] start server on $BASE"
(
  cd "$RUN_DIR"
  DATABASE_URL="$DSN" APP_SECRET="e2e-app-secret" PORT="$PORT" EXTERNAL_URL="$BASE" LOG_LEVEL=warn \
    exec "$RUN_DIR/bot-engine" serve
) >"$RUN_DIR/server.log" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" >"$RUN_DIR/server.pid"
for _ in $(seq 1 100); do
  if curl -fsS -o /dev/null "$BASE/studio/" 2>/dev/null; then break; fi
  sleep 0.2
done
curl -fsS -o /dev/null "$BASE/studio/"

echo "[e2e] import fixture bot $BOT_ID"
TOKEN="$(curl -fsS -X POST "$BASE/api/v1/auth/login/basic/default" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | sed -n 's/.*"jwt":"\([^"]*\)".*/\1/p')"
[[ -n "$TOKEN" ]] || { echo "[e2e] login failed"; exit 1; }
FIXTURE_TMP="$(mktemp -d "$RUN_DIR/fixture.XXXX")"
cp -R "$ROOT/testdata/bots/synthetic-core" "$FIXTURE_TMP/synthetic-core"
tar -czf "$RUN_DIR/fixture.tgz" -C "$FIXTURE_TMP" synthetic-core
rm -rf "$FIXTURE_TMP"
curl -fsS -X POST "$BASE/api/v1/admin/workspace/bots/$BOT_ID/import?overwrite=true" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/tar+gzip' \
  --data-binary "@$RUN_DIR/fixture.tgz" >/dev/null


echo "[e2e] playwright"
export E2E_BASE="$BASE" E2E_EMAIL="$EMAIL" E2E_PASSWORD="$PASSWORD" E2E_BOT_ID="$BOT_ID"
# The bot is throwaway (the database is recreated above), so the write-gated specs run too.
export E2E_EDITOR_WRITE=1
export E2E_DSN="$DSN" E2E_SHOTS="${E2E_SHOTS:-$RUN_DIR/screenshots}"
cd "$ROOT/ui"
pnpm exec playwright test "$@"
