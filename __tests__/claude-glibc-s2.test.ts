/**
 * __tests__/claude-glibc-s2.test.ts
 *
 * Claude Code glibc S2 (BASHRC_VERSION 275): private proxy, OSC 8 sign-in URL
 * bridge, drain loop safety. See DEFERRED.md "Claude Code 公式 glibc 版（2.1.314）
 * を Shelly で動かす".
 *
 *  - lib/deep-link-open-guard.ts: 30 s same-URL dedupe + per-minute burst guard;
 *  - lib/deep-link-queue-policy.ts: Anthropic authorize URLs go to the external
 *    browser intact ('&', '#', '=', percent-escapes survive), nothing else does;
 *  - OAuthHyperlinkBridge.kt / TerminalEmulator.java: source invariants (CI
 *    builds Android but does not run Kotlin unit tests);
 *  - TerminalPane.tsx no longer auto-opens URLs seen in terminal OUTPUT;
 *  - shelly-xdg-open.c takes argv[1] whole;
 *  - assets/shelly-claude-proxy.js: CONNECT tunnel, port denial, port file,
 *    parent-pid lifetime;
 *  - the generated shelly-claude-glibc() bashrc function scopes the proxy env to
 *    the claude command only.
 */
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { createOpenGuard } from '@/lib/deep-link-open-guard';
import {
  resolveQueueLine,
  isAnthropicOAuthAuthorizeUrl,
  ANTHROPIC_OAUTH_AUTHORIZE,
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
const proxyPath = path.join(mainDir, 'assets/shelly-claude-proxy.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxy = require(proxyPath);

const SIGN_IN_URL =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e' +
  '&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback' +
  '&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&code_challenge=Ab_-9xYz' +
  '&code_challenge_method=S256&state=st4te=x#fragment';

describe('deep-link-open-guard', () => {
  it('opens a URL once per 30 s window, again after it', () => {
    const g = createOpenGuard();
    expect(g.check('https://a/', 0)).toEqual({ ok: true });
    expect(g.check('https://a/', 1_000)).toEqual({ ok: false, reason: 'duplicate' });
    expect(g.check('https://a/', 29_999)).toEqual({ ok: false, reason: 'duplicate' });
    expect(g.check('https://a/', 30_000)).toEqual({ ok: true });
  });

  it('drops a burst beyond maxPerMinute and recovers after the minute', () => {
    const g = createOpenGuard({ maxPerMinute: 3 });
    expect(g.check('https://1/', 0).ok).toBe(true);
    expect(g.check('https://2/', 10).ok).toBe(true);
    expect(g.check('https://3/', 20).ok).toBe(true);
    expect(g.check('https://4/', 30)).toEqual({ ok: false, reason: 'rate-limited' });
    // a dropped open does not count against the window
    expect(g.check('https://5/', 60_001).ok).toBe(true);
  });

  it('simulates the focus-regain loop: repeated identical lines open once', () => {
    const g = createOpenGuard();
    let opened = 0;
    for (let i = 0; i < 50; i++) if (g.check(SIGN_IN_URL, i * 400).ok) opened++;
    expect(opened).toBe(1);
  });
});

describe('deep-link-queue-policy — Anthropic sign-in URLs', () => {
  it('routes the OAuthHyperlinkBridge JSON line to the external browser with the URL intact', () => {
    const line = JSON.stringify({
      type: 'open-url',
      url: SIGN_IN_URL,
      authMode: 'external-browser',
      provider: 'anthropic',
    });
    const r = resolveQueueLine(line);
    expect(r.entry).not.toBeNull();
    expect(r.note).toBeUndefined();
    expect(r.entry!.authMode).toBe('external-browser');
    expect(r.entry!.url).toBe(SIGN_IN_URL);
    expect(r.entry!.url).toContain('&client_id=');
    expect(r.entry!.url.endsWith('#fragment')).toBe(true);
  });

  it('upgrades a legacy bare authorize line (e.g. from shelly-xdg-open.c)', () => {
    const r = resolveQueueLine(SIGN_IN_URL);
    expect(r.note).toBe('upgraded-to-external');
    expect(r.entry!.provider).toBe('anthropic');
    expect(r.entry!.url).toBe(SIGN_IN_URL);
  });

  it('keeps non-authorize Anthropic pages and look-alikes out of the external browser', () => {
    for (const u of [
      'https://claude.ai/settings',
      'https://claude.ai/oauth/authorize.evil',
      'http://claude.ai/oauth/authorize?x=1',
      'https://claude.ai:8443/oauth/authorize',
      'https://claude.ai@evil.example/oauth/authorize',
      'https://evil.example/oauth/authorize?next=https://claude.ai/oauth/authorize',
      'http://127.0.0.1:18080',
    ]) {
      expect(isAnthropicOAuthAuthorizeUrl(u)).toBe(false);
      const r = resolveQueueLine(JSON.stringify({ url: u, authMode: 'external-browser' }));
      if (r.entry) expect(r.entry.authMode).toBe('in-app');
    }
  });

  it('Kotlin bridge mirrors the TS host/path table', () => {
    const pairs: Array<[string, string]> = [];
    for (const line of bridgeKt.split(/\r?\n/)) {
      const m = /^\s*(.+) -> path == "([^"]+)"\s*$/.exec(line);
      if (!m) continue;
      for (const h of m[1].match(/"([a-z.]+)"/g) ?? []) pairs.push([h.slice(1, -1), m[2]]);
    }
    expect(new Map(pairs)).toEqual(new Map(ANTHROPIC_OAUTH_AUTHORIZE));
    expect(bridgeKt).toMatch(/"https"\.equals\(u\.scheme, ignoreCase = true\)/);
    expect(bridgeKt).toMatch(/rawUserInfo != null\) return false/);
    expect(bridgeKt).toContain('\\"authMode\\":\\"external-browser\\",\\"provider\\":\\"anthropic\\"');
    expect(bridgeKt).toMatch(/if \(!markFirstSeen\(uri\)\) return/);
  });
});

describe('OSC 8 plumbing (source invariants)', () => {
  it('TerminalEmulator observes OSC 8 URIs without rendering them', () => {
    expect(emulatorJava).toMatch(/public static volatile HyperlinkObserver sHyperlinkObserver;/);
    expect(emulatorJava).toMatch(/case 8: \{[^]*?textParameter\.indexOf\(';'\) \+ 1[^]*?observer\.onHyperlink\(uri\)[^]*?break;/);
  });

  it('HomeInitializer installs the bridge on every initialize()', () => {
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
});

describe('shelly-claude-proxy.js', () => {
  it('only allows CONNECT to 443 by default and parses v6 authorities', () => {
    expect(proxy.parseConnectTarget('api.anthropic.com:443')).toEqual({ host: 'api.anthropic.com', port: 443 });
    expect(proxy.parseConnectTarget('[::1]:443')).toEqual({ host: '::1', port: 443 });
    expect(proxy.parseConnectTarget('api.anthropic.com:22')).toBeNull();
    expect(proxy.parseConnectTarget('a b:443')).toBeNull();
    expect(proxy.parseConnectTarget('')).toBeNull();
  });

  const listen = (srv: net.Server): Promise<number> =>
    new Promise((res) => srv.listen(0, '127.0.0.1', () => res((srv.address() as net.AddressInfo).port)));

  const connectVia = (proxyPort: number, authority: string): Promise<{ status: string; sock: net.Socket }> =>
    new Promise((res, rej) => {
      const sock = net.connect(proxyPort, '127.0.0.1', () => sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
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
    });

  it('tunnels bytes both ways and denies other ports', async () => {
    const echo = net.createServer((s) => s.pipe(s));
    const echoPort = await listen(echo);
    const srv = proxy.createProxyServer({ connectPorts: new Set([echoPort]) });
    const proxyPort = await listen(srv);
    try {
      const ok = await connectVia(proxyPort, `127.0.0.1:${echoPort}`);
      expect(ok.status).toBe('HTTP/1.1 200 Connection Established');
      const echoed = await new Promise<string>((res) => {
        ok.sock.once('data', (d) => res(d.toString()));
        ok.sock.write('ping&client_id=x#y');
      });
      expect(echoed).toBe('ping&client_id=x#y');
      ok.sock.destroy();
      const denied = await connectVia(proxyPort, '127.0.0.1:22');
      expect(denied.status).toBe('HTTP/1.1 403 Forbidden');
      denied.sock.destroy();
    } finally {
      srv.close();
      echo.close();
    }
  });

  it('writes its port file and exits when the parent pid is gone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-proxy-'));
    const portFile = path.join(dir, 'port');
    const parent = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)']);
    const child = spawn(process.execPath, [proxyPath, '--port-file', portFile, '--parent-pid', String(parent.pid)], {
      stdio: 'ignore',
    });
    try {
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(portFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      const port = Number(fs.readFileSync(portFile, 'utf8').trim());
      expect(Number.isInteger(port) && port > 0).toBe(true);
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

describe('shelly-claude-glibc() bashrc function (BASHRC_VERSION 275)', () => {
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
    expect(homeKt).toMatch(/private const val BASHRC_VERSION = 275\b/);
  });

  it('extracts the proxy asset every launch', () => {
    expect(homeKt).toMatch(/context\.assets\.open\("shelly-claude-proxy\.js"\)/);
    expect(homeKt).toMatch(/File\(home, "\.shelly-claude-proxy\.js"\)/);
  });

  it('runs in a subshell and never exports proxy/browser state to the interactive shell', () => {
    expect(start).toBeGreaterThan(0);
    expect(fn).toMatch(/^shelly-claude-glibc\(\) \{\n/);
    expect(fn).toMatch(/\n  \(\n[^]*\n  \)\n\}$/);
    expect(fn).not.toMatch(/\bexport\b/);
    expect(fn).toMatch(/unset BROWSER DISPLAY WAYLAND_DISPLAY/);
  });

  it('starts a private proxy on a random port tied to the subshell lifetime', () => {
    expect(fn).toContain(
      'LD_LIBRARY_PATH="$SHELLY_LD_LIBRARY_PATH" /system/bin/linker64 $libDir/node "$__proxy_js" --port-file "$__pfile" --parent-pid "$BASHPID"',
    );
    expect(fn).not.toMatch(/_run [^\n]*__proxy_js/); // $! must be the proxy, not a function subshell
    expect(fn).toMatch(/__proxy_pid=\$!/);
    expect(fn).toMatch(/trap 'kill "\$__proxy_pid"[^']*' EXIT/);
    expect(fn).toMatch(/case "\$__port" in\n\s+''\|\*\[!0-9\]\*\)/);
  });

  it('passes the proxy env only as a prefix of the claude command', () => {
    const cmd = /\n    HTTPS_PROXY="\$__proxy" [^]*?"\$__bin" "\$@"\n/.exec(fn);
    expect(cmd).not.toBeNull();
    const c = cmd![0];
    for (const v of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) expect(c).toContain(`${v}="$__proxy"`);
    expect(c).toContain('NO_PROXY="localhost,127.0.0.1,::1"');
    expect(c).toContain('/system/bin/linker64');
    expect(c).toContain('"$SHELLY_LIB_DIR/shelly_glibc_exec"');
    // every line of the env-prefixed command continues with a backslash
    const cl = c.trim().split('\n');
    for (const l of cl.slice(0, -1)) expect(l.endsWith('\\')).toBe(true);
    expect(fn).toMatch(/__proxy="http:\/\/127\.0\.0\.1:\$__port"/);
  });

  it('behaves end to end with a fake linker64: env reaches claude only, proxy stops afterwards', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-glibc-home-'));
    const posix = (p: string) => p.replace(/\\/g, '/');
    const rt = path.join(home, '.shelly-runtime/claude-glibc');
    fs.mkdirSync(path.join(rt, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(rt, 'lib/ld-linux-aarch64.so.1'), '');
    fs.writeFileSync(path.join(rt, 'claude'), '');
    fs.copyFileSync(proxyPath, path.join(home, '.shelly-claude-proxy.js'));
    const fake = path.join(home, 'fake-linker64');
    const probe =
      "const u=new URL(process.env.HTTPS_PROXY);require('net').connect(+u.port,u.hostname,()=>{console.log('PROXY=up');process.exit(0)}).on('error',()=>{console.log('PROXY=down');process.exit(0)})";
    // Stands in for `/system/bin/linker64 … claude`: report env + argv and
    // prove the proxy is reachable at the advertised address.
    fs.writeFileSync(
      fake,
      [
        'echo "HTTPS_PROXY=$HTTPS_PROXY"',
        'echo "NO_PROXY=$NO_PROXY"',
        'echo "BROWSER=${BROWSER-unset}"',
        'echo "ARGS=$*"',
        `"${posix(process.execPath)}" -e "${probe}"`,
      ].join('\n'),
    );
    let body = fn
      .replace('LD_LIBRARY_PATH="$SHELLY_LD_LIBRARY_PATH" /system/bin/linker64 $libDir/node', `"${posix(process.execPath)}"`)
      .replace('/system/bin/linker64', `bash "${posix(fake)}"`);
    // MSYS/Git Bash pids are not Windows pids, so node cannot poll them there.
    if (process.platform === 'win32') body = body.replace(' --parent-pid "$BASHPID"', '');
    const script = [
      body,
      'export BROWSER=/x/xdg-open',
      'shelly-claude-glibc setup-token "a&b#c=d"',
      'echo "RC=$?"',
      'echo "PARENT_HTTPS_PROXY=${HTTPS_PROXY-unset}"',
      'echo "PARENT_BROWSER=$BROWSER"',
      'echo "LEFTOVER=$(ls "$TMPDIR" | grep -c shelly-claude-proxy)"',
    ].join('\n');
    const out = await new Promise<string>((res, rej) => {
      const p = spawn('bash', ['-c', script], {
        env: { ...process.env, HOME: posix(home), TMPDIR: posix(path.join(home, 'tmp')), SHELLY_LIB_DIR: '/fake/lib' },
      });
      let o = '';
      p.stdout.on('data', (d) => (o += d));
      p.stderr.on('data', (d) => (o += d));
      p.on('exit', () => res(o));
      p.on('error', rej);
    });
    try {
      expect(out).toMatch(/HTTPS_PROXY=http:\/\/127\.0\.0\.1:\d+\r?\n/);
      expect(out).toContain('NO_PROXY=localhost,127.0.0.1,::1');
      expect(out).toContain('BROWSER=unset');
      expect(out).toContain('ARGS=/fake/lib/shelly_glibc_exec');
      expect(out).toContain('setup-token a&b#c=d');
      expect(out).toContain('PROXY=up');
      expect(out).toContain('RC=0');
      expect(out).toContain('PARENT_HTTPS_PROXY=unset');
      expect(out).toContain('PARENT_BROWSER=/x/xdg-open');
      expect(out).toContain('LEFTOVER=0');
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
