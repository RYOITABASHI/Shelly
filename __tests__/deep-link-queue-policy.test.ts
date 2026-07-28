import * as fs from 'fs';
import * as path from 'path';
import { resolveQueueLine, EXTERNAL_BROWSER_HOSTS } from '@/lib/deep-link-queue-policy';

const ext = (line: string): string => {
  const r = resolveQueueLine(line);
  if (!r.entry) return `rejected:${r.reason}`;
  return r.entry.authMode;
};

const jsonLine = (url: string, authMode?: string) =>
  JSON.stringify({ type: 'open-url', url, provider: 'google', ...(authMode ? { authMode } : {}) });

describe('resolveQueueLine — scheme + shape', () => {
  it('rejects non-http(s) schemes on both the legacy and JSON path', () => {
    for (const url of [
      'file:///data/user/0/dev.shelly.terminal/files/home/.codex/auth.json',
      'content://com.android.providers.media/external',
      'intent://scan/#Intent;scheme=zxing;end',
      'javascript:alert(1)',
      'shelly://browser?url=x',
    ]) {
      expect(ext(url)).toBe('rejected:non-http(s) url');
      expect(ext(jsonLine(url, 'external-browser'))).toBe('rejected:non-http(s) url');
    }
  });

  it('rejects malformed / url-less JSON and empty lines without throwing', () => {
    expect(ext('{not json')).toBe('rejected:malformed JSON line');
    expect(ext('{"type":"open-url"}')).toBe('rejected:JSON line without url field');
    expect(ext('{"url":123}')).toBe('rejected:JSON line without url field');
    expect(ext('   ')).toBe('rejected:empty line');
  });

  it('keeps the legacy bare-URL format working (in-app by default)', () => {
    const r = resolveQueueLine('https://github.com/login/oauth/authorize?client_id=x');
    expect(r.entry).toMatchObject({ authMode: 'in-app', provider: null });
    expect(r.note).toBeUndefined();
  });
});

describe('resolveQueueLine — external-browser is host-gated in BOTH directions', () => {
  it('upgrades a bare/in-app Google OAuth URL to the external browser', () => {
    for (const host of EXTERNAL_BROWSER_HOSTS) {
      const url = `https://${host}/o/oauth2/v2/auth?client_id=x&redirect_uri=http://127.0.0.1:5599/cb`;
      const bare = resolveQueueLine(url);
      expect(bare.note).toBe('upgraded-to-external');
      expect(bare.entry?.authMode).toBe('external-browser');
      expect(bare.entry?.provider).toBe('google');
      // …and an explicit {"authMode":"in-app"} for the same host is upgraded too.
      expect(ext(jsonLine(url, 'in-app'))).toBe('external-browser');
      expect(ext(jsonLine(url, 'external-browser'))).toBe('external-browser');
    }
  });

  it('BLOCKS host spoofing that a substring match would accept (the 2026-07-28 fix)', () => {
    // Every one of these contains the literal string "accounts.google.com",
    // so shelly-xdg-open.c's old `strstr(url, "://accounts.google.com/")` — or
    // any `url.includes('accounts.google.com')` check — would hand them to the
    // user's REAL browser process, with the user's real Google session.
    const spoofs = [
      'https://evil-accounts.google.com.attacker.example/o/oauth2/v2/auth',
      'https://accounts.google.com.attacker.example/o/oauth2/v2/auth',
      'https://attacker.example/redirect?next=https://accounts.google.com/',
      'https://attacker.example/#https://accounts.google.com/',
      'https://accounts.google.com@attacker.example/steal',
      'https://accounts.google.com.evil/',
      'https://xaccounts.google.com/',
      'http://attacker.example/accounts.google.com/',
    ];
    for (const url of spoofs) {
      // declared external-browser ⇒ DOWNGRADED, not honoured
      const declared = resolveQueueLine(jsonLine(url, 'external-browser'));
      expect(declared.note).toBe('downgraded-to-in-app');
      expect(declared.entry?.authMode).toBe('in-app');
      // bare / in-app ⇒ stays in-app (never upgraded)
      expect(ext(url)).toBe('in-app');
      expect(ext(jsonLine(url, 'in-app'))).toBe('in-app');
    }
  });

  it('does not upgrade other google.com hosts (pasted YouTube/Drive/Maps stay in-app)', () => {
    for (const url of [
      'https://www.google.com/search?q=x',
      'https://drive.google.com/file/d/abc',
      'https://youtube.com/watch?v=abc',
      'https://mail.google.com/',
    ]) {
      expect(ext(url)).toBe('in-app');
      expect(ext(jsonLine(url, 'external-browser'))).toBe('in-app');
    }
  });

  it('is case-insensitive on the host and ignores the port', () => {
    expect(ext('https://ACCOUNTS.GOOGLE.COM/o/oauth2/v2/auth')).toBe('external-browser');
    expect(ext('https://Accounts.Google.Com:443/o/oauth2/v2/auth')).toBe('external-browser');
    // …but a port does not let a different host through.
    expect(ext(jsonLine('https://accounts.google.com.evil:443/x', 'external-browser'))).toBe('in-app');
  });

  it('never lets a downgraded entry keep the privileged provider claim silently', () => {
    const r = resolveQueueLine(jsonLine('https://attacker.example/?u=https://accounts.google.com/', 'external-browser'));
    expect(r.entry).not.toBeNull();
    expect(r.note).toBe('downgraded-to-in-app');
    expect(r.entry?.host).toBe('attacker.example');
  });
});

describe('shelly-xdg-open.c — native emitter agrees with the TS policy', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../modules/terminal-emulator/android/src/main/jni/shelly-xdg-open.c'),
    'utf8',
  );

  it('no longer decides the Google-auth flag with a substring match', () => {
    // Regression lock: `strstr(url, "://accounts.google.com/")` matched the
    // string anywhere in the URL, including inside a query parameter.
    expect(src).not.toMatch(/strstr\s*\(\s*url\s*,\s*"::\/\//);
    expect(src).toMatch(/static int url_host_equals\(/);
    expect(src).toMatch(/url_host_equals\(url, "accounts\.google\.com"\)/);
    expect(src).toMatch(/url_host_equals\(url, "codeassist\.google\.com"\)/);
  });

  it('strips userinfo and port before comparing the host', () => {
    // `https://accounts.google.com@evil/` must resolve to `evil`, so the
    // parser has to take the segment after the LAST '@' of the authority.
    expect(src).toMatch(/if \(\*p == '@'\) at = p;/);
    expect(src).toMatch(/if \(\*p == ':'\) \{ host_end = p; break; \}/);
    expect(src).toMatch(/strncasecmp\(host, want, want_len\)/);
    expect(src).toMatch(/#include <strings\.h>/);
  });

  it('keeps the http/https scheme allowlist ahead of everything else', () => {
    expect(src).toMatch(/starts_with\(url, "http:\/\/"\).*\n?.*starts_with\(url, "https:\/\/"\)/);
  });

  it('uses the same two-host allowlist as the TS policy and the gemini emitter', () => {
    expect([...EXTERNAL_BROWSER_HOSTS].sort()).toEqual(['accounts.google.com', 'codeassist.google.com']);
    const gemini = fs.readFileSync(
      path.resolve(__dirname, '../modules/terminal-emulator/android/src/main/assets/shelly-gemini-auth.js'),
      'utf8',
    );
    expect(gemini).toMatch(/GOOGLE_OAUTH_HOSTS = new Set\(\['accounts\.google\.com', 'codeassist\.google\.com'\]\)/);
  });
});
