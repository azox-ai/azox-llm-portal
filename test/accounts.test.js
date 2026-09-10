import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp, register, authHeaders, fakeAdapter, jwt } from './helpers/test-app.js';
import { encryptJson } from '../src/lib/crypto.js';
import { markPending, reconcileAccount } from '../src/services/sync.js';

function addAccount(db, config, ownerId, subject = 'upstream-1') {
  const result = db.prepare(`
    INSERT INTO sponsored_accounts (owner_id, provider, upstream_subject, display_name, credential_envelope)
    VALUES (?, 'claude', ?, 'a***@example.com', ?)
  `).run(ownerId, subject, encryptJson({ accessToken: 'access', refreshToken: 'refresh' }, config.encryptionKey));
  return Number(result.lastInsertRowid);
}

test('OAuth callback stores encrypted token and injects both routers', async (t) => {
  const tokenPayload = { sub: 'oauth-subject', email: 'alice@example.com' };
  const oauthFetch = async (url) => new Response(JSON.stringify({
    access_token: 'top-secret-access', refresh_token: 'top-secret-refresh', id_token: jwt(tokenPayload), expires_in: 3600,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const { app, db, adapters } = await testApp({ oauthFetch: { claude: oauthFetch } });
  t.after(() => { app.close(); db.close(); });
  const auth = await register(app);
  const start = await app.inject({
    method: 'POST', url: '/api/oauth/claude/start', headers: authHeaders(auth),
  });
  assert.equal(start.statusCode, 200);
  const authorization = new URL(start.json().url);
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  const state = authorization.searchParams.get('state');

  const callback = await app.inject({
    method: 'GET', url: `/api/oauth/claude/callback?code=abc&state=${encodeURIComponent(state)}`,
    headers: { cookie: auth.cookie },
  });
  assert.equal(callback.statusCode, 302);
  assert.match(callback.headers.location, /oauth=success/);

  const account = db.prepare('SELECT * FROM sponsored_accounts').get();
  assert.equal(account.display_name, 'a***@example.com');
  assert.ok(!account.credential_envelope.includes('top-secret'));
  assert.deepEqual(adapters.ninerouter.calls[0], ['inject', account.id, 'top-secret-access']);
  assert.deepEqual(adapters.omniroute.calls[0], ['inject', account.id, 'top-secret-access']);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM router_connections WHERE sync_status = 'active'").get().n, 2);
});

test('account list exposes status but never token, quota, limit or subject', async (t) => {
  const { app, db, config, adapters } = await testApp();
  t.after(() => { app.close(); db.close(); });
  const auth = await register(app);
  const userId = db.prepare("SELECT id FROM users WHERE username = 'alice'").get().id;
  const accountId = addAccount(db, config, userId, 'private-subject');
  markPending(db, accountId);
  await reconcileAccount(db, adapters, config, accountId);

  const response = await app.inject({ method: 'GET', url: '/api/accounts', headers: { cookie: auth.cookie } });
  assert.equal(response.statusCode, 200);
  const text = response.body;
  assert.ok(!text.includes('private-subject'));
  assert.ok(!text.includes('access'));
  assert.ok(!text.includes('refresh'));
  assert.ok(!text.includes('quota'));
  assert.ok(!text.includes('limit'));
  assert.equal(response.json()[0].status, 'active');
});

test('ownership is enforced server-side for state and removal', async (t) => {
  const { app, db, config } = await testApp();
  t.after(() => { app.close(); db.close(); });
  const alice = await register(app, 'alice');
  const bob = await register(app, 'bob');
  const aliceId = db.prepare("SELECT id FROM users WHERE username = 'alice'").get().id;
  const accountId = addAccount(db, config, aliceId);

  const toggle = await app.inject({
    method: 'PATCH', url: `/api/accounts/${accountId}/state`, headers: authHeaders(bob), payload: { enabled: false },
  });
  assert.equal(toggle.statusCode, 404);
  const remove = await app.inject({
    method: 'DELETE', url: `/api/accounts/${accountId}`, headers: authHeaders(bob),
  });
  assert.equal(remove.statusCode, 404);
  assert.equal(db.prepare('SELECT desired_enabled FROM sponsored_accounts WHERE id = ?').get(accountId).desired_enabled, 1);
  assert.ok(alice.cookie);
});

test('one router failure yields partially_synced and keeps successful route', async (t) => {
  const adapters = {
    ninerouter: fakeAdapter('nine'),
    omniroute: fakeAdapter('omni', { inject: () => { const error = new Error('secret remote detail'); error.statusCode = 503; throw error; } }),
  };
  const { app, db, config } = await testApp({ adapters });
  t.after(() => { app.close(); db.close(); });
  const auth = await register(app);
  const ownerId = db.prepare("SELECT id FROM users WHERE username = 'alice'").get().id;
  const accountId = addAccount(db, config, ownerId);
  markPending(db, accountId);
  const result = await reconcileAccount(db, adapters, config, accountId);
  assert.equal(result.ninerouter, 'active');
  assert.equal(result.omniroute, 'failed');

  const list = await app.inject({ method: 'GET', url: '/api/accounts', headers: { cookie: auth.cookie } });
  assert.equal(list.json()[0].status, 'partially_synced');
  assert.equal(list.json()[0].routers.omniroute.error, 'HTTP 503');
  assert.ok(!list.body.includes('secret remote detail'));
});

test('remove is fail-closed when a downstream router cannot delete', async (t) => {
  const adapters = {
    ninerouter: fakeAdapter('nine'),
    omniroute: fakeAdapter('omni', { remove: () => { throw Object.assign(new Error('down'), { statusCode: 503 }); } }),
  };
  const { app, db, config } = await testApp({ adapters });
  t.after(() => { app.close(); db.close(); });
  const auth = await register(app);
  const ownerId = db.prepare("SELECT id FROM users WHERE username = 'alice'").get().id;
  const accountId = addAccount(db, config, ownerId);
  markPending(db, accountId);
  await reconcileAccount(db, adapters, config, accountId);

  const response = await app.inject({ method: 'DELETE', url: `/api/accounts/${accountId}`, headers: authHeaders(auth) });
  assert.equal(response.statusCode, 502);
  assert.ok(db.prepare('SELECT id FROM sponsored_accounts WHERE id = ?').get(accountId));
});
