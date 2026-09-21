export const appScript = String.raw`
const state = {
  me: null,
  accounts: [],
  routers: {},
  tab: 'providers',
  message: null,
  quotas: {},
  sponsors: [],
  users: [],
  audit: { items: [], page: 1, pageSize: 20, total: 0, totalPages: 1 },
  settings: null,
  quotaPolicy: null,
  modal: null,
  view: null,
  passwordError: null,
  loginError: null,
  loginNotice: null,
  quotaRefreshTimer: null,
};

const $ = (id) => document.getElementById(id);

const THEME_KEY = 'portal-theme';
const AUDIT_TIME_ZONE = 'Asia/Ho_Chi_Minh';
const QUOTA_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const QUOTA_POST_RESET_DELAY_MS = 5 * 1000;
const TAB_PATHS = {
  providers: '/providers',
  sponsors: '/sponsors',
  admin: '/admin',
  audit: '/audit',
};
const PATH_TABS = {
  '/providers': 'providers',
  '/sponsors': 'sponsors',
  '/admin': 'admin',
  '/audit': 'audit',
};

function tabFromPath(pathname) {
  return PATH_TABS[pathname] || null;
}

function pathForTab(tab) {
  return TAB_PATHS[tab] || TAB_PATHS.providers;
}

function tabIsAvailable(tab) {
  return Boolean(TAB_PATHS[tab]) && (tab !== 'admin' && tab !== 'audit' || state.me?.role === 'admin');
}

function syncTabUrl(tab, replace = false) {
  const path = pathForTab(tab);
  if (window.location.pathname !== path) {
    window.history[replace ? 'replaceState' : 'pushState']({ tab }, '', path);
  }
}

function storedTheme() {
  try { return localStorage.getItem(THEME_KEY); } catch { return null; }
}

function currentTheme() {
  const saved = storedTheme();
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function themeButton() {
  const theme = currentTheme();
  const label = theme === 'dark' ? 'Light mode' : 'Dark mode';
  return '<button class="theme-toggle" id="theme-toggle" title="' + label + '" aria-label="' + label + '">' +
    '<span class="ico">' + (theme === 'dark' ? '\u263C' : '\u263D') + '</span>' + label + '</button>';
}

function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch { /* storage disabled: keep the in-memory theme */ }
  render();
}

function formatAuditTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || '-';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: AUDIT_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date).filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
  return parts.day + '/' + parts.month + '/' + parts.year + ' ' +
    parts.hour + ':' + parts.minute + ':' + parts.second;
}

// Operational timestamps use dd/MM/yyyy, hh:mm:ss AM/PM. Build from parts
// because the browser locale otherwise decides the field order.
function formatDateTime(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    ...(timeZone ? { timeZone } : {}),
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  }).formatToParts(date).filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
  return parts.day + '/' + parts.month + '/' + parts.year + ', ' +
    parts.hour + ':' + parts.minute + ':' + parts.second + ' ' +
    String(parts.dayPeriod || '').toUpperCase();
}
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

async function api(path, options = {}) {
  const headers = { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) };
  if (state.me?.csrfToken) headers['x-csrf-token'] = state.me.csrfToken;
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  if (!response.ok) throw new Error(body.error || ('HTTP ' + response.status));
  return body;
}

function notify(text, kind = 'error') {
  state.message = { text, kind };
  render();
  if (kind === 'ok') setTimeout(() => {
    if (state.message?.text === text) {
      state.message = null;
      render();
    }
  }, 4000);
}

async function refresh() {
  [state.accounts, state.routers, state.quotaPolicy] = await Promise.all([
    api('/api/accounts'),
    api('/api/router-status'),
    api('/api/me/quota-settings'),
  ]);
  if (state.me?.role === 'admin' && state.tab === 'admin') await loadAdmin();
  if (state.me?.role === 'admin' && state.tab === 'audit') await loadAudit();
  if (state.tab === 'sponsors') await loadSponsors();
  render();
  // Quota is part of the Providers surface, so it loads with the page instead
  // of waiting for a click. Failures stay silent per row.
  if (state.tab === 'providers') loadQuotas();
}

async function loadQuotas() {
  await Promise.all(state.accounts.map(async (account) => {
    try {
      state.quotas[account.id] = await api('/api/accounts/' + account.id + '/quota');
    } catch {
      state.quotas[account.id] = { plan: null, quotas: {} };
    }
  }));
  // The background quota policy may have changed desired/router state while
  // this page was open, so refresh the connection rows with each quota poll.
  try {
    [state.accounts, state.routers] = await Promise.all([api('/api/accounts'), api('/api/router-status')]);
  } catch { /* keep the last rendered connection state */ }
  render();
  scheduleQuotaRefresh();
}

function scheduleQuotaRefresh() {
  if (state.quotaRefreshTimer) {
    clearTimeout(state.quotaRefreshTimer);
    state.quotaRefreshTimer = null;
  }
  if (!state.me || state.tab !== 'providers') return;

  const now = Date.now();
  const resetTimes = Object.values(state.quotas)
    .flatMap((quota) => Object.values(quota?.quotas || {}))
    .map((quota) => Date.parse(quota?.resetAt || ''))
    .filter(Number.isFinite);
  const nextReset = resetTimes.length ? Math.min(...resetTimes) : NaN;
  const delay = Number.isFinite(nextReset) && nextReset > now
    ? Math.min(QUOTA_REFRESH_INTERVAL_MS, Math.max(QUOTA_POST_RESET_DELAY_MS, nextReset - now + QUOTA_POST_RESET_DELAY_MS))
    : QUOTA_REFRESH_INTERVAL_MS;

  state.quotaRefreshTimer = setTimeout(() => loadQuotas(), delay);
}

async function loadSponsors() {
  state.sponsors = await api('/api/sponsors');
}

async function loadAdmin() {
  [state.users, state.settings] = await Promise.all([
    api('/api/admin/users'),
    api('/api/admin/settings'),
  ]);
}

async function loadAudit(page = 1) {
  state.audit = await api('/api/admin/audit?page=' + page + '&pageSize=20');
}

function loginView() {
  // One card, one form: the login error stays inside the card instead of the page banner.
  return '<section class="auth-shell"><div class="auth-card"><div class="brand-mark">9</div>' +
    '<span class="eyebrow">LLM PORTAL</span><h2>Welcome back</h2>' +
    '<form id="login-user-form" class="login-form"><label>Username<input id="lu" autocomplete="username" autofocus></label>' +
    '<label>Password<input id="lp" type="password" autocomplete="current-password"></label>' +
    (state.loginError ? '<div class="notice error login-error">' + esc(state.loginError) + '</div>' : '') +
    (state.loginNotice ? '<div class="notice ok login-error">' + esc(state.loginNotice) + '</div>' : '') +
    '<div class="login-actions"><button class="primary" type="submit">Sign in</button>' +
    '<button id="login-new" type="button">New</button></div></form>' +
    '</div></section>';
}

function passwordView() {
  return '<section class="password-shell"><div class="panel compact password-panel"><div class="panel-head"><div><h2>Change password</h2></div></div>' +
    '<label>Current password<input id="cp" type="password" autocomplete="current-password"></label>' +
    '<label>New password<input id="np" type="password" autocomplete="new-password" placeholder="Minimum 12 characters"></label>' +
    (state.passwordError ? '<div class="notice error">' + esc(state.passwordError) + '</div>' : '') +
    '<div class="password-actions"><button id="btn-password-cancel">Cancel</button>' +
    '<button class="primary" id="btn-password">Update password</button></div></div></section>';
}

function statusBadge(value) {
  return '<span class="badge ' + esc(value) + '"><i></i>' + esc(value) + '</span>';
}

function providerIcon(provider) {
  return '<span class="provider-icon ' + provider + '">' + (provider === 'claude' ? 'A' : '⌘') + '</span>';
}

function providerCard(provider, title, subtitle) {
  return '<article class="provider-card"><div class="provider-card-top">' + providerIcon(provider) +
    '<div><h3>' + esc(title) + '</h3><p>' + esc(subtitle) + '</p></div></div>' +
    '<div class="provider-card-meta"><span>OAuth</span><span>PKCE</span><span>Quota</span></div>' +
    '<button class="primary wide" data-add="' + provider + '">Connect ' + esc(title) + '</button></article>';
}

function providersView() {
  const cards = state.accounts.map(connectionCard).join('');
  const missingRouters = ['ninerouter', 'omniroute'].filter((router) => !state.routers[router]?.configured);
  return (missingRouters.length ? '<div class="notice bad">Router sync is not configured: ' + esc(missingRouters.join(', ')) + '.</div>' : '') +
    '<div class="panel"><div class="panel-head"><div><h2>Add provider</h2></div></div>' +
    '<div class="grid-cards">' + providerCard('claude', 'Claude Code', 'Anthropic OAuth account') +
    providerCard('codex', 'Codex', 'OpenAI ChatGPT OAuth account') + '</div></div>' +
    quotaPolicyPanel() +
    '<div class="panel connections-panel"><div class="panel-head"><div><h2>Connections</h2>' +
    '<p>Provider health, router sync, quota and controls in one place.</p></div>' +
    '<span class="connection-count">' + state.accounts.length + ' connected</span></div>' +
    (cards ? '<div class="connections-grid">' + cards + '</div>' :
      '<div class="empty">No provider connections yet.</div>') + '</div>';
}

function quotaPolicyPanel() {
  const policy = state.quotaPolicy || {
    sessionQuotaAutoDisable: true,
    sessionQuotaThresholdPercent: 30,
    sessionQuotaAutoEnable: true,
    source: 'admin',
    adminDefaults: {
      sessionQuotaAutoDisable: true,
      sessionQuotaThresholdPercent: 30,
      sessionQuotaAutoEnable: true,
    },
  };
  const defaults = policy.adminDefaults;
  const defaultsText = 'Admin defaults: auto-disable ' + (defaults.sessionQuotaAutoDisable ? 'on' : 'off') +
    ' at ' + defaults.sessionQuotaThresholdPercent + '% remaining; auto-enable ' +
    (defaults.sessionQuotaAutoEnable ? 'on' : 'off') + '.';
  return '<div class="panel quota-policy-panel"><div class="panel-head"><div><div class="title-with-badge"><h2>My session quota policy</h2>' +
    '<span class="policy-source ' + esc(policy.source) + '">' + (policy.source === 'user' ? 'Custom' : 'Admin defaults') + '</span></div>' +
    '<p>Applies only to provider accounts sponsored by you. ' + esc(defaultsText) + '</p></div></div>' +
    '<form class="quota-settings-form personal-quota-form" id="user-quota-settings-form">' +
    '<div class="policy-settings-grid"><label class="policy-setting policy-switch check-setting">' +
    '<input id="user-quota-auto-disable" type="checkbox" role="switch"' + (policy.sessionQuotaAutoDisable ? ' checked' : '') + '>' +
    '<span><b>Auto-disable</b><small>Pause my accounts when session quota reaches the threshold.</small></span></label>' +
    '<label class="policy-setting threshold-setting"><span class="setting-copy"><b>Remaining threshold</b>' +
    '<small>Pause when session quota reaches this percentage.</small></span>' +
    '<span class="threshold-control"><input id="user-quota-threshold" type="number" min="0" max="100" step="1" ' +
    'aria-label="Remaining threshold percentage" value="' + esc(policy.sessionQuotaThresholdPercent) + '"><i aria-hidden="true">%</i></span></label>' +
    '<label class="policy-setting policy-switch check-setting"><input id="user-quota-auto-enable" type="checkbox" role="switch"' +
    (policy.sessionQuotaAutoEnable ? ' checked' : '') + '>' +
    '<span><b>Auto-enable after reset</b><small>Resume only accounts paused by this policy.</small></span></label></div>' +
    '<div class="policy-form-footer"><small>Changes apply on the next quota check.</small>' +
    '<div class="policy-actions"><button class="primary" type="submit">Save my policy</button>' +
    (policy.source === 'user' ? '<button id="use-admin-quota-defaults" type="button">Use admin defaults</button>' : '') +
    '</div></div></form></div>';
}

function connectionCard(account) {
  const providerName = account.provider === 'claude' ? 'Claude Code' : 'Codex';
  const expiry = account.accessExpiresAt ? formatDateTime(account.accessExpiresAt) : 'Not reported';
  return '<article class="connection-card"><header class="connection-card-head"><div class="account-name">' +
    providerIcon(account.provider) + '<div><h3>' + esc(account.displayName) + '</h3><span class="provider-label">' + esc(providerName) + '</span>' +
    '<small>Sponsored by ' + esc(account.owner) + ' · Portal ID ' + account.id + '</small></div></div>' +
    statusBadge(account.status) + '</header>' +
    '<div class="connection-statuses"><div><span>Portal</span>' + statusBadge(account.status) + '</div>' +
    '<div><span>9Router</span>' + statusBadge(account.routers.ninerouter?.status || 'pending') + '</div>' +
    '<div><span>OmniRoute</span>' + statusBadge(account.routers.omniroute?.status || 'pending') + '</div></div>' +
    '<div class="connection-token"><span>Access token expires</span><strong>' + esc(expiry) + '</strong></div>' +
    (account.quotaAutoDisabled ? '<div class="quota-policy-warning">Auto-disabled by session quota' +
      (account.quotaSessionResetAt ? ' · reset ' + esc(formatDateTime(account.quotaSessionResetAt)) : '') + '</div>' : '') +
    quotaStrip(account) +
    '<footer class="connection-actions"><button data-toggle="' + account.id + '" data-enabled="' + (account.enabled ? '0' : '1') + '">' +
    (account.enabled ? 'Disable' : 'Enable') + '</button><button data-retry="' + account.id + '">Sync</button>' +
    '<button data-reauth="' + account.id + '" data-provider="' + esc(account.provider) + '">Re-auth</button>' +
    '<button class="danger" data-remove-account="' + account.id + '">Delete</button></footer></article>';
}

function quotaStrip(account) {
  const quota = state.quotas[account.id];
  if (!quota) return '<div class="connection-quotas"><span class="quota-hint">Loading quota…</span></div>';
  const entries = Object.entries(quota.quotas || {});
  if (!entries.length) return '<div class="connection-quotas"><span class="quota-hint">Upstream returned no quota window.</span></div>';
  return '<div class="connection-quotas"><div class="quota-section-title">' + entries.length +
    (entries.length === 1 ? ' quota window' : ' quota windows') + '</div>' +
    entries.map(([name, value]) => {
      const remaining = Math.max(0, Math.min(100, Number(value.remaining) || 0));
      const level = remaining <= 20 ? 'low' : remaining <= 50 ? 'medium' : 'healthy';
      return '<div class="quota-meter ' + level + '"><div class="quota-meter-head"><span><i></i>' +
        esc(quotaName(name, account.provider, quota.plan)) + '</span><strong>' + quotaPercent(value.remaining) + ' remaining</strong></div>' +
        '<div class="progress" role="progressbar" aria-label="' + esc(quotaName(name, account.provider, quota.plan)) +
        ' remaining" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + remaining + '">' +
        '<span style="width:' + remaining + '%"></span></div><small>' + quotaResetLabel(value.resetAt) + '</small></div>';
    }).join('') +
    '</div>';
}

function quotaName(name, provider, plan) {
  if (name === 'session' && provider === 'codex' && String(plan || '').trim().toLowerCase() === 'pro') return 'Session (7d)';
  if (name === 'session') return 'Session (5h)';
  if (name === 'weekly') return 'Weekly (7d)';
  return name;
}

function quotaPercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return '—';
  if (percent > 0 && percent < 1) return '<1%';
  return Math.round(Math.max(0, Math.min(100, percent))) + '%';
}

function quotaResetLabel(resetAt) {
  if (!resetAt) return 'Reset: —';
  const resetMs = Date.parse(resetAt);
  if (!Number.isFinite(resetMs)) return 'Reset: —';
  if (resetMs <= Date.now()) return 'Reset passed · refreshing within 5 min';
  return 'Reset: ' + formatDateTime(resetMs);
}

function sponsorsView() {
  const groups = state.sponsors.map((sponsor) => {
    const rows = sponsor.accounts.map((account) => '<tr><td><div class="account-name">' +
      providerIcon(account.provider) + '<div><strong>' + esc(account.displayName) + '</strong></div></div></td>' +
      '<td>' + esc(account.provider === 'claude' ? 'Claude Code' : 'Codex') + '</td>' +
      '<td>' + statusBadge(account.status) + '</td><td>' + statusBadge(account.routers.ninerouter?.status || 'pending') + '</td>' +
      '<td>' + statusBadge(account.routers.omniroute?.status || 'pending') + '</td></tr>').join('');
    return '<div class="panel sponsor-group"><div class="panel-head"><div><h2>' + esc(sponsor.username) +
      '</h2></div><span class="sponsor-count">' + sponsor.accounts.length + ' accounts</span></div>' +
      '<div class="table-wrap"><table><colgroup><col class="sponsor-account-col"><col class="sponsor-provider-col">' +
      '<col class="sponsor-state-col"><col class="sponsor-router-col"><col class="sponsor-router-col"></colgroup>' +
      '<thead><tr><th>Account</th><th>Provider</th><th>State</th><th>9Router</th><th>OmniRoute</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div></div>';
  }).join('');
  return groups || '<div class="panel empty">No sponsors available.</div>';
}

function adminView() {
  const userRows = state.users.map((user) => '<tr><td><div><strong>' + esc(user.username) + '</strong><small class="row-sub">' +
    esc(formatDateTime(user.createdAt)) + '</small></div></td><td><select class="role-select" data-role-user="' + user.id +
    '" data-current-role="' + esc(user.role) + '"><option value="user"' + (user.role === 'user' ? ' selected' : '') +
    '>user</option><option value="admin"' + (user.role === 'admin' ? ' selected' : '') + '>admin</option></select></td><td>' + user.accountCount +
    '</td><td>' + statusBadge(user.disabled ? 'disabled' : 'active') + '</td><td class="actions">' +
    '<button data-reset-user="' + user.id + '" data-username="' + esc(user.username) + '">Reset password</button>' +
    '<button data-disable="' + user.id + '" data-value="' + (user.disabled ? '0' : '1') + '">' + (user.disabled ? 'Enable' : 'Disable') + '</button>' +
    (user.id === state.me.id ? '' : '<button class="danger" data-remove-user="' + user.id + '" data-username="' + esc(user.username) + '">Remove</button>') +
    '</td></tr>').join('');
  const refreshLeadHours = state.settings?.refreshLeadHours ?? 8;
  const quotaAutoDisable = state.settings?.sessionQuotaAutoDisable ?? true;
  const quotaThreshold = state.settings?.sessionQuotaThresholdPercent ?? 30;
  const quotaAutoEnable = state.settings?.sessionQuotaAutoEnable ?? true;
  return '<div class="panel"><div class="panel-head"><div><h2>Token refresh</h2>' +
    '<p>Refresh provider tokens this many hours before expiry. Changes apply to the next scheduler run.</p></div></div>' +
    '<form class="settings-form" id="refresh-settings-form"><label>Before expiry (hours)' +
    '<input id="refresh-lead-hours" type="number" min="1" max="168" step="1" value="' + esc(refreshLeadHours) + '"></label>' +
    '<button class="primary" type="submit">Save</button></form></div>' +
    '<div class="panel"><div class="panel-head"><div><h2>Session quota automation</h2>' +
    '<p>Protect provider accounts using the upstream session quota window.</p></div></div>' +
    '<form class="quota-settings-form" id="quota-settings-form">' +
    '<label class="check-setting"><input id="quota-auto-disable" type="checkbox"' + (quotaAutoDisable ? ' checked' : '') + '>' +
    '<span><b>Auto-disable</b><small>Disable an account when remaining session quota reaches the threshold.</small></span></label>' +
    '<label>Remaining threshold (%)<input id="quota-threshold" type="number" min="0" max="100" step="1" value="' + esc(quotaThreshold) + '"></label>' +
    '<label class="check-setting"><input id="quota-auto-enable" type="checkbox"' + (quotaAutoEnable ? ' checked' : '') + '>' +
    '<span><b>Auto-enable after reset</b><small>Only accounts disabled by this policy are enabled again.</small></span></label>' +
    '<button class="primary" type="submit">Save</button></form></div>' +
    '<div class="panel"><div class="panel-head"><div><h2>User management</h2><p>Create, reset password, disable, or remove users.</p></div></div>' +
    '<form class="create-user" id="create-user-form"><label>Username<input id="new-user" placeholder="username" autocomplete="off"></label>' +
    '<label>Initial password<input id="new-pass" type="password" placeholder="Minimum 12 characters" autocomplete="new-password"></label>' +
    '<label>Role<select id="new-role"><option value="user">user</option><option value="admin">admin</option></select></label>' +
    '<button class="primary" type="submit">Create user</button></form><div class="table-wrap"><table><thead><tr><th>Username</th><th>Role</th>' +
    '<th>Accounts</th><th>State</th><th></th></tr></thead><tbody>' + userRows + '</tbody></table></div></div>' +
    '';
}

function auditView() {
  const auditRows = state.audit.items.map((entry) => '<tr><td title="' + esc(entry.time) + '">' + esc(formatAuditTime(entry.time)) + '</td><td>' + esc(entry.actor) +
    '</td><td>' + esc(entry.action) + '</td><td>' + esc(entry.target) + '</td></tr>').join('');
  return '<div class="panel"><div class="panel-head"><div><h2>Audit log</h2><p>Credential and token values never logged.</p></div></div>' +
    '<div class="table-wrap"><table><thead><tr><th>Time (GMT+7)</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead><tbody>' +
    (auditRows || '<tr><td colspan="4" class="empty">No audit entries.</td></tr>') + '</tbody></table></div>' +
    '<div class="pagination"><button id="audit-prev"' + (state.audit.page <= 1 ? ' disabled' : '') + '>Previous</button>' +
    '<span>Page ' + state.audit.page + ' of ' + state.audit.totalPages + ' · ' + state.audit.total + ' entries</span>' +
    '<button id="audit-next"' + (state.audit.page >= state.audit.totalPages ? ' disabled' : '') + '>Next</button></div></div>';
}

function oauthModal(modal) {
  const providerName = modal.provider === 'claude' ? 'Claude Code' : 'Codex';
  const actionName = modal.accountId === null || modal.accountId === undefined ? 'Connect' : 'Re-authenticate';
  const pasteLabel = modal.provider === 'claude' ? 'authorization code (code#state)' : 'full callback URL';
  const placeholder = modal.provider === 'claude' ? 'Paste code#state here...' : 'http://localhost:1455/auth/callback?code=...&state=...';
  const body = modal.loading
    ? '<div class="waiting-row"><span class="spinner"></span>Preparing secure OAuth session…</div>'
    : '<div class="waiting-row"><span class="spinner"></span>Waiting for browser authorization…</div>' +
      '<div class="step"><div class="step-title"><span class="step-num">1</span>Open OAuth URL in browser</div>' +
      '<p class="step-hint">The popup opens just like 9Router. If it is blocked, use the Open OAuth button.</p>' +
      '<div class="auth-url"><input id="oauth-url" value="' + esc(modal.url) + '" readonly>' +
      '<button id="copy-oauth">Copy</button><button class="primary" id="open-oauth">Open OAuth</button></div></div>' +
      '<div class="divider"><i></i><span>then</span><i></i></div>' +
      '<div class="step"><div class="step-title"><span class="step-num">2</span>Paste ' + pasteLabel + '</div>' +
      '<p class="step-hint">' + (modal.provider === 'claude'
        ? 'After you authorize, Claude shows a code. Copy the whole code#state value.'
        : 'After the localhost redirect, copy the whole address bar URL even if the callback page fails to load.') + '</p>' +
      '<textarea id="oauth-callback" class="mono" placeholder="' + esc(placeholder) + '"></textarea></div>' +
      (modal.error ? '<div class="notice error">' + esc(modal.error) + '</div>' : '');
  return modalFrame(actionName + ' ' + providerName, body,
    modal.loading ? '<button id="close-modal">Cancel</button>' :
      '<button id="close-modal">Cancel</button><button class="primary" id="complete-oauth">' + actionName + ' ' + providerName + '</button>');
}

function resetPasswordModal(modal) {
  return modalFrame('Reset password', '<p>Set a new password for <strong>' + esc(modal.username) + '</strong>. Their current sessions are signed out.</p>' +
    '<label>New password<input id="reset-pass" type="password" autocomplete="new-password" placeholder="Minimum 12 characters"></label>' +
    '<label>Confirm password<input id="reset-pass-confirm" type="password" autocomplete="new-password"></label>' +
    (modal.error ? '<div class="notice error">' + esc(modal.error) + '</div>' : ''),
  '<button id="close-modal">Cancel</button><button class="primary" id="confirm-reset">Reset password</button>');
}

function removeUserModal(modal) {
  return modalFrame('Remove user', '<p>Remove <strong>' + esc(modal.username) + '</strong>?</p>' +
    '<div class="notice bad">Their provider accounts are removed from the routers first. This cannot be undone.</div>' +
    (modal.error ? '<div class="notice error">' + esc(modal.error) + '</div>' : ''),
  '<button id="close-modal">Cancel</button><button class="danger" id="confirm-remove-user">Remove user</button>');
}

function modalFrame(title, body, footer) {
  return '<div class="modal-overlay"><section class="modal" role="dialog" aria-modal="true" aria-label="' + esc(title) + '">' +
    '<div class="modal-head"><div class="traffic"><button class="close" id="traffic-close" aria-label="Close"></button><i class="min"></i><i class="max"></i></div>' +
    '<div class="modal-title">' + esc(title) + '</div></div><div class="modal-body">' + body + '</div><div class="modal-foot">' + footer + '</div></section></div>';
}

function modalView() {
  if (!state.modal) return '';
  if (state.modal.type === 'oauth') return oauthModal(state.modal);
  if (state.modal.type === 'reset-password') return resetPasswordModal(state.modal);
  if (state.modal.type === 'remove-user') return removeUserModal(state.modal);
  return '';
}

async function selectTab(requestedTab, { writeHistory = true, replaceHistory = false } = {}) {
  const tab = tabIsAvailable(requestedTab) ? requestedTab : 'providers';
  state.view = null;
  state.passwordError = null;
  state.tab = tab;
  if (writeHistory || tab !== requestedTab) syncTabUrl(tab, replaceHistory || tab !== requestedTab);
  await refresh();
}

function bindBrowserNavigation() {
  window.addEventListener('popstate', () => {
    if (state.me) void selectTab(tabFromPath(window.location.pathname), { writeHistory: false });
  });
}

function render(extra) {
  document.body.classList.toggle('signed-out', !state.me);
  const banner = state.message ? '<div class="notice ' + esc(state.message.kind) + '">' + esc(state.message.text) + '</div>' : '';
  if ($('theme-slot')) $('theme-slot').innerHTML = themeButton();
  if (!state.me) {
    $('session').innerHTML = '';
    $('nav').innerHTML = '';
    $('page-title').textContent = 'Sign in';
    $('main').innerHTML = banner + loginView();
    $('modal-root').innerHTML = '';
    bind();
    return;
  }
  $('page-title').textContent = state.view === 'password'
    ? 'Change password'
    : ({ providers: 'Providers', sponsors: 'Sponsors', admin: 'Admin', audit: 'Audit log' }[state.tab] || 'Portal');
  $('session').innerHTML = '<div class="who"><strong>' + esc(state.me.username) + '</strong><span>' + esc(state.me.role) + '</span></div>' +
    '<button id="btn-password-view">Change password</button><button class="ghost" id="btn-logout">Logout</button>';
  const navItems = [
    ['providers', '◈', 'Providers'],
    ['sponsors', '♧', 'Sponsors'],
    ...(state.me.role === 'admin' ? [['admin', '♙', 'Admin'], ['audit', '≣', 'Audit log']] : []),
  ];
  $('nav').innerHTML = navItems.map(([tab, icon, label]) => '<a class="nav-item ' + (state.tab === tab ? 'active' : '') +
    '" ' + (state.tab === tab ? 'aria-current="page" ' : '') + 'href="' + pathForTab(tab) +
    '" data-tab="' + tab + '"><span class="ico">' + icon + '</span>' + label + '</a>').join('');
  const content = extra !== undefined
    ? extra
    : state.view === 'password'
      ? passwordView()
      : state.tab === 'audit'
        ? auditView()
      : state.tab === 'admin'
        ? adminView()
        : state.tab === 'sponsors'
          ? sponsorsView()
          : providersView();
  $('main').innerHTML = banner + content;
  $('modal-root').innerHTML = modalView();
  bind();
}

function closeModal() {
  state.modal = null;
  render();
}

function bind() {
  if ($('theme-toggle')) $('theme-toggle').onclick = toggleTheme;
  if ($('login-user-form')) $('login-user-form').onsubmit = (event) => { event.preventDefault(); submitLogin(); };
  if ($('login-new')) $('login-new').onclick = registerUser;
  if ($('btn-logout')) $('btn-logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.reload(); };
  if ($('btn-password-view')) $('btn-password-view').onclick = () => {
    state.view = 'password';
    state.passwordError = null;
    render();
  };
  if ($('btn-password-cancel')) $('btn-password-cancel').onclick = () => {
    state.view = null;
    state.passwordError = null;
    render();
  };
  if ($('btn-password')) $('btn-password').onclick = changePassword;
  document.querySelectorAll('[data-tab]').forEach((element) => { element.onclick = (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void selectTab(element.dataset.tab);
  }; });
  document.querySelectorAll('[data-add]').forEach((element) => {
    element.onclick = () => startOAuth(element.dataset.add);
  });
  document.querySelectorAll('[data-reauth]').forEach((element) => {
    element.onclick = () => startOAuth(element.dataset.provider, Number(element.dataset.reauth));
  });
  document.querySelectorAll('[data-toggle]').forEach((element) => { element.onclick = () => act(element, async () => {
    await api('/api/accounts/' + element.dataset.toggle + '/state', { method: 'PATCH', body: JSON.stringify({ enabled: element.dataset.enabled === '1' }) });
    await refresh();
  }); });
  document.querySelectorAll('[data-retry]').forEach((element) => { element.onclick = () => act(element, async () => {
    const result = await api('/api/accounts/' + element.dataset.retry + '/retry', { method: 'POST' });
    await refresh();
    notify('9Router: ' + (result.routers?.ninerouter || 'unknown') + ' · OmniRoute: ' + (result.routers?.omniroute || 'unknown'), 'ok');
  }); });
  document.querySelectorAll('[data-remove-account]').forEach((element) => { element.onclick = () => act(element, async () => {
    if (!confirm('Delete account from Portal, 9Router, and OmniRoute?')) return;
    await api('/api/accounts/' + element.dataset.removeAccount, { method: 'DELETE' }); await refresh();
  }); });
  document.querySelectorAll('[data-reset-user]').forEach((element) => { element.onclick = () => {
    state.modal = { type: 'reset-password', id: element.dataset.resetUser, username: element.dataset.username };
    render();
  }; });
  document.querySelectorAll('[data-remove-user]').forEach((element) => { element.onclick = () => {
    state.modal = { type: 'remove-user', id: element.dataset.removeUser, username: element.dataset.username };
    render();
  }; });
  document.querySelectorAll('[data-disable]').forEach((element) => { element.onclick = () => act(element, async () => {
    await api('/api/admin/users/' + element.dataset.disable, { method: 'PATCH', body: JSON.stringify({ disabled: element.dataset.value === '1' }) });
    await loadAdmin(); render();
  }); });
  document.querySelectorAll('[data-role-user]').forEach((element) => { element.onchange = () => updateUserRole(element); });
  if ($('audit-prev')) $('audit-prev').onclick = async () => { await loadAudit(state.audit.page - 1); render(); };
  if ($('audit-next')) $('audit-next').onclick = async () => { await loadAudit(state.audit.page + 1); render(); };
  if ($('create-user-form')) $('create-user-form').onsubmit = (event) => { event.preventDefault(); createUser(); };
  if ($('refresh-settings-form')) $('refresh-settings-form').onsubmit = (event) => { event.preventDefault(); updateRefreshSettings(); };
  if ($('quota-settings-form')) $('quota-settings-form').onsubmit = (event) => { event.preventDefault(); updateQuotaSettings(); };
  if ($('user-quota-settings-form')) $('user-quota-settings-form').onsubmit = (event) => { event.preventDefault(); updateMyQuotaSettings(); };
  if ($('use-admin-quota-defaults')) $('use-admin-quota-defaults').onclick = resetMyQuotaSettings;
  if ($('traffic-close')) $('traffic-close').onclick = closeModal;
  if ($('close-modal')) $('close-modal').onclick = closeModal;
  if ($('open-oauth')) $('open-oauth').onclick = () => window.open(state.modal.url, 'portal_oauth', 'width=680,height=760');
  if ($('copy-oauth')) $('copy-oauth').onclick = copyOAuthUrl;
  if ($('complete-oauth')) $('complete-oauth').onclick = completeOAuth;
  if ($('confirm-reset')) $('confirm-reset').onclick = resetUserPassword;
  if ($('confirm-remove-user')) $('confirm-remove-user').onclick = removeUser;
}

async function act(element, action) {
  element.disabled = true;
  try { await action(); } catch (error) { notify(error.message); } finally { element.disabled = false; }
}

async function startOAuth(provider, accountId = null) {
  const popup = window.open('', 'portal_oauth', 'width=680,height=760');
  state.modal = { type: 'oauth', provider, accountId, loading: true, error: null };
  render();
  try {
    const result = await api('/api/oauth/' + provider + '/start', {
      method: 'POST',
      ...(accountId === null ? {} : { body: JSON.stringify({ accountId }) }),
    });
    state.modal = { type: 'oauth', provider, accountId, loading: false, url: result.url, redirectUri: result.redirectUri, error: null };
    render();
    if (popup) popup.location.href = result.url;
  } catch (error) {
    if (popup) popup.close();
    state.modal = { type: 'oauth', provider, accountId, loading: false, url: '', error: error.message };
    render();
  }
}

async function copyOAuthUrl() {
  try {
    await navigator.clipboard.writeText(state.modal.url);
    const button = $('copy-oauth');
    button.textContent = 'Copied';
  } catch {
    $('oauth-url').select();
    document.execCommand('copy');
  }
}

async function completeOAuth() {
  const button = $('complete-oauth');
  const callback = $('oauth-callback').value.trim();
  if (!callback) {
    state.modal.error = state.modal.provider === 'claude' ? 'Paste code#state from Claude.' : 'Paste full Codex callback URL.';
    render();
    return;
  }
  button.disabled = true;
  button.textContent = 'Connecting…';
  try {
    await api('/api/oauth/' + state.modal.provider + '/complete', { method: 'POST', body: JSON.stringify({ callback }) });
    state.modal = null;
    state.message = { text: 'OAuth connected. Credential synced to the routers.', kind: 'ok' };
    await refresh();
  } catch (error) {
    state.modal.error = error.message;
    render();
  }
}

async function submitLogin() {
  const credentials = { username: $('lu').value, password: $('lp').value };
  try {
    state.me = await api('/api/login', { method: 'POST', body: JSON.stringify(credentials) });
    state.loginError = null;
    state.loginNotice = null;
    await selectTab(tabFromPath(window.location.pathname), { replaceHistory: true });
  } catch (error) {
    // Login problems belong to the card, not to the page-wide banner.
    state.loginError = error.message;
    state.loginNotice = null;
    render();
    restoreLoginInput(credentials);
  }
}

async function registerUser() {
  const credentials = { username: $('lu').value, password: $('lp').value };
  const button = $('login-new');
  button.disabled = true;
  try {
    state.me = await api('/api/register', { method: 'POST', body: JSON.stringify(credentials) });
    state.loginError = null;
    state.loginNotice = null;
    state.message = { text: 'User created successfully.', kind: 'ok' };
    await selectTab('providers', { replaceHistory: true });
  } catch (error) {
    state.loginError = error.message;
    state.loginNotice = null;
    render();
    restoreLoginInput(credentials);
  }
}

function restoreLoginInput(credentials) {
  if (!$('lu')) return;
  $('lu').value = credentials.username;
  $('lp').value = credentials.password;
  $('lu').focus();
}

async function changePassword() {
  try {
    await api('/api/password', { method: 'POST', body: JSON.stringify({ currentPassword: $('cp').value, newPassword: $('np').value }) });
    state.me = await api('/api/me');
    state.view = null;
    state.passwordError = null;
    state.message = { text: 'Password updated.', kind: 'ok' };
    await refresh();
  } catch (error) {
    state.passwordError = error.message;
    render();
  }
}

async function createUser() {
  const button = $('create-user-form').querySelector('button[type=submit]');
  await act(button, async () => {
    await api('/api/admin/users', { method: 'POST', body: JSON.stringify({
      username: $('new-user').value,
      password: $('new-pass').value,
      role: $('new-role').value,
    }) });
    state.message = { text: 'User created.', kind: 'ok' };
    await loadAdmin(); render();
  });
}

async function updateRefreshSettings() {
  const button = $('refresh-settings-form').querySelector('button[type=submit]');
  await act(button, async () => {
    state.settings = await api('/api/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify({ refreshLeadHours: Number($('refresh-lead-hours').value) }),
    });
    state.message = { text: 'Token refresh lead time updated.', kind: 'ok' };
    render();
  });
}

async function updateQuotaSettings() {
  const button = $('quota-settings-form').querySelector('button[type=submit]');
  await act(button, async () => {
    state.settings = await api('/api/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        sessionQuotaAutoDisable: $('quota-auto-disable').checked,
        sessionQuotaThresholdPercent: Number($('quota-threshold').value),
        sessionQuotaAutoEnable: $('quota-auto-enable').checked,
      }),
    });
    state.message = { text: 'Session quota automation updated.', kind: 'ok' };
    render();
  });
}
async function updateMyQuotaSettings() {
  const button = $('user-quota-settings-form').querySelector('button[type=submit]');
  await act(button, async () => {
    state.quotaPolicy = await api('/api/me/quota-settings', {
      method: 'PATCH',
      body: JSON.stringify({
        sessionQuotaAutoDisable: $('user-quota-auto-disable').checked,
        sessionQuotaThresholdPercent: Number($('user-quota-threshold').value),
        sessionQuotaAutoEnable: $('user-quota-auto-enable').checked,
      }),
    });
    state.message = { text: 'Your session quota policy was updated.', kind: 'ok' };
    render();
  });
}
async function resetMyQuotaSettings() {
  const button = $('use-admin-quota-defaults');
  await act(button, async () => {
    state.quotaPolicy = await api('/api/me/quota-settings', { method: 'DELETE' });
    state.message = { text: 'Your policy now follows the admin defaults.', kind: 'ok' };
    render();
  });
}

async function updateUserRole(element) {
  const previousRole = element.dataset.currentRole;
  element.disabled = true;
  try {
    await api('/api/admin/users/' + element.dataset.roleUser, {
      method: 'PATCH',
      body: JSON.stringify({ role: element.value }),
    });
    state.me = await api('/api/me');
    if (state.me.role !== 'admin') {
      await selectTab('providers', { replaceHistory: true });
      return;
    }
    await loadAdmin();
    render();
    notify('User role updated.', 'ok');
  } catch (error) {
    element.value = previousRole;
    notify(error.message);
  }
}

async function resetUserPassword() {
  const password = $('reset-pass').value;
  if (password !== $('reset-pass-confirm').value) {
    state.modal.error = 'Password confirmation does not match.';
    render();
    return;
  }
  try {
    await api('/api/admin/users/' + state.modal.id + '/reset-password', {
      method: 'POST', body: JSON.stringify({ password }),
    });
    const username = state.modal.username;
    state.modal = null;
    state.message = { text: 'Password reset for ' + username + '.', kind: 'ok' };
    await loadAdmin(); render();
  } catch (error) {
    state.modal.error = error.message;
    render();
  }
}

async function removeUser() {
  try {
    const username = state.modal.username;
    await api('/api/admin/users/' + state.modal.id, { method: 'DELETE' });
    state.modal = null;
    state.message = { text: 'User ' + username + ' removed.', kind: 'ok' };
    await loadAdmin(); render();
  } catch (error) {
    state.modal.error = error.message;
    render();
  }
}

(async function init() {
  bindBrowserNavigation();
  try {
    state.me = await api('/api/me');
    await selectTab(tabFromPath(window.location.pathname), { replaceHistory: true });
  } catch {
    render();
  }
})();
`;
