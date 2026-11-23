# Unified LLM gateway (parallel implementation)

One service that replaces the management and routing roles currently split across
`azox-llm-portal`, `azox-9router` and `azox-omniroute`:

* Rust (Axum) backend — control plane API, OpenAI/Anthropic-compatible gateway,
  isolated SQLite store, AES-256-GCM credential envelopes, Argon2id logins.
* React + TypeScript single-page UI served by the same process.

This is a **parallel implementation**. Nothing here cuts over production traffic:
the legacy stack keeps running untouched, keeps owning OAuth refresh tokens, and
the new service starts with upstream execution disabled.

## Layout

```
unified/
  src/            Rust backend (lib.rs, request/response conversion, main.rs)
  tests/          Integration tests (auth, ownership, sync contract, gateway)
  web/            Vite + React + TS control plane UI
  import/         Snapshot copy pipeline (SQLite -> isolated unified DB)
```

## Build and run

```sh
cargo build --release                # binary: target/release/unified-gateway
cd web && npm ci && npm run build    # static bundle: web/dist
```

Configuration is environment-only; see `.env.example`. `UNIFIED_ENCRYPTION_KEY`
must be the base64 encoding of 32 random bytes and must be backed up — losing it
makes stored credentials unrecoverable.

```sh
UNIFIED_LISTEN=127.0.0.1:18080 \
UNIFIED_DATABASE_PATH=/data/unified-gateway/data/unified.sqlite \
UNIFIED_ENCRYPTION_KEY=... \
UNIFIED_ADMIN_USERNAME=admin \
UNIFIED_ADMIN_PASSWORD=... \
UNIFIED_ALLOW_UPSTREAM=false \
UNIFIED_WEB_DIR=/data/unified-gateway/web \
./unified-gateway
```

Health: `GET /health/live`, `GET /health/ready`. Management API under `/api`
(bearer token from `POST /api/login`). Gateway under `/v1` authenticated with a
policy key created in the UI (`Authorization: Bearer <key>` or `x-api-key`).

### Environment

| Variable | Meaning |
|---|---|
| `UNIFIED_LISTEN` | Bind address, default `127.0.0.1:3030` |
| `UNIFIED_DATABASE_PATH` | SQLite file, default `./data/unified.sqlite` |
| `UNIFIED_ENCRYPTION_KEY` | base64 32-byte AES-GCM key (required) |
| `UNIFIED_ADMIN_USERNAME` / `UNIFIED_ADMIN_PASSWORD` | bootstrap admin (password 12–256 chars) |
| `UNIFIED_ALLOW_UPSTREAM` | `true` enables real upstream calls; default `false` |
| `UNIFIED_WEB_DIR` | directory holding the built UI, default `web/dist` |
| `PORTAL_SYNC_TOKEN` | bearer for `PUT/GET/DELETE /api/internal/portal/connections/:externalId`; unset disables the endpoint |

## What the gateway does

* `/v1/models`, `/v1/chat/completions`, `/v1/responses`, `/v1/messages`.
* Same-protocol passthrough plus conversion across the three request/response
  shapes for text, tool calls/results, usage and errors; streaming is converted
  frame-by-frame; a failure after the first frame terminates the stream with an
  error frame instead of retrying.
* Candidate selection by model row (`provider`, `upstreamModel`, `protocol`),
  provider aliases `cc`/`claude` and `cx`/`codex`, and combos (ordered fallback).
  Connections carry priority, per-connection cooldown, and admin-owned
  connections are shared to all gateway key owners.
* OAuth connections pushed through the internal portal contract execute with the
  access token only; they never refresh, and expired tokens are skipped.
* Requests are size-limited, upstream calls have bounded timeouts and no token or
  credential values are logged.

### Known limits

* No background refresh, quota auto-disable/enable, audit UI or per-key policy
  enforcement (daily limits, model allow-lists, IP allow-lists).
* Single choice per response; reasoning/thinking content is not carried through
  protocol conversion; Claude billing-header/metadata/tool-cloaking headers are
  not sent; Codex rejects sampling/token-limit fields and hosted tools.
* OmniRoute-only features (compression, batches, files, MCP/A2A, radar, training
  data, leaderboard) are not implemented.

## Copying existing data

`import/` copies from **snapshots**, never from live volumes, and writes only to
the isolated unified database. See `import/README.md` for the full procedure,
verification and rollback. Copying is lossless for archival purposes: every
source row is stored encrypted in `raw_imports`; only rows that map safely
become live objects (accounts, API-key connections, simple combos, models).

## Tests

```sh
cargo test        # unit + integration (54 tests at time of writing)
cd web && npm test && npm run typecheck
```