/**
 * lib/x-oauth.ts — pure, host-testable X (Twitter) OAuth 2.0 PKCE helpers.
 *
 * Deliberately free of device-only imports (no expo-crypto, no fetch calls)
 * so this runs identically in Jest and on device — the same split
 * lib/memory/crypto-expo.ts uses (device-only CSPRNG/SHA256 lives in
 * lib/x-oauth-crypto-expo.ts; this file takes the resulting
 * codeVerifier/codeChallenge strings as plain parameters).
 *
 * Endpoints/parameters verified against X's own docs (docs.x.com,
 * 2026-07-31): authorize https://x.com/i/oauth2/authorize, token
 * https://api.x.com/2/oauth2/token, S256 PKCE, offline.access scope for a
 * refresh_token. X rotates the refresh_token on every exchange — the caller
 * MUST persist the new refresh_token returned by exchangeCodeForToken /
 * refreshAccessToken, or the NEXT refresh will fail with an invalid_grant.
 */

import { bytesToBase64 } from './memory/base64';

export const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
export const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token';
export const X_REVOKE_URL = 'https://api.x.com/2/oauth2/revoke';

/** tweet.write covers both regular posts and Articles (docs.x.com/x-api/articles).
 *  offline.access is required to receive a refresh_token at all. */
export const X_OAUTH_SCOPE = 'tweet.read tweet.write users.read offline.access';

const PKCE_UNRESERVED_RE = /^[A-Za-z0-9\-._~]+$/;

/** RFC 7636 §4.1: 43-128 characters from [A-Za-z0-9-._~]. */
export function isValidCodeVerifier(verifier: string): boolean {
  return verifier.length >= 43 && verifier.length <= 128 && PKCE_UNRESERVED_RE.test(verifier);
}

/** base64url (RFC 4648 §5): '+'→'-', '/'→'_', strip '=' padding. Reuses the
 *  dependency-free base64 codec lib/memory/crypto-expo.ts already relies on. */
export function base64UrlFromBytes(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export interface AuthorizeUrlParams {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

/** Builds the browser URL to open (via Custom Tabs, same trampoline pattern
 *  BrowserPane/app _layout already use for Google's OAuth host). */
export function buildAuthorizeUrl(params: AuthorizeUrlParams): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    scope: X_OAUTH_SCOPE,
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${X_AUTHORIZE_URL}?${q.toString()}`;
}

export interface TokenExchangeParams {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
}

/** application/x-www-form-urlencoded body for the authorization_code grant. */
export function buildTokenExchangeBody(params: TokenExchangeParams): string {
  return new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  }).toString();
}

export interface TokenRefreshParams {
  refreshToken: string;
  clientId: string;
}

/** application/x-www-form-urlencoded body for the refresh_token grant. */
export function buildRefreshTokenBody(params: TokenRefreshParams): string {
  return new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
    client_id: params.clientId,
  }).toString();
}

export interface XTokenResponse {
  access_token: string;
  /** Present when the request included offline.access; X rotates this on
   *  every exchange — the OLD refresh_token becomes invalid once used. */
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

/** Narrow, defensive parse — never throws on malformed JSON/shape; callers
 *  treat a null return as a failed exchange (fail-closed, same convention as
 *  lib/agent-executor.ts's Bluesky session-exchange handling). */
export function parseTokenResponse(raw: string): XTokenResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.access_token !== 'string' || !obj.access_token) return null;
  return {
    access_token: obj.access_token,
    refresh_token: typeof obj.refresh_token === 'string' ? obj.refresh_token : undefined,
    expires_in: typeof obj.expires_in === 'number' ? obj.expires_in : undefined,
    scope: typeof obj.scope === 'string' ? obj.scope : undefined,
    token_type: typeof obj.token_type === 'string' ? obj.token_type : undefined,
  };
}
