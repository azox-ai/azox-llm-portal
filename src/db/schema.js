export const schema = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
  verifier TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

-- Canonical credential store. The portal — not a router — owns the refresh
-- token: it refreshes ahead of expiry and pushes only the access token out, so
-- two routers can serve the same upstream account without racing each other on
-- a single-use refresh token.
CREATE TABLE IF NOT EXISTS provider_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
  upstream_subject TEXT NOT NULL,
  display_name TEXT NOT NULL,
  credential_envelope TEXT NOT NULL,
  desired_enabled INTEGER NOT NULL DEFAULT 1 CHECK (desired_enabled IN (0, 1)),
  credential_status TEXT NOT NULL DEFAULT 'active' CHECK (credential_status IN ('active', 'needs_reauth', 'revoked')),
  -- Monotonic per account. Routers reject an older version, so a slow sync
  -- retry can never overwrite a newer access token with a stale one.
  token_version INTEGER NOT NULL DEFAULT 1,
  access_expires_at TEXT,
  last_refresh_at TEXT,
  last_refresh_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, upstream_subject)
) STRICT;
CREATE INDEX IF NOT EXISTS provider_accounts_owner_id ON provider_accounts(owner_id);
CREATE INDEX IF NOT EXISTS provider_accounts_expiry ON provider_accounts(access_expires_at);

CREATE TABLE IF NOT EXISTS router_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  router TEXT NOT NULL CHECK (router IN ('ninerouter', 'omniroute')),
  remote_id TEXT,
  synced_token_version INTEGER NOT NULL DEFAULT 0,
  sync_status TEXT NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending', 'active', 'disabled', 'failed', 'needs_reauth', 'unsupported')),
  last_error TEXT,
  last_synced_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(account_id, router)
) STRICT;

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  detail TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
CREATE INDEX IF NOT EXISTS audit_created_at ON audit_log(created_at);
`;
