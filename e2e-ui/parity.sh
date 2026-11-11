#!/usr/bin/env bash
# Data-parity run: the same edit sequences through legacy editor and bot-engine's editor,
# then a structural diff of each server's saved flows (docs/editor-parity.md).
#
#   make e2e-parity                                  # synthetic archive from testdata/bots/synthetic-parity
#   BOT_TGZ=/path/to/bot_export.tgz make e2e-parity  # or any other bot archive, read in place
#
# Needs both servers running (defaults: legacy on :53901, ours on :53950). Each scenario re-imports the
# archive into both servers first.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v pnpm >/dev/null 2>&1; then exec nix develop "$ROOT" -c bash "$0" "$@"; fi
if [[ -z "${BOT_TGZ:-}" ]]; then
  # No archive given: pack the synthetic fixture bot from testdata (removed on exit).
  PACK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/bot-engine-parity.XXXX")"
  trap 'rm -rf "$PACK_DIR"' EXIT
  cp -R "$ROOT/testdata/bots/synthetic-parity" "$PACK_DIR/synthetic-parity"
  tar -czf "$PACK_DIR/synthetic-parity.tgz" -C "$PACK_DIR" synthetic-parity
  BOT_TGZ="$PACK_DIR/synthetic-parity.tgz"
fi
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
