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
  assert.ok(first.json().every((model) => model.status === 'inactive' && model.families.length === 0));
  assert.equal(db.prepare('SELECT count(*) AS n FROM model_families').get().n, 0);

  const dir = mkdtempSync(join(tmpdir(), 'portal-legacy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'legacy.db');
  const legacy = openDatabase(path);
  // Shape of the 1.4.0 production database: no status column, no family tables.
  legacy.exec('DROP TABLE model_family_links; DROP TABLE model_families; ALTER TABLE model_catalog DROP COLUMN status');
  legacy.close();
  const upgraded = openDatabase(path);
  t.after(() => upgraded.close());
  assert.equal(upgraded.prepare("SELECT count(*) AS n FROM model_catalog WHERE status = 'inactive'").get().n, 20);
  assert.equal(upgraded.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
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

test('families start empty, require admin and CSRF, validate titles and keep increasing IDs', async (t) => {
  const { app, db } = await testApp();
  t.after(() => { app.close(); db.close(); });
  const user = await member(db, app, 'alice');
  const admin = await member(db, app, 'admin', 'admin');
  const get = (headers) => app.inject({ method: 'GET', url: '/api/model-families', headers });
  assert.equal((await get()).statusCode, 401);
  assert.deepEqual((await get({ cookie: user.cookie })).json(), []);
  const add = (headers, title) => app.inject({ method: 'POST', url: '/api/model-families', headers, payload: { title } });
  assert.equal((await add(authHeaders(user), 'code')).statusCode, 403);
  assert.equal((await add({ cookie: admin.cookie }, 'code')).statusCode, 403);
  for (const title of ['Code', 'two words', '<script>', '', 'a'.repeat(65)]) {
    assert.equal((await add(authHeaders(admin), title)).statusCode, 400, title);
  }
  const first = await add(authHeaders(admin), 'code');
  assert.equal(first.statusCode, 201);
  assert.deepEqual({ id: first.json().id, title: first.json().title, modelCount: first.json().modelCount }, { id: 1, title: 'code', modelCount: 0 });
  assert.equal((await add(authHeaders(admin), 'code')).statusCode, 400);
  const second = await add(authHeaders(admin), 'mix-2');
  assert.equal(second.json().id, 2);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/model-families/1', headers: authHeaders(user), payload: { title: 'agent' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/model-families/1', headers: authHeaders(admin), payload: { title: 'agent' } })).json().title, 'agent');
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/model-families/1', headers: authHeaders(admin), payload: { title: 'mix-2' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/model-families/2', headers: authHeaders(user) })).statusCode, 403);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/model-families/2', headers: authHeaders(admin) })).statusCode, 200);
  assert.equal((await add(authHeaders(admin), 'runtime')).json().id, 3);
  assert.deepEqual((await get({ cookie: user.cookie })).json().map((family) => family.title), ['agent', 'runtime']);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/model-families/99999', headers: authHeaders(admin) })).statusCode, 404);
  assert.deepEqual(db.prepare("SELECT action FROM audit_log WHERE target_type = 'model_family' ORDER BY id").all().map((r) => r.action),
    ['admin.create_model_family', 'admin.create_model_family', 'admin.update_model_family', 'admin.delete_model_family', 'admin.create_model_family']);
});

test('models link multiple families and deleting a family unlinks all models atomically', async (t) => {
  const { app, db } = await testApp();
  t.after(() => { app.close(); db.close(); });
  const admin = await member(db, app, 'admin', 'admin');
  const add = async (title) => (await app.inject({ method: 'POST', url: '/api/model-families', headers: authHeaders(admin), payload: { title } })).json().id;
  const code = await add('code');
  const agent = await add('agent');
  const payload = { model: 'custom/one', tiers: ['High'], inputPrice: 1, outputPrice: 2, status: 'active', familyIds: [code, agent] };
  const created = await app.inject({ method: 'POST', url: '/api/models', headers: authHeaders(admin), payload });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().status, 'active');
  assert.deepEqual(created.json().families.map((family) => family.title), ['code', 'agent']);
  const id = created.json().id;
  const other = db.prepare('SELECT id FROM model_catalog ORDER BY id LIMIT 1').get().id;
  const seed = db.prepare('SELECT model, tiers, input_price, output_price FROM model_catalog WHERE id = ?').get(other);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/models/' + other, headers: authHeaders(admin), payload: {
    model: seed.model, tiers: JSON.parse(seed.tiers), inputPrice: seed.input_price, outputPrice: seed.output_price, familyIds: [code], status: 'inactive',
  } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/model-families', headers: authHeaders(admin) })).json()[0].modelCount, 2);
  const bad = await app.inject({ method: 'PATCH', url: '/api/models/' + id, headers: authHeaders(admin), payload: { ...payload, familyIds: [code, 99999] } });
  assert.equal(bad.statusCode, 400);
  assert.deepEqual(db.prepare('SELECT family_id FROM model_family_links WHERE model_id = ? ORDER BY family_id').all(id).map((r) => r.family_id), [code, agent]);
  db.exec("CREATE TRIGGER reject_family_delete BEFORE INSERT ON audit_log WHEN NEW.action = 'admin.delete_model_family' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/model-families/' + code, headers: authHeaders(admin) })).statusCode, 500);
  assert.equal(db.prepare('SELECT count(*) AS n FROM model_family_links WHERE family_id = ?').get(code).n, 2);
  db.exec('DROP TRIGGER reject_family_delete');
  const deleted = await app.inject({ method: 'DELETE', url: '/api/model-families/' + code, headers: authHeaders(admin) });
  assert.equal(deleted.statusCode, 200);
  assert.equal(deleted.json().unlinkedModels, 2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM model_family_links WHERE family_id = ?').get(code).n, 0);
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/models', headers: authHeaders(admin) })).json().find((m) => m.id === id).families.map((f) => f.title), ['agent']);
});

test('model status defaults inactive, validates status and family IDs, and toggles with audit', async (t) => {
  const { app, db } = await testApp();
  t.after(() => { app.close(); db.close(); });
  const user = await member(db, app, 'alice');
  const admin = await member(db, app, 'admin', 'admin');
  const payload = { model: 'custom/status', tiers: ['Medium'], inputPrice: 0, outputPrice: 1 };
  const created = await app.inject({ method: 'POST', url: '/api/models', headers: authHeaders(admin), payload });
  assert.equal(created.json().status, 'inactive');
  assert.deepEqual(created.json().families, []);
  const id = created.json().id;
  for (const patch of [{ status: 'enabled' }, { status: true }, { familyIds: [1, 1] }, { familyIds: ['1'] }, { familyIds: [12345] }]) {
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/models/' + id, headers: authHeaders(admin), payload: { ...payload, ...patch } })).statusCode, 400);
  }
  const url = '/api/models/' + id + '/status';
  assert.equal((await app.inject({ method: 'PATCH', url, headers: authHeaders(user), payload: { status: 'active' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'PATCH', url, headers: { cookie: admin.cookie }, payload: { status: 'active' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'PATCH', url, headers: authHeaders(admin), payload: { status: 'on' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url, headers: authHeaders(admin), payload: { status: 'active' } })).json().status, 'active');
  assert.equal(db.prepare('SELECT status FROM model_catalog WHERE id = ?').get(id).status, 'active');
  assert.equal(db.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'admin.set_model_status' AND target_id = ?").get(String(id)).n, 1);
});

test('model deletion requires admin and CSRF, clears links, and rolls back on audit failure', async (t) => {
  const { app, db } = await testApp();
  t.after(() => { app.close(); db.close(); });
  const user = await member(db, app, 'alice');
  const admin = await member(db, app, 'admin', 'admin');
  const family = (await app.inject({ method: 'POST', url: '/api/model-families', headers: authHeaders(admin), payload: { title: 'code' } })).json().id;
  const payload = { model: 'custom/delete-me', tiers: ['High'], inputPrice: 1, outputPrice: 2, familyIds: [family] };
  const id = (await app.inject({ method: 'POST', url: '/api/models', headers: authHeaders(admin), payload })).json().id;
  const url = '/api/models/' + id;
  assert.equal((await app.inject({ method: 'DELETE', url, headers: authHeaders(user) })).statusCode, 403);
  assert.equal((await app.inject({ method: 'DELETE', url, headers: { cookie: admin.cookie } })).statusCode, 403);
  db.exec("CREATE TRIGGER reject_model_delete BEFORE INSERT ON audit_log WHEN NEW.action = 'admin.delete_model' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
  assert.equal((await app.inject({ method: 'DELETE', url, headers: authHeaders(admin) })).statusCode, 500);
  assert.equal(db.prepare('SELECT count(*) AS n FROM model_family_links WHERE model_id = ?').get(id).n, 1);
  db.exec('DROP TRIGGER reject_model_delete');
  assert.equal((await app.inject({ method: 'DELETE', url, headers: authHeaders(admin) })).statusCode, 200);
  assert.equal(db.prepare('SELECT count(*) AS n FROM model_family_links WHERE model_id = ?').get(id).n, 0);
  assert.equal((await app.inject({ method: 'DELETE', url, headers: authHeaders(admin) })).statusCode, 404);
  assert.equal(db.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'admin.delete_model' AND target_id = ?").get(String(id)).n, 1);
});

test('audit view names deleted models and model families', async (t) => {
  const { app, db } = await testApp();
  t.after(() => { app.close(); db.close(); });
  const admin = await member(db, app, 'admin', 'admin');
  const family = (await app.inject({ method: 'POST', url: '/api/model-families', headers: authHeaders(admin), payload: { title: 'code' } })).json().id;
  const id = (await app.inject({ method: 'POST', url: '/api/models', headers: authHeaders(admin), payload: { model: 'custom/gone', tiers: ['High'], inputPrice: 1, outputPrice: 2 } })).json().id;
  await app.inject({ method: 'DELETE', url: '/api/models/' + id, headers: authHeaders(admin) });
  await app.inject({ method: 'DELETE', url: '/api/model-families/' + family, headers: authHeaders(admin) });
  const items = (await app.inject({ method: 'GET', url: '/api/admin/audit?page=1&pageSize=20', headers: { cookie: admin.cookie } })).json().items;
  const target = (action) => items.find((item) => item.action === action)?.target;
  assert.equal(target('admin.delete_model'), 'custom/gone');
  assert.equal(target('admin.create_model'), 'custom/gone');
  assert.equal(target('admin.delete_model_family'), 'code');
  assert.equal(target('admin.create_model_family'), 'code');
});
