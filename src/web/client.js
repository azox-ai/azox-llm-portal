export const appScript = String.raw`
const state = {
  me: null,
  accounts: [],
  routers: {},
  tab: 'providers',
  message: null,
  quotas: {},
  users: [],
  audit: [],
  modal: null,
};

const $ = (id) => document.getElementById(id);
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
  [state.accounts, state.routers] = await Promise.all([api('/api/accounts'), api('/api/router-status')]);
  if (state.me?.role === 'admin' && state.tab === 'admin') await loadAdmin();
  render();
}

async function loadAdmin() {
  [state.users, state.audit] = await Promise.all([api('/api/admin/users'), api('/api/admin/audit?limit=40')]);
}

function loginView() {
  return '<section class="auth-shell"><div class="auth-card"><div class="brand-mark">9</div>' +
    '<span class="eyebrow">LLM GATEWAY</span><h2>Welcome back</h2>' +
    '<p>User đăng nhập bằng username/password. Admin có thể dùng password init giống 9Router.</p>' +
    '<div class="login-tabs"><button class="primary" id="login-user-tab">User login</button>' +
    '<button id="login-admin-tab">Admin login</button></div>' +
    '<form id="login-user-form"><label>Username<input id="lu" autocomplete="username" autofocus></label>' +
    '<label>Password<input id="lp" type="password" autocomplete="current-password"></label>' +
    '<button class="primary wide" type="submit">Sign in</button></form>' +
    '<form id="login-admin-form" hidden><label>Admin password<input id="lap" type="password" autocomplete="current-password"></label>' +
    '<button class="primary wide" type="submit">Sign in as admin</button>' +
    '<p class="form-hint">Dùng <span class="mono">INIT_ADMIN_PASSWORD</span> đã cấu hình khi khởi tạo Portal.</p></form>' +
    '</div></section>';
}

function passwordView() {
  return '<div class="panel compact"><div class="panel-head"><div><h2>Change password</h2>' +
    '<p>Không bắt buộc đổi password lần đầu.</p></div></div>' +
    '<label>Current password<input id="cp" type="password" autocomplete="current-password"></label>' +
    '<label>New password<input id="np" type="password" autocomplete="new-password" placeholder="Minimum 12 characters"></label>' +
    '<button class="primary" id="btn-password">Update password</button></div>';
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
  const rows = state.accounts.map((account) => '<tr><td><div class="account-name">' +
    providerIcon(account.provider) + '<div><strong>' + esc(account.displayName) + '</strong><small>' +
    esc(account.owner) + '</small></div></div></td><td>' + esc(account.provider === 'claude' ? 'Claude Code' : 'Codex') +
    '</td><td>' + statusBadge(account.status) + '</td><td>' +
    statusBadge(account.routers.ninerouter?.status || 'pending') + '</td><td>' +
    (account.accessExpiresAt ? new Date(account.accessExpiresAt).toLocaleString() : '—') + '</td><td class="actions">' +
    '<button data-toggle="' + account.id + '" data-enabled="' + (account.enabled ? '0' : '1') + '">' +
    (account.enabled ? 'Disable' : 'Enable') + '</button><button data-retry="' + account.id + '">Sync</button>' +
    '<button data-reauth="' + esc(account.provider) + '">Re-auth</button>' +
    '<button class="danger" data-remove-account="' + account.id + '">Delete</button></td></tr>').join('');
  const configured = state.routers.ninerouter?.configured;
  return (!configured ? '<div class="notice bad">9Router sync chưa được cấu hình.</div>' : '') +
    '<div class="panel"><div class="panel-head"><div><h2>Add provider</h2><p>Flow OAuth hai bước giống 9Router.</p></div></div>' +
    '<div class="grid-cards">' + providerCard('claude', 'Claude Code', 'Anthropic OAuth account') +
    providerCard('codex', 'Codex', 'OpenAI ChatGPT OAuth account') + '</div></div>' +
    '<div class="panel"><div class="panel-head"><div><h2>Connections</h2><p>Chỉ hiện account do user hiện tại thêm.</p></div></div>' +
    (rows ? '<div class="table-wrap"><table><thead><tr><th>Account</th><th>Provider</th><th>State</th>' +
      '<th>9Router</th><th>Access token expires</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' :
      '<div class="empty">No provider connections yet.</div>') + '</div>';
}

function quotaCards(quota) {
  if (!quota) return '<div class="quota-placeholder">Select Refresh to load current quota.</div>';
  const entries = Object.entries(quota.quotas || {});
  if (!entries.length) return '<div class="quota-placeholder">Upstream returned no quota windows.</div>';
  return '<div class="quota-grid">' + entries.map(([name, value]) => '<div class="quota-card"><div class="quota-title">' +
    esc(name) + '</div><div class="quota-value">' + Math.round(value.remaining) + '%</div><div class="progress"><span style="width:' +
    Math.max(0, Math.min(100, value.remaining)) + '%"></span></div><small>Reset: ' +
    (value.resetAt ? new Date(value.resetAt).toLocaleString() : '—') + '</small></div>').join('') + '</div>';
}

function quotaView() {
  const cards = state.accounts.map((account) => '<div class="panel"><div class="panel-head"><div><div class="account-name">' +
    providerIcon(account.provider) + '<div><h2>' + esc(account.displayName) + '</h2><p>' + esc(account.provider) + '</p></div></div></div>' +
    '<button data-quota="' + account.id + '">Refresh</button></div>' + quotaCards(state.quotas[account.id]) + '</div>').join('');
  return '<div class="readonly"><span>Read-only</span>Quota Tracker không có enable, disable, delete hoặc mutation khác.</div>' +
    (cards || '<div class="panel empty">No accounts available for quota tracking.</div>');
}

function adminView() {
  const userRows = state.users.map((user) => '<tr><td><div><strong>' + esc(user.username) + '</strong><small class="row-sub">' +
    new Date(user.createdAt).toLocaleString() + '</small></div></td><td>' + esc(user.role) + '</td><td>' + user.accountCount +
    '</td><td>' + statusBadge(user.disabled ? 'disabled' : 'active') + '</td><td class="actions">' +
    '<button data-reset-user="' + user.id + '" data-username="' + esc(user.username) + '">Reset password</button>' +
    '<button data-disable="' + user.id + '" data-value="' + (user.disabled ? '0' : '1') + '">' + (user.disabled ? 'Enable' : 'Disable') + '</button>' +
    (user.id === state.me.id ? '' : '<button class="danger" data-remove-user="' + user.id + '" data-username="' + esc(user.username) + '">Remove</button>') +
    '</td></tr>').join('');
  const auditRows = state.audit.map((entry) => '<tr><td>' + esc(entry.created_at) + '</td><td>' + esc(entry.actor || 'system') +
    '</td><td>' + esc(entry.action) + '</td><td>' + esc(entry.target_type) + ':' + esc(entry.target_id || '-') + '</td></tr>').join('');
  return '<div class="panel"><div class="panel-head"><div><h2>User management</h2><p>Create, reset password, disable, or remove users.</p></div></div>' +
    '<form class="create-user" id="create-user-form"><label>Username<input id="new-user" placeholder="username" autocomplete="off"></label>' +
    '<label>Initial password<input id="new-pass" type="password" placeholder="Minimum 12 characters" autocomplete="new-password"></label>' +
    '<label>Role<select id="new-role"><option value="user">user</option><option value="admin">admin</option></select></label>' +
    '<button class="primary" type="submit">Create user</button></form><div class="table-wrap"><table><thead><tr><th>Username</th><th>Role</th>' +
    '<th>Accounts</th><th>State</th><th></th></tr></thead><tbody>' + userRows + '</tbody></table></div></div>' +
    '<div class="panel"><div class="panel-head"><div><h2>Audit log</h2><p>Credential and token values never logged.</p></div></div>' +
    '<div class="table-wrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead><tbody>' +
    auditRows + '</tbody></table></div></div>';
}

function oauthModal(modal) {
  const providerName = modal.provider === 'claude' ? 'Claude Code' : 'Codex';
  const pasteLabel = modal.provider === 'claude' ? 'authorization code (code#state)' : 'full callback URL';
  const placeholder = modal.provider === 'claude' ? 'Paste code#state here...' : 'http://localhost:1455/auth/callback?code=...&state=...';
  const body = modal.loading
    ? '<div class="waiting-row"><span class="spinner"></span>Preparing secure OAuth session…</div>'
    : '<div class="waiting-row"><span class="spinner"></span>Waiting for browser authorization…</div>' +
      '<div class="step"><div class="step-title"><span class="step-num">1</span>Open OAuth URL in browser</div>' +
      '<p class="step-hint">Popup đã mở giống 9Router. Nếu popup bị chặn, dùng nút Open OAuth.</p>' +
      '<div class="auth-url"><input id="oauth-url" value="' + esc(modal.url) + '" readonly>' +
      '<button id="copy-oauth">Copy</button><button class="primary" id="open-oauth">Open OAuth</button></div></div>' +
      '<div class="divider"><i></i><span>then</span><i></i></div>' +
      '<div class="step"><div class="step-title"><span class="step-num">2</span>Paste ' + pasteLabel + '</div>' +
      '<p class="step-hint">' + (modal.provider === 'claude'
        ? 'Sau khi authorize, Claude hiển thị code. Copy toàn bộ giá trị code#state.'
        : 'Sau redirect localhost, copy toàn bộ URL trên address bar dù trang callback không mở được.') + '</p>' +
      '<textarea id="oauth-callback" class="mono" placeholder="' + esc(placeholder) + '"></textarea></div>' +
      (modal.error ? '<div class="notice error">' + esc(modal.error) + '</div>' : '');
  return modalFrame('Connect ' + providerName, body,
    modal.loading ? '<button id="close-modal">Cancel</button>' :
      '<button id="close-modal">Cancel</button><button class="primary" id="complete-oauth">Connect ' + providerName + '</button>');
}

function resetPasswordModal(modal) {
  return modalFrame('Reset password', '<p>Set password mới cho <strong>' + esc(modal.username) + '</strong>. Session hiện tại của user sẽ bị logout.</p>' +
    '<label>New password<input id="reset-pass" type="password" autocomplete="new-password" placeholder="Minimum 12 characters"></label>' +
    '<label>Confirm password<input id="reset-pass-confirm" type="password" autocomplete="new-password"></label>' +
    (modal.error ? '<div class="notice error">' + esc(modal.error) + '</div>' : ''),
  '<button id="close-modal">Cancel</button><button class="primary" id="confirm-reset">Reset password</button>');
}

function removeUserModal(modal) {
  return modalFrame('Remove user', '<p>Remove <strong>' + esc(modal.username) + '</strong>?</p>' +
    '<div class="notice bad">Provider accounts của user sẽ được xóa khỏi 9Router trước. Không thể undo.</div>' +
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

async function selectTab(tab) {
  state.tab = tab;
  if (tab === 'admin') await loadAdmin();
  render();
}

function render(extra) {
  document.body.classList.toggle('signed-out', !state.me);
  const banner = state.message ? '<div class="notice ' + esc(state.message.kind) + '">' + esc(state.message.text) + '</div>' : '';
  if (!state.me) {
    $('session').innerHTML = '';
    $('nav').innerHTML = '';
    $('page-title').textContent = 'Sign in';
    $('main').innerHTML = banner + loginView();
    $('modal-root').innerHTML = '';
    bind();
    return;
  }
  $('page-title').textContent = ({ providers: 'Providers', quota: 'Quota Tracker', admin: 'Admin' }[state.tab] || 'Portal');
  $('session').innerHTML = '<div class="who"><strong>' + esc(state.me.username) + '</strong><span>' + esc(state.me.role) + '</span></div>' +
    '<button id="btn-password-view">Change password</button><button class="ghost" id="btn-logout">Logout</button>';
  const navItems = [
    ['providers', '◈', 'Providers'],
    ['quota', '◷', 'Quota Tracker'],
    ...(state.me.role === 'admin' ? [['admin', '♙', 'Admin']] : []),
  ];
  $('nav').innerHTML = navItems.map(([tab, icon, label]) => '<button class="nav-item ' + (state.tab === tab ? 'active' : '') +
    '" data-tab="' + tab + '"><span class="ico">' + icon + '</span>' + label + '</button>').join('');
  const content = extra !== undefined ? extra : state.tab === 'quota' ? quotaView() : state.tab === 'admin' ? adminView() : providersView();
  $('main').innerHTML = banner + content;
  $('modal-root').innerHTML = modalView();
  bind();
}

function closeModal() {
  state.modal = null;
  render();
}

function bind() {
  if ($('login-user-form')) $('login-user-form').onsubmit = (event) => { event.preventDefault(); submitLogin(false); };
  if ($('login-admin-form')) $('login-admin-form').onsubmit = (event) => { event.preventDefault(); submitLogin(true); };
  if ($('login-user-tab')) $('login-user-tab').onclick = () => switchLogin(false);
  if ($('login-admin-tab')) $('login-admin-tab').onclick = () => switchLogin(true);
  if ($('btn-logout')) $('btn-logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.reload(); };
  if ($('btn-password-view')) $('btn-password-view').onclick = () => render(passwordView());
  if ($('btn-password')) $('btn-password').onclick = changePassword;
  document.querySelectorAll('[data-tab]').forEach((element) => { element.onclick = () => selectTab(element.dataset.tab); });
  document.querySelectorAll('[data-add], [data-reauth]').forEach((element) => {
    element.onclick = () => startOAuth(element.dataset.add || element.dataset.reauth);
  });
  document.querySelectorAll('[data-toggle]').forEach((element) => { element.onclick = () => act(element, async () => {
    await api('/api/accounts/' + element.dataset.toggle + '/state', { method: 'PATCH', body: JSON.stringify({ enabled: element.dataset.enabled === '1' }) });
    await refresh();
  }); });
  document.querySelectorAll('[data-retry]').forEach((element) => { element.onclick = () => act(element, async () => {
    await api('/api/accounts/' + element.dataset.retry + '/retry', { method: 'POST' }); await refresh();
  }); });
  document.querySelectorAll('[data-remove-account]').forEach((element) => { element.onclick = () => act(element, async () => {
    if (!confirm('Delete account from Portal and 9Router?')) return;
    await api('/api/accounts/' + element.dataset.removeAccount, { method: 'DELETE' }); await refresh();
  }); });
  document.querySelectorAll('[data-quota]').forEach((element) => { element.onclick = () => act(element, async () => {
    state.quotas[element.dataset.quota] = await api('/api/accounts/' + element.dataset.quota + '/quota'); render();
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
  if ($('create-user-form')) $('create-user-form').onsubmit = (event) => { event.preventDefault(); createUser(); };
  if ($('traffic-close')) $('traffic-close').onclick = closeModal;
  if ($('close-modal')) $('close-modal').onclick = closeModal;
  if ($('open-oauth')) $('open-oauth').onclick = () => window.open(state.modal.url, 'portal_oauth', 'width=680,height=760');
  if ($('copy-oauth')) $('copy-oauth').onclick = copyOAuthUrl;
  if ($('complete-oauth')) $('complete-oauth').onclick = completeOAuth;
  if ($('confirm-reset')) $('confirm-reset').onclick = resetUserPassword;
  if ($('confirm-remove-user')) $('confirm-remove-user').onclick = removeUser;
}

function switchLogin(admin) {
  $('login-user-form').hidden = admin;
  $('login-admin-form').hidden = !admin;
  $('login-user-tab').className = admin ? '' : 'primary';
  $('login-admin-tab').className = admin ? 'primary' : '';
  (admin ? $('lap') : $('lu')).focus();
}

async function act(element, action) {
  element.disabled = true;
  try { await action(); } catch (error) { notify(error.message); } finally { element.disabled = false; }
}

async function startOAuth(provider) {
  const popup = window.open('', 'portal_oauth', 'width=680,height=760');
  state.modal = { type: 'oauth', provider, loading: true, error: null };
  render();
  try {
    const result = await api('/api/oauth/' + provider + '/start', { method: 'POST' });
    state.modal = { type: 'oauth', provider, loading: false, url: result.url, redirectUri: result.redirectUri, error: null };
    render();
    if (popup) popup.location.href = result.url;
  } catch (error) {
    if (popup) popup.close();
    state.modal = { type: 'oauth', provider, loading: false, url: '', error: error.message };
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
    state.message = { text: 'OAuth connected. Credential synced to 9Router.', kind: 'ok' };
    await refresh();
  } catch (error) {
    state.modal.error = error.message;
    render();
  }
}

async function submitLogin(admin) {
  try {
    const path = admin ? '/api/login/admin' : '/api/login';
    const body = admin ? { password: $('lap').value } : { username: $('lu').value, password: $('lp').value };
    state.me = await api(path, { method: 'POST', body: JSON.stringify(body) });
    state.tab = state.me.role === 'admin' ? 'admin' : 'providers';
    await refresh();
  } catch (error) { notify(error.message); }
}

async function changePassword() {
  try {
    await api('/api/password', { method: 'POST', body: JSON.stringify({ currentPassword: $('cp').value, newPassword: $('np').value }) });
    state.me = await api('/api/me');
    state.message = { text: 'Password updated.', kind: 'ok' };
    await refresh();
  } catch (error) { notify(error.message); }
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
  try {
    state.me = await api('/api/me');
    state.tab = state.me.role === 'admin' ? 'admin' : 'providers';
    await refresh();
  } catch {
    render();
  }
})();
`;
