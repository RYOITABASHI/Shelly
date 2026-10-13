/**
 * __tests__/shelly-codex-remote.test.ts
 *
 * `shelly codex pair|code` (BASHRC_VERSION 252): hosts the official
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
    mkdir -p "$TMPDIR/codex-rc-new"
    : > "$TMPDIR/codex-rc-new/rc.sock"
    : > "$TMPDIR/codex-rc-new/alive"
    echo "This machine is available for remote control as test-host."
    local i=0
    while [ ! -f "$HOME/paired" ] && [ "$i" -lt 200 ]; do command sleep 0.05; i=$((i + 1)); done
    return 0
  fi
  if [ "$1 $2" = "remote-control pair" ]; then
    local link="\${CODEX_HOME:-$HOME/.codex}/app-server-control-termux/app-server-control.sock"
    local target
    target="$(readlink "$link" 2>/dev/null)"
    # A host "answers" only while its dir carries the alive marker.
    if [ -e "$link" ] && [ -e "\${target%/*}/alive" ]; then
      printf '%s\\n' "$target" > "$HOME/link-target"
      echo "Pairing code: ABCD-1234"
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
  const r = spawnSync('bash', ['-c', full], {
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
    expect(help.out).toContain('Usage: shelly codex <pair|code|help>');
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
