import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { appScript } from '../src/web/client.js';
import { styles } from '../src/web/styles.js';
import { renderApp } from '../src/web/page.js';
import { testApp } from './helpers/test-app.js';

test('client bundle parses and merges quota into the providers surface', () => {
  assert.doesNotThrow(() => new vm.Script(appScript));
  for (const label of ['Providers', 'Sponsors', 'Admin']) assert.match(appScript, new RegExp(label));
  // Quota Tracker is no longer a separate tab: it renders under each account row.
  assert.match(appScript, /quota-row/);
  assert.match(appScript, /quotaStrip/);
  assert.doesNotMatch(appScript, /\['quota', /);
  assert.doesNotMatch(appScript, /function quotaView/);
  // Quota now loads with the page instead of behind a button.
  assert.match(appScript, /loadQuotas/);
  assert.doesNotMatch(appScript, /data-quota=/);
  assert.doesNotMatch(appScript, /Bấm Quota để tải usage hiện tại/);
  assert.doesNotMatch(appScript, /Quota Tracker · read-only/);
  assert.doesNotMatch(appScript, /Flow OAuth hai bước giống 9Router/);
  assert.doesNotMatch(appScript, /Quota hiển thị ngay dưới mỗi account/);
  assert.match(appScript, /sponsorsView/);
  assert.doesNotMatch(appScript, /Tạo tài khoản mới/);
  assert.match(appScript, /OmniRoute/);
  assert.match(appScript, /Sponsored by: /);
  assert.match(appScript, /Step 1: Open OAuth URL|Open OAuth URL in browser/);
  assert.match(appScript, /Paste full Codex callback URL/);
  // Login uses one form for users and admins, with errors inside the card.
  assert.doesNotMatch(appScript, /login-user-tab|login-admin-tab|login-tabs/);
  assert.match(appScript, /loginError/);
  assert.match(appScript, /login-error/);
  assert.match(appScript, /login-new/);
  assert.match(appScript, /registerUser/);
  assert.doesNotMatch(appScript, /Admin login|User login/);
  assert.doesNotMatch(appScript, /User đăng nhập bằng username\/password/);
  assert.doesNotMatch(appScript, /INIT_ADMIN_PASSWORD đã cấu hình/);
  assert.match(appScript, /sponsor-account-col/);
  assert.match(appScript, /Reset password/);
  assert.match(appScript, /Remove user/);
  assert.match(appScript, /btn-password-cancel/);
  assert.doesNotMatch(appScript, /Không bắt buộc đổi password lần đầu/);
  assert.doesNotMatch(appScript, /window\.prompt/);
});

test('served assets contain the 9Router-inspired portal shell', () => {
  assert.match(renderApp(), /<aside class="sidebar">/);
  assert.match(renderApp(), /id="modal-root"/);
  assert.match(renderApp(), /LLM Portal/);
  assert.doesNotMatch(renderApp(), /Portal owns credentials/);
  assert.match(styles, /\.nav-item/);
  assert.match(styles, /--brand:#E56A4A/);
  assert.match(styles, /\.modal-overlay/);
  // Session and weekly share the row evenly, with the requested top margin.
  assert.match(styles, /\.quota-inline\{display:grid;grid-template-columns:1fr 1fr[^}]*margin-top:18px\}/);
  // Sponsor tables share one fixed column grid so groups line up.
  assert.match(styles, /\.sponsor-group table\{table-layout:fixed/);
  assert.match(styles, /\.login-form\{margin-top:16px\}/);
  assert.match(styles, /\.auth-card\{width:min\(480px,100%\)/);
  assert.match(styles, /\.login-actions\{display:grid/);
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
