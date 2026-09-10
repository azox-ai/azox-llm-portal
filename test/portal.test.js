import test from 'node:test';
import assert from 'node:assert/strict';
import { RouterAdapter } from '../src/adapters/router-adapter.js';
import { encryptJson } from '../src/lib/crypto.js';
import { hashPassword } from '../src/services/auth.js';
import { reconcileAccount } from '../src/services/sync.js';
import { refreshTokenSet } from '../src/services/refresh.js';
import { parseCallbackInput } from '../src/oauth/client.js';
import { authHeaders, jwt, login, testApp } from './helpers/test-app.js';

async function seedUser(db, username, role = 'user') {
  const result = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run(username, await hashPassword('correct horse battery'), role);
  return Number(result.lastInsertRowid);
}

async function session(app, db, username, role = 'user') {
  await seedUser(db, username, role);
  return login(app, username);
}

test('self-registration is absent and an admin creates users without forced password change', async (t) => {
  const { app, db } = await testApp();
  t.after(() => { app.close(); db.close(); });
  const admin = await session(app, db, 'admin', 'admin');

  const registration = await app.inject({ method: 'POST', url: '/api/register', payload: {} });
  assert.equal(registration.statusCode, 404);

  const created = await app.inject({
    method: 'POST', url: '/api/admin/users', headers: authHeaders(admin),
    payload: { username: 'alice', password: 'correct horse battery', role: 'user' },
  });
  assert.equal(created.statusCode, 201);

  const alice = await login(app, 'alice');
  assert.equal(alice.response.statusCode, 200);
  assert.equal(alice.response.json().mustChangePassword, undefined);
});

test('users only see provider accounts they own, including administrators', async (t) => {
  const { app, db, config } = await testApp();
  t.after(() => { app.close(); db.close(); });
  const aliceId = await seedUser(db, 'alice');
  await seedUser(db, 'admin', 'admin');
  db.prepare(`INSERT INTO provider_accounts
    (owner_id, provider, upstream_subject, display_name, credential_envelope, access_expires_at)
    VALUES (?, 'claude', 'alice-sub', 'a***@example.com', ?, '2030-01-01T00:00:00.000Z')`)
    .run(aliceId, encryptJson({ accessToken: 'a', refreshToken: 'r', expiresAt: '2030-01-01T00:00:00.000Z' }, config.encryptionKey));

  const alice = await login(app, 'alice');
  const admin = await login(app, 'admin');
  assert.equal((await app.inject({ method: 'GET', url: '/api/accounts', headers: { cookie: alice.cookie } })).json().length, 1);
  assert.equal((await app.inject({ method: 'GET', url: '/api/accounts', headers: { cookie: admin.cookie } })).json().length, 0);
});

test('router sync sends access token metadata but never a refresh token', async () => {
  const calls = [];
  const adapter = new RouterAdapter('ninerouter', { baseUrl: 'http://router.test', syncToken: 'secret' }, async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 'router-id' }), { status: 200 });
  });
  await adapter.sync({ id: 4, provider: 'codex', display_name: 'Codex', desired_enabled: 1, credential_status: 'active', token_version: 8 }, {
    accessToken: 'access', refreshToken: 'refresh', expiresAt: '2030-01-01T00:00:00.000Z',
    idToken: jwt({ email: 'a@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct' } }),
  });
  assert.equal(calls[0].headers.authorization, 'Bearer secret');
  assert.equal(calls[0].body.accessToken, 'access');
  assert.equal(calls[0].body.tokenVersion, 8);
  assert.equal(calls[0].body.refreshToken, undefined);
  assert.equal(calls[0].body.providerSpecificData.chatgptAccountId, 'acct');
});

test('reconcile stores the token version acknowledged by 9Router', async () => {
  const { app, db, config, adapters } = await testApp();
  await app.close();
  const ownerId = await seedUser(db, 'alice');
  const result = db.prepare(`INSERT INTO provider_accounts
    (owner_id, provider, upstream_subject, display_name, credential_envelope, token_version, access_expires_at)
    VALUES (?, 'claude', 'sub', 'Claude', ?, 7, '2030-01-01T00:00:00.000Z')`)
    .run(ownerId, encryptJson({ accessToken: 'a', refreshToken: 'r', expiresAt: '2030-01-01T00:00:00.000Z' }, config.encryptionKey));
  await reconcileAccount(db, adapters, config, Number(result.lastInsertRowid));
  const row = db.prepare('SELECT sync_status, synced_token_version FROM router_connections').get();
  assert.equal(row.sync_status, 'active');
  assert.equal(row.synced_token_version, 7);
  db.close();
});

test('refresh preserves a rotated-or-omitted refresh token correctly', async () => {
  const current = { accessToken: 'old', refreshToken: 'canonical', idToken: 'identity' };
  const result = await refreshTokenSet('codex', {
    tokenUrl: 'https://auth.example/token', clientId: 'client', scopes: 'openid offline_access',
  }, current, async () => new Response(JSON.stringify({ access_token: 'new', expires_in: 3600 }), { status: 200 }));
  assert.equal(result.accessToken, 'new');
  assert.equal(result.refreshToken, 'canonical');
  assert.equal(result.idToken, 'identity');
});

test('manual OAuth accepts Claude code#state and a Codex callback URL', () => {
  assert.deepEqual(parseCallbackInput('code-1#state-1'), { code: 'code-1', state: 'state-1' });
  assert.deepEqual(
    parseCallbackInput('http://localhost:1455/auth/callback?code=code-2&state=state-2'),
    { code: 'code-2', state: 'state-2' },
  );
});

test('bodyless POST actions are accepted by the API', async (t) => {
  const { app, db } = await testApp();
  t.after(() => { app.close(); db.close(); });
  await seedUser(db, 'alice');
  const auth = await login(app, 'alice');
  const start = await app.inject({ method: 'POST', url: '/api/oauth/claude/start', headers: authHeaders(auth) });
  assert.equal(start.statusCode, 200);
  const authorizeUrl = new URL(start.json().url);
  assert.equal(authorizeUrl.searchParams.get('client_id'), 'client');
  assert.ok(authorizeUrl.searchParams.get('code_challenge'));
  const logout = await app.inject({ method: 'POST', url: '/api/logout', headers: authHeaders(auth) });
  assert.equal(logout.statusCode, 200);
});

test('Quota Tracker is GET-only and cannot mutate provider state', async (t) => {
  const { app, db, config } = await testApp({ oauthFetch: {
    claudeQuota: async () => new Response(JSON.stringify({ five_hour: { utilization: 25, resets_at: '2030-01-01T00:00:00Z' } }), { status: 200 }),
  } });
  t.after(() => { app.close(); db.close(); });
  const ownerId = await seedUser(db, 'alice');
  const result = db.prepare(`INSERT INTO provider_accounts
    (owner_id, provider, upstream_subject, display_name, credential_envelope, access_expires_at)
    VALUES (?, 'claude', 'sub', 'Claude', ?, '2030-01-01T00:00:00.000Z')`)
    .run(ownerId, encryptJson({ accessToken: 'a', refreshToken: 'r', expiresAt: '2030-01-01T00:00:00.000Z' }, config.encryptionKey));
  const auth = await login(app, 'alice');
  const quota = await app.inject({ method: 'GET', url: `/api/accounts/${result.lastInsertRowid}/quota`, headers: { cookie: auth.cookie } });
  assert.equal(quota.statusCode, 200);
  assert.equal(quota.json().quotas.session.remaining, 75);
  assert.equal((await app.inject({ method: 'POST', url: `/api/accounts/${result.lastInsertRowid}/quota`, headers: authHeaders(auth) })).statusCode, 404);
});
