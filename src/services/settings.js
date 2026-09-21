const REFRESH_LEAD_KEY = 'refresh_lead_hours';
const SESSION_QUOTA_AUTO_DISABLE_KEY = 'session_quota_auto_disable';
const SESSION_QUOTA_THRESHOLD_KEY = 'session_quota_threshold_percent';
const SESSION_QUOTA_AUTO_ENABLE_KEY = 'session_quota_auto_enable';
export const MIN_REFRESH_LEAD_HOURS = 1;
export const MAX_REFRESH_LEAD_HOURS = 168;
export const MIN_SESSION_QUOTA_THRESHOLD = 0;
export const MAX_SESSION_QUOTA_THRESHOLD = 100;
export const DEFAULT_SESSION_QUOTA_THRESHOLD = 30;

function defaultRefreshLeadHours(config) {
  return Math.max(MIN_REFRESH_LEAD_HOURS, Math.ceil(config.refreshLeadMinutes / 60));
}

export function getRefreshLeadHours(db, config) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(REFRESH_LEAD_KEY);
  const hours = Number(row?.value);
  return Number.isInteger(hours) && hours >= MIN_REFRESH_LEAD_HOURS && hours <= MAX_REFRESH_LEAD_HOURS
    ? hours
    : defaultRefreshLeadHours(config);
}

export function getRefreshLeadMs(db, config) {
  return getRefreshLeadHours(db, config) * 60 * 60_000;
}

export function setRefreshLeadHours(db, hours) {
  if (!Number.isInteger(hours) || hours < MIN_REFRESH_LEAD_HOURS || hours > MAX_REFRESH_LEAD_HOURS) {
    throw new RangeError(`Refresh lead time must be ${MIN_REFRESH_LEAD_HOURS}-${MAX_REFRESH_LEAD_HOURS} hours`);
  }
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(REFRESH_LEAD_KEY, String(hours));
  return hours;
}

function storedBoolean(db, key, fallback) {
  const value = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return fallback;
}

function setValue(db, key, value) {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, String(value));
}

export function getSessionQuotaSettings(db) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(SESSION_QUOTA_THRESHOLD_KEY);
  const storedThreshold = Number(row?.value);
  const thresholdPercent = Number.isInteger(storedThreshold)
    && storedThreshold >= MIN_SESSION_QUOTA_THRESHOLD
    && storedThreshold <= MAX_SESSION_QUOTA_THRESHOLD
    ? storedThreshold
    : DEFAULT_SESSION_QUOTA_THRESHOLD;
  return {
    autoDisable: storedBoolean(db, SESSION_QUOTA_AUTO_DISABLE_KEY, true),
    thresholdPercent,
    autoEnable: storedBoolean(db, SESSION_QUOTA_AUTO_ENABLE_KEY, true),
  };
}

export function validateSessionQuotaSettings({ autoDisable, thresholdPercent, autoEnable }) {
  if (typeof autoDisable !== 'boolean') throw new TypeError('Session quota auto-disable must be a boolean');
  if (typeof autoEnable !== 'boolean') throw new TypeError('Session quota auto-enable must be a boolean');
  if (!Number.isInteger(thresholdPercent)
    || thresholdPercent < MIN_SESSION_QUOTA_THRESHOLD
    || thresholdPercent > MAX_SESSION_QUOTA_THRESHOLD) {
    throw new RangeError(`Session quota threshold must be ${MIN_SESSION_QUOTA_THRESHOLD}-${MAX_SESSION_QUOTA_THRESHOLD} percent`);
  }
  return { autoDisable, thresholdPercent, autoEnable };
}

export function setSessionQuotaSettings(db, { autoDisable, thresholdPercent, autoEnable }) {
  validateSessionQuotaSettings({ autoDisable, thresholdPercent, autoEnable });
  setValue(db, SESSION_QUOTA_AUTO_DISABLE_KEY, autoDisable ? 1 : 0);
  setValue(db, SESSION_QUOTA_THRESHOLD_KEY, thresholdPercent);
  setValue(db, SESSION_QUOTA_AUTO_ENABLE_KEY, autoEnable ? 1 : 0);
  return { autoDisable, thresholdPercent, autoEnable };
}

export function getUserSessionQuotaSettings(db, userId) {
  const adminDefaults = getSessionQuotaSettings(db);
  const row = db.prepare(`
    SELECT auto_disable, threshold_percent, auto_enable
    FROM user_quota_settings WHERE user_id = ?
  `).get(userId);
  if (!row) return { ...adminDefaults, source: 'admin', adminDefaults };
  return {
    autoDisable: Boolean(row.auto_disable),
    thresholdPercent: row.threshold_percent,
    autoEnable: Boolean(row.auto_enable),
    source: 'user',
    adminDefaults,
  };
}

export function setUserSessionQuotaSettings(db, userId, settings) {
  const validated = validateSessionQuotaSettings(settings);
  db.prepare(`
    INSERT INTO user_quota_settings
      (user_id, auto_disable, threshold_percent, auto_enable, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      auto_disable = excluded.auto_disable,
      threshold_percent = excluded.threshold_percent,
      auto_enable = excluded.auto_enable,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    userId,
    validated.autoDisable ? 1 : 0,
    validated.thresholdPercent,
    validated.autoEnable ? 1 : 0,
  );
  return getUserSessionQuotaSettings(db, userId);
}

export function deleteUserSessionQuotaSettings(db, userId) {
  db.prepare('DELETE FROM user_quota_settings WHERE user_id = ?').run(userId);
  return getUserSessionQuotaSettings(db, userId);
}
