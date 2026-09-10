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
  // as NODE_ENV: the zbs3 deployment runs NODE_ENV=production but is served as
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
    initialAdminUsername: process.env.INIT_ADMIN_USERNAME || 'admin',
    initialAdminPassword: process.env.INIT_ADMIN_PASSWORD || '',
    claude: {
      authorizeUrl: process.env.CLAUDE_AUTHORIZE_URL || '',
      tokenUrl: process.env.CLAUDE_TOKEN_URL || '',
      clientId: process.env.CLAUDE_CLIENT_ID || '',
      scopes: process.env.CLAUDE_SCOPES || '',
      redirectUri: process.env.CLAUDE_REDIRECT_URI || '',
      identityUrl: process.env.CLAUDE_IDENTITY_URL || '',
    },
    codex: {
      authorizeUrl: process.env.CODEX_AUTHORIZE_URL || '',
      tokenUrl: process.env.CODEX_TOKEN_URL || '',
      clientId: process.env.CODEX_CLIENT_ID || '',
      scopes: process.env.CODEX_SCOPES || '',
      redirectUri: process.env.CODEX_REDIRECT_URI || '',
      identityUrl: process.env.CODEX_IDENTITY_URL || '',
    },
    routers: {
      // Endpoints are not configurable: each router's import contract is
      // specific enough (path, body shape, auth header) that a swappable path
      // would only ever produce a confusing runtime failure. They live in
      // src/adapters/router-adapter.js next to the code that builds the bodies.
      ninerouter: {
        name: '9router',
        // Derived CLI token from the router's data volume, sent as x-9r-cli-token.
        baseUrl: process.env.NINEROUTER_URL || '',
        privilegedToken: process.env.NINEROUTER_PRIVILEGED_TOKEN || '',
      },
      omniroute: {
        name: 'OmniRoute',
        // API key carrying the `manage` scope, sent as a bearer token.
        baseUrl: process.env.OMNIROUTE_URL || '',
        privilegedToken: process.env.OMNIROUTE_PRIVILEGED_TOKEN || '',
      },
    },
    ...overrides,
  };
}
