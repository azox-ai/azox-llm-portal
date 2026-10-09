import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authHeaders, login, testApp } from './helpers/test-app.js';
import { hashPassword } from '../src/services/auth.js';
import { openDatabase } from '../src/db/index.js';

async function member(db, app, name, role = 'user') {
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run(name, await hashPassword('correct horse battery'), role);
  return login(app, name);
}

const titles = ['model-ultra', 'model-max', 'model-high', 'model-medium'];

test('existing catalog tiers migrate once without losing model links or rollback values', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-tiers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'portal.db');
  const db = openDatabase(path);
  assert.deepEqual(db.prepare('SELECT id, title FROM model_tiers ORDER BY id').all().map(({ id, title }) => ({ id, title })),
    titles.map((title, index) => ({ id: index + 1, title })));
  assert.equal(db.prepare('SELECT count(*) AS n FROM model_tier_links').get().n, 20);
  assert.equal(db.prepare('SELECT tiers FROM model_catalog WHERE id = 1').get().tiers, '["Ultra"]');
  db.prepare('DELETE FROM model_tier_links WHERE model_id = 1').run();
  db.prepare('DELETE FROM model_tiers WHERE id = 1').run();
  db.close();
  const reopened = openDatabase(path);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.prepare('SELECT title FROM model_tiers ORDER BY id').all().map((r) => r.title), titles.slice(1));
  assert.equal(reopened.prepare('SELECT count(*) AS n FROM model_tier_links WHERE model_id = 1').get().n, 0);

  // Shape of the 1.5.0 production database: tiers only in the JSON column.
  const legacyPath = join(dir, 'legacy.db');
  const legacy = openDatabase(legacyPath);
  legacy.exec("DROP TABLE model_tier_links; DROP TABLE model_tiers; DELETE FROM app_settings WHERE key = 'model_tiers_migrated'");
  legacy.prepare('UPDATE model_catalog SET tiers = ? WHERE id = 2').run('["Max","High"]');
  legacy.close();
  const upgraded = openDatabase(legacyPath);
  t.after(() => upgraded.close());
  assert.deepEqual(upgraded.prepare('SELECT title FROM model_tiers ORDER BY id').all().map((r) => r.title), titles);
  assert.equal(upgraded.prepare('SELECT count(*) AS n FROM model_tier_links').get().n, 21);
  assert.deepEqual(upgraded.prepare(`SELECT t.title FROM model_tier_links l JOIN model_tiers t ON t.id = l.tier_id
    WHERE l.model_id = 2 ORDER BY t.id`).all().map((r) => r.title), ['model-max', 'model-high']);
  assert.equal(upgraded.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('tier CRUD requires admin and CSRF, assigns monotonic IDs, and audits changes', async (t) => {
  const { app, db } = await testApp();
  t.after(() => { app.close(); db.close(); });
  const user = await member(db, app, 'alice');
  const admin = await member(db, app, 'admin', 'admin');
  const get = (headers) => app.inject({ method: 'GET', url: '/api/model-tiers', headers });
  assert.equal((await get()).statusCode, 401);
  assert.deepEqual((await get({ cookie: user.cookie })).json().map((tier) => tier.title), titles);
  const add = (headers, title) => app.inject({ method: 'POST', url: '/api/model-tiers', headers, payload: { title } });
  assert.equal((await add(authHeaders(user), 'custom')).statusCode, 403);
  assert.equal((await add({ cookie: admin.cookie }, 'custom')).statusCode, 403);
  for (const title of ['BAD', 'two words', '<script>', '', 'a'.repeat(65), 'model-ultra']) {
    assert.equal((await add(authHeaders(admin), title)).statusCode, 400, title);
  }
  const created = await add(authHeaders(admin), 'custom');
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().id, 5);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/model-tiers/5', headers: authHeaders(user), payload: { title: 'new' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/model-tiers/5', headers: { cookie: admin.cookie }, payload: { title: 'new' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/model-tiers/5', headers: authHeaders(admin), payload: { title: 'new' } })).json().title, 'new');
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/model-tiers/5', headers: authHeaders(admin), payload: { title: 'model-max' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/model-tiers/5', headers: authHeaders(user) })).statusCode, 403);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/model-tiers/5', headers: { cookie: admin.cookie } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/model-tiers/5', headers: authHeaders(admin) })).statusCode, 200);
  assert.equal((await add(authHeaders(admin), 'latest')).json().id, 6);
  assert.deepEqual(db.prepare("SELECT action FROM audit_log WHERE target_type = 'model_tier' ORDER BY id").all().map((r) => r.action),
    ['admin.create_model_tier', 'admin.update_model_tier', 'admin.delete_model_tier', 'admin.create_model_tier']);
});

test('models link multiple tiers, rename follows IDs, and delete unlinks without requiring replacement', async (t) => {
  const { app, db } = await testApp();
  t.after(() => { app.close(); db.close(); });
  const admin = await member(db, app, 'admin', 'admin');
  const payload = { model: 'custom/tiers', tierIds: [1, 3], inputPrice: 1, outputPrice: 2 };
  const created = await app.inject({ method: 'POST', url: '/api/models', headers: authHeaders(admin), payload });
  assert.equal(created.statusCode, 201);
  const id = created.json().id;
  assert.deepEqual(created.json().tiers, [{ id: 1, title: 'model-ultra' }, { id: 3, title: 'model-high' }]);
  // The legacy column keeps 1.5 names so a rolled-back image can still read and edit the row.
  assert.deepEqual(JSON.parse(db.prepare('SELECT tiers FROM model_catalog WHERE id = ?').get(id).tiers), ['Ultra', 'High']);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/model-tiers/1', headers: authHeaders(admin), payload: { title: 'renamed-ultra' } })).statusCode, 200);
  const getModel = async () => (await app.inject({ method: 'GET', url: '/api/models', headers: { cookie: admin.cookie } })).json().find((row) => row.id === id);
  const titlesOf = async () => (await getModel()).tiers.map((tier) => tier.title);
  assert.deepEqual(await titlesOf(), ['renamed-ultra', 'model-high']);
  assert.deepEqual(JSON.parse(db.prepare('SELECT tiers FROM model_catalog WHERE id = ?').get(id).tiers), ['renamed-ultra', 'High']);
  for (const tierIds of [[99999], [1, 1], ['1'], 'model-max']) {
    const bad = await app.inject({ method: 'PATCH', url: '/api/models/' + id, headers: authHeaders(admin), payload: { ...payload, tierIds } });
    assert.equal(bad.statusCode, 400, JSON.stringify(tierIds));
  }
  // Omitting tierIds keeps the stored tiers, like families.
  const withoutTiers = { model: payload.model, inputPrice: payload.inputPrice, outputPrice: payload.outputPrice };
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/models/' + id, headers: authHeaders(admin), payload: withoutTiers })).statusCode, 200);
  assert.deepEqual(await titlesOf(), ['renamed-ultra', 'model-high']);
  db.exec("CREATE TRIGGER reject_tier_delete BEFORE INSERT ON audit_log WHEN NEW.action = 'admin.delete_model_tier' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/model-tiers/1', headers: authHeaders(admin) })).statusCode, 500);
  assert.deepEqual(await titlesOf(), ['renamed-ultra', 'model-high']);
  db.exec('DROP TRIGGER reject_tier_delete');
  const deleted = await app.inject({ method: 'DELETE', url: '/api/model-tiers/1', headers: authHeaders(admin) });
  assert.equal(deleted.json().unlinkedModels, 3);
  assert.deepEqual(await titlesOf(), ['model-high']);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/model-tiers/3', headers: authHeaders(admin) })).statusCode, 200);
  assert.deepEqual((await getModel()).tiers, []);
  assert.deepEqual(JSON.parse(db.prepare('SELECT tiers FROM model_catalog WHERE id = ?').get(id).tiers), []);
  const empty = await app.inject({ method: 'PATCH', url: '/api/models/' + id, headers: authHeaders(admin), payload: { ...payload, tierIds: [] } });
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json().tiers, []);
});
