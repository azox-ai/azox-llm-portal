const REFRESH_LEAD_KEY = 'refresh_lead_hours';
export const MIN_REFRESH_LEAD_HOURS = 1;
export const MAX_REFRESH_LEAD_HOURS = 168;

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
