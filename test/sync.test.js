import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/index.js';
import { loadConfig } from '../src/config.js';
import { encryptJson } from '../src/lib/crypto.js';
import { reconcileAccount, removeAccount, aggregateStatus, markPending } from '../src/services/sync.js';
import { fakeAdapter } from './helpers/test-app.js';

function seed() {
  const db = openDatabase(':memory:');
  const config = loadConfig({ dbPath: ':memory:', encryptionKey: 'sync-test-key-long-enough' });
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('alice', 'x', 'user')").run();
  const envelope = encryptJson({ accessToken: 'a', refreshToken: 'r' }, config.encryptionKey);
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO sponsored_accounts (owner_id, provider, upstream_subject, display_name, credential_envelope)
    VALUES (1, 'claude', 'sub-1', 'a***@example.com', ?)
  `).run(envelope);
  return { db, config, accountId: Number(lastInsertRowid) };
}

test('one router failing never blocks the other', async () => {
  const { db, config, accountId } = seed();
  const adapters = {
    ninerouter: fakeAdapter('nine', { inject: () => { throw new Error('router down'); } }),
    omniroute: fakeAdapter('omni'),
  };
  markPending(db, accountId);

  const summary = await reconcileAccount(db, adapters, config, accountId);

  assert.equal(summary.ninerouter, 'failed');
  assert.equal(summary.omniroute, 'active');
  // The working router must still hold a usable remote id.
  const omni = db.prepare("SELECT remote_id FROM router_connections WHERE account_id = ? AND router = 'omniroute'").get(accountId);
  assert.equal(omni.remote_id, `omni-${accountId}`);
});

test('a structural capability gap is recorded as unsupported, not failed', async () => {
  const { db, config, accountId } = seed();
  const unsupported = Object.assign(new Error('no Claude import route'), { code: 'injection_unsupported' });
  const adapters = {
    ninerouter: fakeAdapter('nine', { inject: () => { throw unsupported; } }),
    omniroute: fakeAdapter('omni'),
  };
  markPending(db, accountId);

  const summary = await reconcileAccount(db, adapters, config, accountId);

  // Retrying can never fix this, so it must not look like a transient fault.
  assert.equal(summary.ninerouter, 'unsupported');
  assert.equal(aggregateStatus(summary), 'partially_synced');
});

test('deletion is fail-closed when a router refuses', async () => {
  const { db, config, accountId } = seed();
  const adapters = {
    ninerouter: fakeAdapter('nine'),
    omniroute: fakeAdapter('omni', { remove: () => { throw new Error('boom'); } }),
  };
  markPending(db, accountId);
  await reconcileAccount(db, adapters, config, accountId);

  const result = await removeAccount(db, adapters, accountId);

  assert.equal(result.removed, false);
  // The record must survive so the live upstream credential is never orphaned.
  const still = db.prepare('SELECT id FROM sponsored_accounts WHERE id = ?').get(accountId);
  assert.ok(still, 'account must be kept until both routers confirm deletion');
});

test('aggregate status distinguishes degraded from healthy', () => {
  assert.equal(aggregateStatus({ ninerouter: 'active', omniroute: 'active' }), 'active');
  assert.equal(aggregateStatus({ ninerouter: 'disabled', omniroute: 'disabled' }), 'disabled');
  assert.equal(aggregateStatus({ ninerouter: 'active', omniroute: 'failed' }), 'partially_synced');
  assert.equal(aggregateStatus({ ninerouter: 'failed', omniroute: 'failed' }), 'failed');
  assert.equal(aggregateStatus({ ninerouter: 'unsupported', omniroute: 'unsupported' }), 'unsupported');
});
