/**
 * Router adapters for the portal's push-only credential sync.
 *
 * The portal is the single owner of every refresh token. A router receives an
 * access token, its expiry and identity metadata, and nothing else — so two
 * routers can serve the same upstream account concurrently without racing on a
 * single-use refresh token, and revoking an account is one portal-side action.
 *
 * The wire contract is the router's `/api/internal/portal/connections/:id`
 * endpoint, which is exposed only on the Docker network.
 */

import { decodeJwtPayload } from '../oauth/client.js';

function httpError(router, status) {
  const error = new Error(`Router ${router} returned ${status}`);
  error.statusCode = status;
  error.code = status === 401 || status === 403 ? 'router_unauthorized' : 'router_error';
  return error;
}

function upstreamEmail(tokenSet) {
  const claims = tokenSet.idToken ? decodeJwtPayload(tokenSet.idToken) : null;
  const email = claims?.email;
  return typeof email === 'string' && email.includes('@') ? email : undefined;
}

/**
 * Codex routes requests with the ChatGPT workspace id from the id_token, so it
 * has to travel with the token; without it the router sends Codex traffic
 * without a workspace header and upstream rejects it.
 */
function codexAccountId(tokenSet) {
  const claims = tokenSet.idToken ? decodeJwtPayload(tokenSet.idToken) : null;
  const auth = claims?.['https://api.openai.com/auth'];
  const id = auth?.chatgpt_account_id || auth?.chatgpt_user_id;
  return typeof id === 'string' ? id : undefined;
}

/**
 * One router. `sync` is idempotent and version-guarded; the router rejects an
 * older `tokenVersion` than it already holds, so a slow retry can never
 * overwrite a newer access token.
 */
export class RouterAdapter {
  constructor(key, settings, fetchImpl = fetch) {
    this.key = key;
    this.settings = settings;
    this.fetchImpl = fetchImpl;
  }

  get configured() {
    return Boolean(this.settings.baseUrl && this.settings.syncToken);
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
        authorization: `Bearer ${this.settings.syncToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    if (!response.ok) throw httpError(this.key, response.status);
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  #path(account) {
    return `/api/internal/portal/connections/${encodeURIComponent(`portal-${account.id}`)}`;
  }

  /**
   * Push the current credential state. The refresh token is deliberately NOT
   * part of the body: the router must never be able to rotate a credential the
   * portal owns, or the two routers would invalidate each other's tokens.
   */
  async sync(account, tokenSet) {
    const email = upstreamEmail(tokenSet);
    // 9Router's connection row prints `name` on the first line and falls back
    // to `displayName` for the second when it differs, which is exactly the
    // "<account>\nSponsored by: <user>" shape the portal wants to publish.
    const sponsor = account.owner_username ? `Sponsored by: ${account.owner_username}` : undefined;
    const providerSpecificData = {};
    if (account.provider === 'codex') {
      const chatgptAccountId = codexAccountId(tokenSet);
      if (chatgptAccountId) providerSpecificData.chatgptAccountId = chatgptAccountId;
    }
    await this.request(this.#path(account), 'PUT', {
      provider: account.provider,
      accessToken: tokenSet.accessToken,
      expiresAt: tokenSet.expiresAt,
      idToken: tokenSet.idToken ?? undefined,
      scope: tokenSet.scope ?? undefined,
      tokenType: tokenSet.tokenType ?? undefined,
      email,
      name: email || account.display_name || undefined,
      displayName: sponsor,
      enabled: account.desired_enabled === 1 && account.credential_status === 'active',
      tokenVersion: account.token_version,
      providerSpecificData: {
        ...providerSpecificData,
        sponsoredBy: account.owner_username,
      },
    });
    return `portal-${account.id}`;
  }

  async remove(account) {
    try {
      await this.request(this.#path(account), 'DELETE');
    } catch (error) {
      // Already gone upstream is the state we wanted; anything else must
      // propagate so deletion stays fail-closed.
      if (error.statusCode !== 404) throw error;
    }
  }
}

export function buildAdapters(config, fetchImpl = fetch) {
  return {
    ninerouter: new RouterAdapter('ninerouter', config.routers.ninerouter, fetchImpl),
  };
}
