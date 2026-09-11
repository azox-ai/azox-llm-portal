import { createHash } from 'node:crypto';
import { appScript } from './client.js';
import { styles } from './styles.js';

// The portal sits behind Cloudflare Access, and the shell used to link
// /app.js and /styles.css by fixed path. A deploy therefore kept serving the
// previously cached bundle to browsers. Every asset now carries a content
// hash, so a new build produces a new URL that cannot be served from an old
// cache entry, while the HTML shell itself is always revalidated.
function fingerprint(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// Brand mark from the sidebar, reused so the Chrome tab matches the shell.
export const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" rx="14" fill="#E56A4A"/>
<text x="32" y="45" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Inter,Roboto,sans-serif" font-size="40" font-weight="800" fill="#ffffff" text-anchor="middle">9</text>
</svg>
`;

export const assets = {
  script: { path: `/assets/app-${fingerprint(appScript)}.js`, type: 'application/javascript', body: appScript },
  styles: { path: `/assets/styles-${fingerprint(styles)}.css`, type: 'text/css', body: styles },
  favicon: { path: `/assets/icon-${fingerprint(favicon)}.svg`, type: 'image/svg+xml', body: favicon },
};

export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const NO_STORE_CACHE_CONTROL = 'no-store, no-cache, must-revalidate';
