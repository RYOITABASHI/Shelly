/**
 * __tests__/shelly-device.test.ts
 *
 * `shelly device <command>` (SHELLY_HELPER_SHIM v23, BASHRC_VERSION 272).
 * - parse(): argument parsing of assets/shelly-device.js.
 * - end to end: the generated helper's node body (extracted from
 *   HomeInitializer.kt) + the asset, run against a temp $HOME while a fake
 *   "native side" answers request files the way DeviceApi.kt does.
 * - source invariants for the Kotlin half (rate limits, no identifiers,
 *   watcher wiring, en/ja strings) — CI only builds Android, it does not run
 *   Kotlin unit tests.
 * - lib/agent-boundary-policy.ts treats `clipboard get` as a secret read.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { classifyProposedCommand, GateContext } from '@/lib/agent-boundary-policy';

const root = path.resolve(__dirname, '..');
const modDir = path.join(root, 'modules/terminal-emulator/android/src/main');
const ktDir = path.join(modDir, 'java/expo/modules/terminalemulator');
const read = (p: string) => fs.readFileSync(p, 'utf8');
const assetPath = path.join(modDir, 'assets/shelly-device.js');
const homeKt = read(path.join(ktDir, 'HomeInitializer.kt'));
const deviceKt = read(path.join(ktDir, 'DeviceApi.kt'));
const limiterKt = read(path.join(ktDir, 'DeviceApiRateLimiter.kt'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const device = require(assetPath);

function unescapeKotlin(lit: string): string {
  let out = '';
  for (let i = 0; i < lit.length; i++) {
    const ch = lit[i];
    if (ch === '\\' && i + 1 < lit.length) {
      const nx = lit[++i];
      out += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx;
      continue;
    }
    if (ch === '$' && /[A-Za-z{]/.test(lit[i + 1] ?? '')) throw new Error(`unescaped Kotlin template: ${lit}`);
    out += ch;
  }
  return out;
}

function extractShimJs(): string {
  const body: string[] = [];
  let on = false;
  for (const line of homeKt.split(/\r?\n/)) {
    const m = line.match(/^\s*sb\.appendLine\("(.*)"\)\s*$/);
    if (!m) continue;
    if (!on && m[1] === "const fs = require('fs');") on = true;
    if (!on) continue;
    const text = unescapeKotlin(m[1]);
    if (text === 'SHELLY_HELPER_NODE') break;
    body.push(text);
  }
  return body.join('\n') + '\n';
}

const io = (over: Partial<{ stdinIsTty: boolean; cwd: string; fileExists: (p: string) => boolean }> = {}) => ({
  stdinIsTty: true,
  cwd: '/home/u',
  fileExists: () => false,
  ...over,
});

describe('shelly-device.js parse()', () => {
  const usage = (argv: string[], o = io()) => {
    try {
      device.parse(argv, o);
    } catch (e) {
      expect(e).toBeInstanceOf(device.UsageError);
      return (e as Error).message;
    }
    throw new Error('expected a usage error for ' + JSON.stringify(argv));
  };

  it('prints the overview for no command / help / --help', () => {
    for (const argv of [[], ['help'], ['--help'], ['-h']]) {
      const r = device.parse(argv, io());
      expect(r.help[0]).toBe('Usage: shelly device <command> [options]');
    }
  });

  it('per-command --help never builds a request', () => {
    for (const cmd of ['battery', 'info', 'clipboard', 'notify', 'toast', 'vibrate', 'tts', 'share']) {
      const r = device.parse([cmd, '--help'], io());
      expect(r.help).toBeDefined();
      expect(r.op).toBeUndefined();
    }
    expect(device.parse(['clipboard', 'get', '--help'], io()).help).toBeDefined();
    expect(device.parse(['notify', '--title', 'x', '--help'], io()).help).toBeDefined();
  });

  it('battery / info are JSON data commands without arguments', () => {
    expect(device.parse(['battery'], io())).toMatchObject({ op: 'battery', args: {}, output: 'json' });
    expect(device.parse(['info'], io())).toMatchObject({ op: 'info', output: 'json' });
    expect(usage(['battery', 'now'])).toMatch(/unexpected argument/);
  });

  it('unknown commands and options are usage errors', () => {
    expect(usage(['location'])).toMatch(/unknown command 'location'/);
    expect(usage(['camera', 'photo'])).toMatch(/unknown command/);
    expect(usage(['toast', '--loud', 'x'])).toMatch(/unknown option --loud/);
    expect(usage(['toast', '-x', 'hi'])).toMatch(/unknown option -x/);
    expect(usage(['clipboard', 'paste'])).toMatch(/unknown clipboard command/);
  });

  it('clipboard get (raw or --json)', () => {
    expect(device.parse(['clipboard', 'get'], io())).toMatchObject({ op: 'clipboard.get', output: 'clipboard' });
    expect(device.parse(['clipboard', 'get', '--json'], io())).toMatchObject({ output: 'clipboard-json' });
  });

  it('clipboard set from arguments, "-" or a non-tty stdin', () => {
    expect(device.parse(['clipboard', 'set', 'hello', 'world'], io())).toMatchObject({
      op: 'clipboard.set',
      args: { text: 'hello world', sensitive: false },
    });
    expect(device.parse(['clipboard', 'set', '--sensitive', 'pw'], io()).args.sensitive).toBe(true);
    expect(device.parse(['clipboard', 'set', '-'], io()).readStdin).toBe(true);
    // L6: stdin only with an explicit "-" -- a pipe alone is not enough.
    expect(usage(['clipboard', 'set'], io({ stdinIsTty: false }))).toMatch(/missing text/);
    expect(usage(['clipboard', 'set'], io({ stdinIsTty: true }))).toMatch(/missing text/);
    expect(device.parse(['clipboard', 'set', '--', '-n'], io()).args.text).toBe('-n');
    expect(usage(['clipboard', 'set', 'x'.repeat(100001)])).toMatch(/longer than 100000/);
  });

  it('notify: title, id 0-9999 (default 0), --remove', () => {
    expect(device.parse(['notify', '--title', 'Build', 'done', 'ok'], io())).toMatchObject({
      op: 'notify',
      args: { title: 'Build', text: 'done ok', id: 0 },
    });
    expect(device.parse(['notify', '--id=42', 'x'], io()).args.id).toBe(42);
    expect(device.parse(['notify', '--remove', '42'], io())).toMatchObject({ op: 'notify.remove', args: { id: 42 } });
    expect(usage(['notify', '--id', '10000', 'x'])).toMatch(/0 to 9999/);
    expect(usage(['notify', '--id', '-1', 'x'])).toMatch(/0 to 9999/);
    expect(usage(['notify', '--remove', '1', 'extra'])).toMatch(/--remove takes only/);
    expect(usage(['notify', '--title', 'only'])).toMatch(/missing text/);
    expect(usage(['notify', '--title'])).toMatch(/needs a value/);
    expect(usage(['notify', '--title', 'x'.repeat(101), 'y'])).toMatch(/title is longer/);
  });

  it('toast needs text', () => {
    expect(device.parse(['toast', 'hi', 'there'], io()).args.text).toBe('hi there');
    expect(usage(['toast'])).toMatch(/missing text/);
    expect(usage(['toast', '   '])).toMatch(/missing text/);
  });

  it('vibrate defaults to 300 ms and caps at 2000 ms', () => {
    expect(device.parse(['vibrate'], io()).args.ms).toBe(300);
    expect(device.parse(['vibrate', '50'], io()).args.ms).toBe(50);
    const capped = device.parse(['vibrate', '60000'], io());
    expect(capped.args.ms).toBe(device.MAX_VIBRATE_MS);
    expect(capped.notes[0]).toMatch(/capped at 2000 ms/);
    expect(usage(['vibrate', '0'])).toMatch(/whole number/);
    expect(usage(['vibrate', '1.5'])).toMatch(/whole number/);
    expect(usage(['vibrate', 'long'])).toMatch(/whole number/);
  });

  it('tts with an optional BCP-47 --lang', () => {
    expect(device.parse(['tts', 'こんにちは'], io())).toMatchObject({ op: 'tts', args: { text: 'こんにちは' } });
    expect(device.parse(['tts', 'こんにちは'], io()).args.lang).toBeUndefined();
    expect(device.parse(['tts', '--lang', 'ja-JP', 'hi'], io()).args.lang).toBe('ja-JP');
    expect(usage(['tts', '--lang', 'ja_JP', 'hi'])).toMatch(/language tag/);
    expect(usage(['tts', '--lang', '../x', 'hi'])).toMatch(/language tag/);
  });

  it('share picks file vs text, with --text / --file overrides', () => {
    const report = path.resolve('/home/u', 'report.pdf'); // platform-native (tests also run on Windows)
    const exists = (p: string) => p === report;
    expect(device.parse(['share', 'report.pdf'], io({ fileExists: exists }))).toMatchObject({
      op: 'share',
      args: { kind: 'file', path: report },
    });
    expect(device.parse(['share', 'hello', 'world'], io({ fileExists: exists })).args).toEqual({ kind: 'text', text: 'hello world' });
    expect(device.parse(['share', '--text', 'report.pdf'], io({ fileExists: exists })).args.kind).toBe('text');
    expect(usage(['share', '--file', 'missing.txt'], io({ fileExists: exists }))).toMatch(/no such file/);
    expect(usage(['share', '--file', 'a', 'b'], io({ fileExists: exists }))).toMatch(/exactly one path/);
    expect(usage(['share'])).toMatch(/missing file or text/);
  });
});

const REQ_RE = /^\.shelly-device-req-([0-9]{10,16}-[0-9a-f]{8})$/;
jest.setTimeout(20000); // each end-to-end case spawns node

describe('generated helper: shelly device (end to end with a fake native side)', () => {
  let tmp: string;
  let shimPath: string;
  let home: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-device-'));
    shimPath = path.join(tmp, 'shim.js');
    fs.writeFileSync(shimPath, extractShimJs());
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(tmp, 'home-'));
    fs.copyFileSync(assetPath, path.join(home, '.shelly-device.js'));
  });

  type Req = { v: number; reqId: string; ts: number; op: string; args: Record<string, unknown> };
  /** Answers each request like DeviceApi.kt: claim (delete), then result. */
  function fakeNative(answer: (req: Req) => Record<string, unknown> | null, seen: Req[] = []) {
    return (h: string) => {
      for (const name of fs.readdirSync(h)) {
        const m = name.match(REQ_RE);
        if (!m) continue;
        const req = JSON.parse(fs.readFileSync(path.join(h, name), 'utf8')) as Req;
        fs.unlinkSync(path.join(h, name));
        seen.push(req);
        const res = answer(req);
        if (res) fs.writeFileSync(path.join(h, `.shelly-device-result-${m[1]}.json`), JSON.stringify(res));
      }
    };
  }

  /** opts.fd3: the caller's stdin as the helper hands it over (fd 3 +
   *  SHELLY_DEVICE_STDIN_FD=3); opts.stdin goes to node's own fd 0. */
  function run(
    args: string[],
    opts: { app?: (home: string) => void; stdin?: string; fd3?: string; env?: Record<string, string> } = {},
  ) {
    return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ...(opts.env || {}) };
      delete env.SHELLY_DEVICE_STDIN_FD;
      if (opts.fd3 !== undefined) env.SHELLY_DEVICE_STDIN_FD = '3';
      const child = spawn(process.execPath, [shimPath, 'device', ...args], {
        env,
        cwd: home,
        stdio: opts.fd3 !== undefined ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout!.on('data', (b) => (out += b));
      child.stderr!.on('data', (b) => (err += b));
      if (opts.stdin !== undefined) child.stdin!.end(opts.stdin);
      else child.stdin!.end();
      if (opts.fd3 !== undefined) (child.stdio[3] as NodeJS.WritableStream).end(opts.fd3);
      const h = home; // bind to THIS test's home, never a later test's
      const timer = opts.app ? setInterval(() => opts.app!(h), 30) : null;
      child.on('close', (code) => {
        if (timer) clearInterval(timer);
        resolve({ code, out, err });
      });
    });
  }

  const leftovers = () => fs.readdirSync(home).filter((n) => n.startsWith('.shelly-device-req-') || n.startsWith('.shelly-device-result-'));

  it('shelly --help lists the device command', async () => {
    const r = await new Promise<string>((resolve) => {
      const c = spawn(process.execPath, [shimPath, '--help'], { env: { ...process.env, HOME: home } });
      let o = '';
      c.stdout.on('data', (b) => (o += b));
      c.on('close', () => resolve(o));
    });
    expect(r).toContain('shelly device <battery|info|clipboard|notify|toast|vibrate|tts|share>');
  });

  it('device --help prints usage, exits 0 and writes no request', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Usage: shelly device <command> [options]');
    expect(r.out).toMatch(/clipboard get.*hands whatever is on the clipboard|Privacy: "clipboard get"/s);
    expect(leftovers()).toEqual([]);
  });

  it('battery prints the native JSON and the request is well-formed', async () => {
    const seen: Req[] = [];
    const data = { level: 83, charging: true, plugged: 'usb', status: 'charging', health: 'good', temperatureC: 31.5, voltageMv: 4123 };
    const r = await run(['battery'], { app: fakeNative(() => ({ ok: true, code: 'ok', message: '', data }), seen) });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual(data);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ v: 1, op: 'battery', args: {} });
    expect(Math.abs(seen[0].ts - Date.now())).toBeLessThan(10000);
    expect(leftovers()).toEqual([]);
  });

  it('clipboard get prints the raw text (no added newline when piped)', async () => {
    const r = await run(['clipboard', 'get'], {
      app: fakeNative(() => ({ ok: true, code: 'ok', message: '', data: { text: 'line1\nline2', empty: false } })),
    });
    expect(r.code).toBe(0);
    expect(r.out).toBe('line1\nline2');
  });

  it('clipboard get --json', async () => {
    const r = await run(['clipboard', 'get', '--json'], {
      app: fakeNative(() => ({ ok: true, code: 'ok', message: '', data: { text: 'x' } })),
    });
    expect(JSON.parse(r.out)).toEqual({ text: 'x' });
  });

  it('clipboard set - reads the caller stdin from fd 3 and drops one trailing newline', async () => {
    const seen: Req[] = [];
    const r = await run(['clipboard', 'set', '-'], {
      fd3: 'piped text\n',
      stdin: 'HEREDOC-MUST-NOT-BE-READ',
      app: fakeNative(() => ({ ok: true, code: 'ok' }), seen),
    });
    expect(r.code).toBe(0);
    expect(seen[0]).toMatchObject({ op: 'clipboard.set', args: { text: 'piped text', sensitive: false } });
  });

  it('through the helper without fd 3, "-" is refused instead of reading the heredoc stdin', async () => {
    const r = await run(['clipboard', 'set', '-'], { stdin: 'HEREDOC-MUST-NOT-BE-READ' });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/stdin is not available here/);
    expect(leftovers()).toEqual([]);
  });

  it('clipboard set with only a pipe (no "-") is a usage error, never an empty set', async () => {
    const r = await run(['clipboard', 'set'], { fd3: 'x' });
    expect(r.code).toBe(2);
    expect(leftovers()).toEqual([]);
  });

  it('maps native failure codes to exit codes with a clean stderr line', async () => {
    const cases: [string, number][] = [
      ['background', 3],
      ['permission', 3],
      ['unavailable', 3],
      ['rate_limited', 4],
      ['usage', 2],
      ['error', 1],
    ];
    for (const [code, exit] of cases) {
      const r = await run(['toast', 'hi'], {
        app: fakeNative(() => ({ ok: false, code, message: 'native says \u001b[31mno\u001b[0m' })),
      });
      expect(r.code).toBe(exit);
      expect(r.err).toContain('shelly device toast: native says');
      expect(r.err).not.toContain('\u001b');
    }
  }, 30000);

  it('usage errors exit 2 without writing a request', async () => {
    const r = await run(['vibrate', 'forever']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/shelly device: duration must be a whole number/);
    expect(r.err).toContain('Run "shelly device vibrate --help" for usage.');
    expect(leftovers()).toEqual([]);
  });

  it('times out with exit 124 and removes its unclaimed request', async () => {
    const r = await run(['battery'], { env: { SHELLY_DEVICE_TIMEOUT_MS: '300' } });
    expect(r.code).toBe(124);
    expect(r.err).toMatch(/Shelly did not answer/);
    expect(r.err).toMatch(/The action may still happen on the phone/);
    expect(leftovers()).toEqual([]);
  });

  it('share prints the native message (share sheet or background notification)', async () => {
    const seen: Req[] = [];
    const r = await run(['share', 'some text'], {
      app: fakeNative(() => ({ ok: true, code: 'ok', message: 'Opened the share sheet on the phone' }), seen),
    });
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe('Opened the share sheet on the phone');
    expect(seen[0].args).toEqual({ kind: 'text', text: 'some text' });
  });

  it('share of an existing file sends its absolute path', async () => {
    fs.writeFileSync(path.join(home, 'out.txt'), 'x');
    const seen: Req[] = [];
    await run(['share', 'out.txt'], { app: fakeNative(() => ({ ok: true, code: 'ok', message: '' }), seen) });
    expect(seen[0].args).toEqual({ kind: 'file', path: path.join(home, 'out.txt') });
  });
});

describe('HomeInitializer wiring (BASHRC_VERSION 272 / shim v23)', () => {
  it('bumps the bashrc and shim versions', () => {
    expect(Number(homeKt.match(/private const val BASHRC_VERSION = (\d+)/)![1])).toBeGreaterThanOrEqual(272);
    expect(Number(homeKt.match(/# SHELLY_HELPER_SHIM v(\d+)/)![1])).toBeGreaterThanOrEqual(23);
  });

  it('extracts the client asset every launch', () => {
    expect(homeKt).toContain('val deviceScript = File(home, ".shelly-device.js")');
    expect(homeKt).toContain('context.assets.open("shelly-device.js")');
  });

  it('keeps the caller stdin on fd 3 for device only', () => {
    expect(homeKt).toContain(
      'sb.appendLine("if [ \\"\\${1:-}\\" = device ] && { exec 3<&0; } 2>/dev/null; then export SHELLY_DEVICE_STDIN_FD=3; else unset SHELLY_DEVICE_STDIN_FD; fi")',
    );
  });
});

describe('DeviceApi.kt invariants', () => {
  it('uses the request/result file bridge with a strict request-id pattern', () => {
    expect(deviceKt).toContain('const val REQUEST_FILE_PREFIX = ".shelly-device-req-"');
    expect(deviceKt).toContain('const val RESULT_FILE_PREFIX = ".shelly-device-result-"');
    expect(deviceKt).toContain('Regex("^\\\\.shelly-device-req-([0-9]{10,16}-[0-9a-f]{8})$")');
    // claim before executing: a request runs at most once
    expect(deviceKt).toMatch(/if \(!file\.delete\(\)\) return[\s\S]*dispatch\(context, reqId, ts, op, args\)/);
  });

  it('rate limits every side effect (pinned to the help text and README)', () => {
    expect(deviceKt).toContain('"notify" to (30 to DeviceApiRateLimiter(30, WINDOW_MS))');
    expect(deviceKt).toContain('"toast" to (10 to DeviceApiRateLimiter(10, WINDOW_MS))');
    expect(deviceKt).toContain('"vibrate" to (10 to DeviceApiRateLimiter(10, WINDOW_MS))');
    expect(deviceKt).toContain('"tts" to (10 to DeviceApiRateLimiter(10, WINDOW_MS))');
    expect(deviceKt).toContain('"share" to (5 to DeviceApiRateLimiter(5, WINDOW_MS))');
    expect(deviceKt).toContain('const val MAX_VIBRATE_MS = 2_000L');
    expect(read(assetPath)).toContain('(notify 30/min, toast, vibrate and tts 10/min, share 5/min)');
    expect(limiterKt).toContain('class DeviceApiRateLimiter(private val maxEvents: Int, private val windowMs: Long)');
  });

  it('never reads device identifiers or location-class data', () => {
    for (const banned of [
      'ANDROID_ID',
      'getSerial',
      'Build.SERIAL',
      'getImei',
      'getDeviceId',
      'TelephonyManager',
      'WifiManager',
      'LinkProperties',
      'LocationManager',
      'getMacAddress',
    ]) {
      expect(deviceKt).not.toContain(banned);
    }
  });

  it('never logs clipboard or notification text', () => {
    const logLines = deviceKt.split('\n').filter((l) => /Log\.[iwd]\(/.test(l));
    for (const l of logLines) expect(l).not.toMatch(/\$text|\$shown|\$title|\$\{text/);
  });

  it('announces every clipboard read and never leaves the text lying around', () => {
    const get = deviceKt.slice(deviceKt.indexOf('private fun clipboardGet('), deviceKt.indexOf('private fun announceClipboardRead('));
    expect(get).toContain('announceClipboardRead(context)');
    expect(get).toContain('CLIPBOARD_ANSWER_WINDOW_MS');
    expect(get).toContain('ephemeral = true');
    // the announcement is not behind a rate limiter (clipboard.get is not a side effect op)
    expect(deviceKt).toContain('val sideEffect = op in setOf("notify", "toast", "vibrate", "tts", "share")');
    expect(deviceKt).toContain('private const val EPHEMERAL_RESULT_MS = 15_000L');
    expect(deviceKt).toContain('executor?.schedule({ target.delete() }, EPHEMERAL_RESULT_MS, TimeUnit.MILLISECONDS)');
  });

  it('prefixes toasts ("Script: ") and keeps the poll alive on any Throwable', () => {
    expect(deviceKt).toContain('context.getString(R.string.device_api_toast_format, text)');
    expect(read(path.join(modDir, 'res/values/device_api_strings.xml'))).toContain('<string name="device_api_toast_format">Script: %1$s</string>');
    expect(deviceKt).toMatch(/scan\(context\)\r?\n\s*\} catch \(e: Throwable\)/);
  });

  it('share: allow-list (no dot component) and a per-request snapshot, never the original path', () => {
    const share = deviceKt.slice(deviceKt.indexOf('// ── share'), deviceKt.indexOf('// ── Watcher lifecycle'));
    expect(share).toContain('path.split(\'/\').any { it.startsWith(".") }');
    expect(share).toContain('android.system.Os.readlink("/proc/self/fd/${pfd.fd}")');
    expect(share).toContain('File(shareDir(context), reqId)');
    expect(share).toContain('FileProvider.getUriForFile(context, "${context.packageName}.shelly.fileprovider", snapshot)');
    expect(share).not.toMatch(/getUriForFile\([^)]*\b(pre|file)\)/);
    expect(share).toContain('REQUEST_CODE_SHARE_BASE + slot');
    expect(share).toContain('SHARE_NOTIFICATION_BASE + slot');
    const plugin = read(path.join(root, 'plugins/with-apk-installer.js'));
    expect(plugin).toContain('<cache-path name="device_share" path="share/" />');
  });

  it('is started next to the other file-bridge watchers', () => {
    expect(read(path.join(ktDir, 'TerminalSessionService.kt'))).toContain('DeviceApi.ensureWatching(applicationContext)');
    expect(read(path.join(ktDir, 'TerminalEmulatorModule.kt'))).toContain('DeviceApi.ensureWatching(context)');
  });

  it('has every string in en and ja', () => {
    const keys = (p: string) => [...read(p).matchAll(/<string name="([a-z_]+)"/g)].map((m) => m[1]).sort();
    const en = keys(path.join(modDir, 'res/values/device_api_strings.xml'));
    const ja = keys(path.join(modDir, 'res/values-ja/device_api_strings.xml'));
    expect(en.length).toBeGreaterThan(0);
    expect(ja).toEqual(en);
    for (const m of deviceKt.matchAll(/R\.string\.(device_api_[a-z_]+)/g)) expect(en).toContain(m[1]);
  });
});

describe('agent boundary policy: clipboard get is a secret read', () => {
  const ROOT = '/data/user/0/dev.shelly.terminal/files/home/projects/app';
  const ctx = (level: GateContext['level']): GateContext => ({ workspaceRoot: ROOT, level, policyPath: '.shelly/agents/policy.json' });

  it.each([
    'shelly device clipboard get',
    "bash -lc 'shelly device clipboard get'",
    'shelly device clipboard get --json',
    '~/bin/shelly device clipboard get > out.txt',
    "shelly 'device' \"clipboard\" get",
    'shelly device clip\\board get',
    'shelly device "clip"board get',
    "shelly device clipboard g''et",
    "shelly device clipboard $'get'",
    "shelly device clipboard $'\\x67et'",
    'S=shelly; $S device clipboard get',
    'bash ~/.shelly/shelly-helper.sh device clipboard get',
    `bash -lc "shelly device 'clip'board get"`,
    'c=clipboard; shelly device $c get',
    'shelly device clipboard "$op"',
    'cat ~/.shelly-device-result-1760500000000-0123abcd.json',
    'cat .shelly-device-result-1760500000000-0123abcd.json',
    `echo '{}' > "$HOME/.shelly-device-req-1760500000000-0123abcd"`,
    `node -e "require(process.env.HOME + '/.shelly-device.js').main(['battery'])"`,
  ])('%s -> secret-read (human at L1/L2, denied at L3)', (cmd) => {
    expect(classifyProposedCommand(cmd, ctx('L2')).signals).toContain('secret-read');
    expect(classifyProposedCommand(cmd, ctx('L1')).decision).toBe('gray');
    expect(classifyProposedCommand(cmd, ctx('L2')).decision).toBe('gray');
    expect(classifyProposedCommand(cmd, ctx('L3')).decision).toBe('deny');
  });

  it.each([
    'shelly device clipboard set hello',
    'shelly device battery',
    'shelly device notify done',
    'shelly device notify --title Build "$RESULT"',
    'shelly device toast "$(date)"',
  ])(
    '%s is not a secret read',
    (cmd) => {
      expect(classifyProposedCommand(cmd, ctx('L2')).signals).not.toContain('secret-read');
    },
  );
});
