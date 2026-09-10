import { decryptJson } from '../lib/crypto.js';
import { safeError } from '../lib/validation.js';
import { decodeJwtPayload } from '../oauth/client.js';

export const ROUTERS = ['ninerouter', 'omniroute'];

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
  const account = db.prepare(`
    SELECT a.*, u.username AS owner_username
    FROM provider_accounts a JOIN users u ON u.id = a.owner_id
    WHERE a.id = ?
  `).get(accountId);
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

export async function pullRouterState(db, adapters, accountId) {
  const account = db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(accountId);
  if (!account) throw new Error('Account not found');
  const summary = {};

  for (const router of ROUTERS) {
    try {
      const remote = await adapters[router].status(account);
      if (!remote.found) {
        upsertConnection(db, accountId, router, {
          status: 'failed',
          tokenVersion: 0,
          error: 'Connection not found on router',
        });
        summary[router] = 'failed';
        continue;
      }
      const status = account.credential_status !== 'active'
        ? 'needs_reauth'
        : (remote.enabled ? 'active' : 'disabled');
      upsertConnection(db, accountId, router, {
        remoteId: `portal-${account.id}`,
        tokenVersion: remote.tokenVersion,
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

  const routerStates = Object.values(summary);
  if (routerStates.length > 0 && routerStates.every((status) => status === 'active')) {
    db.prepare('UPDATE provider_accounts SET desired_enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(accountId);
  } else if (routerStates.length > 0 && routerStates.every((status) => status === 'disabled')) {
    db.prepare('UPDATE provider_accounts SET desired_enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(accountId);
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

export async function restoreFullAccountLabels(db, adapters, config) {
  const rows = db.prepare("SELECT id, display_name, credential_envelope FROM provider_accounts WHERE display_name LIKE '%***%'").all();
  const restored = [];
  for (const row of rows) {
    const tokenSet = decryptJson(row.credential_envelope, config.encryptionKey);
    const claims = tokenSet.idToken ? decodeJwtPayload(tokenSet.idToken) : null;
    const label = claims?.email || claims?.name;
    if (typeof label !== 'string' || !label.trim()) continue;
    db.prepare(`
      UPDATE provider_accounts
      SET display_name = ?, token_version = token_version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(label.trim(), row.id);
    markPending(db, row.id);
    await reconcileAccount(db, adapters, config, row.id);
    restored.push(row.id);
  }
  return restored;
}
