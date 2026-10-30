/**
 * __tests__/claude-glibc-s2.test.ts
 *
 * Claude Code glibc S2-S3 (BASHRC_VERSION 275-279): private authenticated proxy, OSC 8
 * sign-in URL bridge (tap-to-open only, armed sessions only), drain loop
 * safety. See DEFERRED.md "Claude Code 公式 glibc 版（2.1.314）を Shelly で動かす".
 *
 *  - lib/deep-link-open-guard.ts: provider+URL dedupe, forget(), burst guard;
 *  - lib/deep-link-queue-policy.ts: only Claude Code's own authorize URLs
 *    (client_id + redirect_uri) pass, always `requiresConfirm`, intact URL;
 *  - real OSC 8 bytes (BEL / ST terminators, id= params, split chunks) through
 *    the vendored TerminalEmulator into the observer (javac harness);
 *  - OAuthHyperlinkBridge.kt / HomeInitializer.kt / app/_layout.tsx source
 *    invariants (CI builds Android but does not run Kotlin unit tests);
 *  - TerminalPane.tsx no longer auto-opens URLs seen in terminal OUTPUT;
 *  - shelly-xdg-open.c takes argv[1] whole;
 *  - assets/shelly-claude-proxy.js: 407 without the token, private-address
 *    denial (literal and after DNS), tunnel, port file, parent-pid lifetime;
 *  - the generated shelly-claude-glibc() bashrc function.
 */
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { createOpenGuard, openGuardKey } from '@/lib/deep-link-open-guard';
import {
  resolveQueueLine,
  isAnthropicOAuthAuthorizeUrl,
  ANTHROPIC_OAUTH_AUTHORIZE,
  CLAUDE_CODE_CLIENT_ID,
  CLAUDE_CODE_MANUAL_REDIRECT,
} from '@/lib/deep-link-queue-policy';

const root = path.resolve(__dirname, '..');
const mainDir = path.join(root, 'modules/terminal-emulator/android/src/main');
const ktDir = path.join(mainDir, 'java/expo/modules/terminalemulator');
const read = (p: string) => fs.readFileSync(p, 'utf8');
const homeKt = read(path.join(ktDir, 'HomeInitializer.kt'));
const bridgeKt = read(path.join(ktDir, 'OAuthHyperlinkBridge.kt'));
const emulatorJava = read(path.join(mainDir, 'java/com/termux/terminal/TerminalEmulator.java'));
const xdgOpenC = read(path.join(mainDir, 'jni/shelly-xdg-open.c'));
const terminalPane = read(path.join(root, 'components/panes/TerminalPane.tsx'));
const layout = read(path.join(root, 'app/_layout.tsx'));
const proxyPath = path.join(mainDir, 'assets/shelly-claude-proxy.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxy = require(proxyPath);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const harness = require('./fixtures/osc8-harness/build.js');

const SIGN_IN_URL =
  `https://claude.com/cai/oauth/authorize?code=true&client_id=${CLAUDE_CODE_CLIENT_ID}` +
  '&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback' +
  '&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&code_challenge=Ab_-9xYz' +
  '&code_challenge_method=S256&state=st4te=x#fragment';

const occurrences = (hay: string, needle: string) => hay.split(needle).length - 1;

describe('deep-link-open-guard', () => {
  it('opens a key once per 30 s window, again after it', () => {
    const g = createOpenGuard();
    expect(g.check('k', 0)).toEqual({ ok: true });
    expect(g.check('k', 1_000)).toEqual({ ok: false, reason: 'duplicate' });
    expect(g.check('k', 29_999)).toEqual({ ok: false, reason: 'duplicate' });
    expect(g.check('k', 30_000)).toEqual({ ok: true });
  });

  it('scopes dedupe to provider + URL, and forget() lets a deliberate retry through', () => {
    const g = createOpenGuard();
    expect(g.check(openGuardKey('anthropic', SIGN_IN_URL), 0).ok).toBe(true);
    expect(g.check(openGuardKey('google', SIGN_IN_URL), 10).ok).toBe(true);
    expect(g.check(openGuardKey('anthropic', SIGN_IN_URL), 20).ok).toBe(false);
    g.forget(openGuardKey('anthropic', SIGN_IN_URL));
    expect(g.check(openGuardKey('anthropic', SIGN_IN_URL), 30).ok).toBe(true);
    // a fresh guard (new app session) does not inherit the old window
    expect(createOpenGuard().check(openGuardKey('anthropic', SIGN_IN_URL), 40).ok).toBe(true);
  });

  it('drops a burst beyond maxPerMinute and recovers after the minute', () => {
    const g = createOpenGuard({ maxPerMinute: 3 });
    expect(g.check('1', 0).ok).toBe(true);
    expect(g.check('2', 10).ok).toBe(true);
    expect(g.check('3', 20).ok).toBe(true);
    expect(g.check('4', 30)).toEqual({ ok: false, reason: 'rate-limited' });
    expect(g.check('5', 60_001).ok).toBe(true);
  });

  it('simulates the focus-regain loop: repeated identical lines pass once', () => {
    const g = createOpenGuard();
    let opened = 0;
    for (let i = 0; i < 50; i++) if (g.check(openGuardKey('anthropic', SIGN_IN_URL), i * 400).ok) opened++;
    expect(opened).toBe(1);
  });

  it('the drain applies the guard to external-browser entries only, toasts burst drops', () => {
    expect(layout).toMatch(/if \(authMode === 'external-browser'\) \{\s+const verdict = openGuard\.check\(guardKey\);/);
    expect(layout).toMatch(/ToastAndroid\.show\(t\('deeplink\.open_rate_limited'\)/);
  });
});

describe('deep-link-queue-policy — Claude Code sign-in URLs', () => {
  it('passes the bridge JSON line through intact and always requires confirmation', () => {
    const line = JSON.stringify({
      type: 'open-url',
      url: SIGN_IN_URL,
      authMode: 'external-browser',
      provider: 'anthropic',
      confirm: true,
    });
    const r = resolveQueueLine(line);
    expect(r.entry).not.toBeNull();
    expect(r.entry!.authMode).toBe('external-browser');
    expect(r.entry!.requiresConfirm).toBe(true);
    expect(r.entry!.url).toBe(SIGN_IN_URL);
    expect(r.entry!.url).toContain('&client_id=');
    expect(r.entry!.url.endsWith('#fragment')).toBe(true);
  });

  it('a legacy bare authorize line still requires confirmation (no silent open)', () => {
    const r = resolveQueueLine(SIGN_IN_URL);
    expect(r.note).toBe('upgraded-to-external');
    expect(r.entry!.requiresConfirm).toBe(true);
    expect(r.entry!.provider).toBe('anthropic');
  });

  it('accepts the localhost callback redirect', () => {
    const u = `https://claude.ai/oauth/authorize?client_id=${CLAUDE_CODE_CLIENT_ID}&redirect_uri=${encodeURIComponent(
      'http://localhost:54545/callback',
    )}&state=s`;
    expect(isAnthropicOAuthAuthorizeUrl(u)).toBe(true);
  });

  it('REJECTS (not even in-app) authorize URLs with a foreign client_id or redirect_uri', () => {
    const bad = [
      SIGN_IN_URL.replace(CLAUDE_CODE_CLIENT_ID, '00000000-0000-4000-8000-000000000000'),
      SIGN_IN_URL.replace('platform.claude.com%2Foauth', 'evil.example%2Foauth'),
      SIGN_IN_URL.replace(encodeURIComponent(CLAUDE_CODE_MANUAL_REDIRECT), encodeURIComponent('http://localhost:1/x')),
      `${SIGN_IN_URL.split('#')[0]}&client_id=${CLAUDE_CODE_CLIENT_ID}`,
      'https://claude.ai/oauth/authorize?a=1',
      SIGN_IN_URL.replace('https://', 'http://'),
    ];
    for (const u of bad) {
      expect(isAnthropicOAuthAuthorizeUrl(u)).toBe(false);
      expect(resolveQueueLine(JSON.stringify({ url: u, authMode: 'external-browser' })).entry).toBeNull();
      expect(resolveQueueLine(u).entry).toBeNull();
    }
  });

  it('keeps non-authorize pages and look-alikes away from the external browser', () => {
    for (const u of [
      'https://claude.ai/settings',
      'https://claude.ai/oauth/authorize.evil',
      `https://evil.example/oauth/authorize?next=${encodeURIComponent(SIGN_IN_URL)}`,
      'http://127.0.0.1:18080',
    ]) {
      expect(isAnthropicOAuthAuthorizeUrl(u)).toBe(false);
      const r = resolveQueueLine(JSON.stringify({ url: u, authMode: 'external-browser' }));
      if (r.entry) {
        expect(r.entry.authMode).toBe('in-app');
        expect(r.entry.requiresConfirm).toBe(false);
      }
    }
  });

  it('Kotlin bridge mirrors the TS host/path table, client id and redirect', () => {
    const pairs: Array<[string, string]> = [];
    for (const line of bridgeKt.split(/\r?\n/)) {
      const m = /^\s*(.+) -> path == "([^"]+)"\s*$/.exec(line);
      if (!m) continue;
      for (const h of m[1].match(/"([a-z.]+)"/g) ?? []) pairs.push([h.slice(1, -1), m[2]]);
    }
    expect(new Map(pairs)).toEqual(new Map(ANTHROPIC_OAUTH_AUTHORIZE));
    expect(bridgeKt).toContain(`const val CLAUDE_CODE_CLIENT_ID = "${CLAUDE_CODE_CLIENT_ID}"`);
    expect(bridgeKt).toContain(`const val CLAUDE_CODE_MANUAL_REDIRECT = "${CLAUDE_CODE_MANUAL_REDIRECT}"`);
    expect(bridgeKt).toContain('Regex("^http://localhost:\\\\d{1,5}/callback$")');
  });
});

describe('sign-in is tap-to-open and armed-only (source invariants)', () => {
  it('the bridge never opens anything; it queues a confirm request only when armed', () => {
    expect(bridgeKt).not.toMatch(/openBrowser|startActivity|ACTION_VIEW|Intent\(/);
    expect(bridgeKt).toMatch(/if \(!isArmed\(File\(home, ARM_RELATIVE_PATH\)/);
    expect(bridgeKt).toContain('const val ARM_RELATIVE_PATH = "tmp/.shelly-claude-login.arm"');
    expect(bridgeKt).toContain('\\"confirm\\":true}');
    expect(bridgeKt).toContain('const val SEEN_TTL_MS = 60_000L');
  });

  it('the drain prompts and opens only from the Open button, consuming the arm file', () => {
    expect(layout).toContain("home/tmp/.shelly-claude-login.arm");
    expect(layout).toMatch(/if \(requiresConfirm\) \{[^]*?await promptClaudeSignIn\(url, provider, host, guardKey\);\s+continue;/);
    const fnStart = layout.indexOf('const promptClaudeSignIn = async');
    const fn = layout.slice(fnStart, layout.indexOf('const drainQueue = async', fnStart));
    expect(fn).toMatch(/if \(!arm\.exists\) \{[^]*?openGuard\.forget\(guardKey\);\s+return;/);
    // the only dispatchExternalBrowser call sits inside the Open button handler
    expect(occurrences(fn, 'dispatchExternalBrowser(')).toBe(1);
    const openBtn = fn.slice(fn.indexOf("text: t('deeplink.claude_signin_open')"));
    expect(openBtn).toMatch(/onPress: \(\) => \{[^]*?deleteAsync\(claudeLoginArmPath[^]*?dispatchExternalBrowser\(url, provider\)/);
  });

  it('i18n strings exist in en and ja', () => {
    const en = read(path.join(root, 'lib/i18n/locales/en.ts'));
    const ja = read(path.join(root, 'lib/i18n/locales/ja.ts'));
    for (const k of ['claude_signin_title', 'claude_signin_body', 'claude_signin_open', 'claude_signin_cancel', 'open_rate_limited']) {
      expect(en).toContain(`'deeplink.${k}'`);
      expect(ja).toContain(`'deeplink.${k}'`);
    }
  });
});

describe('OSC 8 plumbing', () => {
  it('TerminalEmulator observes OSC 8 URIs without rendering them', () => {
    expect(emulatorJava).toMatch(/public static volatile HyperlinkObserver sHyperlinkObserver;/);
    expect(emulatorJava).toMatch(/case 8: \{[^]*?textParameter\.indexOf\(';'\) \+ 1[^]*?observer\.onHyperlink\(uri\)[^]*?break;/);
  });

  it('HomeInitializer installs the bridge and extracts the proxy exactly once', () => {
    expect(occurrences(homeKt, 'OAuthHyperlinkBridge.install(home)')).toBe(1);
    expect(occurrences(homeKt, 'val claudeProxyScript = File(home, ".shelly-claude-proxy.js")')).toBe(1);
    expect(occurrences(homeKt, 'context.assets.open("shelly-claude-proxy.js")')).toBe(1);
    expect(occurrences(homeKt, 'sb.appendLine("shelly-claude-glibc() {")')).toBe(1);
    expect(homeKt).toMatch(/fun initialize\(context: Context\): File \{\s+val home = getHomeDir\(context\)[^]*?OAuthHyperlinkBridge\.install\(home\)/);
  });

  it('TerminalPane no longer opens URLs that merely appear in output', () => {
    const m = /onUrlDetected=\{[^]*?\}\}/.exec(terminalPane);
    expect(m).not.toBeNull();
    expect(m![0]).not.toMatch(/openBrowserAsync|openURL|openUrl/);
  });

  it('shelly-xdg-open.c takes the whole URL from argv[1] (no splitting on & # =)', () => {
    expect(xdgOpenC).toMatch(/const char \*url = argv\[1\];/);
    expect(xdgOpenC).not.toMatch(/strtok|strchr\(url, '&'\)|strchr\(url, '#'\)/);
    expect(xdgOpenC).toMatch(/const char \*payload = url;/);
  });

  describe('real bytes through the vendored TerminalEmulator (javac harness)', () => {
    let dir: string | null = null;
    let skip = '';
    beforeAll(() => {
      const b = harness.build();
      dir = b.dir;
      if (!dir) skip = b.error;
    }, 120_000);

    const ST = '\x1b\\';
    const BEL = '\x07';
    const cases: Array<[string, string]> = [
      ['ST, empty params', `a\x1b]8;;${SIGN_IN_URL}${ST}link${'\x1b]8;;'}${ST}b`],
      ['BEL, empty params', `a\x1b]8;;${SIGN_IN_URL}${BEL}link\x1b]8;;${BEL}b`],
      ['ST, id= params', `a\x1b]8;id=login-1:x=y;${SIGN_IN_URL}${ST}link\x1b]8;;${ST}b`],
      ['BEL, id= params', `a\x1b]8;id=7;${SIGN_IN_URL}${BEL}link\x1b]8;;${BEL}b`],
    ];
    for (const [name, input] of cases) {
      for (const chunk of [1, 3, 7, 4096]) {
        it(`${name}, ${chunk}-byte chunks: full URI reaches the observer, text renders`, () => {
          if (!dir) {
            // eslint-disable-next-line no-console
            console.warn(`OSC 8 harness skipped: ${skip}`);
            return;
          }
          const r = harness.run(dir, input, chunk);
          expect(r.uris).toEqual([SIGN_IN_URL]);
          expect(r.screen.startsWith('alinkb')).toBe(true);
        });
      }
    }

    it('a wrapped multi-row link still yields one complete URI per OSC 8 open', () => {
      if (!dir) return;
      // Ink-style: each visible row wrapped in its own OSC 8 pair with the full URL
      const rows = ['row1', 'row2', 'row3'].map((t) => `\x1b]8;;${SIGN_IN_URL}${ST}${t}\x1b]8;;${ST}\r\n`).join('');
      const r = harness.run(dir, rows, 5);
      expect(r.uris).toEqual([SIGN_IN_URL, SIGN_IN_URL, SIGN_IN_URL]);
    });
  });
});

describe('shelly-claude-proxy.js', () => {
  const TOKEN = '0123456789abcdef0123456789abcdef';
  const AUTH = proxy.expectedAuthHeader(TOKEN);

  it('parses CONNECT authorities and only allows 443 by default', () => {
    expect(proxy.parseConnectTarget('api.anthropic.com:443')).toEqual({ host: 'api.anthropic.com', port: 443 });
    expect(proxy.parseConnectTarget('[::1]:443')).toEqual({ host: '::1', port: 443 });
    expect(proxy.parseConnectTarget('api.anthropic.com:22')).toBeNull();
    expect(proxy.parseConnectTarget('a b:443')).toBeNull();
  });

  it('classifies private / special addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:192.168.0.1', 'not-an-ip']) {
      expect(proxy.isPrivateAddress(a)).toBe(true);
    }
    for (const a of ['160.79.104.10', '8.8.8.8', '172.32.0.1', '2607:6bc0::10', '::ffff:8.8.8.8']) {
      expect(proxy.isPrivateAddress(a)).toBe(false);
    }
  });

  it('checks Proxy-Authorization exactly', () => {
    expect(proxy.checkProxyAuth(AUTH, TOKEN)).toBe(true);
    expect(proxy.checkProxyAuth(AUTH.slice(0, -1), TOKEN)).toBe(false);
    expect(proxy.checkProxyAuth(undefined, TOKEN)).toBe(false);
    expect(proxy.checkProxyAuth(AUTH, '')).toBe(false);
  });

  const listen = (srv: net.Server): Promise<number> =>
    new Promise((res) => srv.listen(0, '127.0.0.1', () => res((srv.address() as net.AddressInfo).port)));

  const connectVia = (proxyPort: number, authority: string, auth?: string): Promise<{ status: string; sock: net.Socket }> =>
    new Promise((res, rej) => {
      const sock = net.connect(proxyPort, '127.0.0.1', () =>
        sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`),
      );
      let buf = '';
      const onData = (d: Buffer) => {
        buf += d.toString('latin1');
        const i = buf.indexOf('\r\n\r\n');
        if (i >= 0) {
          sock.off('data', onData);
          res({ status: buf.split('\r\n')[0], sock });
        }
      };
      sock.on('data', onData);
      sock.on('error', rej);
      sock.on('end', () => res({ status: buf.split('\r\n')[0], sock }));
    });

  const httpVia = (proxyPort: number, url: string, auth?: string): Promise<string> =>
    new Promise((res, rej) => {
      const sock = net.connect(proxyPort, '127.0.0.1', () =>
        sock.write(`GET ${url} HTTP/1.1\r\nHost: x\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}Connection: close\r\n\r\n`),
      );
      let buf = '';
      sock.on('data', (d) => (buf += d.toString('latin1')));
      sock.on('end', () => res(buf.split('\r\n')[0]));
      sock.on('error', rej);
    });

  it('requires the token (407) on CONNECT and plain HTTP, then tunnels both ways', async () => {
    const echo = net.createServer((s) => s.pipe(s));
    const echoPort = await listen(echo);
    const failures: string[] = [];
    const srv = proxy.createProxyServer({
      token: TOKEN,
      connectPorts: new Set([echoPort]),
      allowPrivate: true,
      onAuthFailure: (k: string) => failures.push(k),
    });
    const proxyPort = await listen(srv);
    try {
      const noAuth = await connectVia(proxyPort, `127.0.0.1:${echoPort}`);
      expect(noAuth.status).toBe('HTTP/1.1 407 Proxy Authentication Required');
      noAuth.sock.destroy();
      const badAuth = await connectVia(proxyPort, `127.0.0.1:${echoPort}`, proxy.expectedAuthHeader('f'.repeat(32)));
      expect(badAuth.status).toBe('HTTP/1.1 407 Proxy Authentication Required');
      badAuth.sock.destroy();
      expect(await httpVia(proxyPort, 'http://example.com/')).toMatch(/^HTTP\/1\.1 407/);
      expect(failures).toEqual(['no-credentials', 'bad-credentials', 'no-credentials']);

      const ok = await connectVia(proxyPort, `127.0.0.1:${echoPort}`, AUTH);
      expect(ok.status).toBe('HTTP/1.1 200 Connection Established');
      const echoed = await new Promise<string>((res) => {
        ok.sock.once('data', (d) => res(d.toString()));
        ok.sock.write('ping&client_id=x#y');
      });
      expect(echoed).toBe('ping&client_id=x#y');
      ok.sock.destroy();
      const denied = await connectVia(proxyPort, '127.0.0.1:22', AUTH);
      expect(denied.status).toBe('HTTP/1.1 403 Forbidden');
      denied.sock.destroy();
    } finally {
      srv.close();
      echo.close();
    }
  });

  it('denies loopback / RFC1918 destinations by literal and after DNS resolution', async () => {
    const srv = proxy.createProxyServer({ token: TOKEN });
    const proxyPort = await listen(srv);
    try {
      for (const target of ['127.0.0.1:443', '10.0.0.1:443', '192.168.1.10:443', '[::1]:443', 'localhost:443']) {
        const r = await connectVia(proxyPort, target, AUTH);
        expect([target, r.status]).toEqual([target, 'HTTP/1.1 403 Forbidden']);
        r.sock.destroy();
      }
      expect(await httpVia(proxyPort, 'http://127.0.0.1/', AUTH)).toMatch(/^HTTP\/1\.1 403/);
      expect(await httpVia(proxyPort, 'http://192.168.0.1/', AUTH)).toMatch(/^HTTP\/1\.1 403/);
    } finally {
      srv.close();
    }
  });

  it('safe lookup filters private results for all:true too', async () => {
    const lookup = proxy.makeSafeLookup(false);
    const err = await new Promise<NodeJS.ErrnoException | null>((res) => lookup('localhost', { all: true }, (e: NodeJS.ErrnoException | null) => res(e)));
    expect(err && err.code).toBe('EPRIVATEDEST');
  });

  it('writes "<port> <token>" (0600) to its port file and exits when the parent pid is gone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-proxy-'));
    const portFile = path.join(dir, 'port');
    const parent = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)']);
    const child = spawn(process.execPath, [proxyPath, '--port-file', portFile, '--parent-pid', String(parent.pid)], {
      stdio: 'ignore',
    });
    try {
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(portFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      const [port, token] = fs.readFileSync(portFile, 'utf8').trim().split(' ');
      expect(Number(port)).toBeGreaterThan(0);
      expect(token).toMatch(/^[0-9a-f]{32}$/);
      if (process.platform !== 'win32') expect(fs.statSync(portFile).mode & 0o777).toBe(0o600);
      const st = await connectVia(Number(port), 'example.com:443');
      expect(st.status).toBe('HTTP/1.1 407 Proxy Authentication Required');
      st.sock.destroy();
      const exited = new Promise<number | null>((res) => child.on('exit', (code) => res(code)));
      parent.kill('SIGKILL');
      const code = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r('timeout'), 8_000))]);
      expect(code).toBe(0);
    } finally {
      parent.kill('SIGKILL');
      child.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('shelly-claude-glibc() bashrc function (BASHRC_VERSION 275-279)', () => {
  const lines = homeKt.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes('sb.appendLine("shelly-claude-glibc() {")'));
  const fnLines: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const m = /^\s*sb\.appendLine\("(.*)"\)\s*$/.exec(lines[i]);
    if (!m) break;
    fnLines.push(m[1].replace(/\\(.)/g, '$1'));
    if (m[1] === '}') break;
  }
  const fn = fnLines.join('\n');

  it('bumped BASHRC_VERSION', () => {
    expect(homeKt).toMatch(/private const val BASHRC_VERSION = 279\b/);
  });

  it('S3: tmp dirs and the bionic lib dir reach claude only via command prefixes', () => {
    const cmd = /\n    HTTPS_PROXY="\$__proxy" [^]*?"\$__bin" "\$@"\n/.exec(fn)![0];
    expect(cmd).toContain('TMPDIR="$__tmp" CLAUDE_CODE_TMPDIR="$__ctmp" \\');
    // bionic lib dir for claude's children; glibc ld.so keeps --library-path
    expect(cmd).toContain('SHELLY_GLIBC_LD_LIBRARY_PATH="$SHELLY_LIB_DIR"');
    expect(cmd).not.toContain('SHELLY_GLIBC_LD_LIBRARY_PATH="$__root/lib"');
    expect(cmd).toContain('"$__ld" --library-path "$__root/lib" "$__bin" "$@"');
    const assigns = fn.split('\n').filter((l) => /^\s*(?:SHELL|PATH|CLAUDE_CODE_SHELL|CLAUDE_ENV_FILE|TMPDIR)=/.test(l));
    expect(assigns.length).toBe(2);
    for (const l of assigns) expect(l.endsWith('\\')).toBe(true);
    expect(fn).not.toMatch(/__xbin|USE_BUILTIN_RIPGREP|CLAUDE_CODE_SHELL_PREFIX/);
    expect(homeKt).not.toContain('linkClaudeGlibcExecShims');
    expect(fn).toMatch(/mkdir -p "\$__tmp" "\$__ctmp" 2>\/dev\/null/);
    // the .claude-tmp cleanup target must not be what claude uses as its tmp dir
    expect(fn).not.toContain('.claude-tmp');
  });


  it('S3: Bash tool shell is a bash-named /system/bin/sh link whose env file re-runs -c in Shelly bash', () => {
    const cmd = /\n    HTTPS_PROXY="\$__proxy" [^]*?"\$__bin" "\$@"\n/.exec(fn)![0];
    // user overrides win; ours are claude-only command prefixes
    expect(cmd).toContain('CLAUDE_CODE_SHELL="${CLAUDE_CODE_SHELL:-$__sh}" CLAUDE_ENV_FILE="${CLAUDE_ENV_FILE:-$__envf}" \\');
    expect(fn).toContain('__sh="$__root/bin/bash"');
    expect(fn).toContain('[ "$(readlink "$__sh" 2>/dev/null)" = /system/bin/sh ] || ln -sfn /system/bin/sh "$__sh"');
    const env = /cat > "\$__envf" <<'__SHELLY_CLAUDE_ENV'\n([^]*?)\n__SHELLY_CLAUDE_ENV\n/.exec(fn)![1];
    expect(env).toMatch(/^if \[ -z "\$\{BASH_VERSION:-\}" \]; then\n/);
    expect(env).toMatch(/\/system\/bin\/linker64 \S+\/shelly_shell -c 'mapfile -d "" -t __a < \/proc\/\$PPID\/cmdline; eval "\$\{__a\[-1\]\}"'/);
    expect(env).toMatch(/\n  exit \$\?\nfi$/);
  });

  it('loads ~/.claude-token.env only inside the subshell when no token is set', () => {
    expect(fn).toMatch(/\n    umask 077\n(?:    #[^\n]*\n)*    if \[ -z "\$\{CLAUDE_CODE_OAUTH_TOKEN:-\}" \] && \[ -f "\$HOME\/\.claude-token\.env" \]; then \. "\$HOME\/\.claude-token\.env"; fi\n/);
  });

  it('marks the force-TUI paste mode around claude so a pasted OAuth code is not corrupted', () => {
    expect(fn).toMatch(/__shelly_paste_tui_begin\n {2}\(/);
    expect(fn).toMatch(/__shelly_paste_tui_end\n {2}return \$__rc/);
  });

  it('runs in a subshell and never exports proxy/browser state to the interactive shell', () => {
    expect(start).toBeGreaterThan(0);
    expect(fn).toMatch(/^shelly-claude-glibc\(\) \{\n/);
    expect(fn).toMatch(/\n  \(\n[^]*\n  \)\n  local __rc=\$\?\n  __shelly_paste_tui_end\n  return \$__rc\n\}$/);
    expect(fn).not.toMatch(/\bexport\b/);
    expect(fn).toMatch(/unset BROWSER DISPLAY WAYLAND_DISPLAY/);
    expect(fn).toMatch(/\n    umask 077\n/);
  });

  it('starts the proxy itself in the background (no token in argv) tied to the subshell', () => {
    const launch = fn.split('\n').find((l) => l.includes('--port-file'))!;
    expect(launch).toContain(
      'LD_LIBRARY_PATH="$SHELLY_LD_LIBRARY_PATH" /system/bin/linker64 $libDir/node "$__proxy_js" --port-file "$__pfile" --parent-pid "$BASHPID"',
    );
    expect(launch).not.toMatch(/token/i);
    expect(fn).not.toMatch(/_run [^\n]*__proxy_js/);
    expect(fn).toMatch(/__proxy_pid=\$!/);
    expect(fn).toMatch(/trap __cleanup EXIT/);
    expect(fn).toMatch(/read -r __port __token < "\$__pfile"/);
  });

  it('passes the authenticated proxy env only as a prefix of the claude command', () => {
    expect(fn).toMatch(/__proxy="http:\/\/shelly:\$__token@127\.0\.0\.1:\$__port"/);
    const cmd = /\n    HTTPS_PROXY="\$__proxy" [^]*?"\$__bin" "\$@"\n/.exec(fn);
    expect(cmd).not.toBeNull();
    const c = cmd![0];
    for (const v of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) expect(c).toContain(`${v}="$__proxy"`);
    expect(c).toContain('NO_PROXY="localhost,127.0.0.1,::1"');
    const cl = c.trim().split('\n');
    for (const l of cl.slice(0, -1)) expect(l.endsWith('\\')).toBe(true);
  });

  it('arms the sign-in bridge only for interactive sessions and disarms only its own arm file', () => {
    expect(fn).toMatch(/__arm="\$HOME\/tmp\/\.shelly-claude-login\.arm"/);
    expect(fn).toMatch(/\[ -t 0 \] && \[ -t 1 \] \|\| __interactive=0/);
    expect(fn).toMatch(/-p\|--print\|--version\|-v\|--help\|-h\) __interactive=0/);
    expect(fn).toMatch(/\[ "\$__interactive" = 1 \] && printf '%s\\n' "\$__armtag" > "\$__arm"/);
    expect(fn).toMatch(/\[ "\$\(cat "\$__arm" 2>\/dev\/null\)" = "\$__armtag" \] && rm -f "\$__arm"/);
  });

  it('behaves end to end with a fake linker64: auth works, env reaches claude only, proxy stops afterwards', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-glibc-home-'));
    const posix = (p: string) => p.replace(/\\/g, '/');
    const rt = path.join(home, '.shelly-runtime/claude-glibc');
    fs.mkdirSync(path.join(rt, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(home, 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(rt, 'lib/ld-linux-aarch64.so.1'), '');
    fs.writeFileSync(path.join(rt, 'claude'), '');
    fs.writeFileSync(path.join(home, 'tmp/.shelly-claude-login.arm'), 'foreign 1\n');
    fs.copyFileSync(proxyPath, path.join(home, '.shelly-claude-proxy.js'));
    const fake = path.join(home, 'fake-linker64');
    // CONNECT to a private address: 403 proves the credentials from the proxy
    // URL were accepted (auth runs first); without them it must be 407.
    const probe = [
      "const u=new URL(process.env.HTTPS_PROXY);const net=require('net');",
      "const ask=(a)=>new Promise(r=>{const s=net.connect(+u.port,u.hostname,()=>s.write('CONNECT 10.0.0.1:443 HTTP/1.1\\r\\n'+(a?'Proxy-Authorization: Basic '+Buffer.from(decodeURIComponent(u.username)+':'+decodeURIComponent(u.password)).toString('base64')+'\\r\\n':'')+'\\r\\n'));let b='';s.on('data',d=>{b+=d;});s.on('close',()=>r(b.split('\\r\\n')[0]));s.on('error',()=>r('ERR'))});",
      "(async()=>{console.log('NOAUTH='+await ask(false));console.log('AUTH='+await ask(true));})();",
    ].join('');
    fs.writeFileSync(path.join(home, 'probe.js'), probe);
    fs.writeFileSync(
      fake,
      [
        'echo "HTTPS_PROXY=$HTTPS_PROXY"',
        'echo "NO_PROXY=$NO_PROXY"',
        'echo "BROWSER=${BROWSER-unset}"',
        'echo "SHELL=$SHELL"',
        'echo "CCTMP=$CLAUDE_CODE_TMPDIR"',
        'echo "GLIBCLP=$SHELLY_GLIBC_LD_LIBRARY_PATH"',
        'echo "ARGS=$*"',
        `"${posix(process.execPath)}" "${posix(path.join(home, 'probe.js'))}"`,
      ].join('\n'),
    );
    let body = fn
      .replace('LD_LIBRARY_PATH="$SHELLY_LD_LIBRARY_PATH" /system/bin/linker64 $libDir/node', `"${posix(process.execPath)}"`)
      .replace('LD_LIBRARY_PATH="$SHELLY_LIB_DIR" /system/bin/linker64', `LD_LIBRARY_PATH="$SHELLY_LIB_DIR" "$BASH" "${posix(fake)}"`);
    // MSYS/Git Bash pids are not Windows pids, so node cannot poll them there.
    if (process.platform === 'win32') body = body.replace(' --parent-pid "$BASHPID"', '');
    const script = [
      body,
      'export BROWSER=/x/xdg-open',
      'shelly-claude-glibc setup-token "a&b#c=d"',
      'echo "RC=$?"',
      'echo "PARENT_HTTPS_PROXY=${HTTPS_PROXY-unset}"',
      'echo "PARENT_BROWSER=$BROWSER"',
      'echo "PARENT_SHELL=$SHELL"',
      'echo "LEFTOVER=$(ls "$TMPDIR" | grep -c shelly-claude-proxy)"',
      'echo "ARM=$(cat "$TMPDIR/.shelly-claude-login.arm")"',
    ].join('\n');
    const out = await new Promise<string>((res, rej) => {
      const p = spawn('bash', ['-c', script], {
        env: {
          ...process.env,
          HOME: posix(home),
          TMPDIR: posix(path.join(home, 'tmp')),
          SHELLY_LIB_DIR: '/fake/lib',
          SHELL: '/x/interactive-bash',
        },
      });
      let o = '';
      p.stdout.on('data', (d) => (o += d));
      p.stderr.on('data', (d) => (o += d));
      p.on('exit', () => res(o));
      p.on('error', rej);
    });
    try {
      expect(out).toMatch(/HTTPS_PROXY=http:\/\/shelly:[0-9a-f]{32}@127\.0\.0\.1:\d+\r?\n/);
      expect(out).toContain('NO_PROXY=localhost,127.0.0.1,::1');
      expect(out).toContain('BROWSER=unset');
      // Git Bash rewrites C:/... HOME to /tmp/...; match the runtime-relative tail
      expect(out).toMatch(/\nSHELL=\/x\/interactive-bash\r?\n/);
      expect(out).toMatch(/\nCCTMP=\S*\/\.shelly-runtime\/claude-glibc\/tmp\r?\n/);
      expect(fs.existsSync(path.join(rt, 'tmp'))).toBe(true);
      expect(out).toContain('GLIBCLP=/fake/lib');
      expect(out).toContain('PARENT_SHELL=/x/interactive-bash');
      expect(out).toContain('ARGS=/fake/lib/shelly_glibc_exec');
      expect(out).toContain('setup-token a&b#c=d');
      expect(out).toContain('NOAUTH=HTTP/1.1 407 Proxy Authentication Required');
      expect(out).toContain('AUTH=HTTP/1.1 403 Forbidden');
      expect(out).toContain('RC=0');
      expect(out).toContain('PARENT_HTTPS_PROXY=unset');
      expect(out).toContain('PARENT_BROWSER=/x/xdg-open');
      expect(out).toContain('LEFTOVER=0');
      // not a TTY → not armed; and a foreign arm file is left alone
      expect(out).toContain('ARM=foreign 1');
      // the probe's deliberate unauthenticated request is reported after exit
      expect(out).toContain('did not send the private proxy credentials (407)');
      const port = Number(/127\.0\.0\.1:(\d+)/.exec(out)![1]);
      await new Promise((r) => setTimeout(r, 500));
      const stillUp = await new Promise<boolean>((res) => {
        const s = net.connect(port, '127.0.0.1', () => {
          s.destroy();
          res(true);
        });
        s.on('error', () => res(false));
      });
      expect(stillUp).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
