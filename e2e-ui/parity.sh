#!/usr/bin/env bash
# Data-parity run: the same edit sequences through legacy editor and bot-engine's editor,
# then a structural diff of each server's saved flows (docs/editor-parity.md).
#
#   BOT_TGZ=/path/to/bot_export.tgz make e2e-parity
#
# Needs both servers running (defaults: legacy on :53901, ours on :53950) and the bot archive, which is
# read in place and never copied. Each scenario re-imports the archive into both servers first.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v pnpm >/dev/null 2>&1; then exec nix develop "$ROOT" -c bash "$0" "$@"; fi
: "${BOT_TGZ:?set BOT_TGZ=/path/to/bot archive (.tgz)}"
[[ -f "$BOT_TGZ" ]] || { echo "[parity] BOT_TGZ not found" >&2; exit 2; }
export LEGACY_URL="${LEGACY_URL:-http://localhost:53901}"
export OURS_URL="${OURS_URL:-http://localhost:53950}"
export LEGACY_EMAIL="${LEGACY_EMAIL:-view@example.com}"
export LEGACY_PASSWORD="${LEGACY_PASSWORD:-View-pass-123}"
export OURS_EMAIL="${OURS_EMAIL:-play@example.com}"
export OURS_PASSWORD="${OURS_PASSWORD:-play-pass-123}"
export BOT_TGZ
export E2E_PARITY=1
cd "$ROOT/ui"
pnpm exec playwright test e2e/parity-scenarios.spec.ts "$@"
