import test from 'node:test';
import assert from 'node:assert/strict';
import { NineRouterAdapter, OmniRouteAdapter } from '../src/adapters/router-adapter.js';
import { jwt } from './helpers/test-app.js';

const SETTINGS = { baseUrl: 'http://router.test', privilegedToken: 'privileged-token' };

/** Records every outbound call and replays a scripted response. */
function recordingFetch(responder) {
  const calls = [];
  const impl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method, headers: init.headers, body });
    const scripted = responder(url, init) ?? {};
    return {
      ok: scripted.status === undefined || scripted.status < 400,
      status: scripted.status ?? 200,
      text: async () => JSON.stringify(scripted.body ?? {}),
    };
  };
  impl.calls = calls;
  return impl;
}

const codexTokens = {
  accessToken: 'codex-access',
  refreshToken: 'codex-refresh',
  idToken: jwt({ sub: 'codex-sub', email: 'sponsor@example.com' }),
  expiresAt: '2026-01-01T00:00:00.000Z',
  scope: 'openid profile',
};

const claudeTokens = {
  accessToken: 'claude-access',
  refreshToken: 'claude-refresh',
  idToken: jwt({ sub: 'claude-sub', email: 'sponsor@example.com' }),
  expiresAt: '2026-01-01T00:00:00.000Z',
  scope: 'user:profile user:inference',
};

const account = (overrides = {}) => ({
  id: 7, provider: 'codex', display_name: 's***@example.com', desired_enabled: 1, ...overrides,
});

test('9router codex injection posts a bulk-import entry and returns the remote id', async () => {
  const fetchImpl = recordingFetch(() => ({ body: { success: 1, failed: 0, results: [{ index: 0, ok: true, id: 'conn-9' }] } }));
  const adapter = new NineRouterAdapter('ninerouter', SETTINGS, fetchImpl);

  const remoteId = await adapter.inject(account(), codexTokens);

  assert.equal(remoteId, 'conn-9');
  const [call] = fetchImpl.calls;
  assert.equal(call.url, 'http://router.test/api/oauth/codex/bulk-import');
  // Auth is the derived CLI token header, not a bearer credential.
  assert.equal(call.headers['x-9r-cli-token'], 'privileged-token');
  assert.equal(call.headers.authorization, undefined);
  assert.equal(call.body[0].accessToken, 'codex-access');
  assert.equal(call.body[0].refreshToken, 'codex-refresh');
  // Email is recovered from the id_token, never from the masked display name.
  assert.equal(call.body[0].email, 'sponsor@example.com');
});

test('9router surfaces a per-entry bulk-import rejection as an error', async () => {
  const fetchImpl = recordingFetch(() => ({ body: { success: 0, failed: 1, results: [{ index: 0, ok: false, error: 'duplicate account' }] } }));
  const adapter = new NineRouterAdapter('ninerouter', SETTINGS, fetchImpl);

  // HTTP 200 with a failed entry must not be mistaken for a successful inject.
  await assert.rejects(() => adapter.inject(account(), codexTokens), /duplicate account/);
});

test('9router refuses Claude injection because no import route exists there', async () => {
  const fetchImpl = recordingFetch(() => ({}));
  const adapter = new NineRouterAdapter('ninerouter', SETTINGS, fetchImpl);

  await assert.rejects(
    () => adapter.inject(account({ provider: 'claude' }), claudeTokens),
    (error) => error.code === 'injection_unsupported',
  );
  assert.equal(fetchImpl.calls.length, 0, 'must not call an endpoint that does not exist');
});

test('OmniRoute claude injection sends the credential-file shape with epoch expiry', async () => {
  const fetchImpl = recordingFetch(() => ({ body: { connection: { id: 'conn-omni' }, created: true } }));
  const adapter = new OmniRouteAdapter('omniroute', SETTINGS, fetchImpl);

  const remoteId = await adapter.inject(account({ provider: 'claude' }), claudeTokens);

  assert.equal(remoteId, 'conn-omni');
  const [call] = fetchImpl.calls;
  assert.equal(call.url, 'http://router.test/api/providers/claude-auth/import');
  assert.equal(call.headers.authorization, 'Bearer privileged-token');
  const oauth = call.body.source.json.claudeAiOauth;
  assert.equal(oauth.accessToken, 'claude-access');
  assert.equal(oauth.refreshToken, 'claude-refresh');
  // The credential file stores ms-since-epoch, not an ISO string.
  assert.equal(oauth.expiresAt, Date.parse('2026-01-01T00:00:00.000Z'));
  assert.deepEqual(oauth.scopes, ['user:profile', 'user:inference']);
  // Re-auth must replace the stored credential rather than 409.
  assert.equal(call.body.overwriteExisting, true);
});

test('OmniRoute codex injection uses the auth.json shape and never the refresh-on-import route', async () => {
  const fetchImpl = recordingFetch(() => ({ body: { connection: { id: 'conn-omni' } } }));
  const adapter = new OmniRouteAdapter('omniroute', SETTINGS, fetchImpl);

  await adapter.inject(account(), codexTokens);

  const [call] = fetchImpl.calls;
  assert.equal(call.url, 'http://router.test/api/providers/codex-auth/import');
  // /api/oauth/codex/import validates by refreshing, which would burn the
  // single-use refresh token the portal just obtained.
  assert.ok(!call.url.includes('/api/oauth/codex/import'));
  assert.equal(call.body.source.json.auth_mode, 'chatgpt');
  assert.equal(call.body.source.json.tokens.id_token, codexTokens.idToken);
  assert.equal(call.body.source.json.tokens.refresh_token, 'codex-refresh');
});

test('OmniRoute rejects a codex token set with no id token', async () => {
  const fetchImpl = recordingFetch(() => ({}));
  const adapter = new OmniRouteAdapter('omniroute', SETTINGS, fetchImpl);

  // Without the id_token OmniRoute cannot derive account_id and would reject it.
  await assert.rejects(
    () => adapter.inject(account(), { ...codexTokens, idToken: null }),
    (error) => error.code === 'missing_id_token',
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('OmniRoute disables a connection imported while the sponsor intent was off', async () => {
  const fetchImpl = recordingFetch(() => ({ body: { connection: { id: 'conn-omni' } } }));
  const adapter = new OmniRouteAdapter('omniroute', SETTINGS, fetchImpl);

  await adapter.inject(account({ desired_enabled: 0 }), codexTokens);

  // Import always lands active, so the intent has to be applied afterwards.
  assert.equal(fetchImpl.calls.length, 2);
  const [, update] = fetchImpl.calls;
  assert.equal(update.method, 'PUT');
  assert.equal(update.url, 'http://router.test/api/providers/conn-omni');
  assert.equal(update.body.isActive, false);
});

test('setEnabled always sends a real boolean, never a truthy stand-in', async () => {
  const fetchImpl = recordingFetch(() => ({}));
  const adapter = new NineRouterAdapter('ninerouter', SETTINGS, fetchImpl);

  // 9router persists with a strict `=== false`; 0 or "false" would silently
  // stay ACTIVE while still returning HTTP 200.
  await adapter.setEnabled('conn-9', 0);

  assert.equal(fetchImpl.calls[0].body.isActive, false);
  assert.equal(typeof fetchImpl.calls[0].body.isActive, 'boolean');
});

test('remove treats 404 as already deleted but propagates other failures', async () => {
  const gone = recordingFetch(() => ({ status: 404 }));
  await new OmniRouteAdapter('omniroute', SETTINGS, gone).remove('conn-x');

  const broken = recordingFetch(() => ({ status: 500 }));
  // Deletion stays fail-closed: a server error must not look like success.
  await assert.rejects(() => new OmniRouteAdapter('omniroute', SETTINGS, broken).remove('conn-x'));
});

test('an unconfigured router fails before any network call', async () => {
  const fetchImpl = recordingFetch(() => ({}));
  const adapter = new NineRouterAdapter('ninerouter', { baseUrl: '', privilegedToken: '' }, fetchImpl);

  await assert.rejects(
    () => adapter.inject(account(), codexTokens),
    (error) => error.code === 'router_not_configured',
  );
  assert.equal(fetchImpl.calls.length, 0);
});
