# Editor parity

`make e2e-parity` runs the same editor edit sequences through the legacy editor and through the
bot-engine editor, then compares what each server saved.

## What it checks

- The flow JSON that each server serves, compared structurally after the same edits.
- Node positions, links, content elements and skill flows, as the legacy editor writes them.
- Behaviour per scenario in `ui/e2e/parity-scenarios.spec.ts` (drag, rename, connect, delete,
  paste, copy, edit a choice skill, and similar). The legacy side is driven by
  `ui/e2e/parity-legacy.ts`, the bot-engine side by `ui/e2e/parity-ours.ts`.

## How to run

1. Start the legacy engine and bot-engine.
2. Run:

```sh
LEGACY_URL=http://localhost:53901 LEGACY_EMAIL=... LEGACY_PASSWORD=... \
OURS_URL=http://localhost:53950 OURS_EMAIL=... OURS_PASSWORD=... \
make e2e-parity
```

Without `BOT_TGZ`, the runner packs `testdata/bots/synthetic-parity` and imports it into both servers.
To run against another bot archive, set `BOT_TGZ=/path/to/bot.tgz` (it is read in place and is not
copied into the repository).

`PARITY_BOT_ID` selects the bot id used on both sides (default `example-bot`).
