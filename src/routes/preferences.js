import { audit } from '../services/audit.js';
import {
  deleteUserSessionQuotaSettings,
  getUserSessionQuotaSettings,
  setUserSessionQuotaSettings,
} from '../services/settings.js';

function requireUser(request, reply) {
  if (!request.user) {
    reply.code(401).send({ error: 'Not authenticated' });
    return false;
  }
  return true;
}

function responseFor(settings) {
  return {
    sessionQuotaAutoDisable: settings.autoDisable,
    sessionQuotaThresholdPercent: settings.thresholdPercent,
    sessionQuotaAutoEnable: settings.autoEnable,
    source: settings.source,
    adminDefaults: {
      sessionQuotaAutoDisable: settings.adminDefaults.autoDisable,
      sessionQuotaThresholdPercent: settings.adminDefaults.thresholdPercent,
      sessionQuotaAutoEnable: settings.adminDefaults.autoEnable,
    },
  };
}

export default async function preferenceRoutes(app, { db }) {
  app.get('/api/me/quota-settings', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    return responseFor(getUserSessionQuotaSettings(db, request.user.id));
  });

  app.patch('/api/me/quota-settings', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const body = request.body || {};
    const settings = {
      autoDisable: body.sessionQuotaAutoDisable,
      thresholdPercent: body.sessionQuotaThresholdPercent,
      autoEnable: body.sessionQuotaAutoEnable,
    };
    try {
      const updated = setUserSessionQuotaSettings(db, request.user.id, settings);
      audit(db, {
        actorId: request.user.id,
        action: 'user.update_quota_settings',
        targetType: 'user',
        targetId: request.user.id,
        detail: JSON.stringify(responseFor(updated)),
        ip: request.ip,
      });
      return responseFor(updated);
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });

  app.delete('/api/me/quota-settings', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const updated = deleteUserSessionQuotaSettings(db, request.user.id);
    audit(db, {
      actorId: request.user.id,
      action: 'user.reset_quota_settings',
      targetType: 'user',
      targetId: request.user.id,
      ip: request.ip,
    });
    return responseFor(updated);
  });
}
