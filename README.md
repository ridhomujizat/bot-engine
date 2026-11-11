# bot-engine

bot-engine is a Go server that runs conversational bots (flow engine) and serves a browser-based
visual flow editor. It is wire-compatible with a legacy chatbot platform: bot content, flow files,
database rows, JWT tokens and password hashes written by the legacy engine are read and written
unchanged, so bots can move between the two.

## Features

- Flow engine: flows, sub-flows, skills (choice skill), transitions, timeouts, error flows and a
  session janitor, ported from the legacy dialog engine.
- Content elements (text, image, file, card, carousel, single-choice, ...) rendered with templates.
- User code actions and hooks in JavaScript, run in an embedded sandbox (goja) with `axios`,
  `form-data`, `qs`, `moment`, `lodash`, `crypto` and `Buffer` available through `require`.
- HTTP API for converse (`/api/v1/bots/:botId/converse/...`), login with basic strategies, and
  the editor API under `/api/v1/studio/:botId`.
- Visual flow editor (React, Vite, React Flow, Monaco) embedded in the binary at `/studio/`.
- Storage: PostgreSQL (legacy-compatible tables) or a directory on disk for development.
- Optional Redis lock for multi-replica deployments.

## Quick start

Go, Node 22 and pnpm come from the Nix flake:

```sh
nix develop            # enter the dev shell (go, node 22, pnpm, redis, postgres client)
make ui                # build the editor SPA into internal/web/dist
make build             # build bin/bot-engine (embeds the editor build)
BOTFS_DIR=/path/to/store ./bin/bot-engine serve
```

`BOTFS_DIR` points at a directory laid out like the content store (`data/bots/<id>/...` and
`data/global/...`); copy `testdata/bots/synthetic-core` into `data/bots/` to try it. Then open
`http://localhost:3000/studio/`. Without `BOTFS_DIR` the server needs `DATABASE_URL` and a bot
content store in that database.

Other targets: `make test`, `make vet`, `make validate` (validate every bot in the configured
store), `make docker` (image `bot-engine:dev`).

## Configuration

Settings come from environment variables, from the global bot configuration file
(`data/global/$GLOBAL_CONFIG_FILE` in the content store, default `legacy.config.json`; set it to the file name your existing data uses), and from defaults, in that order of
precedence (environment wins).

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `LOG_LEVEL` | `info` | log level |
| `EXTERNAL_URL` | | public base URL |
| `DATABASE_URL` | | PostgreSQL DSN (or `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD`, `PG_SSLMODE`) |
| `BOT_DB_NAME` | | tenant database name holding the legacy tables |
| `REDIS_URL` | | optional Redis for distributed locks |
| `BOTFS_DIR` | | serve bot content from a directory instead of the database |
| `APP_SECRET` | | secret that signs collaborator JWTs |
| `USERCODE_TIMEOUT` | `30s` | time limit for one user-code run |
| `DIALOG_TIMEOUT_INTERVAL`, `DIALOG_SESSION_TIMEOUT_INTERVAL`, `DIALOG_JANITOR_INTERVAL` | | dialog timeouts and janitor cadence |

## Tests

- `make test`: unit tests. Postgres-backed tests run when `BOTFS_TEST_DSN` is set.
- `make vet`: `go vet` for the Go packages.
- `cd ui && pnpm test`: editor unit tests (Vitest). `pnpm typecheck` and `pnpm build` check the SPA.
- `make e2e-ui`: Playwright specs in `ui/e2e` against the real server. See `e2e-ui/README.md`.
- `make e2e`: stack run against the legacy engine (Docker). Requires `LEGACY_IMAGE` and an
  `e2e/legacy.env` file. See `e2e/README.md`.
- `make e2e-parity`: editor data parity between the legacy editor and this one. See
  `docs/editor-parity.md`.

## Layout

| Path | Contents |
|---|---|
| `cmd/bot-engine` | server binary: `serve` and `validate` commands |
| `config` | environment and global configuration |
| `internal/api` | HTTP routing and middleware |
| `internal/auth` | login strategies, password hashing, JWT |
| `internal/botfs` | bot content store (database or directory) |
| `internal/engine` | converse API, janitor, bot loading |
| `internal/dialog` | dialog engine: flows, instructions, timeouts |
| `internal/event`, `internal/state` | event model, session and KVS state |
| `internal/builtin`, `internal/cms` | built-in actions and content rendering |
| `internal/flow` | flow loading and validation |
| `internal/usercode` | JavaScript runtime for actions and hooks, vendored packages in `js/` |
| `internal/studioapi` | editor API: flows, content, code editor, skills, archives |
| `internal/web` | embedded editor SPA |
| `ui/` | editor frontend (React, Vite, Playwright specs) |
| `testdata/` | synthetic bots and scenario files used by the tests |
| `e2e/`, `e2e-ui/` | end-to-end and parity harnesses |
| `docs/` | HTTP API notes and editor parity notes |

## License

bot-engine is licensed under the GNU Affero General Public License v3.0 (see `LICENSE`).
Vendored third-party code and its license texts are listed in `THIRD_PARTY_NOTICES.md`.
