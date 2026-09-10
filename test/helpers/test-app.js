import { openDatabase } from '../../src/db/index.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';

export function fakeAdapter(key, overrides = {}) {
  const calls = [];
  return {
    configured: true,
    calls,
    async inject(account, token) {
      calls.push(['inject', account.id, token.accessToken]);
      if (overrides.inject) return overrides.inject(account, token);
      return `${key}-${account.id}`;
    },
    async setEnabled(id, enabled) {
      calls.push(['setEnabled', id, enabled]);
      if (overrides.setEnabled) return overrides.setEnabled(id, enabled);
    },
    async remove(id) {
      calls.push(['remove', id]);
      if (overrides.remove) return overrides.remove(id);
    },
  };
}

export async function testApp(overrides = {}) {
  const db = openDatabase(':memory:');
  const config = loadConfig({
    dbPath: ':memory:',
    cookieSecret: 'test-cookie-secret-long-enough',
    encryptionKey: 'test-encryption-secret-long-enough',
    secureCookies: false,
    claude: {
      authorizeUrl: 'https://auth.example/authorize', tokenUrl: 'https://auth.example/token',
      clientId: 'client', scopes: 'profile', redirectUri: 'http://localhost/api/oauth/claude/callback',
      identityUrl: '',
    },
    codex: {
      authorizeUrl: 'https://auth.example/authorize', tokenUrl: 'https://auth.example/token',
      clientId: 'client', scopes: 'openid', redirectUri: 'http://localhost/api/oauth/codex/callback',
      identityUrl: '',
    },
    ...overrides.config,
  });
  const adapters = overrides.adapters || {
    ninerouter: fakeAdapter('nine'),
    omniroute: fakeAdapter('omni'),
  };
  const built = await buildApp({ db, config, adapters, logger: false, oauthFetch: overrides.oauthFetch });
  return { ...built, adapters };
}

export async function register(app, username = 'alice', password = 'correct horse battery') {
  const response = await app.inject({ method: 'POST', url: '/api/register', payload: { username, password } });
  const cookie = response.cookies.find((c) => c.name === 'sp_session');
  return { response, cookie: cookie ? `${cookie.name}=${cookie.value}` : '', csrf: response.json().csrfToken };
}

export function authHeaders(auth) {
  return { cookie: auth.cookie, 'x-csrf-token': auth.csrf };
}

export function jwt(payload) {
  return ['x', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'x'].join('.');
}
