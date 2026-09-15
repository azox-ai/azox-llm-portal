import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { appScript } from '../src/web/client.js';
import { styles } from '../src/web/styles.js';
import { renderApp } from '../src/web/page.js';
import { assets, IMMUTABLE_CACHE_CONTROL, NO_STORE_CACHE_CONTROL } from '../src/web/assets.js';
import { testApp } from './helpers/test-app.js';

function quotaClientHelpers(now) {
  const initStart = appScript.indexOf('(async function init()');
  assert.notEqual(initStart, -1, 'client startup marker must exist');
  let scheduledDelay = null;
  const FakeDate = class extends Date {
    static now() { return now; }
  };
  const context = vm.createContext({
    Date: FakeDate,
    clearTimeout() {},
    setTimeout(_callback, delay) { scheduledDelay = delay; return 1; },
  });
  new vm.Script(appScript.slice(0, initStart) +
    ';globalThis.quotaTest = { state, quotaName, quotaPercent, quotaResetLabel, scheduleQuotaRefresh };')
    .runInContext(context);
  return {
    ...context.quotaTest,
    scheduledDelay: () => scheduledDelay,
  };
}

test('client bundle parses and merges quota into the providers surface', () => {
  assert.doesNotThrow(() => new vm.Script(appScript));
  for (const label of ['Providers', 'Sponsors', 'Admin', 'Audit log']) assert.match(appScript, new RegExp(label));
  // Quota Tracker is no longer a separate tab: it renders under each account row.
  assert.match(appScript, /quota-row/);
  assert.match(appScript, /quotaStrip/);
  assert.doesNotMatch(appScript, /\['quota', /);
  assert.doesNotMatch(appScript, /function quotaView/);
  // Quota now loads with the page instead of behind a button.
  assert.match(appScript, /loadQuotas/);
  assert.match(appScript, /scheduleQuotaRefresh/);
  assert.match(appScript, /Session \(5h\)/);
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
  assert.match(appScript, /Before expiry \(hours\)/);
  assert.match(appScript, /refresh-settings-form/);
  assert.match(appScript, /updateRefreshSettings/);
  assert.match(appScript, /data-role-user/);
  assert.match(appScript, /updateUserRole/);
  assert.match(appScript, /function auditView/);
  assert.match(appScript, /audit-prev/);
  assert.match(appScript, /audit-next/);
  assert.match(appScript, /pageSize=20/);
  assert.match(appScript, /btn-password-cancel/);
  assert.doesNotMatch(appScript, /Không bắt buộc đổi password lần đầu/);
  assert.doesNotMatch(appScript, /window\.prompt/);
});

test('quota UI refreshes after reset and labels stale snapshots', () => {
  const now = Date.parse('2026-09-15T06:07:00.000Z');
  const quota = quotaClientHelpers(now);
  assert.equal(quota.quotaName('session'), 'Session (5h)');
  assert.equal(quota.quotaPercent(0.4), '<1%');
  assert.match(quota.quotaResetLabel('2026-09-15T06:00:00.000Z'), /Reset passed/);

  quota.state.me = { csrfToken: 'test' };
  quota.state.tab = 'providers';
  quota.state.quotas = {
    account: { quotas: { session: { resetAt: '2026-09-15T06:07:20.000Z' } } },
  };
  quota.scheduleQuotaRefresh();
  assert.equal(quota.scheduledDelay(), 25_000);
});

test('the portal ships English copy only and a persisted theme toggle', () => {
  const vietnameseDiacritics = /[\u00C0-\u1EF9]/;
  assert.doesNotMatch(appScript, vietnameseDiacritics);
  assert.doesNotMatch(renderApp(), vietnameseDiacritics);
  assert.doesNotMatch(appScript, /LLM GATEWAY/);
  assert.doesNotMatch(renderApp(), /LLM GATEWAY/);
  assert.match(appScript, /LLM PORTAL/);
  assert.match(renderApp(), /LLM PORTAL/);
  assert.match(renderApp(), /<html lang="en">/);
  // Theme choice survives reloads and is applied before first paint.
  assert.match(renderApp(), /portal-theme/);
  assert.match(renderApp(), /id="theme-slot"/);
  assert.match(appScript, /themeButton/);
  assert.match(appScript, /toggleTheme/);
  assert.match(appScript, /localStorage\.setItem\(THEME_KEY/);
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
  assert.match(styles, /main\{max-width:1440px/);
  assert.match(styles, /\.connections-table th,\.connections-table td\{white-space:nowrap\}/);
  assert.match(styles, /\.role-select\{width:110px/);
  assert.match(styles, /\.pagination\{display:flex/);
  // Theme toggle: explicit choice beats the OS preference.
  assert.match(styles, /:root\[data-theme="dark"\]/);
  assert.match(styles, /:root:not\(\[data-theme="light"\]\)/);
  assert.match(styles, /\.theme-toggle\{display:inline-flex/);
  assert.match(styles, /\.login-actions\{display:grid/);
  for (const status of ['active', 'disabled', 'failed', 'needs_reauth', 'pending']) {
    assert.match(styles, new RegExp('\\.badge\\.' + status + '\\b'));
  }
});

test('fingerprinted assets prevent stale deploys and expose a tab icon', async (t) => {
  const html = renderApp();
  assert.match(assets.script.path, /^\/assets\/app-[a-f0-9]{16}\.js$/);
  assert.match(assets.styles.path, /^\/assets\/styles-[a-f0-9]{16}\.css$/);
  assert.match(assets.favicon.path, /^\/assets\/icon-[a-f0-9]{16}\.svg$/);
  assert.match(html, new RegExp(assets.script.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, new RegExp(assets.styles.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, new RegExp(assets.favicon.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(assets.favicon.body, /<svg/);
  assert.match(assets.favicon.body, />9<\/text>/);

  const { app, db } = await testApp();
  t.after(() => { app.close(); db.close(); });
  const shell = await app.inject({ method: 'GET', url: '/' });
  assert.equal(shell.headers['cache-control'], NO_STORE_CACHE_CONTROL);
  for (const asset of Object.values(assets)) {
    const response = await app.inject({ method: 'GET', url: asset.path });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], IMMUTABLE_CACHE_CONTROL);
    assert.equal(response.body, asset.body);
  }
  for (const path of ['/app.js', '/styles.css', '/favicon.ico']) {
    const response = await app.inject({ method: 'GET', url: path });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], NO_STORE_CACHE_CONTROL);
  }
});

test('plain HTTP mode does not tell browsers to upgrade assets to HTTPS', async (t) => {
  const { app, db } = await testApp({ config: { tls: false, secureCookies: false } });
  t.after(() => { app.close(); db.close(); });
  const response = await app.inject({ method: 'GET', url: '/' });
  assert.equal(response.statusCode, 200);
  assert.doesNotMatch(response.headers['content-security-policy'], /upgrade-insecure-requests/);
});
