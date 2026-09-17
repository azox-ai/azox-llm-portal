import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import formbody from '@fastify/formbody';
import { openDatabase } from './db/index.js';
import { loadConfig } from './config.js';
import { getSession } from './services/auth.js';
import { buildAdapters } from './adapters/router-adapter.js';
import authRoutes from './routes/auth.js';
import accountRoutes from './routes/accounts.js';
import adminRoutes from './routes/admin.js';
import { renderApp } from './web/page.js';
import {
  assets, IMMUTABLE_CACHE_CONTROL, NO_STORE_CACHE_CONTROL,
} from './web/assets.js';
import { startRefreshScheduler } from './services/refresh.js';
import { restoreFullAccountLabels } from './services/sync.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const THEME_BOOTSTRAP_HASH = "'sha256-nazoARPAa07X5Va4zwQ0fEvL8yyU99JAa/DSXxMpIz0='";

export async function buildApp(options = {}) {
  const config = options.config || loadConfig();
  const db = options.db || openDatabase(config.dbPath);
  const app = Fastify({ logger: options.logger ?? false, trustProxy: config.trustProxy });
  const adapters = options.adapters || buildAdapters(config, options.routerFetch);

  // useDefaults:false is load-bearing. Helmet otherwise MERGES its defaults
  // into the directives below, which silently reintroduces
  // `upgrade-insecure-requests` — fatal on a plain-HTTP deployment, because the
  // browser rewrites /app.js and /styles.css to https:// where nothing listens
  // and renders an unstyled, non-functional page. Every directive we rely on is
  // therefore listed explicitly here.
  await app.register(helmet, {
    global: true,
    hsts: config.tls,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'", THEME_BOOTSTRAP_HASH, 'https://static.cloudflareinsights.com'],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'https://cloudflareinsights.com'],
        ...(config.tls ? { upgradeInsecureRequests: [] } : {}),
      },
    },
  });
  await app.register(cookie, { secret: config.cookieSecret, hook: 'onRequest' });
  await app.register(rateLimit, { global: false });
  await app.register(formbody);

  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request, reply) => {
    const signed = request.cookies.sp_session
      ? request.unsignCookie(request.cookies.sp_session)
      : null;
    request.user = signed?.valid ? getSession(db, signed.value) : null;

    // Every mutation from an authenticated browser requires the session-bound
    // CSRF token. The OAuth callback needs no exemption: it is a GET, so it is
    // never in MUTATING, and it is protected by its own one-time PKCE state.
    // An `/api/oauth/` prefix exemption would therefore protect nothing and
    // would instead strip CSRF from POST /api/oauth/:provider/start, letting a
    // cross-site page start OAuth flows against a logged-in user's session.
    if (MUTATING.has(request.method) && request.user) {
      const csrf = request.headers['x-csrf-token'];
      if (!csrf || csrf !== request.user.csrf_token) {
        return reply.code(403).send({ error: 'Invalid CSRF token' });
      }
    }
  });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      db.prepare('SELECT 1').get();
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'not_ready' });
    }
  });

  await app.register(authRoutes, { db, config });
  await app.register(accountRoutes, { db, config, adapters, oauthFetch: options.oauthFetch });
  await app.register(adminRoutes, { db, adapters, config });

  await restoreFullAccountLabels(db, adapters, config);

  const stopRefreshScheduler = options.startScheduler === false
    ? () => {}
    : startRefreshScheduler(db, adapters, config, options.refreshFetch);

  // The shell must never be cached: it is the only document that knows which
  // fingerprinted asset URLs the current build uses.
  const appShell = async (_request, reply) => reply
    .header('cache-control', NO_STORE_CACHE_CONTROL)
    .type('text/html')
    .send(renderApp());
  for (const path of ['/', '/providers', '/sponsors', '/admin', '/audit']) app.get(path, appShell);

  for (const asset of Object.values(assets)) {
    app.get(asset.path, async (_request, reply) => reply
      .header('cache-control', IMMUTABLE_CACHE_CONTROL)
      .type(asset.type)
      .send(asset.body));
  }

  // Chrome still requests /favicon.ico directly, and the unfingerprinted asset
  // paths remain reachable for anything holding an old link. Both revalidate.
  app.get('/favicon.ico', async (_request, reply) => reply
    .header('cache-control', NO_STORE_CACHE_CONTROL)
    .type(assets.favicon.type)
    .send(assets.favicon.body));
  for (const [legacy, asset] of [['/app.js', assets.script], ['/styles.css', assets.styles]]) {
    app.get(legacy, async (_request, reply) => reply
      .header('cache-control', NO_STORE_CACHE_CONTROL)
      .type(asset.type)
      .send(asset.body));
  }

  app.addHook('onClose', async () => {
    stopRefreshScheduler();
    if (!options.db) db.close();
  });
  return { app, db, config, adapters };
}
