import { decryptJson } from '../lib/crypto.js';
import { safeError } from '../lib/validation.js';

export const ROUTERS = ['ninerouter'];

function upsertConnection(db, accountId, router, patch) {
  db.prepare(`
    INSERT INTO router_connections
      (account_id, router, remote_id, synced_token_version, sync_status, last_error, last_synced_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(account_id, router) DO UPDATE SET
      remote_id = COALESCE(excluded.remote_id, router_connections.remote_id),
      synced_token_version = excluded.synced_token_version,
      sync_status = excluded.sync_status,
      last_error = excluded.last_error,
      last_synced_at = COALESCE(excluded.last_synced_at, router_connections.last_synced_at),
      updated_at = CURRENT_TIMESTAMP
  `).run(
    accountId,
    router,
    patch.remoteId ?? null,
    patch.tokenVersion ?? 0,
    patch.status,
    patch.error ?? null,
    patch.syncedAt ?? null,
  );
}

export function markPending(db, accountId) {
  for (const router of ROUTERS) upsertConnection(db, accountId, router, { status: 'pending' });
}

export async function reconcileAccount(db, adapters, config, accountId) {
  const account = db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(accountId);
  if (!account) throw new Error('Account not found');
  const tokenSet = decryptJson(account.credential_envelope, config.encryptionKey);
  const summary = {};

  for (const router of ROUTERS) {
    try {
      const remoteId = await adapters[router].sync(account, tokenSet);
      const status = account.credential_status !== 'active'
        ? 'needs_reauth'
        : (account.desired_enabled ? 'active' : 'disabled');
      upsertConnection(db, accountId, router, {
        remoteId,
        tokenVersion: account.token_version,
        status,
        syncedAt: new Date().toISOString(),
      });
      summary[router] = status;
    } catch (error) {
      upsertConnection(db, accountId, router, {
        status: 'failed',
        tokenVersion: 0,
        error: safeError(error),
      });
      summary[router] = 'failed';
    }
  }
  return summary;
}

export async function removeAccount(db, adapters, accountId) {
  const account = db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(accountId);
  if (!account) return { removed: true, failures: [] };
  const failures = [];
  for (const router of ROUTERS) {
    try { await adapters[router].remove(account); }
    catch (error) { failures.push({ router, error: safeError(error) }); }
  }
  if (failures.length > 0) return { removed: false, failures };
  db.prepare('DELETE FROM provider_accounts WHERE id = ?').run(accountId);
  return { removed: true, failures };
}

export function aggregateStatus(connections) {
  const statuses = ROUTERS.map((router) => connections[router] ?? 'pending');
  if (statuses.every((status) => status === 'active')) return 'active';
  if (statuses.every((status) => status === 'disabled')) return 'disabled';
  if (statuses.some((status) => status === 'needs_reauth')) return 'needs_reauth';
  if (statuses.some((status) => status === 'failed')) return 'failed';
  return 'pending';
}
