# Editor e2e (`make e2e-ui`)

Runs the visual editor (`ui/`, Playwright specs in `ui/e2e/`) against the real Go server with
the SPA embedded at `/studio/`. No MSW mock.

Run from the repo root inside the devshell (or let the script enter it):

    make e2e-ui

What `e2e-ui/run.sh` does:

1. Starts a throwaway Postgres 16 on `:55432` in `$E2E_RUN_DIR` (default `$TMPDIR/bot-engine-e2e-ui`) and recreates `bots_e2e`.
2. `e2e-ui/seed` creates the legacy tables (`srv_ghost_files`, `srv_ghost_index`, `strategy_default`), the engine tables, and one login `e2e@example.com` / `e2e-pass-123`.
3. Builds the SPA (`ui/` -> `internal/web/dist`) and the server binary.
4. Starts `bot-engine serve` on `:3917` with PG-backed bot content and imports `testdata/bots/synthetic-core` as bot `e2e-core` through the admin import API.
5. Runs `pnpm exec playwright test` in `ui/`. Screenshots go to `$E2E_SHOTS` (default `$E2E_RUN_DIR/screenshots`).

Everything is stopped on exit. Env overrides: `E2E_RUN_DIR`, `E2E_SHOTS`, `E2E_PG_PORT`, `E2E_PORT`. Extra args are passed to `playwright test` (for example `--grep "choice"`).

The journey (`ui/e2e/editor.spec.ts`, serial, 14 steps): login good/bad, bot list and flow tree,
unchanged open+save byte-identical, drag a node and rename, Say action with a new text element,
Execute code action, transition, drag-connect and hover-delete an edge, JSON view edit and apply,
emulator reply after the edit (proves the engine reloads the saved flow), code editor edit and
reload, export `.tgz` and import as a new id, media upload in an image form, choice skill
insert/wire/emulator click.

Assertions read the stored bytes straight from `srv_ghost_files` via `psql` (`E2E_DSN`) and the
public studio API.

The write-gated specs (`E2E_EDITOR_WRITE=1`, set by `run.sh`) save flows and create skill files in the throwaway bot. `editor-panel.spec.ts` checks that a new node opens its properties panel for every creation path.

Data parity against legacy editor is a separate runner: `make e2e-parity` (see `docs/editor-parity.md`).

Not in this suite: the one-flow choice generator (unsupported by the engine), the flow mutex (423),
and Redis locks.
