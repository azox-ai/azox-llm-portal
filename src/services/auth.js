import argon2 from 'argon2';
import { randomToken, hashToken } from '../lib/crypto.js';

const OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 3, parallelism: 1 };

export async function hashPassword(password) {
  return argon2.hash(password, OPTIONS);
}

export async function verifyPassword(hash, password) {
  try { return await argon2.verify(hash, password); } catch { return false; }
}

export async function ensureInitialAdmin(db, config) {
  const count = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
  if (count > 0 || !config.initialAdminPassword) return false;
  const hash = await hashPassword(config.initialAdminPassword);
  db.prepare(`INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, 'admin', 1)`)
    .run(config.initialAdminUsername, hash);
  return true;
}

export function createSession(db, userId, hours) {
  const token = randomToken();
  const csrf = randomToken();
  const expires = new Date(Date.now() + hours * 3600_000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)')
    .run(hashToken(token), userId, csrf, expires);
  return { token, csrf, expires };
}

export function getSession(db, token) {
  if (!token) return null;
  return db.prepare(`
    SELECT u.id, u.username, u.role, u.must_change_password, s.csrf_token
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > CURRENT_TIMESTAMP AND u.disabled = 0
  `).get(hashToken(token)) || null;
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function destroyUserSessions(db, userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}
