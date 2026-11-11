#!/usr/bin/env bash
# Validate a bot folder with bot-engine's own validator (flow.Load + flow.Validate), no database needed.
#   validate.sh <bot-dir>          e.g. /tmp/out/my-bot   (folder containing bot.config.json)
# Env: BOT_ENGINE_DIR (repo root; default: found from this script's location)
set -euo pipefail
BOT_DIR="$(cd "${1:?usage: validate.sh <bot-dir>}" && pwd)"
[[ -f "$BOT_DIR/bot.config.json" ]] || { echo "no bot.config.json in $BOT_DIR" >&2; exit 2; }
ROOT="${BOT_ENGINE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)}"
BOT_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$BOT_DIR/bot.config.json")"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/data/bots" && ln -s "$BOT_DIR" "$TMP/data/bots/$BOT_ID"
cd "$ROOT"
run() { if command -v go >/dev/null 2>&1; then "$@"; else nix develop -c "$@"; fi; }
BOTFS_DIR="$TMP" APP_SECRET=validate run go run ./cmd/bot-engine validate --bot "$BOT_ID"
