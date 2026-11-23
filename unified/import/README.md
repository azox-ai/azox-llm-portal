# Isolated, copy-only import

This pipeline reads **private, checkpointed snapshots**, not a live database, and copies to an **isolated** unified database. It never mutates any source database, source volume, or legacy service, and does not cut over traffic. Nothing runs unless explicitly invoked. Disable upstream (`UNIFIED_ALLOW_UPSTREAM=false`) throughout this exercise. Both snapshots and the destination contain sensitive data; control host access and retention.

## What this can and cannot copy

* Every row of every discoverable non-`sqlite_%` table, including virtual and shadow tables, is archived to unified `raw_imports`. Each row preserves column names, SQLite storage classes, raw TEXT/BLOB bytes, INTEGER values and exact binary floating-point values; the payload is JSON encrypted with AES-256-GCM as `v1.<base64url nonce>.<base64url ciphertext+tag>`, the envelope used by the backend. Schema DDL, indexes, triggers, implicit rowids, and `sqlite_%` internal tables are **not** archived; retain a separate secure SQLite backup if database reconstruction or those objects are required. Virtual-table modules unsupported by local SQLite cause failure rather than silent omission.
* Portal `provider_accounts` become accounts with provider, display name and desired enabled flag. The API does not accept credential status, expiry, or token version on creation: these remain in the encrypted archive only (unified defaults are `active`, `1`). No refresh/access token is copied to a usable connection. Portal users/password hashes, OAuth states, settings, catalog and audit are archive-only in this phase; phase 2 applies an explicit catalog mapping (see below). The unified admin is bootstrapped by the gateway, not by the importer.
* 9router and OmniRoute API-key connections are copied only when the source explicitly identifies API-key auth, holds a nonempty **plaintext** key, and provides an explicit supported protocol (`chat`, `responses`, or `messages`) and credential-free base URL. OAuth, absent credentials, recognized encrypted envelopes and incomplete configuration are archive-only. Encrypted upstream keys cannot be decrypted by this tool. No refresh tokens are installed.
* 9router API keys with unrestricted access and usable plaintext of 24–512 bytes can be created **disabled**; policy-restricted keys are skipped. OmniRoute keys are all archived only because unified cannot preserve their ACLs, quotas, schedules, expiry and other restrictions. Enabling any imported key is a separate, explicit operator decision. 9router simple string-list combos are copied **disabled**, since their target models may not exist. More complex combos/strategies are archived only. No model is invented from ambiguous metadata; catalog rows remain archived. Ownership defaults to the unified admin. A source key created in unified may already be used by the old stack; it is not printed. Existing key material and ACLs need an explicit security review before enabling any upstream.
* Unsupported fields, source rows with no compatible API representation, history (except usage, which phase 2 copies), session data, passwords, audit, settings, encrypted upstream credentials and all other tables remain in the encrypted archive. Archive is not an operational migration of these features.

The backend has no raw-row import POST (`GET /api/imports` exposes only the first 500 metadata entries); the phase-1 script therefore writes **only `raw_imports`** via a direct SQLite transaction, and phase 2 additionally inserts the observed `usage` rows directly (one transaction, deduped). All other creation uses the HTTP API. This requires Python 3 and `cryptography` with `AESGCM`; there is deliberately **no plaintext fallback**. The key supplied to the importer must be the same base64-encoded 32-byte `UNIFIED_ENCRYPTION_KEY` used by the destination service. The tool cannot prove that the API URL, DB path, and encryption key belong to the same server; the operator must establish this before apply. Do not send secrets to remote hosts. URL is limited to a loopback HTTP origin. No passwords, tokens, rows, or HTTP response bodies are printed by these scripts.

## Snapshot and dry-run

Run every command below from `unified/` (the directory containing `import/`). The following shows the observed container paths. `docker inspect` first; do not assume volume names or paths remain unchanged. Allow destination disk space comparable to the sum of source sizes: the encrypted archive stores every source row and its WAL can grow during the single archive transaction.

```sh
docker inspect llmproxy-portal --format '{{json .Mounts}}'
docker inspect llmproxy-9router --format '{{json .Mounts}}'
docker inspect llmproxy-omniroute --format '{{json .Mounts}}'
umask 077
SNAP=$(mktemp -d)
chmod 700 "$SNAP"
mkdir "$SNAP/portal" "$SNAP/9router" "$SNAP/omniroute"
docker cp llmproxy-portal:/data/portal.db "$SNAP/portal/db"
docker cp llmproxy-portal:/data/portal.db-wal "$SNAP/portal/db-wal" 2>/dev/null || true
docker cp llmproxy-portal:/data/portal.db-shm "$SNAP/portal/db-shm" 2>/dev/null || true
docker cp llmproxy-9router:/app/data/db/data.sqlite "$SNAP/9router/db"
docker cp llmproxy-9router:/app/data/db/data.sqlite-wal "$SNAP/9router/db-wal" 2>/dev/null || true
docker cp llmproxy-9router:/app/data/db/data.sqlite-shm "$SNAP/9router/db-shm" 2>/dev/null || true
docker cp llmproxy-omniroute:/app/data/storage.sqlite "$SNAP/omniroute/db"
docker cp llmproxy-omniroute:/app/data/storage.sqlite-wal "$SNAP/omniroute/db-wal" 2>/dev/null || true
docker cp llmproxy-omniroute:/app/data/storage.sqlite-shm "$SNAP/omniroute/db-shm" 2>/dev/null || true
chmod -R go-rwx "$SNAP"
python3 - "$SNAP" <<'PY'
import os, sqlite3, sys, urllib.parse
for source in ('portal', '9router', 'omniroute'):
    path = os.path.join(sys.argv[1], source, 'db')
    db = sqlite3.connect('file:' + urllib.parse.quote(path) + '?mode=ro', uri=True)
    out = sqlite3.connect(path + '.snapshot')
    db.backup(out)
    out.close(); db.close()
    os.chmod(path + '.snapshot', 0o600)
PY
python3 import/copy.py portal --snapshot "$SNAP/portal/db.snapshot" --dry-run
python3 import/copy.py 9router --snapshot "$SNAP/9router/db.snapshot" --dry-run
python3 import/copy.py omniroute --snapshot "$SNAP/omniroute/db.snapshot" --dry-run
```

**Consistency caveat:** `docker cp` of a database and WAL is not atomic while the application is running; `quick_check` cannot prove a logically consistent point-in-time pair. Prefer the SQLite online backup API against the live DB through a genuinely read-only mount/access mechanism without touching source files; verify its operational safety for your container/host first. The above `docker cp` method is for exploration only unless the operator independently ensures a consistent copy. Never checkpoint, journal, migrate, or otherwise write to source volumes. The backup step writes only within the private snapshot directory. `--dry-run` is the default and does not contact the API or write the target. It prints table/count and mapping totals only. A nonempty snapshot WAL is rejected, and a snapshot is opened `mode=ro&immutable=1`.

## Apply to isolated unified only

1. Independently check the gateway is the isolated instance, upstream disabled, and that its `UNIFIED_DATABASE_PATH`, `UNIFIED_ENCRYPTION_KEY` and loopback listen address correspond to the DB and URL below. Preserve and securely back up the encryption key. Configure the gateway's `UNIFIED_ADMIN_USERNAME` and `UNIFIED_ADMIN_PASSWORD` (12–256 characters); it creates the first admin at startup if none exists. An existing admin must authenticate with these same env vars. Start the isolated gateway separately; no service start, source volume mount, or cutover is performed by the scripts.
2. Restrict destination DB and parent directory to the operator (e.g. directory 0700, DB 0600). Ensure the backend process can access it. Set the variables in the shell securely without recording values in history or files. Install `cryptography` by your approved process if absent. Use the **same** key as the backend.
3. Run, after validating the snapshot consistency caveat above (replace `DB` with the isolated unified database path).

```sh
DB=/absolute/path/to/isolated/unified.sqlite
# Export UNIFIED_ENCRYPTION_KEY, UNIFIED_ADMIN_USERNAME, UNIFIED_ADMIN_PASSWORD securely first.
python3 import/copy.py portal --snapshot "$SNAP/portal/db.snapshot" --apply --unified-db "$DB" --url http://127.0.0.1:3030
python3 import/copy.py 9router --snapshot "$SNAP/9router/db.snapshot" --apply --unified-db "$DB" --url http://127.0.0.1:3030
python3 import/copy.py omniroute --snapshot "$SNAP/omniroute/db.snapshot" --apply --unified-db "$DB" --url http://127.0.0.1:3030
```

The archive transaction commits before API creates; API calls are individually committed. An interruption can leave a partial apply; rerun against the same snapshot. Stable hash markers in account/connection/key names detect prior creates even if the process failed after the POST; models/combos use their names. Existing items are never updated or deleted. A preexisting combo with the same name is skipped, not overwritten. Concurrent imports are unsupported: two processes can race. Archive rows use hashed primary-key identity (or full-row hash when there is no PK) and duplicate occurrence number, with upsert; repeating the **same** snapshot is idempotent. Changed snapshots can leave stale archive rows and are not reconciled/deleted. Start a fresh isolated DB for a new snapshot. Never treat counts from a changed snapshot as a successful verification.

## Phase 2 backfill

`import/backfill.py` copies the three pieces phase 1 deliberately left archive-only: models, portal-managed OAuth connections and usage history. It reads the same private `{portal,9router,omniroute}/db.snapshot` files (`mode=ro&immutable=1`, nonempty WAL rejected) and writes to the isolated unified gateway only. Dry-run is the default and makes no target writes; it still opens the unified DB read-only to resolve current IDs.

```sh
# From unified/. Source the gateway env file securely; do not echo it.
set -a; . /data/unified-gateway/unified.env; set +a
python3 import/backfill.py --dry-run
python3 import/backfill.py --apply
python3 import/backfill.py --apply    # rerun: proves idempotency
```

Defaults are `/data/unified-gateway/snapshots` for snapshots, `/data/unified-gateway/unified.env` for the gateway env, and `http://127.0.0.1:18080` for the API. `--unified-db` overrides the DB path but must still match the env file under `--apply`. With `--apply` the script refuses unless `UNIFIED_DATABASE_PATH` resolves to the same file, that file's directory is `0700`, `UNIFIED_ALLOW_UPSTREAM` is not `true`, and the API origin matches `UNIFIED_LISTEN`. It never changes those settings. Secrets come from the sourced environment (or the env file); token and password values are never printed, and the OAuth access token is held only in process memory until it is PUT to the gateway, which encrypts it server-side. `refreshToken` and `idToken` are neither read nor sent.

Copy behavior:

* **Models.** Every `portal.model_catalog` row becomes `POST /api/models`: `id` is `catalog.model`, `provider` is the prefix before `/` (`anthropic`→`claude`, `openai`→`codex`, otherwise unchanged), `upstreamModel` is the remainder, `protocol` is `messages` for claude and `chat` otherwise, and `enabled` follows `status='active'` (the observed catalog is entirely inactive, so these are created disabled). Models are additionally **derived from observed usage**: every distinct `(provider, model)` seen in 9router `usageHistory` or OmniRoute `call_logs` with provider `claude` or `codex` is created enabled, with `protocol` `messages` for claude and `responses` for codex and `upstreamModel = model`. These derived rows are a heuristic, not configuration. Existing model IDs (pre-check plus HTTP 409) count as already present.
* **Portal-managed OAuth connections.** From 9router `providerConnections` rows with `authType='oauth'`, a nonempty `data.accessToken`, a `data.providerSpecificData.portalExternalId`, provider `claude` or `codex`, a valid RFC3339 `data.expiresAt` and integer `portalTokenVersion >= 1`, the script `PUT`s `/api/internal/portal/connections/:external_id` with the bearer `PORTAL_SYNC_TOKEN` and a body containing only `provider`, `accessToken`, `expiresAt`, `tokenVersion`, an allow-listed subject ID when present, and `displayName`/`enabled`. Unified assigns protocol and base URL per provider. A `409` means the target already holds an equal or newer version and is reported as stale; the rerun is therefore a no-op. The isolated run imported 3 connections (`portal-1` claude v2401, `portal-3` codex v30, `portal-4` claude v36).
* **Usage history.** All 9router `usageHistory` and OmniRoute `call_logs` rows are inserted directly into the unified `usage` table in one transaction under `owner_id=1` (the admin). 9router `timestamp` becomes `created_at`; `status` text `ok`/`success` becomes `200`, anything else `502`; `key_id` is the unified key whose `key_hash` equals SHA-256 of the row's `apiKey`, else `NULL`. OmniRoute uses `model` (falling back to `requested_model`), its integer `status`, and maps `connection_id` through `provider_connections.provider_specific_data.portalExternalId` to the unified connection ID. 9router `connectionId` maps through `providerConnections.data.providerSpecificData.portalExternalId` the same way. Unmapped connections and empty-model rows are left `NULL`/skipped. Each row is deduped against the existing `(owner_id=1, model, COALESCE(connection_id,''), status, created_at)` tuple before insert; the second run reports every row as deduped and inserts none.

Phase-2 limits: portal password hashes, audit, quota semantics and router policy fields (ACLs, scopes, rate limits, combos, schedules) remain archive-only and are not reconstructed. Models derived from usage are heuristic and can include non-model probe paths such as a `model-sync` call log. Access tokens that are expired at import time are still written so the row exists, but they are unusable until the portal pushes a fresh token; the backfill performs **no refresh** and does not alter token versions. It also does not verify that a token is accepted upstream, and it never contacts a source container or volume.

## Verification and rollback

```sh
python3 import/verify.py portal --snapshot "$SNAP/portal/db.snapshot" --unified-db "$DB"
python3 import/verify.py 9router --snapshot "$SNAP/9router/db.snapshot" --unified-db "$DB"
python3 import/verify.py omniroute --snapshot "$SNAP/omniroute/db.snapshot" --unified-db "$DB"
# Metadata only; do not SELECT row_envelope or source rows into logs.
sqlite3 -readonly "$DB" 'SELECT source, table_name, count(*) FROM raw_imports GROUP BY source, table_name ORDER BY source, table_name;'
sqlite3 -readonly "$DB" 'SELECT "accounts",count(*) FROM accounts UNION ALL SELECT "connections",count(*) FROM connections UNION ALL SELECT "models",count(*) FROM models UNION ALL SELECT "combos",count(*) FROM combos UNION ALL SELECT "api_keys",count(*) FROM api_keys;'
```

Verification decrypts and compares every snapshot row by identity and typed values and compares per-table counts. It checks authenticated GET responses for identifiable source credential values, without printing them. It cannot prove absence of unknown secrets, or verify API/DB/key identity; `GET /api/imports` itself is limited to 500 entries. Compare API create/already-present totals with the dry-run and inspect disabled objects. A failure must block acceptance.

For rollback, stop the isolated gateway and delete **only the isolated unified database and its WAL/SHM** after confirming their exact paths. This also deletes any unrelated data in that database; never target a legacy source. Securely dispose of private snapshots separately under your retention policy. No source mutation occurs during rollback.
