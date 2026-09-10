import { openDatabase } from '../../src/db/index.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';

export function fakeAdapter(key, overrides = {}) {
  const calls = [];
  return {
    configured: true,
    calls,
    async sync(account, token) {
      calls.push(['sync', account.id, token.accessToken, account.token_version]);
      if (overrides.sync) return overrides.sync(account, token);
      return `portal-${account.id}`;
    },
    async remove(account) {
      calls.push(['remove', account.id]);
      if (overrides.remove) return overrides.remove(account);
    },
    async status(account) {
      calls.push(['status', account.id]);
      if (overrides.status) return overrides.status(account);
      return { found: true, enabled: true, expiresAt: null, tokenVersion: account.token_version };
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
  const adapters = {
    ninerouter: fakeAdapter('nine'),
    omniroute: fakeAdapter('omni'),
    ...overrides.adapters,
  };
  const built = await buildApp({ db, config, adapters, logger: false, oauthFetch: overrides.oauthFetch, startScheduler: false });
  return { ...built, adapters };
}

export async function login(app, username = 'alice', password = 'correct horse battery') {
  const response = await app.inject({ method: 'POST', url: '/api/login', payload: { username, password } });
  const cookie = response.cookies.find((c) => c.name === 'sp_session');
  return { response, cookie: cookie ? `${cookie.name}=${cookie.value}` : '', csrf: response.json().csrfToken };
}

export function authHeaders(auth) {
  return { cookie: auth.cookie, 'x-csrf-token': auth.csrf };
}

export function jwt(payload) {
  return ['x', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'x'].join('.');
}
