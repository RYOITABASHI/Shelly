import {
  X_AUTHORIZE_URL,
  X_TOKEN_URL,
  X_OAUTH_SCOPE,
  isValidCodeVerifier,
  base64UrlFromBytes,
  buildAuthorizeUrl,
  buildTokenExchangeBody,
  buildRefreshTokenBody,
  parseTokenResponse,
} from '@/lib/x-oauth';

describe('isValidCodeVerifier — RFC 7636 §4.1', () => {
  it('accepts a well-formed verifier in the 43-128 unreserved-char range', () => {
    expect(isValidCodeVerifier('a'.repeat(43))).toBe(true);
    expect(isValidCodeVerifier('a'.repeat(128))).toBe(true);
    expect(isValidCodeVerifier('A-Za-z0-9-._~'.repeat(4))).toBe(true);
  });

  it('rejects too-short, too-long, or non-unreserved-char verifiers', () => {
    expect(isValidCodeVerifier('a'.repeat(42))).toBe(false);
    expect(isValidCodeVerifier('a'.repeat(129))).toBe(false);
    expect(isValidCodeVerifier('a'.repeat(50) + '+')).toBe(false);
    expect(isValidCodeVerifier('a'.repeat(50) + ' ')).toBe(false);
  });
});

describe('base64UrlFromBytes', () => {
  it('produces URL-safe output with no padding', () => {
    // Bytes chosen so plain base64 would contain '+', '/', and '=' padding.
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf]);
    const out = base64UrlFromBytes(bytes);
    expect(out).not.toMatch(/[+/=]/);
  });
});

describe('buildAuthorizeUrl', () => {
  it('includes every required PKCE/OAuth parameter with S256', () => {
    const url = buildAuthorizeUrl({
      clientId: 'client123',
      redirectUri: 'shelly://oauth/x/callback',
      state: 'state-abc',
      codeChallenge: 'challenge-xyz',
    });
    expect(url.startsWith(X_AUTHORIZE_URL + '?')).toBe(true);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('client_id')).toBe('client123');
    expect(parsed.searchParams.get('redirect_uri')).toBe('shelly://oauth/x/callback');
    expect(parsed.searchParams.get('scope')).toBe(X_OAUTH_SCOPE);
    expect(parsed.searchParams.get('state')).toBe('state-abc');
    expect(parsed.searchParams.get('code_challenge')).toBe('challenge-xyz');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('scope requests offline.access (required for a refresh_token)', () => {
    expect(X_OAUTH_SCOPE).toContain('offline.access');
    expect(X_OAUTH_SCOPE).toContain('tweet.write');
  });
});

describe('buildTokenExchangeBody / buildRefreshTokenBody', () => {
  it('exchange body carries the authorization_code grant + PKCE verifier', () => {
    const body = buildTokenExchangeBody({
      code: 'auth-code',
      clientId: 'client123',
      redirectUri: 'shelly://oauth/x/callback',
      codeVerifier: 'verifier-xyz',
    });
    const params = new URLSearchParams(body);
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe('auth-code');
    expect(params.get('client_id')).toBe('client123');
    expect(params.get('redirect_uri')).toBe('shelly://oauth/x/callback');
    expect(params.get('code_verifier')).toBe('verifier-xyz');
  });

  it('refresh body carries the refresh_token grant', () => {
    const body = buildRefreshTokenBody({ refreshToken: 'refresh-xyz', clientId: 'client123' });
    const params = new URLSearchParams(body);
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('refresh-xyz');
    expect(params.get('client_id')).toBe('client123');
  });
});

describe('parseTokenResponse — fail-closed on malformed input', () => {
  it('parses a well-formed token response', () => {
    const parsed = parseTokenResponse(
      JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 7200, scope: 'tweet.write', token_type: 'bearer' }),
    );
    expect(parsed).toEqual({
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 7200,
      scope: 'tweet.write',
      token_type: 'bearer',
    });
  });

  it('returns null on invalid JSON', () => {
    expect(parseTokenResponse('not json')).toBeNull();
  });

  it('returns null when access_token is missing or empty', () => {
    expect(parseTokenResponse(JSON.stringify({ refresh_token: 'rt' }))).toBeNull();
    expect(parseTokenResponse(JSON.stringify({ access_token: '' }))).toBeNull();
  });

  it('returns null for non-object JSON (array, primitive)', () => {
    expect(parseTokenResponse('[]')).toBeNull();
    expect(parseTokenResponse('"str"')).toBeNull();
    expect(parseTokenResponse('42')).toBeNull();
  });

  it('tolerates a response with no refresh_token (rotation not guaranteed on every provider path)', () => {
    const parsed = parseTokenResponse(JSON.stringify({ access_token: 'at' }));
    expect(parsed).toEqual({ access_token: 'at', refresh_token: undefined, expires_in: undefined, scope: undefined, token_type: undefined });
  });
});

describe('endpoint constants match X\'s documented OAuth 2.0 PKCE endpoints', () => {
  it('authorize/token hosts are api.x.com / x.com (not the legacy twitter.com hosts)', () => {
    expect(X_AUTHORIZE_URL).toBe('https://x.com/i/oauth2/authorize');
    expect(X_TOKEN_URL).toBe('https://api.x.com/2/oauth2/token');
  });
});
