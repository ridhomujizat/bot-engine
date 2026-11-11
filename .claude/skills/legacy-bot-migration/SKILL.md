---
name: legacy-bot-migration
description: Migrate chatbots from a legacy engine or legacy server to bot-engine — inventory a legacy export (.tgz) or a legacy database export of bot files, find features outside bot-engine's scope (NLU, QnA, other skills, say @type, unsupported bp.* or require), rewrite them, validate, prove parity with the legacy engine by sending the same messages to both, try the bot in a local editor, and plan the cutover and rollback. Use this whenever the user mentions migrating, porting, moving or cutting over a bot or tenant from the legacy engine or legacy server, sends a legacy bot export archive, asks "can bot-engine run this bot", wants a parity or compatibility check against the legacy engine, or plans replacing the legacy deployment — even if they only say "coba test file prod ini" or "pindahin bot tenant X".
---

# Legacy bot migration (legacy engine → bot-engine)

bot-engine reads the legacy bot format unchanged (same `srv_ghost_files` layout, `dialog_sessions`, login hashes, converse API), so most bots migrate with **no edits**. The work is proving that, fixing the few out-of-scope features, and swapping the deployment safely. The success criterion: for the same messages, the legacy engine and bot-engine return identical `responses`, `state.context.currentNode` and `state.session`.

The runbook with rewrite tables, parity triage, deploy env and cutover steps is `references/runbook.md`. Bot authoring details (formats, builtins, flowkit) are in the sibling skill `bot-flow-authoring`; reuse its scripts rather than writing new ones.

## Safety first (read before touching a production export)

- **Exports and databases contain secrets and production endpoints** (webhook and handover URLs, bot tokens, API credentials inside action code). Keep archives where the user put them or in a temp dir; never copy them or their files into a repo, and never paste tokens into chat or reports. Say "a token literal in `actions/handover.js`", not the token.
- **Never run a conversation against a production bot with internet access.** Actions call real webhooks. Test only against an isolated instance whose outbound hosts are stubbed or blocked, and verify the block before the first message. If isolation cannot be verified, do static checks only.
- **Production databases are read-only for you.** Inventory with SELECTs. Changing data, deploying, or swapping instances is the user's call: prepare the plan and commands, and ask before running anything that affects a live tenant.

## Workflow

1. **Get the bot.** Prefer the user's `.tgz` export (legacy admin → Export, or `scripts/export-legacy.sh`). For a whole tenant, export each bot's files from the legacy database (read-only) into a folder per bot under `data/bots/<id>/`.
2. **Inventory.** `scripts/inventory.py <bot.tgz|bot-dir>` prints a markdown report: flows, nodes, skills, content types, builtin and custom actions, `bp.*` and `require` usage, external hosts (and ports) the actions call, start-node trigger texts, timeout config, secrets-looking literals (counted, never printed), and an **out-of-scope** list with file references. This tells you whether the bot migrates as-is. Run it with `python3 -I` when the archive comes from an untrusted source.
3. **Validate with the engine itself.** `../bot-flow-authoring/scripts/validate.sh <extracted-bot-dir>` validates one bot without a database. For a whole tenant database, run `DATABASE_URL=<read-only DSN> APP_SECRET=validate-only go run ./cmd/bot-engine validate --all`. Errors mean the bot would not load in bot-engine. Warnings are legacy-tolerated mistakes (dangling targets, missing elements). Report them to the bot owner; they do not block migration.
4. **Fix out-of-scope features** (`references/runbook.md`, section 1). Typical cases: NLU intent transitions become a keyword-matching action or a choice skill; QnA becomes flows; other skills (slot, callApi, email) become a custom action plus nodes; `say @type` becomes a content element; `setTimeout` becomes `builtin/wait`; `process.env` becomes metadata or config; relative `require` is inlined. Edit the extracted bot folder, re-validate, and re-pack with `../bot-flow-authoring/scripts/pack.sh`. Keep a list of every change for the owner.
5. **Prove parity.** Run bot-engine and the legacy engine side by side on the same bot (`make e2e` runs a Docker Compose stack with both engines, the synthetic `e2e-worker` bot and a client test suite; see `e2e/README.md`). Then send the same message sequence to both with `../bot-flow-authoring/scripts/converse.py` (set `BASE` per engine) and diff the output. Include invalid input, back-to-menu, END and the idle-timeout path (`DIALOG_TIMEOUT_INTERVAL` set low). Report the paths explored, the steps compared and the diffs grouped by root cause. A diff is either a bot-engine bug (fix it in the engine with a test that encodes the legacy behavior, then rerun) or real nondeterminism (timestamps, random ids; normalize and explain). Unexplained diffs block cutover.
6. **Let the owner try it.** Run an isolated local instance with the bot imported (`../bot-flow-authoring/scripts/import.sh`), and open the editor at `http://localhost:3000/studio/`. Production bots often start only on trigger texts from the channel (for example `start`) and read downstream-worker metadata. The emulator's metadata fields cover that.
7. **Plan the cutover** (`references/runbook.md`, sections 4 to 6): per tenant, smallest traffic first; same hostname, ingress and database; swap the legacy deployment image for bot-engine with the env vars listed there; rollback means putting the legacy image back, because bot-engine keeps the data readable by the legacy engine. Write the plan as concrete steps, commands and checks. The user executes or explicitly approves each step.

## Report template

```
# Migration report: <bot or tenant>
## Verdict           ready | ready after N rewrites | blocked (why)
## Inventory         flows/nodes/skills/content/actions, external hosts, triggers, timeout
## Out of scope      feature → file → proposed rewrite (or "none")
## Validation        engine validator output (errors/warnings)
## Parity            paths explored, steps compared, diffs by root cause and resolution
## Changes made      every edit to the bot, with reason
## Cutover plan      steps, env, checks, rollback
## Risks / open items
```

## Bundled resources

- `scripts/inventory.py`: static inventory and scope check of an export or folder.
- `scripts/export-legacy.sh`: download a bot export from a legacy server through its admin API. Needs `EMAIL` and `PASSWORD` in the environment.
- `references/runbook.md`: rewrites for out-of-scope features, parity triage, deploy configuration (`GLOBAL_CONFIG_FILE`, `APP_SECRET`), cutover and rollback checklists, known intentional differences.
