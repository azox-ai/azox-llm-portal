import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { appScript } from '../src/web/client.js';
import { styles } from '../src/web/styles.js';
import { renderApp } from '../src/web/page.js';
import { testApp } from './helpers/test-app.js';

/**
 * The browser bundle is stored inside a template literal, so a stray backtick
 * or `${` in the client code terminates that literal and breaks the whole
 * module — a failure that surfaces as an unrelated import error elsewhere in
 * the suite. These tests pin the bundle's integrity at its source.
 */
test('the client bundle parses as JavaScript', () => {
  assert.doesNotThrow(() => new vm.Script(appScript), 'client bundle must be syntactically valid');
});

test('the client bundle is delivered whole', () => {
  // A prematurely closed template literal truncates the script rather than
  // breaking it, so length and a marker from the end of the file are checked.
  assert.ok(appScript.length > 1000, 'bundle looks truncated');
  // The bootstrap IIFE is the last thing in the file, so its presence proves
  // the template literal ran to the end.
  assert.match(appScript, /state\.me = await api\('\/api\/me'\)/, 'bundle is missing its bootstrap');
  assert.match(appScript, /\.onclick = /, 'bundle is missing its event wiring');
});

test('served assets are non-empty and self-consistent', () => {
  assert.ok(styles.includes('.badge'), 'status badge styling is missing');
  // Every status the sync layer can produce needs a visible style.
  for (const status of ['active', 'disabled', 'failed', 'needs_reauth', 'partially_synced', 'pending', 'unsupported']) {
    assert.match(styles, new RegExp('\\.badge\\.' + status + '\\b'), `no styling for status: ${status}`);
  }
  assert.match(renderApp(), /<!doctype html>/i);
});

// Browser-level regression for the blank page seen on zbs3. Helmet adds
// `upgrade-insecure-requests` by default; over a plain HTTP Tailscale address,
// browsers then rewrite /app.js and /styles.css to https:// where no listener
// exists. curl still reports both assets as 200, so source-only tests miss it.
test('plain HTTP mode does not tell browsers to upgrade assets to HTTPS', async (t) => {
  const { app, db } = await testApp({ config: { tls: false, secureCookies: false } });
  t.after(() => { app.close(); db.close(); });
  const response = await app.inject({ method: 'GET', url: '/' });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-security-policy'], /script-src 'self'/);
  assert.doesNotMatch(response.headers['content-security-policy'], /upgrade-insecure-requests/);
  assert.equal(response.headers['strict-transport-security'], undefined);
});

test('TLS mode keeps HSTS, secure cookies and HTTPS asset upgrades', async (t) => {
  const { app, db } = await testApp({ config: { tls: true, secureCookies: true } });
  t.after(() => { app.close(); db.close(); });

  const page = await app.inject({ method: 'GET', url: '/' });
  assert.match(page.headers['content-security-policy'], /upgrade-insecure-requests/);
  assert.match(page.headers['strict-transport-security'], /max-age=/);

  const registration = await app.inject({
    method: 'POST',
    url: '/api/register',
    payload: { username: 'alice', password: 'correct horse battery' },
  });
  const sessionCookie = registration.cookies.find((cookie) => cookie.name === 'sp_session');
  assert.equal(sessionCookie?.secure, true);
});

test('the portal never advertises quota or usage', () => {
  // A deliberate product constraint: sponsors see accounts, not limits.
  for (const forbidden of [/\bquota\b/i, /\busage\b/i, /\blimit\b/i]) {
    const hit = appScript.match(forbidden);
    // The one permitted mention is the note explaining the absence.
    if (hit) assert.match(appScript, /Portal không hiển thị quota/, `unexpected mention of ${hit[0]}`);
  }
});
