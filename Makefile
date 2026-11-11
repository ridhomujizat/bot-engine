# bot-engine build targets. Go and Node come from `nix develop`.

BIN      ?= bin/bot-engine
PKGS     := ./config/... ./cmd/... ./internal/...
UI_DIR   := ui
DIST     := internal/web/dist

.PHONY: ui build test vet validate docker e2e clean

## ui: build the editor SPA into internal/web/dist (served at /studio/)
ui:
	cd $(UI_DIR) && pnpm install --frozen-lockfile && pnpm build

## build: compile the server (embeds whatever is in internal/web/dist)
build:
	CGO_ENABLED=0 go build -trimpath -o $(BIN) ./cmd/bot-engine

## test: unit tests. Postgres-backed tests run when BOTFS_TEST_DSN is set.
test:
	go test -count=1 $(PKGS)

vet:
	go vet $(PKGS)

## validate: validate every bot in the configured store (exit 1 on issues)
validate:
	go run ./cmd/bot-engine validate --all

docker:
	docker build -t bot-engine:dev .

## e2e: stack run against the legacy engine (compose, bot import). Needs docker and LEGACY_IMAGE; see e2e/README.md.
e2e:
	./e2e/run.sh

clean:
	rm -rf bin

## e2e-ui: editor end-to-end suite (ui/e2e) against the real Go server; see e2e-ui/README.md
.PHONY: e2e-ui
e2e-ui:
	./e2e-ui/run.sh

## e2e-parity: legacy vs bot-engine editor data parity (needs both servers and BOT_TGZ); see docs/editor-parity.md
.PHONY: e2e-parity
e2e-parity:
	./e2e-ui/parity.sh
