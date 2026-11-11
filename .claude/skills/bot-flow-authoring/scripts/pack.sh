#!/usr/bin/env bash
# Pack a bot folder as a .tgz in the legacy export layout (files at the archive root), without OS junk.
#   pack.sh <bot-dir> <out.tgz>
set -euo pipefail
BOT_DIR="$(cd "${1:?usage: pack.sh <bot-dir> <out.tgz>}" && pwd)"; OUT="${2:?usage: pack.sh <bot-dir> <out.tgz>}"
[[ -f "$BOT_DIR/bot.config.json" ]] || { echo "no bot.config.json in $BOT_DIR" >&2; exit 2; }
COPYFILE_DISABLE=1 tar --exclude '._*' --exclude '.DS_Store' -czf "$OUT" -C "$BOT_DIR" .
echo "$OUT ($(tar -tzf "$OUT" | grep -vc '/$') files)"
