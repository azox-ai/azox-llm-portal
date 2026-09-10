import { challengeFor } from './pkce.js';
import { createHash } from 'node:crypto';

export function decodeJwtPayload(token) {
  const parts = String(token).split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function buildAuthorizeUrl(providerConfig, { state, verifier }) {
  const url = new URL(providerConfig.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', providerConfig.clientId);
  url.searchParams.set('redirect_uri', providerConfig.redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challengeFor(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  if (providerConfig.scopes) url.searchParams.set('scope', providerConfig.scopes);
  for (const [key, value] of Object.entries(providerConfig.extraAuthorizeParams ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * Accepts either a bare authorization code or the full callback URL the
 * operator copied out of the browser. Claude appends `#state` to the code in
 * its manual flow, so that form is normalized here too.
 */
export function parseCallbackInput(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  let code = text;
  let state = null;
  if (text.startsWith('http://') || text.startsWith('https://')) {
    const url = new URL(text);
    code = url.searchParams.get('code') ?? '';
    state = url.searchParams.get('state');
  }
  if (code.includes('#')) {
    const [rawCode, rawState] = code.split('#');
    code = rawCode;
    state = state || rawState || null;
  }
  return code ? { code, state } : null;
}

/**
 * Exchange an authorization code for a token set.
 * `fetchImpl` is injectable so a TLS-fingerprint-preserving transport can be
 * supplied for Codex — native fetch reliably draws a Cloudflare managed
 * challenge on chatgpt.com, which upstream classifiers turn into a permanent ban.
 */
export async function exchangeCode(providerConfig, { code, verifier }, fetchImpl = fetch) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: providerConfig.clientId,
    redirect_uri: providerConfig.redirectUri,
    code_verifier: verifier,
  });
  const response = await fetchImpl(providerConfig.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  });
  if (!response.ok) {
    const error = new Error('Token exchange failed');
    error.statusCode = response.status;
    throw error;
  }
  return normalizeTokenSet(await response.json());
}

export function normalizeTokenSet(raw) {
  if (!raw || typeof raw !== 'object' || !raw.access_token) {
    throw new Error('Token response missing access_token');
  }
  const expiresIn = Number(raw.expires_in);
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token || null,
    idToken: raw.id_token || null,
    tokenType: raw.token_type || 'Bearer',
    scope: raw.scope || null,
    expiresAt: Number.isFinite(expiresIn) ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
  };
}

export async function resolveIdentity(providerConfig, tokenSet, fetchImpl = fetch) {
  const claims = tokenSet.idToken ? decodeJwtPayload(tokenSet.idToken) : null;
  if (claims?.sub) {
    return { subject: String(claims.sub), label: claims.email || claims.name || String(claims.sub) };
  }
  if (providerConfig.identityUrl) {
    const response = await fetchImpl(providerConfig.identityUrl, {
      headers: { authorization: `Bearer ${tokenSet.accessToken}`, accept: 'application/json' },
    });
    if (response.ok) {
      const profile = await response.json();
      const subject = profile.sub || profile.id || profile.account_id || profile.email;
      if (subject) {
        return { subject: String(subject), label: profile.email || profile.name || String(subject) };
      }
    }
  }
  // Claude consumer OAuth currently returns no id_token/userinfo endpoint. Use
  // a one-way fingerprint of the canonical refresh token as a stable internal
  // subject; the value is never returned or logged. Existing rows keep this
  // subject across future access-token refreshes.
  if (tokenSet.refreshToken) {
    const subject = createHash('sha256').update(tokenSet.refreshToken).digest('hex');
    return { subject: `oauth:${subject}`, label: 'Claude OAuth account' };
  }
  throw new Error('Unable to resolve upstream account identity');
}
