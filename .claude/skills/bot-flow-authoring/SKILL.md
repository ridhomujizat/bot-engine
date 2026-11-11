---
name: bot-flow-authoring
description: Build or change conversational bot workflows for bot-engine — flows (*.flow.json + *.ui.json), content elements (text, single-choice, carousel, card, image, file), choice skills, custom JavaScript actions and hooks — then validate, pack as .tgz, import and test them through the converse API. Use this whenever the user wants to create a new bot or chatbot flow, add/rename/rewire nodes, menus, subflows, replies, buttons, a "choice" question, handover/timeout/error flows, write a bot action (axios webhook, setVariable, session/temp variables), generate a demo bot, or bulk-edit flows as files instead of clicking in the editor — even if they just say "bikin flow bot", "tambah menu", or "buat bot demo".
---

# Bot flow authoring (bot-engine)

bot-engine runs bots stored in the legacy flow format: a bot is a folder of JSON + JS files. You author that folder (usually with the bundled `scripts/flowkit.py`), validate it with the engine's own validator, pack it as `.tgz`, import it through the admin API, and prove it works by talking to it.

Read `references/format.md` before writing files by hand — the engine is strict about shapes (e.g. `onReceive: null` vs `[]` changes behavior). For most work you should not hand-write JSON at all: write a short Python build script that uses `flowkit`.

## Workflow

1. **Clarify the conversation** in a few lines: entry point, menu options, what each branch says/does, where it ends (`END`, back to menu, handover), which variables are stored (`temp.*` lives until END/timeout, `session.*` until reset or session expiry, `user.*` across conversations). Ask only if something essential is missing; otherwise pick sensible defaults and say so.
2. **Build the bot folder** with a script that imports flowkit (see `examples/demo_cs.py`, a complete 9-flow bot):
   ```python
   import sys; sys.path.insert(0, "<skill>/scripts")
   from flowkit import Bot, pick
   bot = Bot("my-bot", name="My Bot")
   ...
   bot.write("out")                  # writes out/my-bot/...
   ```
   Prefer one flow per topic and subflows over giant flows; it keeps the editor canvas readable. Go back to a menu with an explicit target like `main.flow.json#menu` (enters that node fresh, so the menu is shown again) or `##` (returns to the calling node and re-runs it); `#` only re-evaluates the caller node's transitions without re-showing anything.
3. **Validate** with the real engine validator: `scripts/validate.sh out/my-bot`. Errors block import; warnings (dangling targets, missing elements/actions) are allowed by the legacy engine but are almost always mistakes — fix them unless intentional.
4. **Pack**: `scripts/pack.sh out/my-bot out/my-bot.tgz` (legacy export layout, OS junk excluded).
5. **Import + test** against a running bot-engine (default `http://localhost:3000`; editor at `/studio/`):
   ```bash
   EMAIL=<login> PASSWORD=<pw> scripts/import.sh out/my-bot.tgz      # BASE env overrides http://localhost:3000
   EMAIL=<login> PASSWORD=<pw> scripts/converse.py my-bot halo "Cek Tagihan" 0812345678 --meta cust_name=Budi
   ```
   Walk every branch (valid + invalid input, back-to-menu, END) and check replies and `currentFlow/currentNode`. A flow that is never exercised is not done.
6. **Report** what was built (flows, entry triggers, variables, actions), how it was tested (the converse transcript), and how to open it in the editor (`/studio/bots/<id>/flows`).

## Things that commonly go wrong

- **Waiting for input**: a node waits for the user only if `onReceive` is an array (`[]` or with actions). `null` means "don't wait" — put choice menus on a node with `onReceive: []` and branch in its transitions. flowkit's `wait=True` does this.
- **Matching button clicks**: a choice click sends the button title as text, so `event.preview === 'Title'` matches. Keep `value == title` unless you need a different payload; then also match `event.payload.payload`.
- **First matching transition wins**, top to bottom; always end with a `true` fallback.
- **Mustache only interpolates** (`{{session.x}}`, `{{event.payload.metadata.cust_name}}`); no sections/partials — the validator rejects them.
- **Choice skill vs plain single-choice**: the choice *skill* (retries, keyword matching, `temp['skill-choice-ret-…']`) is what production bots use for menus with retry/"invalid answer" handling; plain single-choice + `event.preview` conditions is simpler and easier to read. Use `bot.choice_skill(...)` when retries/keywords matter.
- **Actions are untrusted-network code**: they run in goja with `axios`, `form-data`, `qs`, `moment`, `lodash`, `crypto`/`Buffer`, and `bp.logger`, `bp.cms.renderElement`, `bp.events.replyToEvent`, `bp.database.insertAndRetrieve` only. No `setTimeout`, no `process.env`, no relative `require`. Never hard-code tokens/passwords in action source — they end up in the database and in every export; take them from `event.payload.metadata` or ask the user where secrets should live.
- **Production endpoints**: if an action calls real webhooks (handover/end, payment, chat platforms…), test against an isolated instance whose outbound hosts are stubbed or blocked (check the hosts in the code first) — never point a test conversation at production.

## Bundled resources

- `scripts/flowkit.py` — Python builder: `Bot`, `Flow.node`, content helpers (`text`, `choice`, `image`, `carousel`, `card`, `file`), `set_var`, `choice_skill`, `action`, `hook`, automatic left→right layout, `write()`. Run `python3 flowkit.py --help-api` for the API summary.
- `scripts/validate.sh`, `scripts/pack.sh`, `scripts/import.sh`, `scripts/converse.py` — validate / pack / import / talk. `import.sh` and `converse.py` require `EMAIL` and `PASSWORD` (no defaults); `BASE` defaults to `http://localhost:3000`.
- `references/format.md` — file formats, transitions, builtin actions and their args, content-type fields, choice-skill shape, action/hook sandbox, supported scope.
- `examples/demo_cs.py` — complete example bot (menu, carousel, input validation action, FAQ, handover, feedback, error/timeout flows).
