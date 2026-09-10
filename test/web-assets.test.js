import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { appScript } from '../src/web/client.js';
import { styles } from '../src/web/styles.js';
import { renderApp } from '../src/web/page.js';
import { testApp } from './helpers/test-app.js';

test('client bundle parses and exposes the three product surfaces', () => {
  assert.doesNotThrow(() => new vm.Script(appScript));
  for (const label of ['Providers', 'Quota Tracker', 'Admin']) assert.match(appScript, new RegExp(label));
  assert.doesNotMatch(appScript, /Tạo tài khoản mới|Sponsored accounts|OmniRoute/);
  assert.match(appScript, /Read-only/);
});

test('served assets contain the 9Router-inspired portal shell', () => {
  assert.match(renderApp(), /<aside>/);
  assert.match(renderApp(), /Account Operations/);
  assert.match(styles, /\.nav-item/);
  for (const status of ['active', 'disabled', 'failed', 'needs_reauth', 'pending']) {
    assert.match(styles, new RegExp('\\.badge\\.' + status + '\\b'));
  }
});

test('plain HTTP mode does not tell browsers to upgrade assets to HTTPS', async (t) => {
  const { app, db } = await testApp({ config: { tls: false, secureCookies: false } });
  t.after(() => { app.close(); db.close(); });
  const response = await app.inject({ method: 'GET', url: '/' });
  assert.equal(response.statusCode, 200);
  assert.doesNotMatch(response.headers['content-security-policy'], /upgrade-insecure-requests/);
});
