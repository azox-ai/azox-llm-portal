import test from 'node:test';
import assert from 'node:assert/strict';
import { testApp, register, authHeaders } from './helpers/test-app.js';
import { ensureInitialAdmin } from '../src/services/auth.js';

test('admin resets password with a temporary secret and revokes sessions', async (t) => {
  const { app, db, config } = await testApp({ config: { initialAdminPassword: 'initial admin password' } });
  t.after(() => { app.close(); db.close(); });
  await ensureInitialAdmin(db, config);
  const user = await register(app, 'alice');
  const userId = db.prepare("SELECT id FROM users WHERE username = 'alice'").get().id;

  const login = await app.inject({
    method: 'POST', url: '/api/login', payload: { username: 'admin', password: 'initial admin password' },
  });
  const admin = {
    cookie: `sp_session=${login.cookies.find((c) => c.name === 'sp_session').value}`,
    csrf: login.json().csrfToken,
  };
  const reset = await app.inject({
    method: 'POST', url: `/api/admin/users/${userId}/reset-password`, headers: authHeaders(admin),
  });
  assert.equal(reset.statusCode, 200);
  assert.ok(reset.json().temporaryPassword.length >= 16);
  assert.equal(db.prepare('SELECT must_change_password FROM users WHERE id = ?').get(userId).must_change_password, 1);

  const stale = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: user.cookie } });
  assert.equal(stale.statusCode, 401);
});

test('normal user cannot use admin API', async (t) => {
  const { app, db } = await testApp();
  t.after(() => { app.close(); db.close(); });
  const user = await register(app);
  const response = await app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: user.cookie } });
  assert.equal(response.statusCode, 403);
});

test('last active admin cannot demote or disable themself', async (t) => {
  const { app, db, config } = await testApp({ config: { initialAdminPassword: 'initial admin password' } });
  t.after(() => { app.close(); db.close(); });
  await ensureInitialAdmin(db, config);
  const adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  const login = await app.inject({
    method: 'POST', url: '/api/login', payload: { username: 'admin', password: 'initial admin password' },
  });
  const admin = {
    cookie: `sp_session=${login.cookies.find((c) => c.name === 'sp_session').value}`,
    csrf: login.json().csrfToken,
  };
  const response = await app.inject({
    method: 'PATCH', url: `/api/admin/users/${adminId}`,
    headers: authHeaders(admin), payload: { disabled: true },
  });
  assert.equal(response.statusCode, 409);
});
