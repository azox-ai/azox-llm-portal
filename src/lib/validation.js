export function validUsername(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,63}$/.test(value);
}

export function validPassword(value) {
  return typeof value === 'string' && value.length >= 12 && value.length <= 256;
}

export function ownAccount(db, accountId, user) {
  return db.prepare(`
    SELECT a.*, u.username AS owner_username
    FROM sponsored_accounts a JOIN users u ON u.id = a.owner_id
    WHERE a.id = ? AND (a.owner_id = ? OR ? = 'admin')
  `).get(accountId, user.id, user.role);
}

export function safeError(error) {
  if (error?.statusCode) return `HTTP ${error.statusCode}`;
  if (error?.code) return String(error.code).slice(0, 80);
  return 'Remote operation failed';
}
