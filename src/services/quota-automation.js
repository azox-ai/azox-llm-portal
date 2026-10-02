import { decryptJson } from '../lib/crypto.js';
import { audit } from './audit.js';
import { fetchQuota } from './quota.js';
import { getSessionQuotaSettings } from './settings.js';
import { markPending, reconcileAccount, ROUTERS } from './sync.js';

function fetchForProvider(fetchByProvider, provider) {
  if (typeof fetchByProvider === 'function') return fetchByProvider;
  return fetchByProvider?.[provider] || fetch;
}

function quotaHasReset(account, windows, now) {
  const previousReset = Date.parse(account.quota_session_reset_at || '');
  if (Number.isFinite(previousReset)) {
    if (now >= previousReset) return true;
    // Only a single window is unambiguous when the provider rolls its reset
    // forward. Another window advancing must not bypass the recorded pause.
    return windows.length === 1 && Date.parse(windows[0].resetAt || '') > previousReset;
  }
  // Both supported providers normally return a reset timestamp. If one omits
  // it, only a fully replenished window is strong enough evidence to re-enable.
  return windows.every((window) => window.remaining >= 99.9);
}

const QUOTA_WINDOW_PRIORITY = ['weekly', 'session'];

function quotaWindowsByPriority(quota) {
  const priority = new Map(QUOTA_WINDOW_PRIORITY.map((name, index) => [name, index]));
  return Object.entries(quota.quotas || {})
    .map(([name, window]) => ({ name, ...window, remaining: window?.remaining == null ? NaN : Number(window.remaining) }))
    .filter((window) => Number.isFinite(window.remaining))
    .sort((a, b) => (priority.get(a.name) ?? priority.size)
      - (priority.get(b.name) ?? priority.size));
}

async function setAutomatedState(db, adapters, config, account, enabled, window, thresholdPercent) {
  const changed = enabled
    ? db.prepare(`
      UPDATE provider_accounts
      SET desired_enabled = 1, token_version = token_version + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND desired_enabled = 0 AND quota_auto_disabled = 1
    `).run(account.id).changes
    : db.prepare(`
      UPDATE provider_accounts
      SET desired_enabled = 0, quota_auto_disabled = 1, quota_session_reset_at = ?,
          token_version = token_version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND desired_enabled = 1
    `).run(window.resetAt || null, account.id).changes;
  if (!changed) return false;

  markPending(db, account.id);
  const summary = await reconcileAccount(db, adapters, config, account.id);
  if (enabled && ROUTERS.every((router) => summary[router] === 'active')) {
    db.prepare(`
      UPDATE provider_accounts
      SET quota_auto_disabled = 0, quota_session_reset_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND desired_enabled = 1 AND quota_auto_disabled = 1
    `).run(account.id);
  }
  audit(db, {
    action: enabled ? 'account.auto_enabled_quota' : 'account.auto_disabled_quota',
    targetType: 'account',
    targetId: account.id,
    detail: JSON.stringify({
      window: window.name,
      remaining: window.remaining,
      thresholdPercent,
      resetAt: window.resetAt || null,
    }),
  });
  return true;
}

async function repairAutomatedSync(db, adapters, config, account) {
  const expected = account.desired_enabled === 1 ? 'active' : 'disabled';
  const connections = db.prepare(`
    SELECT router, sync_status, synced_token_version
    FROM router_connections WHERE account_id = ?
  `).all(account.id);
  const byRouter = Object.fromEntries(connections.map((connection) => [connection.router, connection]));
  const synced = ROUTERS.every((router) => byRouter[router]?.sync_status === expected
    && byRouter[router]?.synced_token_version === account.token_version);
  if (synced) return true;

  markPending(db, account.id);
  const summary = await reconcileAccount(db, adapters, config, account.id);
  return ROUTERS.every((router) => summary[router] === expected);
}

export async function runQuotaAutomationTick(
  db,
  adapters,
  config,
  fetchByProvider = {},
  now = Date.now(),
) {
  // Defaults are read on every tick so admin changes apply without a restart.
  // Each owner may override them without affecting anyone else's accounts.
  const defaults = getSessionQuotaSettings(db);
  const accounts = db.prepare(`
    SELECT a.*,
           COALESCE(q.auto_disable, ?) AS effective_auto_disable,
           COALESCE(q.threshold_percent, ?) AS effective_threshold_percent,
           COALESCE(q.auto_enable, ?) AS effective_auto_enable
    FROM provider_accounts a
    LEFT JOIN user_quota_settings q ON q.user_id = a.owner_id
    WHERE a.credential_status = 'active'
      AND ((COALESCE(q.auto_disable, ?) = 1 AND a.desired_enabled = 1)
        OR a.quota_auto_disabled = 1)
    ORDER BY a.id
  `).all(
    defaults.autoDisable ? 1 : 0,
    defaults.thresholdPercent,
    defaults.autoEnable ? 1 : 0,
    defaults.autoDisable ? 1 : 0,
  );
  const result = { checked: 0, disabled: 0, enabled: 0, failed: 0 };

  for (const account of accounts) {
    const settings = {
      autoDisable: Boolean(account.effective_auto_disable),
      thresholdPercent: account.effective_threshold_percent,
      autoEnable: Boolean(account.effective_auto_enable),
    };
    try {
      if (account.quota_auto_disabled === 1) {
        const synced = await repairAutomatedSync(db, adapters, config, account);
        if (!synced) result.failed += 1;
        if (synced && account.desired_enabled === 1) {
          // This completes an auto-enable interrupted by a process exit or a
          // temporary router failure after Portal had already changed intent.
          db.prepare(`
            UPDATE provider_accounts
            SET quota_auto_disabled = 0, quota_session_reset_at = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND desired_enabled = 1 AND quota_auto_disabled = 1
          `).run(account.id);
        }
      }
      const tokenSet = decryptJson(account.credential_envelope, config.encryptionKey);
      const quota = await fetchQuota(
        account.provider,
        tokenSet,
        fetchForProvider(fetchByProvider, account.provider),
      );
      result.checked += 1;
      // Weekly is the long-term hard limit, so evaluate it first. Session is
      // still checked next: an account is usable only while every upstream
      // quota window remains above the configured threshold.
      const windows = quotaWindowsByPriority(quota);
      if (!windows.length) continue;
      const hasUnknownWindow = Object.values(quota.quotas || {})
        .some((window) => window?.remaining == null || !Number.isFinite(Number(window.remaining)));
      const blockedWindows = windows.filter(
        (window) => window.remaining <= settings.thresholdPercent,
      );
      const blockedWindow = blockedWindows.reduce((latest, window) => (
        (Date.parse(window.resetAt || '') || 0) > (Date.parse(latest?.resetAt || '') || 0)
          ? window : latest
      ), blockedWindows[0]);

      if (account.quota_auto_disabled === 1 && account.desired_enabled === 0 && blockedWindow) {
        // Every exhausted window must recover; record the latest reset.
        // Reset times can advance while an account remains disabled.
        db.prepare(`
          UPDATE provider_accounts SET quota_session_reset_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND quota_auto_disabled = 1 AND desired_enabled = 0
            AND quota_session_reset_at IS NOT ?
        `).run(blockedWindow.resetAt || null, account.id, blockedWindow.resetAt || null);
      }

      if (settings.autoDisable && account.desired_enabled === 1
        && blockedWindow) {
        if (await setAutomatedState(
          db, adapters, config, account, false, blockedWindow, settings.thresholdPercent,
        )) result.disabled += 1;
        continue;
      }
      if (settings.autoEnable && account.desired_enabled === 0 && account.quota_auto_disabled === 1
        && !blockedWindow && !hasUnknownWindow && quotaHasReset(account, windows, now)) {
        if (await setAutomatedState(
          db, adapters, config, account, true, windows[0], settings.thresholdPercent,
        )) result.enabled += 1;
      }
    } catch {
      // A provider outage or one invalid credential must not block checks for
      // other accounts. No account state is changed when quota cannot be read.
      result.failed += 1;
    }
  }
  return result;
}

export function startQuotaAutomationScheduler(db, adapters, config, fetchByProvider = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runQuotaAutomationTick(db, adapters, config, fetchByProvider); }
    finally { running = false; }
  };
  const handle = setInterval(tick, config.quotaCheckIntervalMinutes * 60_000);
  handle.unref?.();
  queueMicrotask(tick);
  return () => clearInterval(handle);
}
