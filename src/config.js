import { randomBytes } from 'node:crypto';

function integer(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function requiredInProduction(name, fallback) {
  const value = process.env[name] || fallback;
  if (process.env.NODE_ENV === 'production' && !process.env[name]) {
    throw new Error(`${name} is required in production`);
  }
  return value;
}

export function loadConfig(overrides = {}) {
  const production = process.env.NODE_ENV === 'production';
  // Whether browsers reach the portal over TLS. This is NOT the same question
  // as NODE_ENV: the zbs0 deployment runs NODE_ENV=production but is served as
  // plain HTTP on a Tailscale address. Conflating the two broke the UI outright
  // — `secure` cookies were dropped by the browser so no session could be
  // stored, and helmet's `upgrade-insecure-requests` rewrote /app.js and
  // /styles.css to https:// where nothing listens, leaving a blank page.
  // Defaults to on in production so a TLS deployment stays hardened by
  // omission; a plain-HTTP deployment must opt out loudly.
  const tls = production && process.env.INSECURE_HTTP !== 'true';
  return {
    host: process.env.HOST || '127.0.0.1',
    port: integer('PORT', 3020),
    trustProxy: process.env.TRUST_PROXY === 'true',
    dbPath: process.env.DATABASE_PATH || './data/llm-portal.sqlite',
    cookieSecret: requiredInProduction('COOKIE_SECRET', randomBytes(32).toString('hex')),
    encryptionKey: requiredInProduction('CREDENTIAL_ENCRYPTION_KEY', randomBytes(32).toString('base64')),
    tls,
    secureCookies: tls,
    sessionHours: integer('SESSION_HOURS', 24),
    oauthStateMinutes: integer('OAUTH_STATE_MINUTES', 10),
    // Database-backed admin settings override this startup default. Eight hours
    // provides several retry windows before expiry while the scheduler still
    // checks every five minutes.
    refreshLeadMinutes: integer('REFRESH_LEAD_MINUTES', 480),
    refreshIntervalMinutes: integer('REFRESH_INTERVAL_MINUTES', 5),
    initialAdminUsername: process.env.INIT_ADMIN_USERNAME || 'admin',
    initialAdminPassword: process.env.INIT_ADMIN_PASSWORD || '',
    claude: {
      authorizeUrl: process.env.CLAUDE_AUTHORIZE_URL || 'https://claude.ai/oauth/authorize',
      tokenUrl: process.env.CLAUDE_TOKEN_URL || 'https://api.anthropic.com/v1/oauth/token',
      // Public first-party CLI client ids. They are not secrets: the flow is
      // PKCE, and these are the same values the vendor CLIs ship with.
      clientId: process.env.CLAUDE_CLIENT_ID || '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      scopes: process.env.CLAUDE_SCOPES || 'org:create_api_key user:profile user:inference',
      // Claude's manual flow renders the code in the browser instead of
      // redirecting to a listener, which is what lets the portal run without
      // owning a callback port on this host.
      redirectUri: process.env.CLAUDE_REDIRECT_URI || 'https://console.anthropic.com/oauth/code/callback',
      extraAuthorizeParams: { code: 'true' },
      identityUrl: process.env.CLAUDE_IDENTITY_URL || '',
    },
    codex: {
      authorizeUrl: process.env.CODEX_AUTHORIZE_URL || 'https://auth.openai.com/oauth/authorize',
      tokenUrl: process.env.CODEX_TOKEN_URL || 'https://auth.openai.com/oauth/token',
      clientId: process.env.CODEX_CLIENT_ID || 'app_EMoamEEZ73f0CkXaXp7hrann',
      scopes: process.env.CODEX_SCOPES || 'openid profile email offline_access',
      // Codex pins its callback to localhost:1455, which llm-gateway-9router
      // already binds on this host. The portal therefore never listens for the
      // redirect: the operator pastes the resulting URL back into the UI.
      redirectUri: process.env.CODEX_REDIRECT_URI || 'http://localhost:1455/auth/callback',
      extraAuthorizeParams: {
        id_token_add_organizations: 'true',
        codex_cli_simplified_flow: 'true',
        originator: 'codex_cli_rs',
      },
      identityUrl: process.env.CODEX_IDENTITY_URL || '',
    },
    routers: {
      // Endpoints are not configurable: the internal sync contract (path, body
      // shape, auth header) is specific enough that a swappable path would only
      // ever produce a confusing runtime failure. It lives in
      // src/adapters/router-adapter.js next to the code that builds the bodies.
      ninerouter: {
        name: '9router',
        // Shared service token for POST/PUT /api/internal/portal/**, sent as a
        // bearer credential and reachable only on the Docker network.
        baseUrl: process.env.NINEROUTER_URL || '',
        syncToken: process.env.NINEROUTER_SYNC_TOKEN || '',
      },
      omniroute: {
        name: 'omniroute',
        baseUrl: process.env.OMNIROUTE_URL || '',
        syncToken: process.env.OMNIROUTE_SYNC_TOKEN || '',
      },
    },
    ...overrides,
  };
}
