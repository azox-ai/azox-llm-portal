import { createHash, randomBytes } from 'node:crypto';

export function createVerifier() {
  return randomBytes(32).toString('base64url');
}

export function challengeFor(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}
