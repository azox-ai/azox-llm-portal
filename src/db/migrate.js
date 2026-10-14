/**
 * Forward migrations for databases created by the earlier prototype.
 *
 * The deployed volume already holds real users, credentials and router
 * mappings, so the schema change is applied in place: the prototype's
 * `sponsored_accounts` table is renamed and widened rather than recreated, and
 * `must_change_password` is dropped now that admin-created users log straight
 * in.
 */

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

function addColumn(db, table, column, definition) {
  if (!columnNames(db, table).includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function migrate(db) {
  // `sponsored_accounts` predates the portal owning credentials; the rename has
  // to happen before schema.js runs so the CREATE IF NOT EXISTS sees the table.
  if (tableExists(db, 'sponsored_accounts') && !tableExists(db, 'provider_accounts')) {
    db.exec('ALTER TABLE sponsored_accounts RENAME TO provider_accounts');
  }

  if (tableExists(db, 'provider_accounts')) {
    addColumn(db, 'provider_accounts', 'token_version', 'INTEGER NOT NULL DEFAULT 1');
    addColumn(db, 'provider_accounts', 'access_expires_at', 'TEXT');
    addColumn(db, 'provider_accounts', 'last_refresh_at', 'TEXT');
    addColumn(db, 'provider_accounts', 'last_refresh_error', 'TEXT');
    addColumn(db, 'provider_accounts', 'quota_auto_disabled', 'INTEGER NOT NULL DEFAULT 0 CHECK (quota_auto_disabled IN (0, 1))');
    addColumn(db, 'provider_accounts', 'quota_session_reset_at', 'TEXT');
    addColumn(db, 'provider_accounts', 'quota_reset_window', 'TEXT');
    // Recover the tracked window for existing pauses only when the audit reset
    // still matches the saved reset. Otherwise keep the conservative fallback.
    if (tableExists(db, 'audit_log')) {
      const paused = db.prepare(`
        SELECT id, quota_session_reset_at FROM provider_accounts
        WHERE quota_auto_disabled = 1 AND quota_reset_window IS NULL
          AND quota_session_reset_at IS NOT NULL
      `).all();
      const lastPause = db.prepare(`
        SELECT detail FROM audit_log
        WHERE target_type = 'account' AND target_id = ?
          AND action = 'account.auto_disabled_quota'
        ORDER BY id DESC LIMIT 1
      `);
      const update = db.prepare(`
        UPDATE provider_accounts SET quota_reset_window = ?
        WHERE id = ? AND quota_reset_window IS NULL
      `);
      for (const account of paused) {
        try {
          const detail = JSON.parse(lastPause.get(String(account.id))?.detail || 'null');
          if (detail?.resetAt === account.quota_session_reset_at
            && ['session', 'weekly'].includes(detail.window)) {
            update.run(detail.window, account.id);
          }
        } catch {
          // An invalid legacy audit entry cannot identify the paused window.
        }
      }
    }
  }

  if (tableExists(db, 'oauth_states')) {
    addColumn(db, 'oauth_states', 'account_id', 'INTEGER REFERENCES provider_accounts(id) ON DELETE CASCADE');
  }

  if (tableExists(db, 'router_connections')) {
    addColumn(db, 'router_connections', 'synced_token_version', 'INTEGER NOT NULL DEFAULT 0');
  }

  if (tableExists(db, 'model_catalog')) {
    addColumn(db, 'model_catalog', 'status', "TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('active', 'inactive'))");
  }

  // Dropping the column also drops the old CHECK constraint that referenced it.
  if (tableExists(db, 'users') && columnNames(db, 'users').includes('must_change_password')) {
    db.exec('ALTER TABLE users DROP COLUMN must_change_password');
  }
}
