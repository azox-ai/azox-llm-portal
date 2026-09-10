import { decryptJson } from '../lib/crypto.js';
import { safeError } from '../lib/validation.js';

export const ROUTERS = ['ninerouter', 'omniroute'];

function upsertConnection(db, accountId, router, patch) {
  db.prepare(`
    INSERT INTO router_connections (account_id, router, remote_id, sync_status, last_error, last_synced_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(account_id, router) DO UPDATE SET
      remote_id = COALESCE(excluded.remote_id, router_connections.remote_id),
      sync_status = excluded.sync_status,
      last_error = excluded.last_error,
      last_synced_at = COALESCE(excluded.last_synced_at, router_connections.last_synced_at),
      updated_at = CURRENT_TIMESTAMP
  `).run(accountId, router, patch.remoteId ?? null, patch.status, patch.error ?? null, patch.syncedAt ?? null);
}

export function markPending(db, accountId) {
  for (const router of ROUTERS) {
    upsertConnection(db, accountId, router, { status: 'pending' });
  }
}

/**
 * Reconcile one account against both routers.
 *
 * Per-router failures are isolated: one router being down must never block the
 * other, because a single-router account still serves traffic — it has just lost
 * the ADR-0025 failover property, which the UI surfaces as `partially_synced`.
 */
export async function reconcileAccount(db, adapters, config, accountId) {
  const account = db.prepare('SELECT * FROM sponsored_accounts WHERE id = ?').get(accountId);
  if (!account) throw new Error('Account not found');

  const tokenSet = decryptJson(account.credential_envelope, config.encryptionKey);
  const existing = db.prepare('SELECT router, remote_id FROM router_connections WHERE account_id = ?')
    .all(accountId);
  const remoteIds = Object.fromEntries(existing.map((row) => [row.router, row.remote_id]));

  const results = await Promise.allSettled(ROUTERS.map(async (router) => {
    const adapter = adapters[router];
    let remoteId = remoteIds[router];
    if (!remoteId) {
      remoteId = await adapter.inject(account, tokenSet);
    } else {
      await adapter.setEnabled(remoteId, Boolean(account.desired_enabled));
    }
    return { router, remoteId };
  }));

  const summary = {};
  results.forEach((result, index) => {
    const router = ROUTERS[index];
    if (result.status === 'fulfilled') {
      const status = account.credential_status !== 'active'
        ? 'needs_reauth'
        : (account.desired_enabled ? 'active' : 'disabled');
      upsertConnection(db, accountId, router, {
        remoteId: result.value.remoteId,
        status,
        syncedAt: new Date().toISOString(),
      });
      summary[router] = status;
    } else {
      // A router that has no import route for this provider is a known
      // capability gap, not a transient fault: retrying can never fix it, so it
      // is recorded distinctly instead of masquerading as a failure the
      // sponsor is expected to act on.
      const status = result.reason?.code === 'injection_unsupported' ? 'unsupported' : 'failed';
      upsertConnection(db, accountId, router, {
        status,
        error: safeError(result.reason),
      });
      summary[router] = status;
    }
  });
  return summary;
}

export async function removeAccount(db, adapters, accountId) {
  const rows = db.prepare('SELECT router, remote_id FROM router_connections WHERE account_id = ?').all(accountId);
  const failures = [];
  await Promise.all(rows.map(async (row) => {
    if (!row.remote_id) return;
    try {
      await adapters[row.router].remove(row.remote_id);
    } catch (error) {
      failures.push({ router: row.router, error: safeError(error) });
    }
  }));
  if (failures.length > 0) return { removed: false, failures };
  db.prepare('DELETE FROM sponsored_accounts WHERE id = ?').run(accountId);
  return { removed: true, failures };
}

export function aggregateStatus(connections) {
  const statuses = ROUTERS.map((router) => connections[router] ?? 'pending');
  if (statuses.every((s) => s === 'active')) return 'active';
  if (statuses.every((s) => s === 'disabled')) return 'disabled';
  if (statuses.some((s) => s === 'failed')) {
    return statuses.some((s) => s === 'active') ? 'partially_synced' : 'failed';
  }
  if (statuses.some((s) => s === 'needs_reauth')) return 'needs_reauth';
  // Serving from one router while the other structurally cannot hold this
  // credential is still degraded — the account has lost ADR-0025 failover, and
  // reporting it as `active` would hide that.
  if (statuses.some((s) => s === 'unsupported')) {
    return statuses.some((s) => s === 'active') ? 'partially_synced' : 'unsupported';
  }
  return 'pending';
}
