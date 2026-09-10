/**
 * Privileged admin-API adapters for the two downstream routers.
 *
 * There is deliberately no shared HTTP contract here. 9router and OmniRoute
 * expose different endpoints, different body shapes, and different auth
 * mechanisms for the same three operations, so the shared surface is the
 * *interface* (`inject` / `setEnabled` / `remove`) rather than the wire format.
 * `services/sync.js` only ever touches that interface.
 *
 * Neither adapter writes a router's SQLite file directly: OmniRoute runs 158
 * migrations against a schema incompatible with 9router's, so file-level writes
 * corrupt on upgrade.
 */

import { decodeJwtPayload } from '../oauth/client.js';

class UnsupportedInjection extends Error {
  constructor(router, provider) {
    super(`${router} has no import route for ${provider} credentials`);
    this.code = 'injection_unsupported';
    this.router = router;
    this.provider = provider;
  }
}

function httpError(router, status) {
  const error = new Error(`Router ${router} returned ${status}`);
  error.statusCode = status;
  error.code = status === 401 || status === 403 ? 'router_unauthorized' : 'router_error';
  return error;
}

/** Milliseconds-since-epoch, which is what Claude's credential file stores. */
function epochMillis(isoString) {
  const parsed = Date.parse(isoString ?? '');
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Both routers dedupe connections by upstream email. The portal stores only a
 * masked label, so the real address is read back out of the id_token at
 * injection time rather than kept in a second plaintext column.
 */
function upstreamEmail(tokenSet) {
  const claims = tokenSet.idToken ? decodeJwtPayload(tokenSet.idToken) : null;
  const email = claims?.email;
  return typeof email === 'string' && email.includes('@') ? email : undefined;
}

class BaseAdapter {
  constructor(key, settings, fetchImpl = fetch) {
    this.key = key;
    this.settings = settings;
    this.fetchImpl = fetchImpl;
  }

  get configured() {
    return Boolean(this.settings.baseUrl && this.settings.privilegedToken);
  }

  async request(path, method, payload) {
    if (!this.configured) {
      const error = new Error(`Router ${this.key} is not configured`);
      error.code = 'router_not_configured';
      throw error;
    }
    const response = await this.fetchImpl(new URL(path, this.settings.baseUrl).toString(), {
      method,
      headers: {
        ...this.authHeaders(),
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    if (!response.ok) throw httpError(this.key, response.status);
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  /**
   * 9router persists `isActive` with a strict `=== false` comparison, so `0`,
   * `"false"` and `null` all silently persist as ACTIVE while returning 200.
   * Both adapters therefore send a real boolean, never a truthy stand-in.
   */
  async setEnabled(remoteId, enabled) {
    await this.request(`/api/providers/${encodeURIComponent(remoteId)}`, 'PUT', {
      isActive: enabled === true,
    });
  }

  async remove(remoteId) {
    try {
      await this.request(`/api/providers/${encodeURIComponent(remoteId)}`, 'DELETE');
    } catch (error) {
      // Already gone upstream is the state we wanted; anything else must
      // propagate so deletion stays fail-closed.
      if (error.statusCode !== 404) throw error;
    }
  }
}

/**
 * 9router.
 *
 * Auth is a derived CLI token (`sha256(machineId + salt + cliSecret)`), not a
 * bearer credential — it is read from the router's data volume and supplied to
 * the portal as NINEROUTER_PRIVILEGED_TOKEN.
 *
 * Codex can be injected through the existing bulk-import route. Claude CANNOT:
 * 9router exposes no Claude token-import endpoint, and `POST /api/providers`
 * only ever creates `cookie` or `apikey` connections. Closing that gap needs a
 * new fork seam under ADR-0026, so until then a Claude account reconciles as a
 * per-router failure and the UI reports `partially_synced` rather than
 * pretending both routers hold the credential.
 */
export class NineRouterAdapter extends BaseAdapter {
  authHeaders() {
    return { 'x-9r-cli-token': this.settings.privilegedToken };
  }

  async inject(account, tokenSet) {
    if (account.provider !== 'codex') {
      throw new UnsupportedInjection('9router', account.provider);
    }
    if (!tokenSet.refreshToken) {
      // Without a refresh token 9router would land an `access_token` connection
      // that dies at first expiry and cannot self-heal.
      const error = new Error('Codex injection requires a refresh token');
      error.code = 'missing_refresh_token';
      throw error;
    }

    const result = await this.request('/api/oauth/codex/bulk-import', 'POST', [{
      accessToken: tokenSet.accessToken,
      refreshToken: tokenSet.refreshToken,
      idToken: tokenSet.idToken ?? undefined,
      expiresAt: tokenSet.expiresAt ?? undefined,
      email: upstreamEmail(tokenSet),
      name: account.display_name ?? undefined,
      isActive: account.desired_enabled === 1,
    }]);

    const entry = Array.isArray(result.results) ? result.results[0] : null;
    if (!entry?.ok || !entry.id) {
      const error = new Error(entry?.error || 'Router 9router rejected the import');
      error.code = 'router_error';
      throw error;
    }
    return String(entry.id);
  }
}

/**
 * OmniRoute.
 *
 * Auth is an API key carrying the `manage` scope, sent as a bearer header;
 * management routes deliberately refuse URL-borne credentials.
 *
 * Both providers import through `/api/providers/*-auth/import`, which expects
 * the provider's own CLI credential-file shape rather than a flat token set.
 * `overwriteExisting` is set because the portal is the authority for these
 * accounts: re-authenticating must replace the stored credential, not 409.
 *
 * Note the route NOT used: `/api/oauth/codex/import` validates by calling
 * refresh at import time, which rotates the single-use refresh token the portal
 * just obtained and can invalidate the very credential being injected.
 */
export class OmniRouteAdapter extends BaseAdapter {
  authHeaders() {
    return { authorization: `Bearer ${this.settings.privilegedToken}` };
  }

  #credentialFile(account, tokenSet) {
    if (account.provider === 'claude') {
      if (!tokenSet.refreshToken) {
        const error = new Error('Claude injection requires a refresh token');
        error.code = 'missing_refresh_token';
        throw error;
      }
      return {
        claudeAiOauth: {
          accessToken: tokenSet.accessToken,
          refreshToken: tokenSet.refreshToken,
          expiresAt: epochMillis(tokenSet.expiresAt),
          scopes: tokenSet.scope ? tokenSet.scope.split(' ').filter(Boolean) : [],
        },
      };
    }
    if (account.provider === 'codex') {
      if (!tokenSet.idToken || !tokenSet.refreshToken) {
        // OmniRoute derives account_id, user id and email from the id_token;
        // without it the import is rejected as an unidentifiable account.
        const error = new Error('Codex injection requires an id token and a refresh token');
        error.code = 'missing_id_token';
        throw error;
      }
      return {
        auth_mode: 'chatgpt',
        tokens: {
          id_token: tokenSet.idToken,
          access_token: tokenSet.accessToken,
          refresh_token: tokenSet.refreshToken,
        },
      };
    }
    throw new UnsupportedInjection('OmniRoute', account.provider);
  }

  async inject(account, tokenSet) {
    const path = account.provider === 'claude'
      ? '/api/providers/claude-auth/import'
      : '/api/providers/codex-auth/import';

    const result = await this.request(path, 'POST', {
      source: { kind: 'json', json: this.#credentialFile(account, tokenSet) },
      name: account.display_name ?? undefined,
      email: upstreamEmail(tokenSet),
      overwriteExisting: true,
    });

    const remoteId = result.connection?.id;
    if (!remoteId) {
      const error = new Error('Router OmniRoute returned no connection id');
      error.code = 'router_error';
      throw error;
    }

    // Import always lands active; honour the sponsor's intent explicitly.
    if (account.desired_enabled !== 1) {
      await this.setEnabled(remoteId, false);
    }
    return String(remoteId);
  }
}

export function buildAdapters(config, fetchImpl = fetch) {
  return {
    ninerouter: new NineRouterAdapter('ninerouter', config.routers.ninerouter, fetchImpl),
    omniroute: new OmniRouteAdapter('omniroute', config.routers.omniroute, fetchImpl),
  };
}
