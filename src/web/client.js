export const appScript = String.raw`
const state = { me: null, accounts: [], routers: {}, tab: 'providers', message: null, quotas: {} };
const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

async function api(path, options = {}) {
  // Only declare a JSON body when one is actually sent: Fastify rejects a
  // bodyless POST that claims content-type application/json with 400, which
  // silently broke every action button that takes no payload.
  const headers = { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) };
  if (state.me?.csrfToken) headers['x-csrf-token'] = state.me.csrfToken;
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(body.error || ('HTTP ' + response.status));
  return body;
}

function notify(text, kind = 'error') {
  state.message = { text, kind };
  render();
  if (kind === 'ok') setTimeout(() => { state.message = null; render(); }, 3500);
}

async function refresh() {
  [state.accounts, state.routers] = await Promise.all([api('/api/accounts'), api('/api/router-status')]);
  render();
}

function loginView() {
  return '<section class="auth-shell"><div class="auth-card"><div class="eyebrow">AZOX AI</div>' +
    '<h2>LLM Portal</h2><p>Đăng nhập bằng tài khoản do admin cấp.</p>' +
    '<label>Username<input id="lu" autocomplete="username" autofocus></label>' +
    '<label>Password<input id="lp" type="password" autocomplete="current-password"></label>' +
    '<button class="primary wide" id="btn-login">Đăng nhập</button></div></section>';
}

function passwordView() {
  return '<div class="panel compact"><div class="panel-head"><div><h2>Đổi password</h2>' +
    '<p>Tài khoản không bắt buộc đổi password lần đầu.</p></div></div>' +
    '<label>Password hiện tại<input id="cp" type="password"></label>' +
    '<label>Password mới (tối thiểu 12 ký tự)<input id="np" type="password"></label>' +
    '<button class="primary" id="btn-password">Cập nhật</button></div>';
}

function statusBadge(value) {
  return '<span class="badge ' + esc(value) + '"><i></i>' + esc(value) + '</span>';
}

function providerIcon(provider) {
  return '<span class="provider-icon ' + provider + '">' + (provider === 'claude' ? 'A' : '⌘') + '</span>';
}

function providersView() {
  const rows = state.accounts.map((account) => '<tr><td><div class="account-name">' +
    providerIcon(account.provider) + '<div><strong>' + esc(account.displayName) + '</strong><small>' +
    esc(account.owner) + '</small></div></div></td><td>' + esc(account.provider === 'claude' ? 'Claude' : 'Codex') +
    '</td><td>' + statusBadge(account.status) + '</td><td>' +
    statusBadge(account.routers.ninerouter?.status || 'pending') + '</td><td>' +
    (account.accessExpiresAt ? new Date(account.accessExpiresAt).toLocaleString() : '—') + '</td><td class="actions">' +
    '<button data-toggle="' + account.id + '" data-enabled="' + (account.enabled ? '0' : '1') + '">' +
    (account.enabled ? 'Disable' : 'Enable') + '</button><button data-retry="' + account.id + '">Sync</button>' +
    '<button data-reauth="' + esc(account.provider) + '">Re-auth</button>' +
    '<button class="danger" data-remove="' + account.id + '">Delete</button></td></tr>').join('');
  const configured = state.routers.ninerouter?.configured;
  return (!configured ? '<div class="notice bad">9Router sync chưa được cấu hình.</div>' : '') +
    '<div class="panel"><div class="panel-head"><div><h2>Providers</h2><p>Credential canonical nằm tại Portal; 9Router chỉ nhận access token.</p></div>' +
    '<div class="toolbar"><button class="primary" data-add="claude">+ Claude</button>' +
    '<button class="primary" data-add="codex">+ Codex</button></div></div>' +
    (rows ? '<div class="table-wrap"><table><thead><tr><th>Account</th><th>Provider</th><th>State</th>' +
      '<th>9Router</th><th>Access token expires</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' :
      '<div class="empty">Chưa có provider account. Chọn Claude hoặc Codex để OAuth.</div>') + '</div>';
}

function quotaCards(quota) {
  if (!quota) return '<div class="quota-placeholder">Chọn Refresh để đọc quota.</div>';
  const entries = Object.entries(quota.quotas || {});
  if (!entries.length) return '<div class="quota-placeholder">Upstream chưa trả về quota window.</div>';
  return '<div class="quota-grid">' + entries.map(([name, value]) => '<div class="quota-card"><div class="quota-title">' +
    esc(name) + '</div><div class="quota-value">' + Math.round(value.remaining) + '%</div><div class="progress"><span style="width:' +
    Math.max(0, Math.min(100, value.remaining)) + '%"></span></div><small>Reset: ' +
    (value.resetAt ? new Date(value.resetAt).toLocaleString() : '—') + '</small></div>').join('') + '</div>';
}

function quotaView() {
  const cards = state.accounts.map((account) => '<div class="panel"><div class="panel-head"><div><div class="account-name">' +
    providerIcon(account.provider) + '<div><h2>' + esc(account.displayName) + '</h2><p>' + esc(account.provider) + '</p></div></div></div>' +
    '<button data-quota="' + account.id + '">Refresh</button></div>' + quotaCards(state.quotas[account.id]) + '</div>').join('');
  return '<div class="readonly"><span>Read-only</span>Quota Tracker không có thao tác enable, disable hoặc delete.</div>' +
    (cards || '<div class="panel empty">Chưa có account để theo dõi quota.</div>');
}

async function adminView() {
  const [users, audit] = await Promise.all([api('/api/admin/users'), api('/api/admin/audit?limit=40')]);
  const userRows = users.map((user) => '<tr><td><strong>' + esc(user.username) + '</strong></td><td>' + esc(user.role) +
    '</td><td>' + user.accountCount + '</td><td>' + statusBadge(user.disabled ? 'disabled' : 'active') + '</td><td class="actions">' +
    '<button data-reset="' + user.id + '">Reset password</button><button data-disable="' + user.id + '" data-value="' +
    (user.disabled ? '0' : '1') + '">' + (user.disabled ? 'Enable' : 'Disable') + '</button></td></tr>').join('');
  const auditRows = audit.map((entry) => '<tr><td>' + esc(entry.created_at) + '</td><td>' + esc(entry.actor || 'system') +
    '</td><td>' + esc(entry.action) + '</td><td>' + esc(entry.target_type) + ':' + esc(entry.target_id || '-') + '</td></tr>').join('');
  return '<div class="panel"><div class="panel-head"><div><h2>User Management</h2><p>Chỉ admin tạo user mới.</p></div></div>' +
    '<div class="create-user"><input id="new-user" placeholder="username"><input id="new-pass" type="password" placeholder="password (12+ chars)">' +
    '<select id="new-role"><option value="user">user</option><option value="admin">admin</option></select>' +
    '<button class="primary" id="btn-create-user">Create user</button></div><div class="table-wrap"><table><thead><tr><th>Username</th><th>Role</th>' +
    '<th>Accounts</th><th>State</th><th></th></tr></thead><tbody>' + userRows + '</tbody></table></div></div>' +
    '<div class="panel"><div class="panel-head"><div><h2>Audit Log</h2><p>Không ghi credential hoặc token.</p></div></div>' +
    '<div class="table-wrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead><tbody>' +
    auditRows + '</tbody></table></div></div>';
}

async function selectTab(tab) {
  state.tab = tab;
  render(tab === 'admin' ? await adminView() : undefined);
}

function render(extra) {
  const banner = state.message ? '<div class="notice ' + esc(state.message.kind) + '">' + esc(state.message.text) + '</div>' : '';
  if (!state.me) {
    $('session').innerHTML = '';
    $('nav').innerHTML = '';
    $('main').innerHTML = banner + loginView();
    $('btn-login').onclick = submitLogin;
    return;
  }
  $('session').innerHTML = '<button id="btn-password-view">Change password</button><span>' + esc(state.me.username) +
    '</span><button id="btn-logout">Logout</button>';
  $('nav').innerHTML = ['providers', 'quota'].concat(state.me.role === 'admin' ? ['admin'] : []).map((tab) =>
    '<button class="nav-item ' + (state.tab === tab ? 'active' : '') + '" data-tab="' + tab + '">' +
    ({ providers: 'Providers', quota: 'Quota Tracker', admin: 'Admin' }[tab]) + '</button>').join('');
  $('main').innerHTML = banner + (extra !== undefined ? extra : state.tab === 'quota' ? quotaView() : state.tab === 'providers' ? providersView() : '');
  bind();
}

function bind() {
  $('btn-logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.reload(); };
  $('btn-password-view').onclick = () => { $('main').innerHTML = passwordView(); $('btn-password').onclick = changePassword; };
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
  document.querySelectorAll('[data-remove]').forEach((element) => { element.onclick = () => act(element, async () => {
    if (!confirm('Delete account khỏi Portal và 9Router?')) return;
    await api('/api/accounts/' + element.dataset.remove, { method: 'DELETE' }); await refresh();
  }); });
  document.querySelectorAll('[data-quota]').forEach((element) => { element.onclick = () => act(element, async () => {
    state.quotas[element.dataset.quota] = await api('/api/accounts/' + element.dataset.quota + '/quota'); render();
  }); });
  document.querySelectorAll('[data-reset]').forEach((element) => { element.onclick = () => act(element, async () => {
    const result = await api('/api/admin/users/' + element.dataset.reset + '/reset-password', { method: 'POST' });
    notify('Temporary password for ' + result.username + ': ' + result.temporaryPassword, 'ok');
  }); });
  document.querySelectorAll('[data-disable]').forEach((element) => { element.onclick = () => act(element, async () => {
    await api('/api/admin/users/' + element.dataset.disable, { method: 'PATCH', body: JSON.stringify({ disabled: element.dataset.value === '1' }) });
    render(await adminView());
  }); });
  if ($('btn-create-user')) $('btn-create-user').onclick = createUser;
}

async function act(element, action) {
  element.disabled = true;
  try { await action(); } catch (error) { notify(error.message); } finally { element.disabled = false; }
}

async function startOAuth(provider) {
  try {
    const result = await api('/api/oauth/' + provider + '/start', { method: 'POST' });
    window.open(result.url, '_blank', 'noopener,noreferrer');
    const callback = window.prompt(
      provider === 'claude'
        ? 'OAuth xong, paste authorization code (code#state) vào đây:'
        : 'OAuth xong, paste toàn bộ callback URL từ address bar vào đây:'
    );
    if (!callback) return;
    await api('/api/oauth/' + provider + '/complete', {
      method: 'POST', body: JSON.stringify({ callback }),
    });
    notify('OAuth thành công; credential đã sync sang 9Router.', 'ok');
    await refresh();
  } catch (error) { notify(error.message); }
}

async function submitLogin() {
  try {
    state.me = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: $('lu').value, password: $('lp').value }) });
    await refresh();
  } catch (error) { notify(error.message); }
}

async function changePassword() {
  try {
    await api('/api/password', { method: 'POST', body: JSON.stringify({ currentPassword: $('cp').value, newPassword: $('np').value }) });
    state.me = await api('/api/me'); notify('Password updated', 'ok'); await refresh();
  } catch (error) { notify(error.message); }
}

async function createUser() {
  try {
    await api('/api/admin/users', { method: 'POST', body: JSON.stringify({ username: $('new-user').value, password: $('new-pass').value, role: $('new-role').value }) });
    notify('User created', 'ok'); render(await adminView());
  } catch (error) { notify(error.message); }
}

(async function init() {
  const oauth = new URLSearchParams(location.search).get('oauth');
  if (oauth) {
    history.replaceState({}, '', '/');
    state.message = oauth === 'success' ? { text: 'OAuth thành công; credential đã sync sang 9Router.', kind: 'ok' } : { text: 'OAuth thất bại.', kind: 'error' };
  }
  try { state.me = await api('/api/me'); await refresh(); } catch { render(); }
})();
`;
