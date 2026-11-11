# End-to-end stack (`make e2e`)

`e2e/run.sh` starts a Docker Compose stack and checks that bot-engine behaves like the legacy
engine on the same bot:

1. PostgreSQL 16 and Redis, then the legacy engine (image from `LEGACY_IMAGE`).
2. The legacy engine creates its own schema and an admin user through its API.
3. The schema and the admin login row are copied to `bots_e2e_go`, so bot-engine reads the same
   tables and must accept the legacy password hash.
4. The synthetic `testdata/bots/e2e-worker` bot is packed as `.tgz` and imported into both engines.
5. Optional client test suite (see below) runs against the legacy engine and two bot-engine replicas.
6. The stack is removed with `docker compose down -v`, also on failure.

## Requirements

- Docker with Compose v2, and the Nix dev shell (`nix develop`).
- A legacy engine image you are allowed to run. It is not part of this repository.
- `e2e/legacy.env`, created from `e2e/legacy.env.example`. It holds the legacy engine's own
  settings and is git-ignored.

## Run

```sh
cp e2e/legacy.env.example e2e/legacy.env     # then review it
LEGACY_IMAGE=<your legacy engine image> make e2e
```

`LEGACY_IMAGE` has no default and the run stops without it.

## Options

| Variable | Default | Meaning |
|---|---|---|
| `E2E_KEEP` | unset | keep the stack running after the run |
| `E2E_TEST_RUN` | unset | regex passed to `go test -run` for the client suite |
| `E2E_CLIENT_TESTS_DIR` | unset | path to a Go module whose `./e2e/...` tests (build tag `e2e`) run against the stack |
| `E2E_LEGACY_PORT`, `E2E_GO_A_PORT`, `E2E_GO_B_PORT` | `53100`, `53101`, `53102` | host ports |
| `E2E_PG_PORT`, `E2E_REDIS_PORT`, `E2E_MOCK_PORT` | `55433`, `56379`, `18080` | host ports |

## Client test suite

The stack is also a target for your own tests. Put them in a separate module with `//go:build e2e`
files under `./e2e/`, then run `E2E_CLIENT_TESTS_DIR=/path/to/module make e2e`. The run exports:

- `E2E_LEGACY_URL`, `E2E_GO_A_URL`, `E2E_GO_B_URL`: base URLs of the legacy engine and both replicas
- `E2E_GO_DB_DSN`: PostgreSQL DSN of the bot-engine database
- `E2E_MOCK_ADDR`, `E2E_MOCK_URL`: address for a mock server on the host, and the URL the containers use
- `E2E_BOT_ID`, `E2E_EMAIL`, `E2E_PASSWORD`: the bot and the admin login

## Notes

- Bot actions in the test bots call only the local mock server. Keep it that way.
- `make e2e-ui` (editor specs against the Go server only) does not need Docker or the legacy image.
- Editor parity between the two editors is covered by `make e2e-parity`, see `docs/editor-parity.md`.
