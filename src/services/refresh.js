import { decryptJson, encryptJson } from '../lib/crypto.js';
import { normalizeTokenSet } from '../oauth/client.js';
import { reconcileAccount } from './sync.js';
import { getRefreshLeadMs } from './settings.js';

export const MIN_REFRESH_GAP_MS = 10 * 60_000;

function refreshLeadMs(account, configuredLeadMs) {
  const expires = Date.parse(account.access_expires_at);
  const refreshedAt = account.last_refresh_at;
  const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(refreshedAt || '')
    ? refreshedAt.replace(' ', 'T') + 'Z' : refreshedAt;
  const lastRefresh = Date.parse(normalized || '');
  const lifetime = expires - lastRefresh;
  // A lead equal to the whole token lifetime makes every new token eligible
  // again immediately. Never refresh before half its measured lifetime.
  return Number.isFinite(lifetime) && lifetime > 0
    ? Math.min(configuredLeadMs, lifetime / 2) : configuredLeadMs;
}

function refreshRequest(provider, providerConfig, refreshToken) {
  const values = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: providerConfig.clientId,
  };
  if (provider === 'claude') {
    return {
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(values),
    };
  }
  if (providerConfig.scopes) values.scope = providerConfig.scopes;
  return {
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(values),
  };
}

export async function refreshTokenSet(provider, providerConfig, current, fetchImpl = fetch) {
  if (!current.refreshToken) throw new Error('Missing refresh token');
  const response = await fetchImpl(providerConfig.tokenUrl, {
    method: 'POST',
    ...refreshRequest(provider, providerConfig, current.refreshToken),
  });
  if (!response.ok) {
    const error = new Error(`OAuth refresh failed (${response.status})`);
    error.statusCode = response.status;
    error.unrecoverable = [400, 401, 403].includes(response.status);
    throw error;
  }
  const refreshed = normalizeTokenSet(await response.json());
  return {
    ...current,
    ...refreshed,
    refreshToken: refreshed.refreshToken || current.refreshToken,
    idToken: refreshed.idToken || current.idToken,
  };
}

export async function refreshAccount(db, adapters, config, accountId, fetchImpl = fetch) {
  const account = db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(accountId);
  if (!account) return null;
  const current = decryptJson(account.credential_envelope, config.encryptionKey);
  try {
    const refreshed = await refreshTokenSet(account.provider, config[account.provider], current, fetchImpl);
    db.prepare(`
      UPDATE provider_accounts SET credential_envelope = ?, token_version = token_version + 1,
        access_expires_at = ?, last_refresh_at = CURRENT_TIMESTAMP, last_refresh_error = NULL,
        credential_status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(encryptJson(refreshed, config.encryptionKey), refreshed.expiresAt, account.id);
    await reconcileAccount(db, adapters, config, account.id);
    return refreshed;
  } catch (error) {
    db.prepare(`
      UPDATE provider_accounts SET last_refresh_error = ?,
        credential_status = CASE WHEN ? THEN 'needs_reauth' ELSE credential_status END,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(String(error.message).slice(0, 160), error.unrecoverable ? 1 : 0, account.id);
    throw error;
  }
}

export async function runRefreshTick(db, adapters, config, fetchImpl = fetch, now = Date.now()) {
  // Read the setting on every tick so admin changes apply without a restart.
  const configuredLeadMs = getRefreshLeadMs(db, config);
  const cutoff = new Date(now + configuredLeadMs).toISOString();
  const lastEligibleRefresh = new Date(now - MIN_REFRESH_GAP_MS).toISOString();
  const accounts = db.prepare(`
    SELECT id, access_expires_at, last_refresh_at FROM provider_accounts
    WHERE credential_status = 'active'
      AND access_expires_at IS NOT NULL
      AND access_expires_at <= ?
      AND (last_refresh_at IS NULL OR datetime(last_refresh_at) <= datetime(?))
  `).all(cutoff, lastEligibleRefresh);
  const due = accounts.filter((account) => Date.parse(account.access_expires_at)
    <= now + refreshLeadMs(account, configuredLeadMs));
  for (const account of due) {
    try { await refreshAccount(db, adapters, config, account.id, fetchImpl); }
    catch { /* recorded on the account; one failure must not block the others */ }
  }
  return due.length;
}

export function startRefreshScheduler(db, adapters, config, fetchImpl = fetch) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runRefreshTick(db, adapters, config, fetchImpl); }
    finally { running = false; }
  };
  const handle = setInterval(tick, config.refreshIntervalMinutes * 60_000);
  handle.unref?.();
  queueMicrotask(tick);
  return () => clearInterval(handle);
}
