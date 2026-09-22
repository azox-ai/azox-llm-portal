import { randomBytes } from 'node:crypto';
import { hashPassword, destroyUserSessions } from '../services/auth.js';
import { validUsername, validPassword } from '../lib/validation.js';
import { audit } from '../services/audit.js';
import { removeAccount } from '../services/sync.js';
import {
  getRefreshLeadHours, setRefreshLeadHours, MIN_REFRESH_LEAD_HOURS, MAX_REFRESH_LEAD_HOURS,
  getSessionQuotaSettings, setSessionQuotaSettings,
  MIN_SESSION_QUOTA_THRESHOLD, MAX_SESSION_QUOTA_THRESHOLD,
} from '../services/settings.js';

function requireAdmin(request, reply) {
  if (!request.user) { reply.code(401).send({ error: 'Not authenticated' }); return false; }
  if (request.user.role !== 'admin') { reply.code(403).send({ error: 'Admin role required' }); return false; }
  return true;
}

const ACTION_LABELS = {
  'account.added': 'account added',
  'account.reauthenticated': 'account re-authenticated',
  'account.enabled': 'account enabled',
  'account.disabled': 'account disabled',
  'account.auto_enabled_quota': 'account auto-enabled after quota reset',
  'account.auto_disabled_quota': 'account auto-disabled by quota',
  'account.removed': 'account removed',
  'account.remove_failed': 'account removal failed',
  'admin.create_user': 'user created',
  'admin.reset_password': 'password reset',
  'admin.remove_user': 'user removed',
  'admin.remove_user_failed': 'user removal failed',
  'admin.update_user': 'user updated',
  'user.login': 'user login',
  'user.login_failed': 'user login failed',
  'admin.login': 'admin login',
  'admin.login_failed': 'admin login failed',
  'user.registered': 'user registered',
  'user.password_changed': 'password changed',
  'user.update_quota_settings': 'personal quota settings updated',
  'user.reset_quota_settings': 'personal quota settings reset',
};

function auditTarget(entry) {
  if (entry.resolved_target) return entry.resolved_target;
  const targetId = entry.target_id || '-';
  if (/^\d+$/.test(targetId)) {
    const action = ACTION_LABELS[entry.action] || entry.action.replace(/[._]/g, ' ');
    return `${targetId} (${action})`;
  }
  return targetId;
}

function sqliteUtcToIso(value) {
  if (typeof value !== 'string') return value;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) {
    return `${value.replace(' ', 'T')}Z`;
  }
  return value;
}

export default async function adminRoutes(app, { db, adapters, config }) {
  app.get('/api/admin/settings', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const quota = getSessionQuotaSettings(db);
    return {
      refreshLeadHours: getRefreshLeadHours(db, config),
      sessionQuotaAutoDisable: quota.autoDisable,
      sessionQuotaThresholdPercent: quota.thresholdPercent,
      sessionQuotaAutoEnable: quota.autoEnable,
    };
  });

  app.patch('/api/admin/settings', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const body = request.body || {};
    const hasRefreshLead = Object.hasOwn(body, 'refreshLeadHours');
    const hasQuotaSetting = ['sessionQuotaAutoDisable', 'sessionQuotaThresholdPercent', 'sessionQuotaAutoEnable']
      .some((key) => Object.hasOwn(body, key));
    if (!hasRefreshLead && !hasQuotaSetting) {
      return reply.code(400).send({ error: 'No supported setting supplied' });
    }

    const refreshLeadHours = hasRefreshLead ? Number(body.refreshLeadHours) : null;
    if (hasRefreshLead && (!Number.isInteger(refreshLeadHours)
      || refreshLeadHours < MIN_REFRESH_LEAD_HOURS
      || refreshLeadHours > MAX_REFRESH_LEAD_HOURS)) {
      return reply.code(400).send({ error: `Refresh lead time must be ${MIN_REFRESH_LEAD_HOURS}-${MAX_REFRESH_LEAD_HOURS} hours` });
    }
    const currentQuota = getSessionQuotaSettings(db);
    const quota = {
      autoDisable: Object.hasOwn(body, 'sessionQuotaAutoDisable')
        ? body.sessionQuotaAutoDisable : currentQuota.autoDisable,
      thresholdPercent: Object.hasOwn(body, 'sessionQuotaThresholdPercent')
        ? Number(body.sessionQuotaThresholdPercent) : currentQuota.thresholdPercent,
      autoEnable: Object.hasOwn(body, 'sessionQuotaAutoEnable')
        ? body.sessionQuotaAutoEnable : currentQuota.autoEnable,
    };
    if (hasQuotaSetting && (typeof quota.autoDisable !== 'boolean' || typeof quota.autoEnable !== 'boolean')) {
      return reply.code(400).send({ error: 'Quota auto-enable and auto-disable must be booleans' });
    }
    if (hasQuotaSetting && (!Number.isInteger(quota.thresholdPercent)
      || quota.thresholdPercent < MIN_SESSION_QUOTA_THRESHOLD
      || quota.thresholdPercent > MAX_SESSION_QUOTA_THRESHOLD)) {
      return reply.code(400).send({ error: `Quota threshold must be ${MIN_SESSION_QUOTA_THRESHOLD}-${MAX_SESSION_QUOTA_THRESHOLD} percent` });
    }

    if (hasRefreshLead) setRefreshLeadHours(db, refreshLeadHours);
    if (hasQuotaSetting) setSessionQuotaSettings(db, quota);
    const updatedQuota = getSessionQuotaSettings(db);
    const updated = {
      refreshLeadHours: getRefreshLeadHours(db, config),
      sessionQuotaAutoDisable: updatedQuota.autoDisable,
      sessionQuotaThresholdPercent: updatedQuota.thresholdPercent,
      sessionQuotaAutoEnable: updatedQuota.autoEnable,
    };
    audit(db, {
      actorId: request.user.id, action: 'admin.update_settings', targetType: 'setting',
      targetId: hasQuotaSetting && !hasRefreshLead ? 'session_quota_automation' : 'portal',
      detail: JSON.stringify(updated), ip: request.ip,
    });
    return updated;
  });

  app.get('/api/admin/users', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    return db.prepare(`
      SELECT u.id, u.username, u.role, u.disabled, u.created_at,
             (SELECT COUNT(*) FROM provider_accounts a WHERE a.owner_id = u.id) AS account_count
      FROM users u ORDER BY u.created_at
    `).all().map((row) => ({
      id: row.id,
      username: row.username,
      role: row.role,
      disabled: Boolean(row.disabled),
      accountCount: row.account_count,
      createdAt: row.created_at,
    }));
  });

  // Accounts exist only because an admin creates them: there is no
  // self-registration, so the admin sets the first password and hands it over
  // out of band. The user may change it later but is never forced to.
  app.post('/api/admin/users', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { username, password, role = 'user' } = request.body ?? {};
    if (!validUsername(username)) {
      return reply.code(400).send({ error: 'Username must be 3-64 chars: letters, digits, . _ -' });
    }
    if (!validPassword(password)) {
      return reply.code(400).send({ error: 'Password must be at least 12 characters' });
    }
    if (!['user', 'admin'].includes(role)) {
      return reply.code(400).send({ error: 'role must be user or admin' });
    }
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
      return reply.code(409).send({ error: 'Username already taken' });
    }
    const result = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run(username, await hashPassword(password), role);
    const userId = Number(result.lastInsertRowid);
    audit(db, {
      actorId: request.user.id, action: 'admin.create_user', targetType: 'user', targetId: userId,
      detail: role, ip: request.ip,
    });
    return reply.code(201).send({ id: userId, username, role });
  });

  /** Issues a temporary password; the admin never sees the user's real password. */
  app.post('/api/admin/users/:id/reset-password', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(request.params.id);
    if (!user) return reply.code(404).send({ error: 'User not found' });
    const requestedPassword = request.body?.password;
    if (requestedPassword !== undefined && !validPassword(requestedPassword)) {
      return reply.code(400).send({ error: 'Password must be at least 12 characters' });
    }
    const temporary = requestedPassword || randomBytes(12).toString('base64url');
    db.prepare(`
      UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(await hashPassword(temporary), user.id);
    destroyUserSessions(db, user.id);
    audit(db, {
      actorId: request.user.id, action: 'admin.reset_password', targetType: 'user', targetId: user.id, ip: request.ip,
    });
    return reply.send({
      username: user.username,
      ...(requestedPassword ? {} : { temporaryPassword: temporary }),
    });
  });

  app.delete('/api/admin/users/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(request.params.id);
    if (!user) return reply.code(404).send({ error: 'User not found' });
    if (user.id === request.user.id) return reply.code(409).send({ error: 'Cannot remove your own account' });
    if (user.role === 'admin') {
      const remaining = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?")
        .get(user.id).n;
      if (remaining === 0) return reply.code(409).send({ error: 'Cannot remove the last active admin' });
    }

    const accounts = db.prepare('SELECT id FROM provider_accounts WHERE owner_id = ? ORDER BY id').all(user.id);
    for (const account of accounts) {
      const result = await removeAccount(db, adapters, account.id);
      if (!result.removed) {
        audit(db, {
          actorId: request.user.id, action: 'admin.remove_user_failed', targetType: 'user', targetId: user.id,
          detail: result.failures.map((failure) => failure.router).join(','), ip: request.ip,
        });
        return reply.code(502).send({ error: 'Could not remove user accounts from every router', failures: result.failures });
      }
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    audit(db, {
      actorId: request.user.id, action: 'admin.remove_user', targetType: 'user', targetId: user.id,
      detail: user.username, ip: request.ip,
    });
    return reply.code(204).send();
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
    const page = Math.max(1, Number.parseInt(request.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(10, Number.parseInt(request.query.pageSize, 10) || 20));
    const total = db.prepare('SELECT COUNT(*) AS total FROM audit_log').get().total;
    const items = db.prepare(`
      SELECT l.id, l.action, l.target_type, l.target_id, l.detail, l.created_at,
        actor.username AS actor,
        CASE
          WHEN l.target_type = 'user' THEN target_user.username
          WHEN l.target_type = 'account' THEN target_account.display_name
          ELSE NULL
        END AS resolved_target
      FROM audit_log l
      LEFT JOIN users actor ON actor.id = l.actor_id
      LEFT JOIN users target_user
        ON l.target_type = 'user' AND target_user.id = CAST(l.target_id AS INTEGER)
      LEFT JOIN provider_accounts target_account
        ON l.target_type = 'account' AND target_account.id = CAST(l.target_id AS INTEGER)
      ORDER BY l.id DESC LIMIT ? OFFSET ?
    `).all(pageSize, (page - 1) * pageSize).map((entry) => ({
      id: entry.id,
      time: sqliteUtcToIso(entry.created_at),
      actor: entry.actor || 'system',
      action: entry.action,
      target: auditTarget(entry),
      detail: entry.detail,
    }));
    return {
      items,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  });
}
