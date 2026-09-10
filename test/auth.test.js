import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp, register, authHeaders } from './helpers/test-app.js';
import { ensureInitialAdmin } from '../src/services/auth.js';

test('self-registration creates a user session but never admin', async (t) => {
  const { app, db } = await testApp();
  t.after(() => { app.close(); db.close(); });
  const auth = await register(app);
  assert.equal(auth.response.statusCode, 201);
  assert.ok(auth.cookie);
  assert.ok(auth.csrf);
  assert.equal(db.prepare("SELECT role FROM users WHERE username = 'alice'").get().role, 'user');

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: auth.cookie } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().username, 'alice');
});

test('registration validates input and duplicate usernames', async (t) => {
  const { app, db } = await testApp();
  t.after(() => { app.close(); db.close(); });
  assert.equal((await register(app, 'x', 'correct horse battery')).response.statusCode, 400);
  assert.equal((await register(app, 'alice', 'short')).response.statusCode, 400);
  assert.equal((await register(app)).response.statusCode, 201);
  assert.equal((await register(app, 'ALICE')).response.statusCode, 409);
});

test('mutations require CSRF while reads accept session cookie', async (t) => {
  const { app, db } = await testApp();
  t.after(() => { app.close(); db.close(); });
  const auth = await register(app);
  const denied = await app.inject({
    method: 'POST', url: '/api/logout', headers: { cookie: auth.cookie },
  });
  assert.equal(denied.statusCode, 403);
  const ok = await app.inject({ method: 'POST', url: '/api/logout', headers: authHeaders(auth) });
  assert.equal(ok.statusCode, 200);
});

// Regression: an `/api/oauth/` prefix exemption once lived in the CSRF hook,
// intended to let the OAuth callback through. The callback is a GET, so the
// exemption never applied to it and only ever disabled CSRF on this POST —
// letting a cross-site page start OAuth flows on a logged-in user's session.
test('POST /api/oauth/:provider/start is not exempt from CSRF', async (t) => {
  const { app, db } = await testApp();
  t.after(() => { app.close(); db.close(); });
  const auth = await register(app);

  const denied = await app.inject({
    method: 'POST', url: '/api/oauth/codex/start', headers: { cookie: auth.cookie },
  });
  assert.equal(denied.statusCode, 403, 'missing CSRF token must be rejected');

  const wrongToken = await app.inject({
    method: 'POST',
    url: '/api/oauth/codex/start',
    headers: { cookie: auth.cookie, 'x-csrf-token': 'not-the-session-token' },
  });
  assert.equal(wrongToken.statusCode, 403, 'mismatched CSRF token must be rejected');

  // With the real token the request reaches the handler (200 here because the
  // test config has a configured provider) — proving 403 came from CSRF, not
  // from the route being unreachable.
  const allowed = await app.inject({
    method: 'POST', url: '/api/oauth/codex/start', headers: authHeaders(auth),
  });
  assert.equal(allowed.statusCode, 200);
});

// The GET callback must stay reachable without a CSRF header: the browser
// arrives from the provider's redirect and cannot carry one. Its protection is
// the one-time PKCE state, which is what rejects this stateless request.
test('OAuth callback needs no CSRF header', async (t) => {
  const { app, db } = await testApp();
  t.after(() => { app.close(); db.close(); });
  const auth = await register(app);
  const response = await app.inject({
    method: 'GET',
    url: '/api/oauth/codex/callback?code=abc&state=never-issued',
    headers: { cookie: auth.cookie },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /state/i);
});

test('initial admin is seeded once and must change password', async (t) => {
  const { app, db, config } = await testApp({ config: { initialAdminPassword: 'initial admin password' } });
  t.after(() => { app.close(); db.close(); });
  assert.equal(await ensureInitialAdmin(db, config), true);
  assert.equal(await ensureInitialAdmin(db, config), false);
  const admin = db.prepare("SELECT role, must_change_password FROM users WHERE username = 'admin'").get();
  assert.equal(admin.role, 'admin');
  assert.equal(admin.must_change_password, 1);

  const login = await app.inject({
    method: 'POST', url: '/api/login', payload: { username: 'admin', password: 'initial admin password' },
  });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().mustChangePassword, true);
});
