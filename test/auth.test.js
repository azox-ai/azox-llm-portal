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
