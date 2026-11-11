# syntax=docker/dockerfile:1

# 1. Editor UI: built by Vite into internal/web/dist (base /studio/).
FROM node:22-alpine AS ui
WORKDIR /src/ui
RUN corepack enable
COPY ui/package.json ui/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY ui/ ./
RUN pnpm build

# 2. Go binary with the embedded editor build.
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=ui /src/internal/web/dist ./internal/web/dist
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/bot-engine ./cmd/bot-engine

# 3. Minimal runtime. Runs as the distroless nonroot user.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/bot-engine /usr/local/bin/bot-engine
ENV PORT=3000
EXPOSE 3000
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/bot-engine"]
CMD ["serve"]
