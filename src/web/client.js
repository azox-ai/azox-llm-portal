export const appScript = String.raw`
const state = { me: null, accounts: [], routers: {}, tab: 'accounts', message: null };
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
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
  if (kind === 'ok') setTimeout(() => { state.message = null; render(); }, 4000);
}

async function refresh() {
  const [accounts, routers] = await Promise.all([api('/api/accounts'), api('/api/router-status')]);
  state.accounts = accounts;
  state.routers = routers;
  render();
}

function loginView() {
  return '<div class="card"><h2>Đăng nhập</h2>' +
    '<label><span>Username</span><input id="lu" autocomplete="username"></label>' +
    '<label><span>Password</span><input id="lp" type="password" autocomplete="current-password"></label>' +
    '<div class="row"><button class="primary" id="btn-login">Đăng nhập</button>' +
    '<button id="btn-register">Tạo tài khoản mới</button></div>' +
    '<p class="dim">Internal service. Tài khoản mới có quyền contributor.</p></div>';
}

function passwordView() {
  return '<div class="card"><h2>Bắt buộc đổi mật khẩu</h2>' +
    '<label><span>Mật khẩu hiện tại</span><input id="cp" type="password"></label>' +
    '<label><span>Mật khẩu mới (tối thiểu 12 ký tự)</span><input id="np" type="password"></label>' +
    '<button class="primary" id="btn-password">Cập nhật</button></div>';
}

function routerCell(account, key) {
  const info = account.routers[key];
  if (!info) return '<span class="badge pending">pending</span>';
  const title = info.error ? ' title="' + esc(info.error) + '"' : '';
  return '<span class="badge ' + esc(info.status) + '"' + title + '>' + esc(info.status) + '</span>';
}

function accountsView() {
  const unconfigured = Object.entries(state.routers)
    .filter(([, v]) => !v.configured).map(([k]) => k);
  const warning = unconfigured.length
    ? '<div class="msg error">Router chưa cấu hình: ' + esc(unconfigured.join(', ')) +
      '. Account sẽ ở trạng thái failed cho tới khi có endpoint và privileged token.</div>'
    : '';

  const rows = state.accounts.map((a) => {
    const isAdminView = state.me.role === 'admin';
    return '<tr>' +
      '<td>' + esc(a.displayName) + (isAdminView ? ' <span class="dim">(' + esc(a.owner) + ')</span>' : '') + '</td>' +
      '<td>' + esc(a.provider) + '</td>' +
      '<td><span class="badge ' + esc(a.status) + '">' + esc(a.status) + '</span></td>' +
      '<td>' + routerCell(a, 'ninerouter') + '</td>' +
      '<td>' + routerCell(a, 'omniroute') + '</td>' +
      '<td class="row">' +
        '<button data-toggle="' + a.id + '" data-enabled="' + (a.enabled ? '0' : '1') + '">' +
          (a.enabled ? 'Off' : 'On') + '</button>' +
        '<button data-retry="' + a.id + '">Retry</button>' +
        '<button data-reauth="' + esc(a.provider) + '">Re-auth</button>' +
        '<button class="danger" data-remove="' + a.id + '">Remove</button>' +
      '</td></tr>';
  }).join('');

  return warning + '<div class="card"><h2>Sponsored accounts</h2>' +
    '<div class="row" style="margin-bottom:14px">' +
      '<button class="primary" data-add="claude">+ Add Claude account</button>' +
      '<button class="primary" data-add="codex">+ Add Codex account</button></div>' +
    (state.accounts.length
      ? '<table><thead><tr><th>Account</th><th>Provider</th><th>Status</th>' +
        '<th>9router</th><th>OmniRoute</th><th>Actions</th></tr></thead><tbody>' + rows + '</tbody></table>'
      : '<p class="dim">Chưa có account nào. Nhấn +Add để OAuth.</p>') +
    '<p class="dim">Portal không hiển thị quota, limit hay usage của bất kỳ account nào.</p></div>';
}

async function adminView() {
  const [users, auditLog] = await Promise.all([api('/api/admin/users'), api('/api/admin/audit?limit=50')]);
  const userRows = users.map((u) => '<tr><td>' + esc(u.username) + '</td><td>' + esc(u.role) + '</td>' +
    '<td>' + u.accountCount + '</td>' +
    '<td>' + (u.disabled ? '<span class="badge failed">disabled</span>' : '<span class="badge active">active</span>') + '</td>' +
    '<td class="row"><button data-reset="' + u.id + '">Reset password</button>' +
    '<button data-disable="' + u.id + '" data-value="' + (u.disabled ? '0' : '1') + '">' +
      (u.disabled ? 'Enable' : 'Disable') + '</button></td></tr>').join('');
  const auditRows = auditLog.map((l) => '<tr><td class="dim">' + esc(l.created_at) + '</td>' +
    '<td>' + esc(l.actor || '-') + '</td><td>' + esc(l.action) + '</td>' +
    '<td class="dim">' + esc(l.target_type) + ':' + esc(l.target_id || '-') + '</td></tr>').join('');
  return '<div class="card"><h2>Users</h2><table><thead><tr><th>Username</th><th>Role</th>' +
    '<th>Accounts</th><th>State</th><th>Actions</th></tr></thead><tbody>' + userRows + '</tbody></table></div>' +
    '<div class="card"><h2>Audit log</h2><table><thead><tr><th>Time</th><th>Actor</th>' +
    '<th>Action</th><th>Target</th></tr></thead><tbody>' + auditRows + '</tbody></table></div>';
}

function render(extra) {
  const session = $('session');
  const main = $('main');
  const banner = state.message
    ? '<div class="msg ' + esc(state.message.kind) + '">' + esc(state.message.text) + '</div>' : '';

  if (!state.me) {
    session.innerHTML = '';
    main.innerHTML = banner + loginView();
    $('btn-login').onclick = () => submitAuth('/api/login');
    $('btn-register').onclick = () => submitAuth('/api/register');
    return;
  }
  session.innerHTML = '<div class="row"><span class="dim">' + esc(state.me.username) +
    ' · ' + esc(state.me.role) + '</span><button id="btn-logout">Đăng xuất</button></div>';
  $('btn-logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); state.me = null; render(); };

  if (state.me.mustChangePassword) {
    main.innerHTML = banner + passwordView();
    $('btn-password').onclick = changePassword;
    return;
  }
  const tabs = state.me.role === 'admin'
    ? '<div class="tabs"><button data-tab="accounts">Accounts</button><button data-tab="admin">Admin</button></div>'
    : '';
  main.innerHTML = banner + tabs + (extra !== undefined ? extra : accountsView());
  bind();
}

function bind() {
  document.querySelectorAll('[data-tab]').forEach((el) => {
    el.onclick = async () => {
      state.tab = el.dataset.tab;
      render(state.tab === 'admin' ? await adminView() : undefined);
    };
  });
  document.querySelectorAll('[data-add], [data-reauth]').forEach((el) => {
    el.onclick = () => startOAuth(el.dataset.add || el.dataset.reauth);
  });
  document.querySelectorAll('[data-toggle]').forEach((el) => {
    el.onclick = () => guard(el, async () => {
      await api('/api/accounts/' + el.dataset.toggle + '/state',
        { method: 'PATCH', body: JSON.stringify({ enabled: el.dataset.enabled === '1' }) });
      await refresh();
    });
  });
  document.querySelectorAll('[data-retry]').forEach((el) => {
    el.onclick = () => guard(el, async () => {
      await api('/api/accounts/' + el.dataset.retry + '/retry', { method: 'POST' });
      await refresh();
    });
  });
  document.querySelectorAll('[data-remove]').forEach((el) => {
    el.onclick = () => guard(el, async () => {
      if (!confirm('Gỡ account khỏi cả 9router và OmniRoute?')) return;
      await api('/api/accounts/' + el.dataset.remove, { method: 'DELETE' });
      notify('Đã gỡ account', 'ok');
      await refresh();
    });
  });
  document.querySelectorAll('[data-reset]').forEach((el) => {
    el.onclick = () => guard(el, async () => {
      const result = await api('/api/admin/users/' + el.dataset.reset + '/reset-password', { method: 'POST' });
      notify('Mật khẩu tạm cho ' + result.username + ': ' + result.temporaryPassword, 'ok');
    });
  });
  document.querySelectorAll('[data-disable]').forEach((el) => {
    el.onclick = () => guard(el, async () => {
      await api('/api/admin/users/' + el.dataset.disable,
        { method: 'PATCH', body: JSON.stringify({ disabled: el.dataset.value === '1' }) });
      render(await adminView());
    });
  });
}

async function guard(el, action) {
  el.disabled = true;
  try { await action(); } catch (error) { notify(error.message); } finally { el.disabled = false; }
}

async function startOAuth(provider) {
  try {
    const result = await api('/api/oauth/' + provider + '/start', { method: 'POST' });
    window.location.href = result.url;
  } catch (error) { notify(error.message); }
}

async function submitAuth(path) {
  try {
    state.me = await api(path, {
      method: 'POST',
      body: JSON.stringify({ username: $('lu').value, password: $('lp').value }),
    });
    state.message = null;
    if (!state.me.mustChangePassword) await refresh(); else render();
  } catch (error) { notify(error.message); }
}

async function changePassword() {
  try {
    await api('/api/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: $('cp').value, newPassword: $('np').value }),
    });
    state.me = await api('/api/me');
    notify('Đã đổi mật khẩu', 'ok');
    await refresh();
  } catch (error) { notify(error.message); }
}

(async function init() {
  const params = new URLSearchParams(window.location.search);
  const oauth = params.get('oauth');
  if (oauth) {
    window.history.replaceState({}, '', '/');
    state.message = oauth === 'success'
      ? { text: 'OAuth thành công, đang đồng bộ sang 9router và OmniRoute', kind: 'ok' }
      : { text: 'OAuth thất bại hoặc bị từ chối', kind: 'error' };
  }
  try {
    state.me = await api('/api/me');
    if (!state.me.mustChangePassword) await refresh(); else render();
  } catch { render(); }
})();
`;
