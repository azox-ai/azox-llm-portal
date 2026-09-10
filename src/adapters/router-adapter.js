/**
 * Privileged admin-API adapter for a downstream router (9router / OmniRoute).
 *
 * Contract deliberately narrow: the portal injects a credential once, then flips
 * enable/disable and deletes. It never reads usage, quota, or spend, and never
 * writes the router's SQLite file directly — OmniRoute runs 158 migrations with a
 * schema incompatible with 9router's, so file-level writes corrupt on upgrade.
 */
export class RouterAdapter {
  constructor(key, settings, fetchImpl = fetch) {
    this.key = key;
    this.settings = settings;
    this.fetchImpl = fetchImpl;
  }

  get configured() {
    return Boolean(this.settings.baseUrl && this.settings.privilegedToken);
  }

  #url(template, remoteId) {
    const path = template.replace('{id}', encodeURIComponent(remoteId ?? ''));
    return new URL(path, this.settings.baseUrl).toString();
  }

  async #request(url, method, payload) {
    if (!this.configured) {
      const error = new Error(`Router ${this.key} is not configured`);
      error.code = 'router_not_configured';
      throw error;
    }
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${this.settings.privilegedToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    if (!response.ok) {
      const error = new Error(`Router ${this.key} returned ${response.status}`);
      error.statusCode = response.status;
      error.code = response.status === 401 || response.status === 403 ? 'router_unauthorized' : 'router_error';
      throw error;
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  /** Create or replace the provider connection. Returns the router-side id. */
  async inject(account, tokenSet) {
    const result = await this.#request(this.#url(this.settings.injectPath), 'POST', {
      provider: account.provider,
      external_id: account.upstream_subject,
      name: account.display_name,
      enabled: Boolean(account.desired_enabled),
      credential: {
        type: 'oauth',
        access_token: tokenSet.accessToken,
        refresh_token: tokenSet.refreshToken,
        expires_at: tokenSet.expiresAt,
        token_type: tokenSet.tokenType,
        scope: tokenSet.scope,
      },
    });
    return String(result.id ?? result.connection_id ?? account.upstream_subject);
  }

  async setEnabled(remoteId, enabled) {
    await this.#request(this.#url(this.settings.statePath, remoteId), 'PATCH', { enabled });
  }

  async remove(remoteId) {
    try {
      await this.#request(this.#url(this.settings.deletePath, remoteId), 'DELETE');
    } catch (error) {
      if (error.statusCode !== 404) throw error;
    }
  }
}

export function buildAdapters(config, fetchImpl = fetch) {
  return {
    ninerouter: new RouterAdapter('ninerouter', config.routers.ninerouter, fetchImpl),
    omniroute: new RouterAdapter('omniroute', config.routers.omniroute, fetchImpl),
  };
}
