import test from 'node:test';
import assert from 'node:assert/strict';
import { authHeaders, login, testApp } from './helpers/test-app.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword } from '../src/services/auth.js';
import { openDatabase } from '../src/db/index.js';

async function member(db, app, name, role = 'user') {
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run(name, await hashPassword('correct horse battery'), role);
  return login(app, name);
}

test('catalog seeds 20 distinct models once', async (t) => {
  const { app, db } = await testApp();
  t.after(() => { app.close(); db.close(); });
  const user = await member(db, app, 'alice');
  const first = await app.inject({ method: 'GET', url: '/api/models', headers: { cookie: user.cookie } });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().length, 20);
  assert.equal(new Set(first.json().map((row) => row.model)).size, 20);
  assert.deepEqual(first.json().slice(0, 2).map((row) => row.model), [
    'anthropic/claude-fable-5', 'openai/gpt-6-astra',
  ]);
  assert.deepEqual(first.json()[0].tiers, ['Ultra']);
  assert.equal(first.json()[0].inputPrice, 10);
  assert.equal(first.json()[0].outputPrice, 50);
  const second = await app.inject({ method: 'GET', url: '/api/models', headers: { cookie: user.cookie } });
  assert.deepEqual(second.json(), first.json());
  assert.equal(db.prepare('SELECT count(*) AS n FROM model_catalog').get().n, 20);
});

test('all users can read models but only admins can add, edit and reorder', async (t) => {
  const { app, db } = await testApp();
  t.after(() => { app.close(); db.close(); });
  const user = await member(db, app, 'alice');
  const admin = await member(db, app, 'admin', 'admin');
  assert.equal((await app.inject({ method: 'GET', url: '/api/models' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/models', headers: { cookie: user.cookie } })).statusCode, 200);
  const payload = { model: 'custom/new-model', tiers: ['Ultra', 'Medium'], inputPrice: 0.01, outputPrice: 0.5 };
  assert.equal((await app.inject({ method: 'POST', url: '/api/models', headers: authHeaders(user), payload })).statusCode, 403);
  const created = await app.inject({ method: 'POST', url: '/api/models', headers: authHeaders(admin), payload });
  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.json().tiers, ['Ultra', 'Medium']);
  const id = created.json().id;
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/models/' + id, headers: authHeaders(user), payload })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/models/' + id + '/move', headers: authHeaders(user), payload: { direction: 'up' } })).statusCode, 403);
  const changed = await app.inject({ method: 'PATCH', url: '/api/models/' + id, headers: authHeaders(admin), payload: { ...payload, tiers: ['Max', 'High'] } });
  assert.equal(changed.statusCode, 200);
  assert.deepEqual(changed.json().tiers, ['Max', 'High']);
  const moved = await app.inject({ method: 'POST', url: '/api/models/' + id + '/move', headers: authHeaders(admin), payload: { direction: 'up' } });
  assert.equal(moved.statusCode, 200);
  const listing = (await app.inject({ method: 'GET', url: '/api/models', headers: { cookie: user.cookie } })).json();
  assert.equal(listing.at(-2).id, id);
  assert.deepEqual(listing.map((row) => row.position), Array.from({ length: 21 }, (_, i) => i + 1));
});

test('catalog accepts provider IDs with uppercase and variant suffixes', async (t) => {
  const { app, db } = await testApp();
  t.after(() => { app.close(); db.close(); });
  const admin = await member(db, app, 'admin', 'admin');
  for (const model of ['meta-llama/Llama-3.1-8B-Instruct', 'deepseek/deepseek-r1:free']) {
    const result = await app.inject({ method: 'POST', url: '/api/models', headers: authHeaders(admin),
      payload: { model, tiers: ['High'], inputPrice: 0.00005, outputPrice: 1 } });
    assert.equal(result.statusCode, 201, model);
  }
});

test('catalog mutation rolls back when audit insert fails', async (t) => {
  const { app, db } = await testApp();
  t.after(() => { app.close(); db.close(); });
  const admin = await member(db, app, 'admin', 'admin');
  const model = 'anthropic/claude-fable-5';
  const before = db.prepare('SELECT * FROM model_catalog WHERE model = ?').get(model);
  const count = db.prepare('SELECT count(*) AS n FROM model_catalog').get().n;
  db.exec("CREATE TRIGGER reject_model_audit BEFORE INSERT ON audit_log WHEN NEW.action IN ('admin.create_model', 'admin.update_model') BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
  const update = await app.inject({ method: 'PATCH', url: '/api/models/' + before.id, headers: authHeaders(admin),
    payload: { model, tiers: ['Medium'], inputPrice: 20, outputPrice: 100 } });
  assert.equal(update.statusCode, 500);
  assert.deepEqual(db.prepare('SELECT * FROM model_catalog WHERE model = ?').get(model), before);
  const create = await app.inject({ method: 'POST', url: '/api/models', headers: authHeaders(admin),
    payload: { model: 'custom/no-audit', tiers: ['High'], inputPrice: 1, outputPrice: 1 } });
  assert.equal(create.statusCode, 500);
  assert.equal(db.prepare('SELECT count(*) AS n FROM model_catalog').get().n, count);
});

test('admin edits survive reopening a file-backed database', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-models-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'portal.db');
  const first = openDatabase(path);
  first.prepare("DELETE FROM model_catalog WHERE model = 'anthropic/claude-fable-5'").run();
  first.prepare("UPDATE model_catalog SET tiers = '[\"Max\",\"High\"]' WHERE model = 'openai/gpt-6-astra'").run();
  first.close();
  const second = openDatabase(path);
  t.after(() => second.close());
  assert.equal(second.prepare('SELECT count(*) AS n FROM model_catalog').get().n, 19);
  assert.equal(second.prepare("SELECT tiers FROM model_catalog WHERE model = 'openai/gpt-6-astra'").get().tiers, '["Max","High"]');
});

test('model writes require CSRF and reorder rejects edges and unknown rows', async (t) => {
  const { app, db } = await testApp();
  t.after(() => { app.close(); db.close(); });
  const admin = await member(db, app, 'admin', 'admin');
  const first = db.prepare('SELECT id FROM model_catalog ORDER BY position LIMIT 1').get().id;
  const last = db.prepare('SELECT id FROM model_catalog ORDER BY position DESC LIMIT 1').get().id;
  const noCsrf = await app.inject({ method: 'POST', url: '/api/models/' + first + '/move', headers: { cookie: admin.cookie }, payload: { direction: 'down' } });
  assert.equal(noCsrf.statusCode, 403);
  const move = (id, direction) => app.inject({ method: 'POST', url: '/api/models/' + id + '/move', headers: authHeaders(admin), payload: { direction } });
  assert.equal((await move(first, 'up')).statusCode, 400);
  assert.equal((await move(last, 'down')).statusCode, 400);
  assert.equal((await move(first, 'left')).statusCode, 400);
  assert.equal((await move(999999, 'up')).statusCode, 404);
  const missing = await app.inject({ method: 'PATCH', url: '/api/models/999999', headers: authHeaders(admin), payload: { model: 'custom/x', tiers: ['Max'], inputPrice: 1, outputPrice: 1 } });
  assert.equal(missing.statusCode, 404);
  assert.equal(db.prepare('SELECT id FROM model_catalog ORDER BY position LIMIT 1').get().id, first);
});

test('invalid or duplicate models cannot change catalog', async (t) => {
  const { app, db } = await testApp();
  t.after(() => { app.close(); db.close(); });
  const admin = await member(db, app, 'admin', 'admin');
  const initial = db.prepare('SELECT count(*) AS n FROM model_catalog').get().n;
  for (const model of ['', '<script>', 'custom model', 'anthropic/claude-fable-5']) {
    const result = await app.inject({ method: 'POST', url: '/api/models', headers: authHeaders(admin), payload: { model, tiers: ['Max'], inputPrice: 1, outputPrice: 1 } });
    assert.equal(result.statusCode, 400, model);
  }
  for (const tiers of [[], ['Unknown'], ['Ultra', 'Ultra'], 'Max']) {
    const result = await app.inject({ method: 'POST', url: '/api/models', headers: authHeaders(admin), payload: { model: 'custom/new-model', tiers, inputPrice: 1, outputPrice: 1 } });
    assert.equal(result.statusCode, 400);
  }
  for (const price of [-1, 'free', Infinity]) {
    const result = await app.inject({ method: 'POST', url: '/api/models', headers: authHeaders(admin), payload: { model: 'custom/new-model', tiers: ['Max'], inputPrice: price, outputPrice: 1 } });
    assert.equal(result.statusCode, 400);
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM model_catalog').get().n, initial);
});
