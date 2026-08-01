// X OAuth 2.0 PKCE — device-only CSPRNG + SHA256, same split as
// lib/memory/crypto-expo.ts (host tests never load this file; it only runs
// on device). See lib/x-oauth.ts for the pure/host-testable half.

import * as Crypto from 'expo-crypto';
import { base64UrlFromBytes, isValidCodeVerifier } from './x-oauth';

const CODE_VERIFIER_BYTES = 64; // → 86 base64url chars, within RFC 7636's 43-128 range

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

/** Generates a fresh RFC 7636 code_verifier (CSPRNG, base64url) and its S256
 *  code_challenge = BASE64URL(SHA256(ASCII(verifier))). Call once per
 *  connect attempt; the verifier must be held (e.g. in-memory/React state)
 *  until the callback arrives, then discarded. */
export async function generatePkcePair(): Promise<PkcePair> {
  const randomBytes = await Crypto.getRandomBytesAsync(CODE_VERIFIER_BYTES);
  const codeVerifier = base64UrlFromBytes(randomBytes);
  if (!isValidCodeVerifier(codeVerifier)) {
    // Should be unreachable (86 base64url chars is always in range), but
    // fail loudly rather than send X a verifier it will reject.
    throw new Error('generated PKCE code_verifier failed RFC 7636 validation');
  }
  const digestBase64 = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, codeVerifier, {
    encoding: Crypto.CryptoEncoding.BASE64,
  });
  const codeChallenge = digestBase64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return { codeVerifier, codeChallenge };
}

/** CSPRNG state string for the authorize request (CSRF protection). */
export async function generateOAuthState(): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(24);
  return base64UrlFromBytes(bytes);
}
