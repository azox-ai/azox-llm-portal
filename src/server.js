import { buildApp } from './app.js';
import { ensureInitialAdmin } from './services/auth.js';

const { app, db, config } = await buildApp({ logger: true });
const seeded = await ensureInitialAdmin(db, config);
if (seeded) {
  app.log.warn('Initial admin created from INIT_ADMIN_PASSWORD; sign in and change it immediately');
}
await app.listen({ host: config.host, port: config.port });
