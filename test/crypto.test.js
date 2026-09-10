import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptJson, decryptJson } from '../src/lib/crypto.js';
import { challengeFor } from '../src/oauth/pkce.js';
import { normalizeTokenSet } from '../src/oauth/client.js';

test('credential envelope round-trips and rejects wrong key', () => {
  const token = { accessToken: 'secret-a', refreshToken: 'secret-r' };
  const envelope = encryptJson(token, 'key-one');
  assert.ok(!envelope.includes('secret-a'));
  assert.deepEqual(decryptJson(envelope, 'key-one'), token);
  assert.throws(() => decryptJson(envelope, 'key-two'));
});

test('PKCE challenge matches RFC 7636 example', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.equal(challengeFor(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('token normalization preserves token fields', () => {
  const token = normalizeTokenSet({ access_token: 'a', refresh_token: 'r', expires_in: 3600 });
  assert.equal(token.accessToken, 'a');
  assert.ok(token.expiresAt);
});
