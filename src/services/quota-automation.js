import { decryptJson } from '../lib/crypto.js';
import { safeError } from '../lib/validation.js';
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
  const pausedWindow = windows.find((window) => window.name === account.quota_reset_window);
  if (account.quota_reset_window && !pausedWindow) return false;
  if (Number.isFinite(previousReset)) {
    if (now >= previousReset) return true;
    // Only the window responsible for the pause can prove an early reset.
    // Legacy pauses without a known window cannot use an early reset safely.
    return Boolean(account.quota_reset_window && pausedWindow
      && Date.parse(pausedWindow.resetAt || '') > previousReset);
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
      SET desired_enabled = 0, quota_auto_disabled = 1, quota_session_reset_at = ?, quota_reset_window = ?,
          token_version = token_version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND desired_enabled = 1
    `).run(window.resetAt || null, window.name, account.id).changes;
  if (!changed) return false;

  markPending(db, account.id);
  const summary = await reconcileAccount(db, adapters, config, account.id);
  const synced = ROUTERS.every((router) => summary[router] === (enabled ? 'active' : 'disabled'));
  if (enabled && synced) {
    db.prepare(`
      UPDATE provider_accounts
      SET quota_auto_disabled = 0, quota_session_reset_at = NULL, quota_reset_window = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND desired_enabled = 1 AND quota_auto_disabled = 1
    `).run(account.id);
  }
  audit(db, {
    action: enabled ? (synced ? 'account.auto_enabled_quota' : 'account.quota_resume_sync_failed')
      : (synced ? 'account.auto_disabled_quota' : 'account.quota_pause_sync_failed'),
    targetType: 'account',
    targetId: account.id,
    detail: JSON.stringify({
      window: window.name,
      remaining: window.remaining,
      thresholdPercent,
      resetAt: window.resetAt || null,
      ...(synced ? {} : { routers: summary }),
    }),
  });
  return synced ? 'synced' : 'pending';
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
  logger = null,
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
      if (account.quota_auto_disabled === 1 && account.desired_enabled === 0) {
        const synced = await repairAutomatedSync(db, adapters, config, account);
        if (!synced) result.failed += 1;
        else {
          const last = db.prepare(`
            SELECT action FROM audit_log
            WHERE target_type = 'account' AND target_id = ?
              AND action IN ('account.auto_disabled_quota', 'account.quota_pause_sync_failed')
            ORDER BY id DESC LIMIT 1
          `).get(String(account.id));
          if (last?.action === 'account.quota_pause_sync_failed') {
            audit(db, {
              action: 'account.auto_disabled_quota', targetType: 'account', targetId: account.id,
              detail: JSON.stringify({ window: account.quota_reset_window,
                thresholdPercent: settings.thresholdPercent, resetAt: account.quota_session_reset_at }),
            });
          }
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
      const hasUnknownWindow = Object.values(quota.quotas || {})
        .some((window) => window?.remaining == null || !Number.isFinite(Number(window.remaining)));
      const blockedWindows = windows.filter(
        (window) => window.remaining <= settings.thresholdPercent,
      );
      const blockedWindow = blockedWindows.reduce((latest, window) => (
        (Date.parse(window.resetAt || '') || 0) > (Date.parse(latest?.resetAt || '') || 0)
          ? window : latest
      ), blockedWindows[0]);

      if (account.quota_auto_disabled === 1 && account.desired_enabled === 1) {
        // A prior resume reached only some routers. Recheck quota before
        // retrying; partial routing must not survive a depleted or missing window.
        const recordedPause = { name: account.quota_reset_window,
          resetAt: account.quota_session_reset_at, remaining: null };
        const pauseWindow = blockedWindow
          || windows.find((window) => window.name === account.quota_reset_window)
          || recordedPause;
        if (!settings.autoEnable || !windows.length || hasUnknownWindow
          || blockedWindow || !quotaHasReset(account, windows, now)) {
          const outcome = await setAutomatedState(
            db, adapters, config, account, false, blockedWindow || recordedPause,
            settings.thresholdPercent,
          );
          if (outcome === 'synced') result.disabled += 1;
          else if (outcome === 'pending') result.failed += 1;
        } else {
          const synced = await repairAutomatedSync(db, adapters, config, account);
          if (synced) {
            db.prepare(`
              UPDATE provider_accounts
              SET quota_auto_disabled = 0, quota_session_reset_at = NULL, quota_reset_window = NULL,
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ? AND desired_enabled = 1 AND quota_auto_disabled = 1
            `).run(account.id);
            audit(db, {
              action: 'account.auto_enabled_quota', targetType: 'account', targetId: account.id,
              detail: JSON.stringify({ window: pauseWindow.name, remaining: pauseWindow.remaining,
                thresholdPercent: settings.thresholdPercent, resetAt: pauseWindow.resetAt || null }),
            });
            result.enabled += 1;
          } else result.failed += 1;
        }
        continue;
      }
      if (!windows.length) continue;

      if (account.quota_auto_disabled === 1 && account.desired_enabled === 0 && blockedWindow) {
        // Every exhausted window must recover; record the latest reset.
        // Reset times can advance while an account remains disabled.
        db.prepare(`
          UPDATE provider_accounts SET quota_session_reset_at = ?, quota_reset_window = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND quota_auto_disabled = 1 AND desired_enabled = 0
            AND (quota_session_reset_at IS NOT ? OR quota_reset_window IS NOT ?)
        `).run(blockedWindow.resetAt || null, blockedWindow.name, account.id,
          blockedWindow.resetAt || null, blockedWindow.name);
      }

      if (settings.autoDisable && account.desired_enabled === 1
        && blockedWindow) {
        const outcome = await setAutomatedState(
          db, adapters, config, account, false, blockedWindow, settings.thresholdPercent,
        );
        if (outcome === 'synced') result.disabled += 1;
        else if (outcome === 'pending') result.failed += 1;
        continue;
      }
      if (settings.autoEnable && account.desired_enabled === 0 && account.quota_auto_disabled === 1
        && !blockedWindow && !hasUnknownWindow && quotaHasReset(account, windows, now)) {
        const outcome = await setAutomatedState(
          db, adapters, config, account, true,
          windows.find((window) => window.name === account.quota_reset_window) || windows[0],
          settings.thresholdPercent,
        );
        if (outcome === 'synced') result.enabled += 1;
        else if (outcome === 'pending') result.failed += 1;
      }
    } catch (error) {
      // A pending resume may already have reached one router. Revoke it if
      // upstream quota cannot be verified on this tick.
      if (account.quota_auto_disabled === 1 && account.desired_enabled === 1) {
        try {
          const outcome = await setAutomatedState(db, adapters, config, account, false, {
            name: account.quota_reset_window,
            resetAt: account.quota_session_reset_at,
            remaining: null,
          }, settings.thresholdPercent);
          if (outcome === 'synced') result.disabled += 1;
          else if (outcome === 'pending') result.failed += 1;
        } catch (rollbackError) {
          logger?.error?.({ accountId: account.id, provider: account.provider,
            error: safeError(rollbackError) },
          'Quota resume rollback failed');
        }
      }
      // One unavailable upstream must not block checks for other accounts.
      result.failed += 1;
      logger?.warn?.({ accountId: account.id, provider: account.provider, error: safeError(error) },
        'Quota automation check failed');
    }
  }
  return result;
}

export function startQuotaAutomationScheduler(db, adapters, config, fetchByProvider = {}, logger = null) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runQuotaAutomationTick(db, adapters, config, fetchByProvider, Date.now(), logger);
      if (result.enabled || result.disabled || result.failed) {
        logger?.info?.(result, 'Quota automation tick');
      }
    } catch (error) {
      logger?.error?.({ err: error }, 'Quota automation tick failed');
    }
    finally { running = false; }
  };
  const handle = setInterval(tick, config.quotaCheckIntervalMinutes * 60_000);
  handle.unref?.();
  queueMicrotask(tick);
  return () => clearInterval(handle);
}
