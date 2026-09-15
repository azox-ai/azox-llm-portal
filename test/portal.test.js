import test from 'node:test';
import assert from 'node:assert/strict';
import { RouterAdapter } from '../src/adapters/router-adapter.js';
import { encryptJson } from '../src/lib/crypto.js';
import { hashPassword } from '../src/services/auth.js';
import { reconcileAccount } from '../src/services/sync.js';
import { refreshTokenSet, runRefreshTick } from '../src/services/refresh.js';
import { fetchQuota } from '../src/services/quota.js';
import { parseCallbackInput } from '../src/oauth/client.js';
import { authHeaders, fakeAdapter, jwt, login, testApp } from './helpers/test-app.js';

async function seedUser(db, username, role = 'user') {
  const result = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run(username, await hashPassword('correct horse battery'), role);
  return Number(result.lastInsertRowid);
}

async function session(app, db, username, role = 'user') {
  await seedUser(db, username, role);
  return login(app, username);
}

test('the login card creates a free username and rejects one already taken', async (t) => {
  const { app, db } = await testApp();
  t.after(() => { app.close(); db.close(); });

  const created = await app.inject({
    method: 'POST', url: '/api/register',
    payload: { username: 'newcomer', password: 'correct horse battery' },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().role, 'user');
  assert.equal((await login(app, 'newcomer')).response.statusCode, 200);

  const duplicate = await app.inject({
    method: 'POST', url: '/api/register',
    payload: { username: 'newcomer', password: 'another correct horse' },
  });
  assert.equal(duplicate.statusCode, 409);
  assert.match(duplicate.json().error, /already exists/);

  const weak = await app.inject({
    method: 'POST', url: '/api/register', payload: { username: 'shorty', password: 'short' },
  });
  assert.equal(weak.statusCode, 400);
});

test('an admin creates users without forcing a password change', async (t) => {
  const { app, db } = await testApp();
  t.after(() => { app.close(); db.close(); });
  const admin = await session(app, db, 'admin', 'admin');

  const created = await app.inject({
    method: 'POST', url: '/api/admin/users', headers: authHeaders(admin),
    payload: { username: 'alice', password: 'correct horse battery', role: 'user' },
  });
  assert.equal(created.statusCode, 201);

  const alice = await login(app, 'alice');
  assert.equal(alice.response.statusCode, 200);
  assert.equal(alice.response.json().mustChangePassword, undefined);
});

test('admin reads and updates the token refresh lead time in hours', async (t) => {
  const { app, db } = await testApp({ config: { refreshLeadMinutes: 480 } });
  t.after(() => { app.close(); db.close(); });
  const admin = await session(app, db, 'admin', 'admin');

  const initial = await app.inject({ method: 'GET', url: '/api/admin/settings', headers: { cookie: admin.cookie } });
  assert.equal(initial.statusCode, 200);
  assert.equal(initial.json().refreshLeadHours, 8);

  const changed = await app.inject({
    method: 'PATCH', url: '/api/admin/settings', headers: authHeaders(admin),
    payload: { refreshLeadHours: 12 },
  });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.json().refreshLeadHours, 12);
  assert.equal(db.prepare("SELECT value FROM app_settings WHERE key = 'refresh_lead_hours'").get().value, '12');

  for (const invalid of [0, 1.5, 169, 'eight']) {
    const rejected = await app.inject({
      method: 'PATCH', url: '/api/admin/settings', headers: authHeaders(admin),
      payload: { refreshLeadHours: invalid },
    });
    assert.equal(rejected.statusCode, 400);
  }
  assert.equal(db.prepare("SELECT value FROM app_settings WHERE key = 'refresh_lead_hours'").get().value, '12');
});

test('admin changes roles and audit pagination resolves user targets', async (t) => {
  const { app, db } = await testApp();
  t.after(() => { app.close(); db.close(); });
  const admin = await session(app, db, 'admin', 'admin');
  const aliceId = await seedUser(db, 'alice');

  const promoted = await app.inject({
    method: 'PATCH', url: `/api/admin/users/${aliceId}`, headers: authHeaders(admin),
    payload: { role: 'admin' },
  });
  assert.equal(promoted.statusCode, 200);
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(aliceId).role, 'admin');

  db.prepare('DELETE FROM audit_log').run();
  const addAudit = db.prepare(`
    INSERT INTO audit_log (actor_id, action, target_type, target_id, detail)
    VALUES (?, ?, 'user', ?, NULL)
  `);
  for (let index = 1; index <= 27; index += 1) {
    addAudit.run(admin.response.json().id, `test.action_${index}`, String(aliceId));
  }

  const first = await app.inject({ method: 'GET', url: '/api/admin/audit?page=1&pageSize=20', headers: { cookie: admin.cookie } });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().items.length, 20);
  assert.equal(first.json().page, 1);
  assert.equal(first.json().total, 27);
  assert.equal(first.json().totalPages, 2);
  assert.equal(first.json().items[0].target, 'alice');
  assert.equal(first.json().items[0].target.includes('user:'), false);

  const second = await app.inject({ method: 'GET', url: '/api/admin/audit?page=2&pageSize=20', headers: { cookie: admin.cookie } });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().items.length, 7);
  assert.equal(second.json().page, 2);
  assert.equal(second.json().items[0].target, 'alice');

  db.prepare('DELETE FROM users WHERE id = ?').run(aliceId);
  db.prepare(`INSERT INTO audit_log (actor_id, action, target_type, target_id)
    VALUES (?, 'admin.update_user', 'user', '10')`).run(admin.response.json().id);
  const annotated = await app.inject({ method: 'GET', url: '/api/admin/audit?page=1&pageSize=20', headers: { cookie: admin.cookie } });
  assert.equal(annotated.json().items[0].target, '10 (user updated)');
});

test('admin login uses INIT_ADMIN_PASSWORD independently of the database password', async (t) => {
  const { app, db } = await testApp({ config: { initialAdminUsername: 'admin', initialAdminPassword: 'configured init password' } });
  t.after(() => { app.close(); db.close(); });
  await seedUser(db, 'admin', 'admin');
  const loginWithInit = await app.inject({
    method: 'POST', url: '/api/login/admin', payload: { password: 'configured init password' },
  });
  assert.equal(loginWithInit.statusCode, 200);
  assert.equal(loginWithInit.json().role, 'admin');
  const unifiedLogin = await app.inject({
    method: 'POST', url: '/api/login', payload: { username: 'admin', password: 'configured init password' },
  });
  assert.equal(unifiedLogin.statusCode, 200);
  assert.equal(unifiedLogin.json().role, 'admin');
  const loginWithDbPassword = await app.inject({
    method: 'POST', url: '/api/login/admin', payload: { password: 'correct horse battery' },
  });
  assert.equal(loginWithDbPassword.statusCode, 401);
});

test('admin resets a chosen password and removes a user from routers first', async (t) => {
  const { app, db, config, adapters } = await testApp();
  t.after(() => { app.close(); db.close(); });
  const admin = await session(app, db, 'admin', 'admin');
  const userId = await seedUser(db, 'remove-me');
  const account = db.prepare(`INSERT INTO provider_accounts
    (owner_id, provider, upstream_subject, display_name, credential_envelope)
    VALUES (?, 'claude', 'remove-sub', 'Claude', ?)`)
    .run(userId, encryptJson({ accessToken: 'a', refreshToken: 'r' }, config.encryptionKey));

  const reset = await app.inject({
    method: 'POST', url: `/api/admin/users/${userId}/reset-password`, headers: authHeaders(admin),
    payload: { password: 'new correct horse battery' },
  });
  assert.equal(reset.statusCode, 200);
  assert.equal(reset.json().temporaryPassword, undefined);
  assert.equal((await login(app, 'remove-me', 'new correct horse battery')).response.statusCode, 200);

  const removed = await app.inject({
    method: 'DELETE', url: `/api/admin/users/${userId}`, headers: authHeaders(admin),
  });
  assert.equal(removed.statusCode, 204);
  assert.deepEqual(adapters.ninerouter.calls.at(-1), ['remove', Number(account.lastInsertRowid)]);
  assert.equal(db.prepare('SELECT id FROM users WHERE id = ?').get(userId), undefined);
});

test('users see provider accounts they own while administrators see every account', async (t) => {
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
  const adminAccounts = (await app.inject({ method: 'GET', url: '/api/accounts', headers: { cookie: admin.cookie } })).json();
  assert.equal(adminAccounts.length, 1);
  assert.equal(adminAccounts[0].owner, 'alice');
});

test('Sponsors groups account rows by owner without exposing credentials', async (t) => {
  const { app, db, config } = await testApp();
  t.after(() => { app.close(); db.close(); });
  const aliceId = await seedUser(db, 'alice');
  const bobId = await seedUser(db, 'bob');
  for (const [ownerId, provider, subject, label] of [
    [aliceId, 'claude', 'claude-sub', 'alice@example.com'],
    [aliceId, 'codex', 'codex-sub', 'alice-codex@example.com'],
    [bobId, 'codex', 'bob-sub', 'bob@example.com'],
  ]) {
    const inserted = db.prepare(`INSERT INTO provider_accounts
      (owner_id, provider, upstream_subject, display_name, credential_envelope)
      VALUES (?, ?, ?, ?, ?)`).run(ownerId, provider, subject, label, encryptJson({ accessToken: 'secret' }, config.encryptionKey));
    db.prepare(`INSERT INTO router_connections (account_id, router, sync_status)
      VALUES (?, 'ninerouter', 'active')`).run(Number(inserted.lastInsertRowid));
  }
  const auth = await login(app, 'bob');
  const response = await app.inject({ method: 'GET', url: '/api/sponsors', headers: { cookie: auth.cookie } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().map((group) => [group.username, group.accounts.length]), [['alice', 2], ['bob', 1]]);
  assert.equal(JSON.stringify(response.json()).includes('secret'), false);
});

test('router sync sends access token metadata but never a refresh token', async () => {
  const calls = [];
  const adapter = new RouterAdapter('ninerouter', { baseUrl: 'http://router.test', syncToken: 'secret' }, async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 'router-id' }), { status: 200 });
  });
  await adapter.sync({ id: 4, provider: 'codex', display_name: 'a@example.com', owner_username: 'anhth2', desired_enabled: 1, credential_status: 'active', token_version: 8 }, {
    accessToken: 'access', refreshToken: 'refresh', expiresAt: '2030-01-01T00:00:00.000Z',
    idToken: jwt({ email: 'a@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct' } }),
  });
  assert.equal(calls[0].headers.authorization, 'Bearer secret');
  assert.equal(calls[0].body.accessToken, 'access');
  assert.equal(calls[0].body.tokenVersion, 8);
  assert.equal(calls[0].body.refreshToken, undefined);
  assert.equal(calls[0].body.providerSpecificData.chatgptAccountId, 'acct');
  assert.equal(calls[0].body.providerSpecificData.sponsoredBy, 'anhth2');
  assert.equal(calls[0].body.name, 'a@example.com');
  assert.equal(calls[0].body.email, 'a@example.com');
  assert.equal(calls[0].body.displayName, 'Sponsored by: anhth2');
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

test('Sync pulls an externally changed enabled state from 9Router into Portal', async (t) => {
  const ninerouter = fakeAdapter('nine', {
    status: async (account) => ({ found: true, enabled: true, tokenVersion: account.token_version }),
  });
  const { app, db, config } = await testApp({ adapters: { ninerouter } });
  t.after(() => { app.close(); db.close(); });
  const ownerId = await seedUser(db, 'alice');
  const inserted = db.prepare(`INSERT INTO provider_accounts
    (owner_id, provider, upstream_subject, display_name, credential_envelope, desired_enabled, token_version, access_expires_at)
    VALUES (?, 'codex', 'sub', 'user@example.com', ?, 0, 4, '2030-01-01T00:00:00.000Z')`)
    .run(ownerId, encryptJson({ accessToken: 'a', refreshToken: 'r', expiresAt: '2030-01-01T00:00:00.000Z' }, config.encryptionKey));
  const accountId = Number(inserted.lastInsertRowid);
  const auth = await login(app, 'alice');

  const synced = await app.inject({
    method: 'POST', url: `/api/accounts/${accountId}/retry`, headers: authHeaders(auth),
  });
  assert.equal(synced.statusCode, 200);
  assert.equal(synced.json().routers.ninerouter, 'active');
  assert.deepEqual(ninerouter.calls.at(-1), ['status', accountId]);
  assert.equal(db.prepare('SELECT desired_enabled FROM provider_accounts WHERE id = ?').get(accountId).desired_enabled, 1);

  const accounts = await app.inject({ method: 'GET', url: '/api/accounts', headers: { cookie: auth.cookie } });
  assert.equal(accounts.json()[0].enabled, true);
  assert.equal(accounts.json()[0].routers.ninerouter.status, 'active');
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

test('refresh tick honors the configured lead boundary and live admin setting', async (t) => {
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  const refreshCalls = [];
  const { app, db, config, adapters } = await testApp({ config: { refreshLeadMinutes: 480 } });
  t.after(() => { app.close(); db.close(); });
  const ownerId = await seedUser(db, 'refresh-owner');

  const insert = (subject, hours, extraMilliseconds = 0) => Number(db.prepare(`
    INSERT INTO provider_accounts
      (owner_id, provider, upstream_subject, display_name, credential_envelope, access_expires_at)
    VALUES (?, 'codex', ?, ?, ?, ?)
  `).run(
    ownerId,
    subject,
    subject,
    encryptJson({ accessToken: `old-${subject}`, refreshToken: `refresh-${subject}` }, config.encryptionKey),
    new Date(now + hours * 60 * 60_000 + extraMilliseconds).toISOString(),
  ).lastInsertRowid);

  const atEightHours = insert('at-eight-hours', 8);
  const afterEightHours = insert('after-eight-hours', 8, 1);
  const atTenHours = insert('at-ten-hours', 10);
  const refreshFetch = async (_url, options) => {
    const refreshToken = new URLSearchParams(options.body).get('refresh_token');
    refreshCalls.push(refreshToken);
    return new Response(JSON.stringify({ access_token: `new-${refreshToken}`, expires_in: 3600 }), { status: 200 });
  };

  assert.equal(await runRefreshTick(db, adapters, config, refreshFetch, now), 1);
  assert.deepEqual(refreshCalls, ['refresh-at-eight-hours']);
  assert.equal(db.prepare('SELECT token_version FROM provider_accounts WHERE id = ?').get(atEightHours).token_version, 2);
  assert.equal(db.prepare('SELECT token_version FROM provider_accounts WHERE id = ?').get(afterEightHours).token_version, 1);
  assert.equal(db.prepare('SELECT token_version FROM provider_accounts WHERE id = ?').get(atTenHours).token_version, 1);

  db.prepare("INSERT INTO app_settings (key, value) VALUES ('refresh_lead_hours', '12')").run();
  assert.equal(await runRefreshTick(db, adapters, config, refreshFetch, now), 3);
  assert.deepEqual(refreshCalls.slice(1).sort(), [
    'refresh-after-eight-hours', 'refresh-at-eight-hours', 'refresh-at-ten-hours',
  ]);
  assert.equal(db.prepare('SELECT token_version FROM provider_accounts WHERE id = ?').get(afterEightHours).token_version, 2);
  assert.equal(db.prepare('SELECT token_version FROM provider_accounts WHERE id = ?').get(atTenHours).token_version, 2);
});

test('Codex quota converts epoch-second reset_at instead of rendering 1970', async () => {
  const quota = await fetchQuota('codex', { accessToken: 'token' }, async () => new Response(JSON.stringify({
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 100, reset_at: 1789064300 },
      secondary_window: { used_percent: 73, reset_at: 1789539456 },
    },
  }), { status: 200 }));
  assert.equal(quota.quotas.session.resetAt, new Date(1789064300 * 1000).toISOString());
  assert.equal(quota.quotas.weekly.resetAt, new Date(1789539456 * 1000).toISOString());
  assert.match(quota.quotas.session.resetAt, /^2026-/);
});

test('Claude quota treats utilization as percent used and returns remaining percent', async () => {
  const quota = await fetchQuota('claude', { accessToken: 'token' }, async () => new Response(JSON.stringify({
    plan_type: 'max',
    five_hour: { utilization: 100, resets_at: '2026-09-15T06:30:00.000Z' },
    seven_day: { utilization: 27.5, resets_at: '2026-09-20T00:00:00.000Z' },
  }), { status: 200 }));

  assert.deepEqual(quota.quotas.session, {
    used: 100,
    remaining: 0,
    resetAt: '2026-09-15T06:30:00.000Z',
  });
  assert.deepEqual(quota.quotas.weekly, {
    used: 27.5,
    remaining: 72.5,
    resetAt: '2026-09-20T00:00:00.000Z',
  });
});

test('manual OAuth accepts Claude code#state and a Codex callback URL', () => {
  assert.deepEqual(parseCallbackInput('code-1#state-1'), { code: 'code-1', state: 'state-1' });
  assert.deepEqual(
    parseCallbackInput('http://localhost:1455/auth/callback?code=code-2&state=state-2'),
    { code: 'code-2', state: 'state-2' },
  );
});

test('Claude OAuth mirrors 9Router JSON exchange and keeps state after a rejected code', async (t) => {
  const exchanges = [];
  const { app, db } = await testApp({ oauthFetch: {
    claude: async (_url, options) => {
      exchanges.push({ headers: options.headers, body: JSON.parse(options.body) });
      if (exchanges.length === 1) return new Response('{}', { status: 400 });
      return new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }), { status: 200 });
    },
  } });
  t.after(() => { app.close(); db.close(); });
  await seedUser(db, 'alice');
  const auth = await login(app, 'alice');
  const started = await app.inject({ method: 'POST', url: '/api/oauth/claude/start', headers: authHeaders(auth) });
  const state = new URL(started.json().url).searchParams.get('state');

  const rejected = await app.inject({
    method: 'POST', url: '/api/oauth/claude/complete', headers: authHeaders(auth),
    payload: { callback: `wrong-code#${state}` },
  });
  assert.equal(rejected.statusCode, 400);
  assert.match(rejected.json().error, /Paste a fresh code/);
  assert.equal(exchanges[0].headers['content-type'], 'application/json');
  assert.equal(exchanges[0].body.state, state);
  assert.equal(exchanges[0].body.code, 'wrong-code');

  const retried = await app.inject({
    method: 'POST', url: '/api/oauth/claude/complete', headers: authHeaders(auth),
    payload: { callback: `fresh-code#${state}` },
  });
  assert.equal(retried.statusCode, 200);
  assert.equal(exchanges[1].body.code, 'fresh-code');
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

test('quota uses the credential belonging to the requested account and admins can inspect every owner', async (t) => {
  const { app, db, config } = await testApp({ oauthFetch: {
    claudeQuota: async (_url, init) => {
      const used = init.headers.authorization === 'Bearer alice-access' ? 0 : 100;
      return new Response(JSON.stringify({
        five_hour: { utilization: used, resets_at: '2030-01-01T00:00:00Z' },
      }), { status: 200 });
    },
  } });
  t.after(() => { app.close(); db.close(); });
  const aliceId = await seedUser(db, 'alice');
  const bobId = await seedUser(db, 'bob');
  const admin = await session(app, db, 'admin', 'admin');
  const insert = db.prepare(`INSERT INTO provider_accounts
    (owner_id, provider, upstream_subject, display_name, credential_envelope, access_expires_at)
    VALUES (?, 'claude', ?, ?, ?, '2030-01-01T00:00:00.000Z')`);
  const aliceAccount = Number(insert.run(
    aliceId,
    'alice-subject',
    'Alice Claude',
    encryptJson({ accessToken: 'alice-access' }, config.encryptionKey),
  ).lastInsertRowid);
  const bobAccount = Number(insert.run(
    bobId,
    'bob-subject',
    'Bob Claude',
    encryptJson({ accessToken: 'bob-access' }, config.encryptionKey),
  ).lastInsertRowid);

  const aliceQuota = await app.inject({
    method: 'GET', url: `/api/accounts/${aliceAccount}/quota`, headers: { cookie: admin.cookie },
  });
  const bobQuota = await app.inject({
    method: 'GET', url: `/api/accounts/${bobAccount}/quota`, headers: { cookie: admin.cookie },
  });
  assert.equal(aliceQuota.statusCode, 200);
  assert.equal(aliceQuota.json().quotas.session.remaining, 100);
  assert.equal(bobQuota.statusCode, 200);
  assert.equal(bobQuota.json().quotas.session.remaining, 0);

  const alice = await login(app, 'alice');
  const forbidden = await app.inject({
    method: 'GET', url: `/api/accounts/${bobAccount}/quota`, headers: { cookie: alice.cookie },
  });
  assert.equal(forbidden.statusCode, 404);
});

test('refresh tick keeps a minimum gap between two refreshes of the same account', async (t) => {
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  const refreshCalls = [];
  const { app, db, config, adapters } = await testApp({ config: { refreshLeadMinutes: 60 } });
  t.after(() => { app.close(); db.close(); });
  const ownerId = await seedUser(db, 'gap-owner');

  const accountId = Number(db.prepare(`
    INSERT INTO provider_accounts
      (owner_id, provider, upstream_subject, display_name, credential_envelope, access_expires_at, last_refresh_at)
    VALUES (?, 'claude', 'gap-subject', 'gap-subject', ?, ?, ?)
  `).run(
    ownerId,
    encryptJson({ accessToken: 'old', refreshToken: 'refresh-gap' }, config.encryptionKey),
    new Date(now + 30 * 60_000).toISOString(),
    new Date(now - 4 * 60_000).toISOString(),
  ).lastInsertRowid);

  const refreshFetch = async (_url, options) => {
    refreshCalls.push(JSON.parse(options.body).refresh_token);
    return new Response(JSON.stringify({ access_token: 'new-access', expires_in: 3600 }), { status: 200 });
  };

  // Refreshed 4 minutes ago: inside the 10-minute guard, so the tick must skip it.
  assert.equal(await runRefreshTick(db, adapters, config, refreshFetch, now), 0);
  assert.deepEqual(refreshCalls, []);
  assert.equal(db.prepare('SELECT token_version FROM provider_accounts WHERE id = ?').get(accountId).token_version, 1);

  // 11 minutes after the last refresh the account becomes eligible again.
  assert.equal(await runRefreshTick(db, adapters, config, refreshFetch, now + 7 * 60_000), 1);
  assert.deepEqual(refreshCalls, ['refresh-gap']);
  assert.equal(db.prepare('SELECT token_version FROM provider_accounts WHERE id = ?').get(accountId).token_version, 2);
});

test('refresh tick still runs for an account that has never been refreshed', async (t) => {
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  const refreshCalls = [];
  const { app, db, config, adapters } = await testApp({ config: { refreshLeadMinutes: 60 } });
  t.after(() => { app.close(); db.close(); });
  const ownerId = await seedUser(db, 'fresh-owner');

  db.prepare(`
    INSERT INTO provider_accounts
      (owner_id, provider, upstream_subject, display_name, credential_envelope, access_expires_at)
    VALUES (?, 'claude', 'fresh-subject', 'fresh-subject', ?, ?)
  `).run(
    ownerId,
    encryptJson({ accessToken: 'old', refreshToken: 'refresh-fresh' }, config.encryptionKey),
    new Date(now + 30 * 60_000).toISOString(),
  );

  const refreshFetch = async (_url, options) => {
    refreshCalls.push(JSON.parse(options.body).refresh_token);
    return new Response(JSON.stringify({ access_token: 'new-access', expires_in: 3600 }), { status: 200 });
  };

  assert.equal(await runRefreshTick(db, adapters, config, refreshFetch, now), 1);
  assert.deepEqual(refreshCalls, ['refresh-fresh']);
});

test('a failed refresh does not start the minimum-gap window', async (t) => {
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  let attempts = 0;
  const { app, db, config, adapters } = await testApp({ config: { refreshLeadMinutes: 60 } });
  t.after(() => { app.close(); db.close(); });
  const ownerId = await seedUser(db, 'failure-owner');

  db.prepare(`
    INSERT INTO provider_accounts
      (owner_id, provider, upstream_subject, display_name, credential_envelope, access_expires_at)
    VALUES (?, 'claude', 'failure-subject', 'failure-subject', ?, ?)
  `).run(
    ownerId,
    encryptJson({ accessToken: 'old', refreshToken: 'refresh-failure' }, config.encryptionKey),
    new Date(now + 30 * 60_000).toISOString(),
  );

  const refreshFetch = async () => {
    attempts += 1;
    return new Response('{}', { status: 500 });
  };

  await runRefreshTick(db, adapters, config, refreshFetch, now);
  await runRefreshTick(db, adapters, config, refreshFetch, now + 60_000);
  assert.equal(attempts, 2);
});
