import { randomBytes } from 'node:crypto';
import { hashPassword } from '../services/auth.js';
import { destroyUserSessions } from '../services/auth.js';
import { audit } from '../services/audit.js';

function requireAdmin(request, reply) {
  if (!request.user) { reply.code(401).send({ error: 'Not authenticated' }); return false; }
  if (request.user.role !== 'admin') { reply.code(403).send({ error: 'Admin role required' }); return false; }
  return true;
}

export default async function adminRoutes(app, { db }) {
  app.get('/api/admin/users', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    return db.prepare(`
      SELECT u.id, u.username, u.role, u.disabled, u.must_change_password, u.created_at,
             (SELECT COUNT(*) FROM sponsored_accounts a WHERE a.owner_id = u.id) AS account_count
      FROM users u ORDER BY u.created_at
    `).all().map((row) => ({
      id: row.id,
      username: row.username,
      role: row.role,
      disabled: Boolean(row.disabled),
      mustChangePassword: Boolean(row.must_change_password),
      accountCount: row.account_count,
      createdAt: row.created_at,
    }));
  });

  /** Issues a temporary password; the admin never sees the user's real password. */
  app.post('/api/admin/users/:id/reset-password', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(request.params.id);
    if (!user) return reply.code(404).send({ error: 'User not found' });
    const temporary = randomBytes(12).toString('base64url');
    db.prepare(`
      UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(await hashPassword(temporary), user.id);
    destroyUserSessions(db, user.id);
    audit(db, {
      actorId: request.user.id, action: 'admin.reset_password', targetType: 'user', targetId: user.id, ip: request.ip,
    });
    return reply.send({ username: user.username, temporaryPassword: temporary });
  });

  app.patch('/api/admin/users/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const user = db.prepare('SELECT id, role, disabled FROM users WHERE id = ?').get(request.params.id);
    if (!user) return reply.code(404).send({ error: 'User not found' });
    const { disabled, role } = request.body ?? {};

    if (role !== undefined && !['user', 'admin'].includes(role)) {
      return reply.code(400).send({ error: 'role must be user or admin' });
    }
    const losingAdmin = (role !== undefined && user.role === 'admin' && role !== 'admin')
      || (disabled === true && user.role === 'admin');
    if (losingAdmin) {
      const remaining = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?")
        .get(user.id).n;
      if (remaining === 0) return reply.code(409).send({ error: 'Cannot remove the last active admin' });
    }
    if (typeof disabled === 'boolean') {
      db.prepare('UPDATE users SET disabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(disabled ? 1 : 0, user.id);
      if (disabled) destroyUserSessions(db, user.id);
    }
    if (role !== undefined) {
      db.prepare('UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(role, user.id);
    }
    audit(db, {
      actorId: request.user.id, action: 'admin.update_user', targetType: 'user', targetId: user.id,
      detail: JSON.stringify({ disabled, role }), ip: request.ip,
    });
    return reply.send({ ok: true });
  });

  app.get('/api/admin/audit', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const limit = Math.min(Number(request.query.limit) || 100, 500);
    return db.prepare(`
      SELECT l.id, l.action, l.target_type, l.target_id, l.detail, l.created_at, u.username AS actor
      FROM audit_log l LEFT JOIN users u ON u.id = l.actor_id
      ORDER BY l.id DESC LIMIT ?
    `).all(limit);
  });
}
