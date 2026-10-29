/**
 * __tests__/shelly-codex-remote.test.ts
 *
 * `shelly codex pair|code|trust|status|stop` (BASHRC_VERSION 252, 257): hosts the official
 * `codex remote-control --no-daemon` for the ChatGPT app's Codex remote
 * control, links the host's private rendezvous socket where
 * `codex remote-control pair` looks for a daemon, and prints the manual
 * pairing code. The generated bash is extracted from the real
 * HomeInitializer.kt `sb.appendLine("...")` literals and run against a temp
 * HOME with codex()/the auth probe stubbed (no Codex binary, no network).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const ktPath = path.resolve(
  __dirname,
  '..',
  'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt',
);
const ktSrc = fs.readFileSync(ktPath, 'utf8');

function unescapeKotlin(lit: string): string {
  let out = '';
  for (let i = 0; i < lit.length; i++) {
    const ch = lit[i];
    if (ch === '\\' && i + 1 < lit.length) {
      const nx = lit[++i];
      out += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx;
      continue;
    }
    out += ch;
  }
  return out;
}

function appendLines(): string[] {
  return ktSrc
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*sb\.appendLine\("(.*)"\)\s*$/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => unescapeKotlin(m[1]));
}

/** Generated lines from the one equal to `start` up to (excluding) `end`. */
function extract(start: string, end: string): string {
  const lines = appendLines();
  const from = lines.indexOf(start);
  if (from < 0) throw new Error(`start not found: ${start}`);
  const to = lines.indexOf(end, from);
  if (to < 0) throw new Error(`end not found: ${end}`);
  return lines.slice(from, to).join('\n') + '\n';
}

const remoteFns = extract('__shelly_codex_remote_usage() {', 'shelly-codex-smoke() {');
const shellyFn = extract('shelly() {', 'hash -r 2>/dev/null || true');

const hasBash = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok';
const maybe = hasBash ? describe : describe.skip;
// Git Bash's `ln -s` copies instead of linking unless native symlinks are
// available (MSYS=winsymlinks:nativestrict + Developer Mode); the
// link-lifecycle cases only run where real symlinks work (always on CI).
function nativeSymlinksWork(): boolean {
  if (process.platform !== 'win32') return true;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-symlink-probe-'));
  try {
    fs.writeFileSync(path.join(dir, 'a'), '');
    fs.symlinkSync(path.join(dir, 'a'), path.join(dir, 'b'));
    return fs.lstatSync(path.join(dir, 'b')).isSymbolicLink();
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const itPosix = nativeSymlinksWork() ? it : it.skip;

let home: string;

function posix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Stubs: codex() records its argv and simulates the host / pair calls. */
const STUBS = `
__shelly_codex_remote_auth_ok() { [ "\${STUB_AUTH:-ok}" = ok ]; }
_run() { echo "_run $*" >> "$HOME/calls.log"; return 0; }
sleep() { command sleep 0.05; }
codex() {
  echo "codex $*" >> "$HOME/calls.log"
  if [ "$1 $2" = "remote-control --no-daemon" ]; then
    printf 'host-name=%s\\n' "$(printenv SHELLY_CODEX_HOST_NAME)" >> "$HOME/calls.log"
    mkdir -p "$TMPDIR/codex-rc-new"
    : > "$TMPDIR/codex-rc-new/rc.sock"
    : > "$TMPDIR/codex-rc-new/alive"
    echo "This machine is available for remote control as test-host."
    local i=0
    while [ ! -f "$HOME/paired" ] && [ "$i" -lt 200 ]; do command sleep 0.05; i=$((i + 1)); done
    if [ "\${STUB_HOST_STAY:-0}" = 1 ]; then
      while :; do command sleep 0.1; done
    fi
    # A real host keeps running; give the pairer time to finish printing.
    command sleep 1
    return 0
  fi
  if [ "$1 $2" = "remote-control pair" ]; then
    local link="\${CODEX_HOME:-$HOME/.codex}/app-server-control-termux/app-server-control.sock"
    local target
    target="$(readlink "$link" 2>/dev/null)"
    # A host "answers" only while its dir carries the alive marker.
    if [ -e "$link" ] && [ -e "\${target%/*}/alive" ]; then
      printf '%s\\n' "$target" > "$HOME/link-target"
      if [ "\${3:-}" = --json ] && [ "\${STUB_PAIR_JSON:-1}" = 1 ]; then
        printf '{"pairingCode":"pc","manualPairingCode":"ABCD-1234","environmentId":"env","expiresAt":%s}\\n' "$(( $(date +%s) + 600 ))"
      else
        echo "Pairing code: ABCD-1234"
      fi
      : > "$HOME/paired"
      return 0
    fi
    echo "Error: no app-server is listening" >&2
    return 1
  fi
  return 0
}
`;

function run(script: string, env: Record<string, string> = {}) {
  const full = `${remoteFns}\n${shellyFn}\n${STUBS}\n${script}`;
  // Run from a file, not `bash -c`: Windows argv quoting mangles the
  // backslash/quote mixes in the generated bash.
  const scriptFile = path.join(home, `run-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(scriptFile, full);
  const r = spawnSync('bash', [posix(scriptFile)], {
    encoding: 'utf8',
    env: { ...(process.env as Record<string, string>), MSYS: 'winsymlinks:nativestrict', HOME: posix(home), TMPDIR: `${posix(home)}/tmp`, ...env } as unknown as NodeJS.ProcessEnv,
    timeout: 30000,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-codex-rc-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('shelly codex remote-control generator', () => {
  it('bumps BASHRC_VERSION to >= 252 and routes `shelly codex` in the bash function', () => {
    const m = ktSrc.match(/private const val BASHRC_VERSION = (\d+)\b/);
    expect(Number(m![1])).toBeGreaterThanOrEqual(252);
    expect(shellyFn).toMatch(/if \[ "\$\{1:-\}" = codex \]; then\n\s+shift\n\s+__shelly_codex_remote "\$@"/);
  });

  it('uses the official foreground host and the official pair subcommand only', () => {
    expect(remoteFns).toContain('codex remote-control --no-daemon');
    expect(remoteFns).toContain('codex remote-control pair');
    // The daemon path (`remote-control start`) needs the hardcoded Termux
    // socket root even before pairing; Shelly never relies on it.
    expect(remoteFns).not.toMatch(/codex remote-control start/);
  });

  it('checks ChatGPT auth with the same probe codex() uses', () => {
    expect(remoteFns).toContain('a.auth_mode==="chatgpt"&&a.tokens&&a.tokens.refresh_token');
  });
});

maybe('shelly codex (bash)', () => {
  it('help prints usage and exits 0; unknown subcommands exit 2', () => {
    const help = run('shelly codex help');
    expect(help.code).toBe(0);
    expect(help.out).toContain('Usage: shelly codex <pair|code|trust|untrust|status|stop|autostart|help>');
    const bad = run('shelly codex frobnicate');
    expect(bad.code).toBe(2);
  });

  it('code without a running host fails with a hint', () => {
    const r = run('shelly codex code');
    expect(r.code).toBe(1);
    expect(r.out).toContain('shelly codex pair');
  });

  it('pair refuses without a ChatGPT sign-in and never starts the host', () => {
    const r = run('shelly codex pair', { STUB_AUTH: 'missing' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('ChatGPT sign-in');
    const calls = fs.existsSync(path.join(home, 'calls.log')) ? fs.readFileSync(path.join(home, 'calls.log'), 'utf8') : '';
    expect(calls).not.toContain('remote-control');
  });

  itPosix('pair hosts in the foreground, links the new socket, prints the code, then unlinks', () => {
    // A stale host dir from an earlier run must not be picked.
    fs.mkdirSync(path.join(home, 'tmp', 'codex-rc-old'), { recursive: true });
    fs.writeFileSync(path.join(home, 'tmp', 'codex-rc-old', 'rc.sock'), '');
    const r = run('shelly codex pair; echo "rc=$?"');
    expect(r.out).toContain('Pairing code: ABCD-1234');
    expect(r.out).toContain('rc=0');
    const calls = fs.readFileSync(path.join(home, 'calls.log'), 'utf8');
    expect(calls).toContain('codex remote-control --no-daemon');
    expect(calls).toContain('codex remote-control pair');
    // (MSYS may report the temp dir under its /tmp alias, so match the tail.)
    const target = fs.readFileSync(path.join(home, 'link-target'), 'utf8').trim();
    expect(target.endsWith(`${path.basename(home)}/tmp/codex-rc-new/rc.sock`)).toBe(true);
    const link = path.join(home, '.codex', 'app-server-control-termux', 'app-server-control.sock');
    expect(fs.existsSync(link)).toBe(false);
    let isLink = false;
    try {
      isLink = fs.lstatSync(link).isSymbolicLink();
    } catch {
      isLink = false;
    }
    expect(isLink).toBe(false);
  });

  function linkPath() {
    return path.join(home, '.codex', 'app-server-control-termux', 'app-server-control.sock');
  }
  function linkLeft(): boolean {
    try {
      fs.lstatSync(linkPath());
      return true;
    } catch {
      return false;
    }
  }
  function liveHost(name: string) {
    const sockDir = path.join(home, 'tmp', name);
    fs.mkdirSync(sockDir, { recursive: true });
    fs.writeFileSync(path.join(sockDir, 'rc.sock'), '');
    fs.writeFileSync(path.join(sockDir, 'alive'), '');
  }

  itPosix('pair with a live host just prints a fresh code and leaves no link behind', () => {
    liveHost('codex-rc-live');
    const r = run('shelly codex pair');
    expect(r.code).toBe(0);
    expect(r.out).toContain('already running');
    expect(r.out).toContain('Pairing code: ABCD-1234');
    expect(fs.readFileSync(path.join(home, 'calls.log'), 'utf8')).not.toContain('--no-daemon');
    expect(linkLeft()).toBe(false);
  });

  itPosix('code mints a code from the running host and unlinks again', () => {
    liveHost('codex-rc-live');
    const r = run('shelly codex code');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Pairing code: ABCD-1234');
    expect(linkLeft()).toBe(false);
  });

  itPosix('code against only dead hosts reports failure, not success', () => {
    fs.mkdirSync(path.join(home, 'tmp', 'codex-rc-dead'), { recursive: true });
    fs.writeFileSync(path.join(home, 'tmp', 'codex-rc-dead', 'rc.sock'), '');
    const r = run('shelly codex code');
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain('Pairing code');
    expect(linkLeft()).toBe(false);
  });

  itPosix('a dangling link left by a crashed host is removed before starting a new one', () => {
    const linkDir = path.join(home, '.codex', 'app-server-control-termux');
    fs.mkdirSync(linkDir, { recursive: true });
    fs.symlinkSync(`${posix(home)}/tmp/codex-rc-gone/rc.sock`, path.join(linkDir, 'app-server-control.sock'));
    const r = run('shelly codex pair');
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('already running');
    expect(r.out).toContain('Pairing code: ABCD-1234');
    expect(linkLeft()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// v257: trust / host name / expiry / background host
// ---------------------------------------------------------------------------
describe('shelly codex v257 generator invariants', () => {
  it('bumps BASHRC_VERSION to >= 257', () => {
    const m = ktSrc.match(/private const val BASHRC_VERSION = (\d+)\b/);
    expect(Number(m![1])).toBeGreaterThanOrEqual(257);
  });

  it('asks Codex for the pairing code as JSON so the expiry can be shown', () => {
    expect(remoteFns).toContain('codex remote-control pair --json');
    expect(remoteFns).toContain('"expiresAt"');
  });

  it('passes the host name only to the remote-control launches', () => {
    const launches = remoteFns.match(/SHELLY_CODEX_HOST_NAME="\$__name" codex remote-control --no-daemon/g) || [];
    expect(launches.length).toBe(3); // foreground + --background + autostart __host
    expect(remoteFns).toContain('/system/bin/getprop "$__k"');
  });

  it('writes trust entries only for a resolved directory, in the Codex trust-prompt format', () => {
    expect(remoteFns).toContain('__canon="$(__shelly_codex_remote_canon "$__dir")"');
    expect(remoteFns).toContain(`printf '\\n[projects."%s"]\\ntrust_level = "trusted"\\n' "$__k"`);
  });
});

maybe('shelly codex v257 (bash)', () => {
  function cfgPath() {
    return path.join(home, '.codex', 'config.toml');
  }
  function canon(rel: string): string {
    return run(`cd "$HOME/${rel}" && pwd -P`).out.trim();
  }

  it('pair prints the code, its expiry and the next step; host name defaults to "Shelly"', () => {
    const r = run('shelly codex pair');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Pairing code: ABCD-1234');
    expect(r.out).toMatch(/Expires( at \d\d:\d\d)? \(in about (9|10|11) min\)/);
    expect(r.out).toContain('shelly codex code');
    expect(r.out).toContain('as "Shelly');
    expect(fs.readFileSync(path.join(home, 'calls.log'), 'utf8')).toContain('codex remote-control pair --json');
  });

  it('SHELLY_CODEX_HOST_NAME overrides the name and reaches the host process env', () => {
    const r = run('shelly codex pair', { SHELLY_CODEX_HOST_NAME: 'My Fold' });
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(home, 'calls.log'), 'utf8')).toContain('host-name=My Fold');
  });

  it('host name is capped to 63 bytes and loses control characters', () => {
    const r = run(
      `__shelly_codex_remote_host_name | wc -c; echo; SHELLY_CODEX_HOST_NAME=$'a\\tb' __shelly_codex_remote_host_name`,
      { SHELLY_CODEX_HOST_NAME: 'x'.repeat(100) },
    );
    expect(r.out.split('\n')[0].trim()).toBe('63');
    expect(r.out.trim().endsWith('ab')).toBe(true);
  });

  itPosix('falls back to the raw pair output when Codex does not return JSON', () => {
    const r = run('shelly codex pair', { STUB_PAIR_JSON: '0' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Pairing code: ABCD-1234');
    expect(r.out).not.toContain('Expires');
  });

  it('pair lists trusted projects (home as ~) and hints at `shelly codex trust`', () => {
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const h = canon('.');
    fs.writeFileSync(
      cfgPath(),
      `model = "x"\n\n[projects."${h}"]\ntrust_level = "trusted"\n\n[projects."/elsewhere"]\ntrust_level = "untrusted"\n`,
    );
    const r = run('shelly codex pair');
    expect(r.out).toContain('Trusted Codex projects');
    expect(r.out).toMatch(/\n {2}- ~\n/);
    expect(r.out).not.toContain('/elsewhere');
    expect(r.out).toContain('shelly codex trust <dir>');
  });

  it('status without any trusted project says so', () => {
    const r = run('shelly codex status');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Background host: not running');
    expect(r.out).toContain('(none yet)');
  });

  it('trust writes the Codex trust-prompt entry for the realpath, idempotently', () => {
    fs.mkdirSync(path.join(home, 'myapp'));
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(cfgPath(), 'model = "gpt"'); // no trailing newline
    const r = run('shelly codex trust "$HOME/myapp"');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Trusted for Codex');
    const c = canon('myapp');
    const cfg = fs.readFileSync(cfgPath(), 'utf8');
    expect(cfg).toBe(`model = "gpt"\n\n[projects."${c}"]\ntrust_level = "trusted"\n`);
    const again = run('shelly codex trust "$HOME/myapp/"');
    expect(again.code).toBe(0);
    expect(again.out).toContain('Already trusted');
    expect(fs.readFileSync(cfgPath(), 'utf8')).toBe(cfg);
    expect(run('shelly codex status').out).toMatch(/\n {2}- ~\/myapp\n/);
  });

  it('trust flips an explicit untrusted entry in place', () => {
    fs.mkdirSync(path.join(home, 'proj'));
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const c = canon('proj');
    fs.writeFileSync(cfgPath(), `[projects."${c}"]\ntrust_level = "untrusted"\n\n[tui]\nx = 1\n`);
    const r = run('shelly codex trust "$HOME/proj"');
    expect(r.code).toBe(0);
    expect(fs.readFileSync(cfgPath(), 'utf8')).toBe(`[projects."${c}"]\ntrust_level = "trusted"\n\n[tui]\nx = 1\n`);
  });

  it('trust refuses /, missing dirs, ancestors of HOME and inline project tables', () => {
    expect(run('shelly codex trust /').code).toBe(1);
    expect(run('shelly codex trust "$HOME/nope"').out).toContain('Not a directory');
    const parent = run('shelly codex trust "$HOME/.."');
    expect(parent.code).toBe(1);
    expect(parent.out).toContain('contains the Shelly home directory');
    expect(run('shelly codex trust').code).toBe(2);
    fs.mkdirSync(path.join(home, 'p2'));
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(cfgPath(), 'projects = { "/x" = { trust_level = "trusted" } }\n');
    const inline = run('shelly codex trust "$HOME/p2"');
    expect(inline.code).toBe(1);
    expect(inline.out).toContain('inline table');
    expect(fs.readFileSync(cfgPath(), 'utf8')).toBe('projects = { "/x" = { trust_level = "trusted" } }\n');
  });

  it('maps /data/user/0 and /data/data spellings onto each other', () => {
    const r = run(
      '__shelly_codex_remote_alias /data/user/0/dev.shelly.terminal/files/home/a; echo; __shelly_codex_remote_alias /data/data/p/x; echo; __shelly_codex_remote_alias /sdcard/x; echo end',
    );
    expect(r.out).toBe('/data/data/dev.shelly.terminal/files/home/a\n/data/user/0/p/x\nend\n');
  });

  // Needs /proc/<pid>/stat (Linux; Git Bash's /proc works too).
  const itProc = process.platform === 'linux' || process.platform === 'win32' ? it : it.skip;
  itProc('pair --background detaches the host; status and stop manage it', () => {
    const r = run('shelly codex pair --background; echo "rc=$?"', { STUB_HOST_STAY: '1' });
    expect(r.out).toContain('Pairing code: ABCD-1234');
    expect(r.out).toContain('rc=0');
    expect(r.out).toContain('shelly codex stop');
    const state = fs.readFileSync(path.join(home, 'tmp', 'shelly-codex-remote.host'), 'utf8').trim().split(' ');
    const pid = Number(state[0]);
    expect(pid).toBeGreaterThan(1);
    // The background host gets its own TMPDIR, so stop can always find its rc dir.
    expect(fs.readFileSync(path.join(home, 'tmp', 'shelly-codex-remote.host.sock'), 'utf8')).toContain(
      'shelly-codex-bg/codex-rc-new/rc.sock',
    );
    expect(run('shelly codex status').out).toContain(`running (pid ${pid}`);
    // A second pair never starts another host while the tracked one is alive.
    const again = run('shelly codex pair --background', { STUB_HOST_STAY: '1' });
    expect(again.out).toContain('already running');
    expect(fs.readFileSync(path.join(home, 'calls.log'), 'utf8').match(/--no-daemon/g)!.length).toBe(1);
    const stop = run('shelly codex stop');
    expect(stop.code).toBe(0);
    expect(stop.out).toContain('Stopped');
    expect(run(`kill -0 ${pid} 2>/dev/null && echo alive || echo gone`).out.trim()).toBe('gone');
    expect(fs.existsSync(path.join(home, 'tmp', 'shelly-codex-bg', 'codex-rc-new'))).toBe(false);
    expect(run('shelly codex stop').code).toBe(1);
  });

  itProc('stop never signals a pid whose start time does not match', () => {
    fs.mkdirSync(path.join(home, 'tmp'), { recursive: true });
    // The state file names this very shell, with a wrong start time.
    const r = run(`printf '%s 999999999\\n' "$$" > "$TMPDIR/shelly-codex-remote.host"; shelly codex stop; echo "rc=$? survived"`);
    expect(r.out).toContain('No background');
    expect(r.out).toContain('rc=1 survived');
  });
});

// ---------------------------------------------------------------------------
// v258: review follow-ups
// ---------------------------------------------------------------------------
maybe('shelly codex v258 (bash)', () => {
  function cfgPath() {
    return path.join(home, '.codex', 'config.toml');
  }
  function canon(rel: string): string {
    return run(`cd "$HOME/${rel}" && pwd -P`).out.trim();
  }
  function writeCfg(s: string) {
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(cfgPath(), s);
  }

  it('cuts the default host name to 63 bytes on a UTF-8 boundary', () => {
    const out = run('__shelly_codex_remote_host_name', { SHELLY_CODEX_HOST_NAME: `Shelly ${'あ'.repeat(30)}` }).out;
    expect(Buffer.byteLength(out, 'utf8')).toBe(7 + 18 * 3);
    expect(out).not.toContain('�');
    expect(out).toBe(`Shelly ${'あ'.repeat(18)}`);
  });

  it('validates UTF-8 (Japanese allowed, truncated or stray bytes refused)', () => {
    const r = run(
      `for s in 'myアプリ' $'\\xff' $'\\xe3\\x81' $'a\\x80'; do __shelly_codex_remote_utf8_ok "$s" && echo ok || echo bad; done`,
    );
    expect(r.out.trim().split('\n')).toEqual(['ok', 'bad', 'bad', 'bad']);
  });

  it('trusts a Japanese-named folder', () => {
    fs.mkdirSync(path.join(home, 'アプリ'));
    const r = run('shelly codex trust "$HOME/アプリ"');
    expect(r.code).toBe(0);
    expect(fs.readFileSync(cfgPath(), 'utf8')).toContain(`[projects."${canon('アプリ')}"]`);
  });

  it('refuses $HOME itself with a hint to trust a subfolder', () => {
    const r = run('shelly codex trust "$HOME"');
    expect(r.code).toBe(1);
    expect(r.out).toContain('Trust the project folder instead');
    expect(fs.existsSync(cfgPath())).toBe(false);
  });

  it('shared storage needs --yes', () => {
    fs.mkdirSync(path.join(home, 'sd'));
    const fake = `__shelly_codex_remote_canon() { case "$1" in *sd) printf /storage/emulated/0/proj ;; *) (cd "$1" && pwd -P) ;; esac; }`;
    const no = run(`${fake}; shelly codex trust "$HOME/sd"`);
    expect(no.code).toBe(1);
    expect(no.out).toContain('shelly codex trust --yes');
    expect(fs.existsSync(cfgPath())).toBe(false);
    const yes = run(`${fake}; shelly codex trust --yes "$HOME/sd"`);
    expect(yes.code).toBe(0);
    expect(fs.readFileSync(cfgPath(), 'utf8')).toContain('[projects."/storage/emulated/0/proj"]');
  });

  it('the HOME-ancestor check compares /data/data and /data/user/0 spellings', () => {
    fs.mkdirSync(path.join(home, 'up'));
    const fake = `__shelly_codex_remote_canon() { case "$1" in *up) printf /data/data/dev.shelly.terminal/files ;; *) printf /data/user/0/dev.shelly.terminal/files/home ;; esac; }`;
    const r = run(`${fake}; shelly codex trust "$HOME/up"`);
    expect(r.code).toBe(1);
    expect(r.out).toContain('contains the Shelly home directory');
  });

  it('finds an existing table despite CRLF, indentation, spacing and comments, and flips only its key line', () => {
    fs.mkdirSync(path.join(home, 'crlf'));
    const c = canon('crlf');
    writeCfg(`model = "x"\r\n  [ projects . "${c}" ]  # mine\r\n  trust_level = 'untrusted' # was\r\n\r\n[tui]\r\nx = 1\r\n`);
    const r = run('shelly codex trust "$HOME/crlf"');
    expect(r.code).toBe(0);
    expect(fs.readFileSync(cfgPath(), 'utf8')).toBe(
      `model = "x"\r\n  [ projects . "${c}" ]  # mine\r\ntrust_level = "trusted"\r\n\r\n[tui]\r\nx = 1\r\n`,
    );
    // Reader agrees, so a second run is a no-op (no duplicate table).
    expect(run('shelly codex trust "$HOME/crlf"').out).toContain('Already trusted');
  });

  it('leaves look-alike lines (array items, other tables) alone', () => {
    fs.mkdirSync(path.join(home, 'arr'));
    const c = canon('arr');
    const before =
      `[projects."/other"]\ntrust_level = "untrusted"\n\n` +
      `[projects."${c}"]\nnotes = [\n  "trust_level = \\"x\\"",\n]\ntrust_level = "untrusted"\n`;
    writeCfg(before);
    expect(run('shelly codex trust "$HOME/arr"').code).toBe(0);
    expect(fs.readFileSync(cfgPath(), 'utf8')).toBe(before.replace(/trust_level = "untrusted"\n$/, 'trust_level = "trusted"\n'));
  });

  it('adds trust_level right under an existing table that has none', () => {
    fs.mkdirSync(path.join(home, 'bare'));
    const c = canon('bare');
    writeCfg(`[projects."${c}"]\nother = 1\n`);
    expect(run('shelly codex trust "$HOME/bare"').code).toBe(0);
    expect(fs.readFileSync(cfgPath(), 'utf8')).toBe(`[projects."${c}"]\ntrust_level = "trusted"\nother = 1\n`);
  });

  itPosix('writes through a symlinked config.toml and keeps its mode', () => {
    fs.mkdirSync(path.join(home, 'lnk'));
    const c = canon('lnk');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const real = path.join(home, 'real-config.toml');
    fs.writeFileSync(real, `[projects."${c}"]\ntrust_level = "untrusted"\n`);
    fs.chmodSync(real, 0o640);
    fs.symlinkSync(real, cfgPath());
    expect(run('shelly codex trust "$HOME/lnk"').code).toBe(0);
    expect(fs.lstatSync(cfgPath()).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe(`[projects."${c}"]\ntrust_level = "trusted"\n`);
    if (process.platform !== 'win32') expect(fs.statSync(real).mode & 0o777).toBe(0o640);
  });
});

// ---------------------------------------------------------------------------
// v270: `shelly codex untrust <dir>`
// ---------------------------------------------------------------------------
maybe('shelly codex untrust (bash)', () => {
  function cfgPath() {
    return path.join(home, '.codex', 'config.toml');
  }
  function canon(rel: string): string {
    return run(`cd "$HOME/${rel}" && pwd -P`).out.trim();
  }
  function writeCfg(s: string) {
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(cfgPath(), s);
  }

  it('exactly reverses trust (byte for byte, with or without a final newline) and status reflects it', () => {
    fs.mkdirSync(path.join(home, 'myapp'));
    for (const before of ['model = "gpt"\n# keep me\n', 'model = "gpt"']) {
      writeCfg(before);
      expect(run('shelly codex trust "$HOME/myapp"').code).toBe(0);
      expect(run('shelly codex status').out).toMatch(/\n {2}- ~\/myapp\n/);
      const r = run('shelly codex untrust "$HOME/myapp/"');
      expect(r.code).toBe(0);
      expect(r.out).toContain('Removed the trusted entry for Codex');
      const after = fs.readFileSync(cfgPath(), 'utf8');
      expect(after).toBe(before.endsWith('\n') ? before : before + '\n');
      expect(run('shelly codex status').out).toContain('(none yet)');
    }
  });

  it('removes only the target table and keeps other tables, comments and CRLF', () => {
    fs.mkdirSync(path.join(home, 'a'));
    const c = canon('a');
    const head = `model = "x"\r\n# top comment\r\n\r\n[projects."/other"]\r\ntrust_level = "trusted"\r\n`;
    const tail = `\r\n[tui]\r\nx = 1 # note\r\n`;
    writeCfg(head + `\r\n  [ projects . "${c}" ]  # mine\r\n  trust_level = 'trusted'\r\n` + tail);
    const r = run('shelly codex untrust "$HOME/a"');
    expect(r.code).toBe(0);
    expect(fs.readFileSync(cfgPath(), 'utf8')).toBe(head + tail);
  });

  it('keeps a table that has other settings, dropping only its trust_level line', () => {
    fs.mkdirSync(path.join(home, 'b'));
    const c = canon('b');
    writeCfg(`[projects."${c}"]\ntrust_level = "trusted"\nother = 1\n\n[tui]\nx = 1\n`);
    expect(run('shelly codex untrust "$HOME/b"').code).toBe(0);
    expect(fs.readFileSync(cfgPath(), 'utf8')).toBe(`[projects."${c}"]\nother = 1\n\n[tui]\nx = 1\n`);
  });

  it('is a no-op with a clear message when not trusted, untrusted, or no config exists', () => {
    fs.mkdirSync(path.join(home, 'c'));
    const c = canon('c');
    const none = run('shelly codex untrust "$HOME/c"');
    expect(none.code).toBe(0);
    expect(none.out).toContain('No Codex config');
    expect(fs.existsSync(cfgPath())).toBe(false);
    const before = `[projects."${c}"]\ntrust_level = "untrusted"\n\n[projects."/x"]\ntrust_level = "trusted"\n`;
    writeCfg(before);
    const r = run('shelly codex untrust "$HOME/c"');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Not trusted, nothing to change');
    expect(fs.readFileSync(cfgPath(), 'utf8')).toBe(before);
  });

  it('accepts the absolute path of a folder that no longer exists; refuses usage errors and inline tables', () => {
    writeCfg(`a = 1\n\n[projects."/gone/proj"]\ntrust_level = "trusted"\n`);
    expect(run('shelly codex untrust /gone/proj').code).toBe(0);
    expect(fs.readFileSync(cfgPath(), 'utf8')).toBe('a = 1\n');
    expect(run('shelly codex untrust').code).toBe(2);
    expect(run('shelly codex untrust a b').code).toBe(2);
    expect(run('shelly codex untrust relative-missing').code).toBe(1);
    writeCfg('projects = { "/x" = { trust_level = "trusted" } }\n');
    const inline = run('shelly codex untrust /x');
    expect(inline.code).toBe(1);
    expect(inline.out).toContain('inline table');
    expect(fs.readFileSync(cfgPath(), 'utf8')).toBe('projects = { "/x" = { trust_level = "trusted" } }\n');
  });

  itPosix('writes through a symlinked config.toml and keeps its mode', () => {
    fs.mkdirSync(path.join(home, 'lnk'));
    const c = canon('lnk');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const real = path.join(home, 'real-config.toml');
    fs.writeFileSync(real, `x = 1\n\n[projects."${c}"]\ntrust_level = "trusted"\n`);
    fs.chmodSync(real, 0o600);
    fs.symlinkSync(real, cfgPath());
    expect(run('shelly codex untrust "$HOME/lnk"').code).toBe(0);
    expect(fs.lstatSync(cfgPath()).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe('x = 1\n');
    if (process.platform !== 'win32') expect(fs.statSync(real).mode & 0o777).toBe(0o600);
  });
});

describe('v258 generator invariants', () => {
  it('bumps BASHRC_VERSION to >= 258', () => {
    const m = ktSrc.match(/private const val BASHRC_VERSION = (\d+)\b/);
    expect(Number(m![1])).toBeGreaterThanOrEqual(258);
  });

  it('runs the background host with its own TMPDIR', () => {
    expect(remoteFns).toContain('TMPDIR="$__bgtmp" SHELLY_CODEX_HOST_NAME="$__name" codex remote-control --no-daemon');
  });
});

// ---------------------------------------------------------------------------
// v264: Keep ChatGPT connected (autostart) -- shim side of CodexRemoteHost.kt
// ---------------------------------------------------------------------------
describe('v266 generator invariants', () => {
  it('bumps BASHRC_VERSION to >= 266', () => {
    const m = ktSrc.match(/private const val BASHRC_VERSION = (\d+)\b/);
    expect(Number(m![1])).toBeGreaterThanOrEqual(266);
  });

  it('uses the file names CodexRemoteHost.kt reads', () => {
    const native = fs.readFileSync(
      path.resolve(
        __dirname,
        '..',
        'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/CodexRemoteHost.kt',
      ),
      'utf8',
    );
    for (const name of [
      'codex-remote-autostart-off-request',
      'shelly-codex-remote.stopped',
      'shelly-codex-remote.host',
      'shelly-codex-remote.log',
    ]) {
      expect(remoteFns).toContain(name);
      expect(native).toContain(name);
    }
    expect(native).toContain('__shelly_codex_remote __host');
  });

  it('H1: no generated shell code can write the ON switch or a paired marker', () => {
    // The mirror is only ever READ by the shell.
    expect(remoteFns).not.toMatch(/>\s*"\\?\$HOME\/\.shelly\/codex-remote-autostart"/);
    expect(remoteFns).not.toMatch(/printf 'on\\n'/);
    expect(remoteFns).not.toContain('codex-remote-paired');
    expect(ktSrc).not.toContain('codex-remote-paired');
  });
});

maybe('shelly codex autostart (bash)', () => {
  const mirrorFile = () => path.join(home, '.shelly', 'codex-remote-autostart');
  const offRequest = () => path.join(home, '.shelly', 'codex-remote-autostart-off-request');
  const stoppedFile = () => path.join(home, 'tmp', 'shelly-codex-remote.stopped');
  const itProc = process.platform === 'linux' || process.platform === 'win32' ? it : it.skip;

  it('status reads the native mirror and points to Settings', () => {
    const off = run('shelly codex autostart status');
    expect(off.code).toBe(0);
    expect(off.out).toContain('(autostart): off');
    expect(off.out).toContain('Settings');
    expect(run('shelly codex status').out).toContain('(autostart): off');
    fs.mkdirSync(path.join(home, '.shelly'), { recursive: true });
    fs.writeFileSync(mirrorFile(), 'on\n');
    expect(run('shelly codex autostart').out).toContain('(autostart): on');
  });

  it('H1: `autostart on` cannot enable it from a shell', () => {
    const r = run('shelly codex autostart on; echo "rc=$?"');
    expect(r.out).toContain('rc=1');
    expect(r.out).toContain('Turn this on in Shelly Settings');
    expect(fs.existsSync(mirrorFile())).toBe(false);
    expect(fs.existsSync(path.join(home, '.shelly', 'codex-remote-paired'))).toBe(false);
  });

  it('off writes an off request for the native supervisor and mentions the ChatGPT app', () => {
    const r = run('shelly codex autostart off');
    expect(r.code).toBe(0);
    expect(fs.existsSync(offRequest())).toBe(true);
    expect(r.out).toContain('remove this device in the ChatGPT app');
  });

  it('rejects unknown autostart arguments', () => {
    expect(run('shelly codex autostart maybe').code).toBe(2);
    expect(run('shelly codex autostart off now').code).toBe(2);
  });

  itProc('H2: pair --background leaves autostart alone and points to the Settings toggle', () => {
    const r = run('shelly codex pair --background; echo "rc=$?"; shelly codex stop >/dev/null', { STUB_HOST_STAY: '1' });
    expect(r.out).toContain('rc=0');
    expect(r.out).toContain('Settings > Codex Login > Keep ChatGPT connected');
    expect(r.out).not.toContain('Keep ChatGPT connected is ON');
    expect(fs.existsSync(mirrorFile())).toBe(false);
    expect(fs.existsSync(offRequest())).toBe(false);
    expect(fs.existsSync(path.join(home, '.shelly', 'codex-remote-paired'))).toBe(false);
  });

  it('stop leaves the stop marker and explains autostart', () => {
    fs.mkdirSync(path.join(home, '.shelly'), { recursive: true });
    fs.writeFileSync(mirrorFile(), 'on\n');
    const r = run('shelly codex stop');
    expect(fs.existsSync(stoppedFile())).toBe(true);
    expect(r.out).toContain('next time you open Shelly');
  });

  itProc('__host runs the host in the foreground with its own TMPDIR and a "native" state line', () => {
    const r = run(
      [
        '( shelly codex __host; echo "host-rc=$?" > "$HOME/host-rc" ) &',
        'for i in $(seq 1 100); do [ -s "$TMPDIR/shelly-codex-remote.host" ] && break; command sleep 0.05; done',
        'cat "$TMPDIR/shelly-codex-remote.host"',
        'shelly codex status',
        ': > "$HOME/paired"',
        'for i in $(seq 1 200); do [ -f "$HOME/host-rc" ] && break; command sleep 0.05; done',
        'cat "$HOME/host-rc"',
      ].join('\n'),
    );
    expect(r.out).toMatch(/^\d+ \d+ native$/m);
    expect(r.out).toContain('Background host: running');
    expect(r.out).toContain('host-rc=0');
    expect(fs.readFileSync(path.join(home, 'calls.log'), 'utf8')).toContain('codex remote-control --no-daemon');
    expect(fs.existsSync(path.join(home, 'tmp', 'shelly-codex-remote.host'))).toBe(false);
    expect(fs.readFileSync(path.join(home, 'tmp', 'shelly-codex-remote.log'), 'utf8')).toContain('autostart host starting');
  });

  it('__host refuses without sign-in (exit 3) and never starts codex', () => {
    const r = run('shelly codex __host; echo "rc=$?"', { STUB_AUTH: 'missing' });
    expect(r.out).toContain('rc=3');
    const calls = fs.existsSync(path.join(home, 'calls.log')) ? fs.readFileSync(path.join(home, 'calls.log'), 'utf8') : '';
    expect(calls).not.toContain('remote-control');
  });

  itProc('__host refuses a second instance while a tracked host is alive (exit 4)', () => {
    fs.mkdirSync(path.join(home, 'tmp'), { recursive: true });
    const r = run(
      'printf \'%s %s\\n\' "$$" "$(__shelly_codex_remote_proc_start $$)" > "$TMPDIR/shelly-codex-remote.host"; shelly codex __host; echo "rc=$?"',
    );
    expect(r.out).toContain('rc=4');
  });
});
