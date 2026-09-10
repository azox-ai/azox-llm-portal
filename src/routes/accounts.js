import { randomToken, hashToken, encryptJson, decryptJson } from '../lib/crypto.js';
import { createVerifier } from '../oauth/pkce.js';
import {
  buildAuthorizeUrl, exchangeCode, resolveIdentity, parseCallbackInput,
} from '../oauth/client.js';
import { ownAccount } from '../lib/validation.js';
import { audit } from '../services/audit.js';
import {
  ROUTERS, aggregateStatus, markPending, reconcileAccount, removeAccount,
} from '../services/sync.js';
import { fetchQuota } from '../services/quota.js';
import { refreshAccount } from '../services/refresh.js';

export default async function accountRoutes(app, { db, config, adapters, oauthFetch = {} }) {
  async function completeOauth(request, reply, provider, code, state, redirect) {
    if (!code || !state || !['claude', 'codex'].includes(provider)) {
      return reply.code(400).send({ error: 'Invalid OAuth callback' });
    }
    const saved = db.prepare(`
      DELETE FROM oauth_states
      WHERE state_hash = ? AND user_id = ? AND provider = ? AND expires_at > CURRENT_TIMESTAMP
      RETURNING verifier
    `).get(hashToken(state), request.user.id, provider);
    if (!saved) return reply.code(400).send({ error: 'OAuth state expired or invalid' });

    try {
      const providerConfig = config[provider];
      const fetchImpl = oauthFetch[provider] || fetch;
      const tokenSet = await exchangeCode(providerConfig, { code, verifier: saved.verifier }, fetchImpl);
      const identity = await resolveIdentity(providerConfig, tokenSet, fetchImpl);
      const duplicate = db.prepare('SELECT id, owner_id FROM provider_accounts WHERE provider = ? AND upstream_subject = ?')
        .get(provider, identity.subject);
      if (duplicate && duplicate.owner_id !== request.user.id) {
        return reply.code(409).send({ error: 'This account is already registered by another user' });
      }

      let accountId;
      const envelope = encryptJson(tokenSet, config.encryptionKey);
      if (duplicate) {
        accountId = duplicate.id;
        db.prepare(`
          UPDATE provider_accounts SET display_name = ?, credential_envelope = ?, credential_status = 'active',
            desired_enabled = 1, token_version = token_version + 1, access_expires_at = ?,
            last_refresh_at = CURRENT_TIMESTAMP, last_refresh_error = NULL,
            updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(identity.label, envelope, tokenSet.expiresAt, accountId);
      } else {
        const result = db.prepare(`
          INSERT INTO provider_accounts
            (owner_id, provider, upstream_subject, display_name, credential_envelope, access_expires_at, last_refresh_at)
          VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(request.user.id, provider, identity.subject, identity.label, envelope, tokenSet.expiresAt);
        accountId = Number(result.lastInsertRowid);
      }
      markPending(db, accountId);
      audit(db, {
        actorId: request.user.id, action: duplicate ? 'account.reauthenticated' : 'account.added',
        targetType: 'account', targetId: accountId, detail: provider, ip: request.ip,
      });
      const routers = await reconcileAccount(db, adapters, config, accountId);
      return redirect
        ? reply.redirect(`/?oauth=success&account=${accountId}`)
        : reply.send({ ok: true, accountId, routers });
    } catch (exchangeError) {
      request.log.warn({ err: exchangeError, provider }, 'OAuth callback failed');
      return redirect
        ? reply.redirect('/?oauth=failed')
        : reply.code(502).send({ error: 'OAuth exchange failed' });
    }
  }

  app.get('/api/accounts', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Not authenticated' });
    const rows = db.prepare(`
      SELECT a.id, a.provider, a.display_name, a.desired_enabled, a.credential_status,
             a.access_expires_at, a.last_refresh_at, a.last_refresh_error,
             a.created_at, a.updated_at, u.username AS owner_username
      FROM provider_accounts a JOIN users u ON u.id = a.owner_id
      WHERE a.owner_id = ?
      ORDER BY a.created_at DESC
    `).all(request.user.id);
    const connections = db.prepare(`
      SELECT router, sync_status, last_error, last_synced_at
      FROM router_connections WHERE account_id = ?
    `);
    return rows.map((row) => {
      const states = Object.fromEntries(connections.all(row.id).map((c) => [c.router, {
        status: c.sync_status,
        error: c.last_error,
        lastSyncedAt: c.last_synced_at,
      }]));
      const statusMap = Object.fromEntries(Object.entries(states).map(([k, v]) => [k, v.status]));
      return {
        id: row.id,
        provider: row.provider,
        displayName: row.display_name,
        owner: row.owner_username,
        enabled: Boolean(row.desired_enabled),
        credentialStatus: row.credential_status,
        accessExpiresAt: row.access_expires_at,
        lastRefreshAt: row.last_refresh_at,
        lastRefreshError: row.last_refresh_error,
        status: aggregateStatus(statusMap),
        routers: states,
        createdAt: row.created_at,
      };
    });
  });

  app.post('/api/oauth/:provider/start', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Not authenticated' });
    const { provider } = request.params;
    const providerConfig = config[provider];
    if (!['claude', 'codex'].includes(provider) || !providerConfig?.authorizeUrl || !providerConfig?.clientId) {
      return reply.code(400).send({ error: 'OAuth provider is not configured' });
    }
    const state = randomToken();
    const verifier = createVerifier();
    const expires = new Date(Date.now() + config.oauthStateMinutes * 60_000).toISOString();
    db.prepare('DELETE FROM oauth_states WHERE expires_at <= CURRENT_TIMESTAMP').run();
    db.prepare('INSERT INTO oauth_states (state_hash, user_id, provider, verifier, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(hashToken(state), request.user.id, provider, verifier, expires);
    return reply.send({
      url: buildAuthorizeUrl(providerConfig, { state, verifier }),
      provider,
      // The modal renders a provider-accurate step 2: Claude's manual flow
      // shows `code#state` in the browser, Codex redirects to its fixed
      // localhost:1455 callback which the operator copies out of the address bar.
      redirectUri: providerConfig.redirectUri,
      expiresInMinutes: config.oauthStateMinutes,
    });
  });

  app.get('/api/oauth/:provider/callback', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Not authenticated' });
    const { provider } = request.params;
    const { code, state, error } = request.query;
    if (error) return reply.redirect('/?oauth=denied');
    return completeOauth(request, reply, provider, code, state, true);
  });

  app.post('/api/oauth/:provider/complete', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Not authenticated' });
    const parsed = parseCallbackInput(request.body?.callback);
    if (!parsed?.code || !parsed.state) {
      return reply.code(400).send({ error: 'Paste the complete callback URL or code#state' });
    }
    return completeOauth(request, reply, request.params.provider, parsed.code, parsed.state, false);
  });

  app.patch('/api/accounts/:id/state', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Not authenticated' });
    const account = ownAccount(db, request.params.id, request.user);
    if (!account) return reply.code(404).send({ error: 'Account not found' });
    if (typeof request.body?.enabled !== 'boolean') {
      return reply.code(400).send({ error: 'enabled must be a boolean' });
    }
    if (request.body.enabled && account.credential_status !== 'active') {
      return reply.code(409).send({ error: 'Account needs OAuth authentication' });
    }
    db.prepare('UPDATE provider_accounts SET desired_enabled = ?, token_version = token_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(request.body.enabled ? 1 : 0, account.id);
    markPending(db, account.id);
    const result = await reconcileAccount(db, adapters, config, account.id);
    audit(db, {
      actorId: request.user.id, action: request.body.enabled ? 'account.enabled' : 'account.disabled',
      targetType: 'account', targetId: account.id, ip: request.ip,
    });
    return reply.send({ ok: true, routers: result });
  });

  app.post('/api/accounts/:id/retry', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Not authenticated' });
    const account = ownAccount(db, request.params.id, request.user);
    if (!account) return reply.code(404).send({ error: 'Account not found' });
    markPending(db, account.id);
    return reply.send({ ok: true, routers: await reconcileAccount(db, adapters, config, account.id) });
  });

  // Quota Tracker is deliberately read-only. It has only GET routes; account
  // state changes remain in the Providers surface and are owner-scoped.
  app.get('/api/accounts/:id/quota', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Not authenticated' });
    const account = ownAccount(db, request.params.id, request.user);
    if (!account) return reply.code(404).send({ error: 'Account not found' });
    if (account.owner_id !== request.user.id) return reply.code(404).send({ error: 'Account not found' });
    try {
      const expiresAt = Date.parse(account.access_expires_at || '');
      if (Number.isFinite(expiresAt) && expiresAt <= Date.now() + config.refreshLeadMinutes * 60_000) {
        await refreshAccount(db, adapters, config, account.id, oauthFetch[account.provider] || fetch);
      }
      const current = db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(account.id);
      return await fetchQuota(
        current.provider,
        decryptJson(current.credential_envelope, config.encryptionKey),
        oauthFetch[`${account.provider}Quota`] || fetch,
      );
    } catch (error) {
      request.log.warn({ err: error, accountId: account.id }, 'Quota fetch failed');
      return reply.code(502).send({ error: 'Quota upstream unavailable' });
    }
  });

  app.delete('/api/accounts/:id', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Not authenticated' });
    const account = ownAccount(db, request.params.id, request.user);
    if (!account) return reply.code(404).send({ error: 'Account not found' });
    // Fail closed: preserve the portal record and credential until every router
    // confirms deletion, otherwise an orphaned active connection becomes invisible.
    const result = await removeAccount(db, adapters, account.id);
    audit(db, {
      actorId: request.user.id, action: result.removed ? 'account.removed' : 'account.remove_failed',
      targetType: 'account', targetId: account.id, detail: result.failures.map((f) => f.router).join(','), ip: request.ip,
    });
    if (!result.removed) {
      return reply.code(502).send({ error: 'Could not remove account from every router', failures: result.failures });
    }
    return reply.send({ ok: true });
  });

  app.get('/api/router-status', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Not authenticated' });
    return Object.fromEntries(ROUTERS.map((key) => [key, { configured: adapters[key].configured }]));
  });
}
