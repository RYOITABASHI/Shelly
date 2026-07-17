/**
 * Unit tests for the pure logic in shelly-gemini-auth.js (bug #102/#115
 * Phase 1.2 — Google OAuth Custom Tabs trampoline).
 *
 * The script is a plain CommonJS Node asset (runs standalone via bundled
 * bionic node, not through the app's TS build), so we require() it
 * directly and exercise only the pure, side-effect-free functions it
 * exports. Everything else in the file (spawning the real `gemini`
 * process, polling the filesystem, writing to the deep-link queue) is
 * imperative glue with no existing test precedent in this codebase for
 * sibling scripts like shelly-codex-auth.js — see
 * __tests__/agent-driver-asset-parity.test.ts and
 * __tests__/plan-executor*.test.ts for the two testing patterns that DO
 * exist (byte-parity check, and full-process E2E spawn); neither applies
 * here since shelly-gemini-auth.js has no scripts/ mirror and spawning it
 * end-to-end would require a real `gemini` binary this repo doesn't
 * bundle.
 */

import * as path from 'path';

const scriptPath = path.resolve(
  __dirname,
  '..',
  'modules/terminal-emulator/android/src/main/assets/shelly-gemini-auth.js',
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  extractGoogleOAuthUrl,
  buildOpenUrlQueueLine,
  decideCompletionState,
  GOOGLE_OAUTH_HOSTS,
} = require(scriptPath);

describe('shelly-gemini-auth.js — extractGoogleOAuthUrl', () => {
  it('finds a bare accounts.google.com OAuth URL', () => {
    const text = 'Please visit https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&redirect_uri=http://127.0.0.1:1234/callback to continue.';
    expect(extractGoogleOAuthUrl(text)).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&redirect_uri=http://127.0.0.1:1234/callback',
    );
  });

  it('finds a codeassist.google.com OAuth URL', () => {
    const text = 'Sign in: https://codeassist.google.com/authorize?foo=bar';
    expect(extractGoogleOAuthUrl(text)).toBe('https://codeassist.google.com/authorize?foo=bar');
  });

  it('trims trailing sentence punctuation', () => {
    const text = 'Open this link: https://accounts.google.com/signin.';
    expect(extractGoogleOAuthUrl(text)).toBe('https://accounts.google.com/signin');
  });

  it('ignores non-Google URLs', () => {
    const text = 'Docs: https://github.com/google-gemini/gemini-cli and https://example.com/foo';
    expect(extractGoogleOAuthUrl(text)).toBeNull();
  });

  it('does not false-positive on a substring match of the host (host-based, not substring)', () => {
    // "accounts.google.com" appears only inside a query string value on a
    // DIFFERENT host — a naive substring check would wrongly match this.
    const text = 'Redirecting via https://evil.example.com/?next=accounts.google.com/oauth';
    expect(extractGoogleOAuthUrl(text)).toBeNull();
  });

  it('returns null for empty or non-string input', () => {
    expect(extractGoogleOAuthUrl('')).toBeNull();
    expect(extractGoogleOAuthUrl(undefined as unknown as string)).toBeNull();
    expect(extractGoogleOAuthUrl(null as unknown as string)).toBeNull();
  });

  it('finds a URL split across a chunk boundary once concatenated by the caller', () => {
    // The script's chunk handler concatenates stdout chunks before calling
    // this function, so from this function's point of view a "split" URL
    // is just a URL in a longer combined string.
    const combined = 'partial line before...https://accounts.google.com/o/oauth2/v2/auth?x=1 rest of line';
    expect(extractGoogleOAuthUrl(combined)).toBe('https://accounts.google.com/o/oauth2/v2/auth?x=1');
  });

  it('GOOGLE_OAUTH_HOSTS matches shelly-xdg-open.c host allowlist', () => {
    expect(GOOGLE_OAUTH_HOSTS.has('accounts.google.com')).toBe(true);
    expect(GOOGLE_OAUTH_HOSTS.has('codeassist.google.com')).toBe(true);
    expect(GOOGLE_OAUTH_HOSTS.size).toBe(2);
  });
});

describe('shelly-gemini-auth.js — buildOpenUrlQueueLine', () => {
  it('matches the JSON schema app/_layout.tsx drainQueue expects', () => {
    const line = buildOpenUrlQueueLine('https://accounts.google.com/signin', 'google');
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      type: 'open-url',
      url: 'https://accounts.google.com/signin',
      provider: 'google',
      authMode: 'external-browser',
    });
  });

  it('defaults provider to "google" when omitted', () => {
    const parsed = JSON.parse(buildOpenUrlQueueLine('https://accounts.google.com/signin'));
    expect(parsed.provider).toBe('google');
  });

  it('always sets authMode to external-browser (never in-app, per absolute prohibition on WebView fallback)', () => {
    const parsed = JSON.parse(buildOpenUrlQueueLine('https://accounts.google.com/x', 'anything'));
    expect(parsed.authMode).toBe('external-browser');
  });

  it('produces a single line with no embedded newlines (queue format is newline-delimited)', () => {
    const line = buildOpenUrlQueueLine('https://accounts.google.com/signin?a=1&b=2', 'google');
    expect(line.includes('\n')).toBe(false);
  });
});

describe('shelly-gemini-auth.js — decideCompletionState', () => {
  const base = {
    credentialsExists: false,
    mtimeMs: null as number | null,
    baselineMtimeMs: null as number | null,
    versionCheckOk: null as boolean | null,
    elapsedMs: 0,
    deadlineMs: 900000,
  };

  it('stays pending when the credential file has not appeared yet', () => {
    expect(decideCompletionState({ ...base })).toBe('pending');
  });

  it('stays pending when the file exists but mtime has not changed from baseline', () => {
    expect(
      decideCompletionState({
        ...base,
        credentialsExists: true,
        mtimeMs: 1000,
        baselineMtimeMs: 1000,
      }),
    ).toBe('pending');
  });

  it('requests a smoke check once mtime changes and none has run yet', () => {
    expect(
      decideCompletionState({
        ...base,
        credentialsExists: true,
        mtimeMs: 2000,
        baselineMtimeMs: 1000,
        versionCheckOk: null,
      }),
    ).toBe('needs-smoke-check');
  });

  it('declares complete only once mtime changed AND the smoke check passed', () => {
    expect(
      decideCompletionState({
        ...base,
        credentialsExists: true,
        mtimeMs: 2000,
        baselineMtimeMs: 1000,
        versionCheckOk: true,
      }),
    ).toBe('complete');
  });

  it('does not declare complete if mtime changed but the smoke check failed (partial/corrupt write)', () => {
    expect(
      decideCompletionState({
        ...base,
        credentialsExists: true,
        mtimeMs: 2000,
        baselineMtimeMs: 1000,
        versionCheckOk: false,
        elapsedMs: 5000,
      }),
    ).toBe('pending');
  });

  it('times out a failed smoke check once past the deadline', () => {
    expect(
      decideCompletionState({
        ...base,
        credentialsExists: true,
        mtimeMs: 2000,
        baselineMtimeMs: 1000,
        versionCheckOk: false,
        elapsedMs: 900001,
      }),
    ).toBe('timeout');
  });

  it('times out when nothing ever changes past the deadline', () => {
    expect(
      decideCompletionState({
        ...base,
        elapsedMs: 900001,
      }),
    ).toBe('timeout');
  });

  it('treats a baseline of null (no pre-existing file) as changed once the file appears', () => {
    expect(
      decideCompletionState({
        ...base,
        credentialsExists: true,
        mtimeMs: 500,
        baselineMtimeMs: null,
        versionCheckOk: true,
      }),
    ).toBe('complete');
  });
});
