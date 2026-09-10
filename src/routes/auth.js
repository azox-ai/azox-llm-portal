import { validPassword } from '../lib/validation.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  hashPassword, verifyPassword, createSession, destroySession, destroyUserSessions,
} from '../services/auth.js';
import { audit } from '../services/audit.js';

export default async function authRoutes(app, { db, config }) {
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookies,
    path: '/',
    signed: true,
  };

  function issue(reply, userId) {
    const session = createSession(db, userId, config.sessionHours);
    reply.setCookie('sp_session', session.token, { ...cookieOptions, expires: new Date(session.expires) });
    return session;
  }

  async function authenticate(request, reply, username, password) {
    const user = typeof username === 'string'
      ? db.prepare('SELECT * FROM users WHERE username = ?').get(username)
      : null;
    // Always run a verify to keep timing uniform between unknown and known users.
    const reference = user?.password_hash
      ?? '$argon2id$v=19$m=19456,t=3,p=1$c3BvbnNvcnBvcnRhbA$3Q0nQ0G0nZ1s2mB0dQ2gGZ5nqQ0nJx0V0mK0aA1qA0A';
    const ok = await verifyPassword(reference, typeof password === 'string' ? password : '');

    if (!user || !ok || user.disabled) {
      audit(db, { action: 'user.login_failed', targetType: 'user', targetId: username ?? null, ip: request.ip });
      return reply.code(401).send({ error: 'Invalid username or password' });
    }
    const session = issue(reply, user.id);
    audit(db, { actorId: user.id, action: 'user.login', targetType: 'user', targetId: user.id, ip: request.ip });
    return reply.send({
      id: user.id,
      username: user.username,
      role: user.role,
      csrfToken: session.csrf,
    });
  }

  app.post('/api/login', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const { username, password } = request.body ?? {};
    return authenticate(request, reply, username, password);
  });

  app.post('/api/login/admin', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const supplied = typeof request.body?.password === 'string' ? request.body.password : '';
    const expected = config.initialAdminPassword || '';
    const suppliedDigest = createHash('sha256').update(supplied).digest();
    const expectedDigest = createHash('sha256').update(expected).digest();
    const valid = Boolean(expected) && timingSafeEqual(suppliedDigest, expectedDigest);
    const user = db.prepare("SELECT * FROM users WHERE username = ? AND role = 'admin' AND disabled = 0")
      .get(config.initialAdminUsername);
    if (!valid || !user) {
      audit(db, { action: 'admin.login_failed', targetType: 'user', targetId: config.initialAdminUsername, ip: request.ip });
      return reply.code(401).send({ error: 'Invalid admin password' });
    }
    const session = issue(reply, user.id);
    audit(db, { actorId: user.id, action: 'admin.login', targetType: 'user', targetId: user.id, ip: request.ip });
    return reply.send({ id: user.id, username: user.username, role: user.role, csrfToken: session.csrf });
  });

  app.post('/api/logout', async (request, reply) => {
    const token = request.unsignCookie(request.cookies.sp_session ?? '').value;
    destroySession(db, token);
    reply.clearCookie('sp_session', { path: '/' });
    return reply.send({ ok: true });
  });

  app.get('/api/me', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Not authenticated' });
    return reply.send({
      id: request.user.id,
      username: request.user.username,
      role: request.user.role,
      csrfToken: request.user.csrf_token,
    });
  });

  app.post('/api/password', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Not authenticated' });
    const { currentPassword, newPassword } = request.body ?? {};
    if (!validPassword(newPassword)) {
      return reply.code(400).send({ error: 'Password must be at least 12 characters' });
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(request.user.id);
    if (!await verifyPassword(user.password_hash, currentPassword ?? '')) {
      return reply.code(401).send({ error: 'Current password is incorrect' });
    }
    const hash = await hashPassword(newPassword);
    db.prepare(`
      UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(hash, user.id);
    destroyUserSessions(db, user.id);
    issue(reply, user.id);
    audit(db, {
      actorId: user.id, action: 'user.password_changed', targetType: 'user', targetId: user.id, ip: request.ip,
    });
    return reply.send({ ok: true });
  });
}
