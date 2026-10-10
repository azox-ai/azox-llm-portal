import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
    ';globalThis.quotaTest = { state, quotaName, quotaPercent, quotaResetLabel, formatDateTime, scheduleQuotaRefresh, connectionCard, accountAvailability };')
    .runInContext(context);
  return {
    ...context.quotaTest,
    scheduledDelay: () => scheduledDelay,
  };
}

function navigationClientHelpers() {
  const initStart = appScript.indexOf('(async function init()');
  assert.notEqual(initStart, -1, 'client startup marker must exist');
  const context = vm.createContext({});
  new vm.Script(appScript.slice(0, initStart) +
    ';globalThis.navigationTest = { tabFromPath, pathForTab };')
    .runInContext(context);
  return context.navigationTest;
}

function auditClientHelpers() {
  const initStart = appScript.indexOf('(async function init()');
  assert.notEqual(initStart, -1, 'client startup marker must exist');
  const context = vm.createContext({});
  new vm.Script(appScript.slice(0, initStart) +
    ';globalThis.auditTest = { formatAuditTime };')
    .runInContext(context);
  return context.auditTest;
}

function accountClientHelpers() {
  const initStart = appScript.indexOf('(async function init()');
  assert.notEqual(initStart, -1);
  const context = vm.createContext({});
  new vm.Script(appScript.slice(0, initStart) +
    ';globalThis.accountTest = { connectionCard, editAccountModal };')
    .runInContext(context);
  return context.accountTest;
}

test('only Claude cards show Edit icon beside name and dialog escapes account labels', () => {
  const { connectionCard, editAccountModal } = accountClientHelpers();
  const account = {
    id: 1, provider: 'claude', displayName: 'Claude OAuth account', owner: 'alice',
    enabled: true, status: 'active', routers: {}, quotaAutoDisabled: false,
  };
  const claudeCard = connectionCard(account);
  const codexCard = connectionCard({ ...account, provider: 'codex' });
  assert.match(claudeCard, /data-edit-account="1"/);
  assert.match(claudeCard, /<div class="account-title"><h3>Claude OAuth account<\/h3><button class="account-edit"/);
  assert.match(claudeCard, /aria-label="Edit account name"/);
  assert.match(claudeCard, /<svg[^>]*aria-hidden="true"/);
  assert.doesNotMatch(claudeCard.slice(claudeCard.indexOf('<footer')), /data-edit-account|has-edit|>Edit</);
  assert.doesNotMatch(codexCard, /data-edit-account|has-edit/);
  assert.match(editAccountModal({ name: '<Claude> & team' }), /value="&lt;Claude&gt; &amp; team"/);
  assert.match(editAccountModal({ name: 'Claude' }), /form="edit-account-form"/);
  assert.match(appScript, /\/api\/accounts\/[' ] \+ accountId \+ '\/name'/);
});

test('client bundle parses and renders quota inside provider connection cards', () => {
  assert.doesNotThrow(() => new vm.Script(appScript));
  for (const label of ['Providers', 'Sponsors', 'Admin', 'Audit log']) assert.match(appScript, new RegExp(label));
  // Quota Tracker is no longer a separate tab: it renders inside each account card.
  assert.match(appScript, /connections-grid/);
  assert.match(appScript, /connection-provider-filter/);
  assert.match(appScript, /data-connection-filter/);
  assert.match(appScript, /connection-card/);
  assert.match(appScript, /quota-meter/);
  assert.match(appScript, /quotaStrip/);
  assert.match(appScript, /data-reauth="' \+ account\.id/);
  assert.match(appScript, /JSON\.stringify\(\{ accountId \}\)/);
  assert.match(appScript, /Portal ID /);
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
  assert.match(appScript, /Sponsored by /);
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
  assert.match(appScript, /quota-settings-form/);
  assert.match(appScript, /user-quota-settings-form/);
  assert.match(appScript, /policy-settings-grid/);
  assert.match(appScript, /policy-form-footer/);
  assert.match(appScript, /type="checkbox" role="switch"/);
  assert.match(appScript, /My quota policy/);
  assert.match(appScript, /Use admin defaults/);
  assert.match(appScript, /\/api\/me\/quota-settings/);
  assert.match(appScript, /updateMyQuotaSettings/);
  assert.match(appScript, /resetMyQuotaSettings/);
  assert.match(appScript, /sessionQuotaAutoDisable/);
  assert.match(appScript, /sessionQuotaThresholdPercent/);
  assert.match(appScript, /sessionQuotaAutoEnable/);
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
  assert.equal(quota.quotaName('session', 'claude', 'max'), 'Session (5h)');
  assert.equal(quota.quotaName('session', 'codex', 'plus'), 'Session (5h)');
  assert.equal(quota.quotaName('session', 'codex', 'pro'), 'Weekly (7d)');
  assert.equal(quota.quotaName('weekly', 'codex', 'pro'), 'Weekly (7d)');
  assert.equal(quota.quotaPercent(0.4), '<1%');
  assert.equal(quota.formatDateTime('2026-09-22T03:30:53'), '22/09/2026 10:30:53');
  assert.equal(quota.formatDateTime('2026-09-22 03:30:53'), '22/09/2026 10:30:53');
  assert.equal(quota.formatDateTime('2026-09-22T03:30:53Z'), '22/09/2026 10:30:53');
  assert.match(quota.quotaResetLabel('2026-09-15T06:00:00.000Z'), /Reset passed/);

  quota.state.me = { csrfToken: 'test' };
  quota.state.tab = 'providers';
  quota.state.quotas = {
    account: { quotas: { session: { resetAt: '2026-09-15T06:07:20.000Z' } } },
  };
  quota.scheduleQuotaRefresh();
  assert.equal(quota.scheduledDelay(), 25_000);
  quota.state.quotas.staleAccount = { quotas: { session: { resetAt: '2026-09-15T06:00:00.000Z' } } };
  quota.scheduleQuotaRefresh();
  assert.equal(quota.scheduledDelay(), 25_000, 'past resets must not hide another account\'s upcoming reset');
});

test('connection cards distinguish routing from exhausted quota and keep session quota first', () => {
  const quota = quotaClientHelpers(Date.parse('2026-10-02T06:00:00Z'));
  const account = { id: 1, provider: 'codex', displayName: 'Test Codex', owner: 'test',
    enabled: true, status: 'active', routers: { ninerouter: { status: 'active' }, omniroute: { status: 'active' } },
    quotaPolicy: { autoDisable: true, thresholdPercent: 30, autoEnable: true } };
  quota.state.quotas[1] = { plan: 'plus', quotas: {
    session: { remaining: 100, resetAt: '2026-10-02T01:00:00Z' },
    weekly: { remaining: 0, resetAt: '2026-10-04T00:00:00Z' },
  } };
  const card = quota.connectionCard(account);
  assert.match(card.slice(0, card.indexOf('</header>')), /Quota exhausted/);
  assert.match(card, />Routing<.*>Enabled</);
  assert.match(card, />9Router sync<.*>active</);
  assert.ok(card.indexOf('quota-meter healthy') < card.indexOf('quota-meter low'));
  assert.doesNotMatch(card.slice(0, card.indexOf('</header>')), />Ready</);
});

test('auto-disabled cards use live blocking reset instead of an old saved reset', () => {
  const quota = quotaClientHelpers(Date.parse('2026-10-02T06:00:00Z'));
  const account = { id: 1, provider: 'codex', displayName: 'Test', owner: 'test', enabled: false,
    status: 'disabled', routers: {}, quotaAutoDisabled: true, quotaSessionResetAt: '2026-09-23T12:00:00Z',
    quotaPolicy: { thresholdPercent: 30, autoEnable: false } };
  quota.state.quotas[1] = { plan: 'plus', quotas: {
    session: { remaining: 100, resetAt: '2026-10-02T09:00:00Z' },
    weekly: { remaining: 0, resetAt: '2026-10-04T00:00:00Z' },
  } };
  const card = quota.connectionCard(account);
  assert.match(card, /Quota paused/);
  assert.match(card, /Weekly \(7d\) at or below 30%/);
  assert.match(card, /Reset: 04\/10\/2026/);
  assert.match(card, /Auto-enable is off/);
  assert.doesNotMatch(card, /23\/09\/2026/);
});

test('missing or failed quota is never reported as ready or fully recovered', () => {
  const quota = quotaClientHelpers(Date.parse('2026-10-02T06:00:00Z'));
  const account = { id: 1, provider: 'codex', displayName: 'Test', owner: 'test', enabled: true,
    status: 'active', routers: {}, quotaPolicy: { thresholdPercent: 30, autoDisable: true } };
  assert.equal(quota.accountAvailability(account).label, 'Checking quota');
  quota.state.quotas[1] = { error: 'Quota unavailable. Retrying within 5 min.', quotas: {} };
  assert.equal(quota.accountAvailability(account).label, 'Quota unavailable');
  assert.doesNotMatch(quota.connectionCard(account), /Upstream returned no quota window/);
  quota.state.quotas[1] = { quotas: { weekly: { remaining: null } } };
  assert.equal(quota.accountAvailability(account).label, 'Quota unknown');
  assert.equal(quota.quotaPercent(null), '\u2014');
  assert.doesNotMatch(quota.connectionCard(account), /aria-valuenow="0"/);
  assert.match(quota.accountAvailability({ ...account, enabled: false, quotaAutoDisabled: true }).message, /unknown/);
  quota.state.quotas[1] = { quotas: { weekly: { remaining: 0, resetAt: '2026-10-01T00:00:00Z' } } };
  assert.equal(quota.accountAvailability(account).label, 'Checking reset');
  quota.state.quotas[1] = { quotas: { weekly: { remaining: 40 } } };
  assert.equal(quota.accountAvailability(account).label, 'Ready');
  quota.state.quotas[1].quotas.weekly.remaining = 20;
  assert.equal(quota.accountAvailability(account).label, 'Quota low');
  assert.equal(quota.accountAvailability({ ...account, enabled: false }).label, 'Disabled');
  assert.equal(quota.accountAvailability({ ...account, credentialStatus: 'needs_reauth' }).label, 'Re-auth required');
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

test('navigator maps each tab to a stable, deep-linkable path', () => {
  const navigation = navigationClientHelpers();
  assert.equal(navigation.tabFromPath('/providers'), 'providers');
  assert.equal(navigation.tabFromPath('/sponsors'), 'sponsors');
  assert.equal(navigation.tabFromPath('/admin'), 'admin');
  assert.equal(navigation.tabFromPath('/audit'), 'audit');
  assert.equal(navigation.tabFromPath('/unknown'), null);
  assert.equal(navigation.pathForTab('audit'), '/audit');
  assert.equal(navigation.pathForTab('unknown'), '/providers');
  assert.match(appScript, /history\[replace \? 'replaceState' : 'pushState'\]/);
  assert.match(appScript, /addEventListener\('popstate'/);
});

test('audit timestamps render in Vietnam time', () => {
  const audit = auditClientHelpers();
  assert.equal(audit.formatAuditTime('2026-09-17T02:10:04Z'), '17/09/2026 09:10:04');
  assert.equal(audit.formatAuditTime('invalid'), 'invalid');
  assert.match(appScript, /Time \(GMT\+7\)/);
});

test('served assets contain the 9Router-inspired portal shell', () => {
  assert.match(renderApp(), /<aside class="sidebar">/);
  assert.match(renderApp(), /id="modal-root"/);
  assert.match(renderApp(), /LLM Portal/);
  assert.doesNotMatch(renderApp(), /Portal owns credentials/);
  assert.match(styles, /\.nav-item/);
  assert.match(styles, /--brand:#E56A4A/);
  assert.match(styles, /--border:#B7BDC6;--border-subtle:#D0D4DA;--border-strong:#8B93A0/);
  assert.match(styles, /input,select,textarea\{[^}]*border:1px solid var\(--border-strong\)/);
  assert.match(styles, /#quota-threshold,#user-quota-threshold\{appearance:textfield;-moz-appearance:textfield\}/);
  assert.match(styles, /#user-quota-threshold::-webkit-inner-spin-button/);
  assert.match(styles, /\.panel\{[^}]*border:1px solid var\(--border\)/);
  assert.match(styles, /\.modal-overlay/);
  // Connections reflow from a two-column dashboard grid to one column.
  assert.match(styles, /\.connections-grid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(styles, /\.connections-grid\{[^}]*align-items:start/);
  assert.match(styles, /\.connection-toolbar\{display:flex;align-items:center;gap:10px;flex-wrap:wrap\}/);
  assert.match(styles, /\.connection-filter-chip/);
  assert.match(styles, /@media\(max-width:1120px\)\{\s*\.connections-grid\{grid-template-columns:1fr\}/);
  assert.match(styles, /\.connection-card\{[^}]*border:1px solid var\(--border\)/);
  assert.match(styles, /\.connection-statuses\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(styles, /\.connection-actions button\{[^}]*min-height:44px/);
  assert.match(styles, /\.quota-meter \.progress\{[^}]*grid-column:1\/-1/);
  // Sponsor tables share one fixed column grid so groups line up.
  assert.match(styles, /\.sponsor-group table\{table-layout:fixed/);
  assert.match(styles, /\.login-form\{margin-top:16px\}/);
  assert.match(styles, /\.auth-card\{width:min\(480px,100%\)/);
  assert.match(styles, /main\{max-width:1440px/);
  assert.match(styles, /\.policy-source\.admin/);
  assert.match(styles, /\.policy-source\.user/);
  assert.match(styles, /\.policy-settings-grid\{display:grid;grid-template-columns:1\.15fr \.8fr 1\.15fr/);
  assert.match(styles, /\.personal-quota-form \.policy-switch input:checked/);
  assert.match(styles, /\.threshold-control input\{[^}]*height:44px/);
  assert.match(styles, /\.policy-form-footer\{display:flex/);
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
  for (const path of ['/providers', '/sponsors', '/admin', '/audit']) {
    const response = await app.inject({ method: 'GET', url: path });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], NO_STORE_CACHE_CONTROL);
    assert.match(response.body, new RegExp(assets.script.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
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

test('content security policy permits the exact theme bootstrap and Cloudflare Insights', async (t) => {
  const { app, db } = await testApp();
  t.after(() => { app.close(); db.close(); });

  const inlineScript = renderApp().match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(inlineScript, 'theme bootstrap script must exist');
  const scriptHash = `'sha256-${createHash('sha256').update(inlineScript).digest('base64')}'`;

  const response = await app.inject({ method: 'GET', url: '/' });
  const csp = response.headers['content-security-policy'];
  assert.ok(csp.includes(scriptHash));
  assert.match(csp, /script-src [^;]*https:\/\/static\.cloudflareinsights\.com/);
  assert.match(csp, /connect-src [^;]*https:\/\/cloudflareinsights\.com/);
  assert.doesNotMatch(csp, /script-src [^;]*'unsafe-inline'/);
});

test('saved model stays saved when the catalog reload fails', async () => {
  const initStart = appScript.indexOf('(async function init()');
  const fields = {
    'model-id': { value: 'custom/new' },
    'model-input-price': { value: '1' },
    'model-output-price': { value: '2' },
    'save-model': { disabled: false, textContent: 'Save' },
  };
  const requests = [];
  const context = vm.createContext({
    document: {
      getElementById: (id) => fields[id] || null,
      querySelectorAll: () => [{ value: 'High' }],
    },
    setTimeout() {},
  });
  new vm.Script(appScript.slice(0, initStart) +
    ';globalThis.saveTest = { state, saveModel, setApi(fn) { api = fn; }, setRender(fn) { render = fn; } };')
    .runInContext(context);
  const { state, saveModel, setApi, setRender } = context.saveTest;
  setRender(() => {});
  setApi(async (path, options = {}) => {
    requests.push([options.method || 'GET', path]);
    if (path === '/api/models' && !options.method) throw new Error('catalog unavailable');
    return { id: 1 };
  });
  state.modal = { type: 'model', id: null, model: '', tierIds: [], inputPrice: '', outputPrice: '', error: null };
  await saveModel();
  assert.deepEqual(requests, [['POST', '/api/models'], ['GET', '/api/models']]);
  assert.equal(state.modal, null);
  assert.equal(state.toast.kind, 'error');
  assert.match(state.toast.text, /saved.*catalog unavailable/i);
});

test('Model tier cell lays out at most three badges per row without affecting family tags', () => {
  const initStart = appScript.indexOf('(async function init()');
  const context = vm.createContext({});
  new vm.Script(appScript.slice(0, initStart) + ';globalThis.modelsTest = { state, modelView };')
    .runInContext(context);
  const { state, modelView } = context.modelsTest;
  state.me = { role: 'user' };
  state.models = [{ id: 1, model: 'example', tiers: Array.from({ length: 6 }, (_, index) => ({ id: index + 1, title: 'tier-' + index })),
    families: [{ id: 7, title: 'family' }], inputPrice: 1, outputPrice: 2 }];
  const view = modelView();
  assert.match(view, /<td class="tier-cell"><div class="tier-badges">(?:<span class="family-tag">[^<]+<\/span>){6}<\/div><\/td>/);
  assert.match(view, /<td class="family-cell"><span class="family-tag">#7 family<\/span><\/td>/);
  assert.match(styles, /\.tier-badges\{[^}]*display:grid;[^}]*grid-template-columns:repeat\(3,max-content\)/);
});

test('Model tab shows tier and family tags with admin-only editing controls', () => {
  const initStart = appScript.indexOf('(async function init()');
  const context = vm.createContext({});
  new vm.Script(appScript.slice(0, initStart) +
    ';globalThis.modelsTest = { state, modelView, editModelModal, formatPrice, modelMoveFocusTarget, tabFromPath, pathForTab };')
    .runInContext(context);
  const { state, modelView, editModelModal, formatPrice, modelMoveFocusTarget, tabFromPath, pathForTab } = context.modelsTest;
  state.me = { role: 'user' };
  state.models = [{ id: 1, model: '<bad>', tiers: [{ id: 2, title: 'model-max' }, { id: 3, title: 'model-high' }], inputPrice: 2, outputPrice: 10, position: 1, status: 'inactive', families: [{ id: 2, title: 'code' }] }];
  state.modelFamilies = [{ id: 2, title: 'code', modelCount: 1 }, { id: 3, title: 'agent', modelCount: 0 }];
  state.modelTiers = [{ id: 1, title: 'model-ultra', modelCount: 0 }, { id: 2, title: 'model-max', modelCount: 1 }, { id: 3, title: 'model-high', modelCount: 1 }];
  const userView = modelView();
  assert.match(userView, /&lt;bad&gt;/);
  assert.ok(userView.indexOf('Model family') < userView.indexOf('Model catalog'));
  assert.match(userView, /class="family-tag"[^>]*>#2 code<\/span>/);
  assert.match(userView, /<th>Family<\/th>/);
  assert.match(userView, /inactive/);
  assert.doesNotMatch(userView, /data-edit-model|id="add-model"|data-move-model|data-delete-model|data-delete-family|data-status-model|id="add-family"/);
  // Tiers are an admin-managed catalog shown exactly like families.
  assert.ok(userView.indexOf('Model tier') < userView.indexOf('Model catalog'));
  assert.match(userView, /class="family-tag"[^>]*>#1 model-ultra<\/span>/);
  assert.match(userView, /<td class="tier-cell"><div class="tier-badges"><span class="family-tag">#2 model-max<\/span><span class="family-tag">#3 model-high<\/span><\/div><\/td>/);
  assert.doesNotMatch(userView, /type="checkbox"[^>]*disabled|data-edit-tier|data-delete-tier|id="add-tier"/);
  state.models = [{ ...state.models[0], tiers: [] }];
  assert.match(modelView(), /<td class="tier-cell">—<\/td>/);
  state.models = [{ id: 1, model: '<bad>', tiers: [{ id: 2, title: 'model-max' }], inputPrice: 2, outputPrice: 10, position: 1, status: 'inactive', families: [{ id: 2, title: 'code' }] }];
  state.me = { role: 'admin' };
  const adminView = modelView();
  assert.match(adminView, /data-edit-model="1"/);
  assert.match(adminView, /data-move-model="1"/);
  assert.match(adminView, /id="add-model"/);
  assert.match(adminView, /id="add-family"/);
  assert.match(adminView, /data-edit-family="2"/);
  assert.match(adminView, /data-delete-family="2"/);
  assert.match(adminView, /id="add-tier"/);
  assert.match(adminView, /data-edit-tier="1"[^>]*aria-label="Rename tier model-ultra"/);
  assert.match(adminView, /data-delete-tier="1"[^>]*aria-label="Delete tier model-ultra"/);
  assert.match(adminView, /data-delete-model="1"/);
  assert.match(adminView, /data-status-model="1"[^>]*role="switch"/);
  assert.match(adminView, /inactive/);
  assert.ok(adminView.indexOf('data-edit-model="1"') < adminView.indexOf('data-delete-model="1"'));
  assert.equal(tabFromPath('/models'), 'models');
  assert.equal(pathForTab('models'), '/models');
  const modal = editModelModal({ id: 1, model: '<script>', tierIds: [3], inputPrice: 2, outputPrice: 10 });
  assert.match(modal, /value="&lt;script&gt;"/);
  assert.match(modal, /name="model-tier" value="3" checked>model-high/);
  assert.match(modal, /name="model-tier" value="1">model-ultra/);
  assert.doesNotMatch(modal, /Select one or more tiers/);
  const addModal = editModelModal({ id: null, model: '', tierIds: [], familyIds: [], status: 'inactive', inputPrice: '', outputPrice: '' });
  assert.match(addModal, /name="model-family" value="2"/);
  assert.match(addModal, /id="model-status"[^>]*role="switch"/);
  assert.doesNotMatch(addModal, /id="model-status"[^>]*checked/);
  const editModal = editModelModal({ id: 1, model: 'custom/edit', tierIds: [3], familyIds: [2], status: 'active', inputPrice: 2, outputPrice: 10 });
  assert.match(editModal, /name="model-family" value="2" checked/);
  assert.match(editModal, /id="model-status"[^>]*checked/);
  // Small per-million prices must not be rounded into a different value.
  assert.equal(formatPrice(0.00005), '$0.00005');
  assert.equal(formatPrice(0.2219), '$0.2219');
  assert.equal(modelMoveFocusTarget({ id: '7', direction: 'up' }, [{ id: 7 }, { id: 8 }]),
    '[data-move-model="7"][data-direction="down"]');
  assert.equal(modelMoveFocusTarget({ id: '7', direction: 'down' }, [{ id: 8 }, { id: 7 }]),
    '[data-move-model="7"][data-direction="up"]');
  assert.equal(modelMoveFocusTarget({ id: '7', direction: 'up' }, [{ id: 8 }, { id: 7 }, { id: 9 }]),
    '[data-move-model="7"][data-direction="up"]');
  // The hidden Actions header is absolutely positioned; without a positioned
  // scroller it escapes the table and widens the whole page on mobile.
  assert.match(styles, /\.table-wrap\{position:relative;overflow-x:auto\}/);
});

test('light theme draws white tier and family checkboxes while dark theme keeps native ones', () => {
  // Light: the explicit choice and the OS default when no dark choice is made.
  // The catalog table shows tier tags, so only the edit-form checkboxes remain.
  assert.doesNotMatch(styles, /\.tier-check|\.tier-group/);
  assert.doesNotMatch(styles, /:root:not\([^)]*\) :root/);
  const light = styles.match(/:root:not\(\[data-theme="dark"\]\) \.tier-option input[^{]*\{([^}]*)\}/);
  assert.ok(light, 'light-only checkbox rule must exist');
  assert.match(light[1], /appearance:none/);
  assert.match(light[1], /background(-color)?:#fff/);
  assert.match(light[1], /border:[^;]*var\(--border-strong\)/);
  assert.match(styles, /:root:not\(\[data-theme="dark"\]\) [^{]*input:checked::after\{[^}]*border[^}]*var\(--brand\)/);
  // The dark OS preference must override the light rule when no explicit light choice was made.
  assert.match(styles, /@media \(prefers-color-scheme:dark\)\{[^@]*:root:not\(\[data-theme="light"\]\) \.tier-option input[^{]*\{[^}]*appearance:auto/);
});

test('saving a model sends selected tier and family IDs and on/off status', async () => {
  const initStart = appScript.indexOf('(async function init()');
  const fields = {
    'model-id': { value: 'custom/new' },
    'model-input-price': { value: '1' },
    'model-output-price': { value: '2' },
    'model-status': { checked: true },
    'save-model': { disabled: false, textContent: 'Save' },
  };
  const bodies = [];
  const context = vm.createContext({
    document: {
      getElementById: (id) => fields[id] || null,
      querySelectorAll: (selector) => selector.includes('model-family') ? [{ value: '3' }, { value: '5' }] : [{ value: '4' }, { value: '1' }],
    },
    setTimeout() {},
  });
  new vm.Script(appScript.slice(0, initStart) +
    ';globalThis.saveTest = { state, saveModel, setApi(fn) { api = fn; }, setRender(fn) { render = fn; } };')
    .runInContext(context);
  const { state, saveModel, setApi, setRender } = context.saveTest;
  setRender(() => {});
  setApi(async (path, options = {}) => {
    if (options.body) bodies.push(JSON.parse(options.body));
    return [];
  });
  state.modal = { type: 'model', id: null, model: '', tierIds: [], familyIds: [], status: 'inactive', inputPrice: '', outputPrice: '', error: null };
  await saveModel();
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].tierIds, [4, 1]);
  assert.equal(bodies[0].tiers, undefined);
  assert.deepEqual(bodies[0].familyIds, [3, 5]);
  assert.equal(bodies[0].status, 'active');
});

test('a model without any tier can be saved', async () => {
  const initStart = appScript.indexOf('(async function init()');
  const fields = {
    'model-id': { value: 'custom/untiered' },
    'model-input-price': { value: '0' },
    'model-output-price': { value: '0' },
    'model-status': { checked: false },
    'save-model': { disabled: false, textContent: 'Save' },
  };
  const bodies = [];
  const context = vm.createContext({
    document: { getElementById: (id) => fields[id] || null, querySelectorAll: () => [] },
    setTimeout() {},
    clearTimeout() {},
  });
  new vm.Script(appScript.slice(0, initStart) +
    ';globalThis.saveTest = { state, saveModel, setApi(fn) { api = fn; }, setRender(fn) { render = fn; } };')
    .runInContext(context);
  const { state, saveModel, setApi, setRender } = context.saveTest;
  setRender(() => {});
  setApi(async (_path, options = {}) => { if (options.body) bodies.push(JSON.parse(options.body)); return []; });
  state.modal = { type: 'model', id: null, model: '', tierIds: [], familyIds: [], status: 'inactive', inputPrice: '', outputPrice: '', error: null };
  await saveModel();
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].tierIds, []);
  assert.equal(state.modal, null);
});

test('tier catalog loads with the models and is managed like families', async () => {
  const initStart = appScript.indexOf('(async function init()');
  const fields = { 'tag-title': { value: 'model-mini' }, 'save-tag': { disabled: false } };
  const requests = [];
  const context = vm.createContext({
    document: { getElementById: (id) => fields[id] || null, querySelectorAll: () => [] },
    setTimeout() {},
    clearTimeout() {},
  });
  new vm.Script(appScript.slice(0, initStart) +
    ';globalThis.tagTest = { state, loadModels, saveTag, deleteTag, tagModal, deleteTagModal, setApi(fn) { api = fn; }, setRender(fn) { render = fn; } };')
    .runInContext(context);
  const { state, loadModels, saveTag, deleteTag, tagModal, deleteTagModal, setApi, setRender } = context.tagTest;
  setRender(() => {});
  setApi(async (path, options = {}) => {
    requests.push([options.method || 'GET', path, options.body && JSON.parse(options.body)]);
    if (path === '/api/model-tiers' && !options.method) return [{ id: 5, title: 'model-mini', modelCount: 0 }];
    if (options.method === 'DELETE') return { unlinkedModels: 2 };
    return [];
  });
  await loadModels();
  assert.deepEqual(requests.map((r) => r[1]), ['/api/models', '/api/model-families', '/api/model-tiers']);
  assert.equal(state.modelTiers[0].title, 'model-mini');

  assert.match(tagModal({ kind: 'tier', id: null, title: '' }), /Add model tier/);
  assert.match(tagModal({ kind: 'tier', id: 5, title: 'model-mini' }), /Rename model tier/);
  assert.match(tagModal({ kind: 'family', id: null, title: '' }), /Add model family/);
  assert.match(deleteTagModal({ kind: 'tier', id: 5, title: 'model-mini', modelCount: 2 }), /Delete model tier[\s\S]*removed from 2 models/);

  requests.length = 0;
  state.modal = { type: 'tag', kind: 'tier', id: null, title: '', error: null };
  await saveTag();
  assert.deepEqual(requests[0], ['POST', '/api/model-tiers', { title: 'model-mini' }]);
  assert.equal(state.modal, null);
  assert.deepEqual({ ...state.toast, id: undefined }, { text: 'Tier added.', kind: 'ok', id: undefined });

  requests.length = 0;
  fields['save-tag'] = { disabled: false };
  state.modal = { type: 'tag', kind: 'tier', id: 5, title: 'model-mini', error: null };
  await saveTag();
  assert.deepEqual(requests[0], ['PATCH', '/api/model-tiers/5', { title: 'model-mini' }]);
  assert.equal(state.toast.text, 'Tier renamed.');

  requests.length = 0;
  fields['confirm-delete-tag'] = { disabled: false };
  state.modal = { type: 'delete-tag', kind: 'tier', id: 5, title: 'model-mini', modelCount: 2, error: null };
  await deleteTag();
  assert.deepEqual(requests[0], ['DELETE', '/api/model-tiers/5', undefined]);
  assert.equal(state.toast.text, 'Tier deleted; unlinked from 2 models.');

  fields['tag-title'] = { value: 'Bad Title' };
  state.modal = { type: 'tag', kind: 'tier', id: null, title: '', error: null };
  await saveTag();
  assert.match(state.modal.error, /lowercase/);
});

function toastClientHelpers() {
  const initStart = appScript.indexOf('(async function init()');
  const roots = { 'toast-root': { innerHTML: '', dataset: {} } };
  const timers = [];
  const cleared = [];
  const context = vm.createContext({
    document: { getElementById: (id) => roots[id] || null },
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    clearTimeout(id) { cleared.push(id); },
  });
  new vm.Script(appScript.slice(0, initStart) +
    ';globalThis.toastTest = { state, notify, showToast, setRender(fn) { render = fn; } };')
    .runInContext(context);
  return { ...context.toastTest, root: roots['toast-root'], timers, cleared };
}

test('every operation result is a top-center toast that hides after 3 seconds', () => {
  const { state, notify, showToast, setRender, root, timers, cleared } = toastClientHelpers();
  let renders = 0;
  setRender(() => { renders += 1; });
  notify('Model updated.', 'ok');
  assert.equal(renders, 1);
  assert.match(root.innerHTML, /<div class="toast ok" role="status">Model updated\.<\/div>/);
  assert.equal(timers.at(-1).delay, 3000);
  // Errors are toasts too, announced assertively and escaped.
  showToast('<b>nope</b>');
  assert.match(root.innerHTML, /<div class="toast error" role="alert">&lt;b&gt;nope&lt;\/b&gt;<\/div>/);
  assert.equal(cleared.length, 1, 'a newer toast restarts the 3s timer');
  // The stale timer of the first toast must not hide the newer one.
  timers[0].callback();
  assert.match(root.innerHTML, /nope/);
  timers.at(-1).callback();
  assert.equal(root.innerHTML, '');
  assert.equal(state.toast, null);
  // No page banner remains for operation results.
  assert.doesNotMatch(appScript, /state\.message|const banner/);
  assert.match(renderApp(), /<div id="toast-root" class="toast-root" aria-live="polite" aria-atomic="true"><\/div>/);
  const rootRule = styles.match(/\.toast-root\{([^}]*)\}/);
  assert.ok(rootRule, 'toast root rule must exist');
  assert.match(rootRule[1], /position:fixed/);
  assert.match(rootRule[1], /top:/);
  assert.match(rootRule[1], /left:50%/);
  assert.match(rootRule[1], /transform:translateX\(-50%\)/);
  assert.match(rootRule[1], /z-index:(\d+)/);
  assert.ok(Number(rootRule[1].match(/z-index:(\d+)/)[1]) > 50, 'toast must sit above modals');
  assert.match(styles, /prefers-reduced-motion:reduce\)\{[^}]*\.toast\{animation:none\}/);
});
