# Migration runbook (legacy engine → bot-engine)

Contents: 1 Rewrites for out-of-scope features · 2 Parity triage · 3 Known intentional differences ·
4 Deploy configuration · 5 Cutover checklist · 6 Rollback · 7 Tenant-wide validation

## 1. Rewrites for out-of-scope features

Make the smallest change that keeps the conversation identical for end users. Record each one in the report.

| Found by inventory/validator | Rewrite |
|---|---|
| `event.nlu.intent.name === 'x'` transitions | Usually dead already (NLU was off, so always false; bot-engine behaves the same). If the owner relies on it: add a custom action that sets `session.keyword` by keyword or regex matching on `event.preview`, then transition on `session.keyword === 'x'`. |
| QnA (`qna/`, `intents/` folders) | Ignored by both engines when the qna module is off. If used: a FAQ flow with a choice skill or a keyword action. |
| Skills `slot`, `callApi`, `email` | Replace the skill node with standard nodes: ask (say) → wait node with a custom action that validates or extracts → transitions. `callApi` → custom action with axios, storing the result in `temp`. |
| `say @builtin_text {"text":…}` inline content | Create a content element with the same formData and use `say #!<id>`. |
| content types `builtin_audio`, `builtin_video`, `builtin_location`, `builtin_action-button`, custom types | The downstream worker does not map them anyway. Replace with `builtin_file` (audio or video URL), `builtin_text` (location as text) or `builtin_card` actions. Confirm with the owner. |
| Mustache sections and partials `{{#x}}…{{/x}}` | Compute the text in an action (`temp.msg = …`) and say `{{temp.msg}}`. |
| hooks other than `before_conversation_end` | Move the logic into the flow: first node of `main.flow.json` for incoming, an action before END for outgoing. |
| `bp.kvs`, `bp.users`, `bp.dialog`, … | `bp.kvs` → `builtin/getGlobalVariable` / `setVariable` (bot type) or session and user state. Others: discuss. Usually only logging or state access that `event.state` already provides. |
| `require('./lib')` / `libraries/` | Inline the helper into the action, or duplicate it in each action. |
| `require('<other npm module>')` | Use an available module (axios, qs, moment, lodash, crypto, form-data) or reimplement the few lines needed. |
| `setTimeout` / `setInterval` | `builtin/wait {"delay": ms}` between instructions. No timers inside actions. |
| `process.env.X` | Pass via `event.payload.metadata` (downstream worker) or a bot-level variable. Never hard-code secrets. |
| `Intl` / `toLocaleString('id-ID')` | Not available (goja). Format manually, e.g. thousands separator with `/\B(?=(\d{3})+(?!\d))/g`. |

After edits: `bot-flow-authoring/scripts/validate.sh`, then `pack.sh`, then repeat the parity check (section 2). Prefer editing the extracted files directly over regenerating them with flowkit. Keep ids, names and positions stable so the owner recognizes the bot.

## 2. Parity triage

Parity means the same messages produce the same results on both engines. Compare, per message: the raw converse response, the typed view the downstream worker reads, `state.session` and `temp`, and the webhook calls received by the stub. Use `make e2e` for the Compose stack (both engines, same bot, client test suite) and `scripts/converse.py` with `BASE` set per engine for ad-hoc sequences.

For each diff:

1. Reproduce it with the smallest message path that shows it.
2. Classify it:
   - **Engine bug.** bot-engine deviates from legacy semantics: dialog, templating, content rendering, builtin action, state persistence, error body. Fix it in `internal/<pkg>` with a unit test that encodes the legacy behavior (cite the legacy behavior in a comment), rebuild, and rerun the full path set.
   - **Nondeterminism.** Timestamps, random ids, time-of-day dependent text (the bot stamps `new Date()`), random text variations. Normalize in the harness with a comment that says why. Never normalize a field the downstream worker reads unless it is also random in the legacy engine.
   - **Stub artifact.** Both sides got the same canned answer, but the bot builds URLs at runtime from data, so an unstubbed host fails on both. Same on both sides means parity holds. Note the reduced coverage.
   - **Harness bug.** Fix the test, not the engine.
3. A cutover is blocked while any diff is unexplained.

Also run the idle-timeout path: the timeout flow should fire once per user, with the same webhooks, the same state and the same next reply, even with two replicas. For bots with heavy traffic, run a short load comparison; p95 latency must not be worse than the legacy engine.

For editor data parity (the flow data the editor shows and saves), run `make e2e-parity` with `BOT_TGZ` set to the export. Without `BOT_TGZ` it uses the synthetic fixture. See `docs/editor-parity.md`.

## 3. Known intentional differences (documented, accepted)

- Concurrent messages from the same user are processed one at a time (per-session lock). The legacy engine could lose updates under bursts; bot-engine does not.
- Actions may use top-level `await` (the legacy engine rejected it). Valid legacy bots are unaffected.
- Legacy development-only error fields (`stack`, `showStackInDev`) are not returned.
- Editor (not runtime): pasting nodes deep-copies their content elements (the legacy editor shared them). Autosave writes immediately.
- `builtin/resetGlobalVariable` deletes the key for all bots of the tenant database. Same as the legacy engine; kept for parity.
- The choice skill keyword match iterates keywords in sorted order (legacy: insertion order). It only differs when two keywords match the same text.

## 4. Deploy configuration (bot-engine instance)

| Env | Value |
|---|---|
| `DATABASE_URL` (or `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD`, `BOT_DB_NAME`, `PG_SSLMODE`) | the tenant's existing bot database (`bots_<tenant>`), with the same credentials the legacy deployment uses |
| `APP_SECRET` | JWT signing secret. Optional when the global config file already has it: if unset, bot-engine reads `appSecret` or `jwtSecret` from that file. Set it to the same value the legacy deployment uses, so existing JWTs and downstream-worker tokens stay valid. Must be identical across replicas. Startup fails when neither is set. |
| `GLOBAL_CONFIG_FILE` | name of the global server config file under `data/global/`. Default `legacy.config.json`. Point it at the file the legacy deployment already has, so `APP_SECRET`, `appSecret`/`jwtSecret` and the dialog timeouts resolve as before. |
| `BOTFS_DIR` | Serve bot files from a directory instead of the database. Use for local runs and validation only, not for a tenant deployment. |
| `REDIS_URL` | Required for more than one replica (per-session lock and a single janitor). Without it, run exactly one replica. |
| `PORT` | `3000` (default) |
| `EXTERNAL_URL` | the tenant's public hostname |
| `USERCODE_TIMEOUT` | action timeout, default `30s` |
| `DIALOG_TIMEOUT_INTERVAL` / `DIALOG_SESSION_TIMEOUT_INTERVAL` / `DIALOG_JANITOR_INTERVAL` | optional overrides. Defaults come from the global config file. A bot's `bot.config.json` `dialog.timeoutInterval` wins for that bot. |
| `LOG_LEVEL` | `info` (default) |

The instance needs the same outbound network access as the legacy deployment, because actions call webhook and handover hosts.
Health: `GET /health`. Editor: `/studio/`. API paths match the legacy engine, so ingress, the downstream worker's endpoint configuration and auth URLs need no change.

## 5. Cutover checklist (per tenant)

Prepare the steps. The user executes or approves each one.

1. Inventory and validator for every bot of the tenant (section 7). Fix, or get sign-off for, every out-of-scope item.
2. Parity: converse comparison for each bot export, including the idle-timeout path (section 2). Zero unexplained diffs.
3. Owner check in a local isolated instance: the editor opens every flow, and an edit made in the editor is used by the emulator.
4. Pick the lowest-traffic tenant first. Announce a short window. Editing flows in the legacy editor must stop during the swap.
5. Swap the image of the legacy deployment to bot-engine with the env above (same service, ingress and hostname). Scale to 1 replica first.
6. Verify: `/health`; login with an existing collaborator; downstream-worker traffic returns 200 (watch its logs for credential or 5xx errors); a real conversation through the channel; the timeout flow fires after the idle interval; the editor at `/studio/` lists the bots.
7. Scale to N replicas only with `REDIS_URL` set. Verify again.
8. Keep the legacy image reference and database untouched for the rollback window.

## 6. Rollback

Swap the image back to the legacy engine (same env and database). bot-engine writes dialog sessions, `srv_ghost_files` (with `srv_ghost_index` revisions) and auth tables in a form the legacy engine can read, so running conversations and editor changes survive. Do not drop legacy tables until every tenant is past its rollback window.

## 7. Tenant-wide validation

Read-only, against the tenant database (use a read-only database user when possible):
```bash
cd <bot-engine repo>
DATABASE_URL='postgres://<ro-user>:<pw>@<host>:5432/bots_<tenant>?sslmode=disable' APP_SECRET=validate-only \
  nix develop -c go run ./cmd/bot-engine validate --all
```
The exit code is non-zero when any bot has issues. For an inventory of every bot in the database, export each bot (legacy admin export, or the `srv_ghost_files` rows under `data/bots/<id>/`) and run `inventory.py` on each one.
