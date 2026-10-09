/**
 * __tests__/codex-python-env.test.ts
 *
 * Regression (device build 2514, Codex CLI 0.156.1): a Codex-executed
 * `python3 hello.py` died with "Could not find platform independent
 * libraries ... Fatal Python error: Failed to import encodings module".
 * Codex runs tool commands through its own shell, so the interactive bash
 * python3() function (which sets PYTHONHOME/PYTHONPATH) is bypassed and the
 * bare binary — exec'd through libexec_wrapper.so -> linker64 — can't derive
 * its prefix. BASHRC_VERSION 246 exports PYTHONHOME/PYTHONPATH into Codex's
 * environment from the codex() function, the $HOME/bin/codex shim and
 * shelly-agent-driver.js (app-server). It also exports TZ from
 * persist.sys.timezone when unset (Codex's footer clock showed UTC).
 *
 * v247 (on-device: v246 still failed): every Codex launch also passes
 * `-c shell_environment_policy.set.<VAR>="<value>"` for PYTHONHOME/PYTHONPATH/
 * TZ/ANDROID_ROOT/ANDROID_DATA, and .bashrc exports ANDROID_ROOT/ANDROID_DATA
 * (chrono needs them to find Android tzdata).
 *
 * The generated bash is extracted from the real HomeInitializer.kt
 * `sb.appendLine("...")` literals and executed with Android-only bits stubbed.
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

/** Extract appendLine bodies from the first line whose unescaped text is `start` up to (excluding) `end`. */
function extract(start: string, end: string, fromIndex = 0): string {
  const lines = ktSrc.split(/\r?\n/).slice(fromIndex);
  const body: string[] = [];
  let on = false;
  for (const line of lines) {
    const m = line.match(/^\s*sb\.appendLine\("(.*)"\)\s*$/);
    if (!m) continue;
    const text = unescapeKotlin(m[1]);
    if (!on && text === start) on = true;
    if (!on) continue;
    if (text === end) return body.join('\n') + '\n';
    body.push(text);
  }
  throw new Error(`could not extract ${start} .. ${end}`);
}

const hasBash = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok';
const maybe = hasBash ? describe : describe.skip;

function posix(p: string): string {
  return p.replace(/\\/g, '/');
}

function makeLibDir(layout: 'bundled' | 'pack' | 'none'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-pyenv-'));
  const target =
    layout === 'bundled' ? path.join(dir, 'python3') : layout === 'pack' ? path.join(dir, 'packs/dev-tools/python3') : null;
  if (target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // A #! header makes MSYS bash treat the file as executable on Windows.
    fs.writeFileSync(target, '#!/bin/sh\n', { mode: 0o755 });
  }
  return posix(dir);
}

function runBashRaw(script: string, env: Record<string, string> = {}): string {
  const baseEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete baseEnv.PYTHONHOME;
  delete baseEnv.PYTHONPATH;
  delete baseEnv.TZ;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...baseEnv, ...env } as NodeJS.ProcessEnv });
  if (r.status !== 0) throw new Error(`bash failed (${r.status}): ${r.stderr}`);
  return r.stdout;
}

function parseEnv(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^(PYTHONHOME|PYTHONPATH|TZ)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function runBash(script: string, env: Record<string, string> = {}): Record<string, string> {
  return parseEnv(runBashRaw(script, env));
}

const ENV_DUMP = 'for v in PYTHONHOME PYTHONPATH TZ; do bash -c "[ -n \\"\\${$v+x}\\" ] && echo $v=\\${$v}"; done; true';

describe('BASHRC_VERSION', () => {
  it('is bumped to >= 247 for the Codex python/TZ env + policy.set args', () => {
    const m = ktSrc.match(/private const val BASHRC_VERSION = (\d+)\b/);
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(247);
  });
});

maybe('codex() function exports python env to Codex (child processes)', () => {
  const toolPath = extract('__shelly_tool_path() {  # $1=tool $2=packId', '__shelly_pack_hint() {  # $1=tool $2=packId');
  const block = extract("  local __shelly_py=''", '  local -a __codex_args=()');
  const harness = (extra = '') =>
    `${toolPath}\nfakecodex() {\n${block}${extra}\n  ${ENV_DUMP}\n}\nfakecodex\necho AFTER; ${ENV_DUMP}\n`;

  it('uses the dev-tools pack python when no bundled copy exists', () => {
    const lib = makeLibDir('pack');
    // PYTHONHOME='' counts as unset for the [ -z ] guard.
    const stdout = runBashRaw(harness(), { SHELLY_LIB_DIR: lib, PYTHONHOME: '' });
    const [inside, after] = stdout.split('AFTER');
    expect(inside).toContain(`PYTHONHOME=${lib}/packs/dev-tools/python3.13`);
    expect(inside).toContain(`PYTHONPATH=${lib}/packs/dev-tools/python3.13`);
    // function-scoped: the interactive shell is unchanged once codex returns
    expect(after).not.toContain('packs/dev-tools/python3.13');
  });

  it('prefers the bundled python and prepends to an existing PYTHONPATH', () => {
    const lib = makeLibDir('bundled');
    const out = runBash(harness().split('echo AFTER')[0], { SHELLY_LIB_DIR: lib, PYTHONPATH: '/user/site' });
    expect(out.PYTHONHOME).toBe(`${lib}/python3.13`);
    expect(out.PYTHONPATH).toBe(`${lib}/python3.13:/user/site`);
  });

  it('never overrides a caller-provided PYTHONHOME', () => {
    const lib = makeLibDir('bundled');
    const out = runBash(harness().split('echo AFTER')[0], { SHELLY_LIB_DIR: lib, PYTHONHOME: '/custom' });
    expect(out.PYTHONHOME).toBe('/custom');
    expect(out.PYTHONPATH).toBeUndefined();
  });

  it('exports nothing when python3 is not installed', () => {
    const lib = makeLibDir('none');
    const out = runBash(harness().split('echo AFTER')[0], { SHELLY_LIB_DIR: lib });
    expect(out.PYTHONHOME).toBeUndefined();
    expect(out.PYTHONPATH).toBeUndefined();
  });
});

maybe('$HOME/bin/codex shim exports python env and TZ', () => {
  const shimStart = ktSrc.indexOf("<<'SHELLY_CODEX_SHIM_EOF'");
  const startLine = ktSrc.slice(0, shimStart).split(/\r?\n/).length - 1;
  const block = extract('if [ -z "${PYTHONHOME:-}" ]; then', '__shelly_linker64() {', startLine).replace(
    /\/system\/bin\/getprop persist\.sys\.timezone/g,
    'echo Asia/Tokyo',
  );

  it('falls back to the pack python and sets TZ from the device property', () => {
    const lib = makeLibDir('pack');
    const out = runBash(`${block}${ENV_DUMP}\n`, { SHELLY_LIB_DIR: lib });
    expect(out.PYTHONHOME).toBe(`${lib}/packs/dev-tools/python3.13`);
    expect(out.PYTHONPATH).toBe(`${lib}/packs/dev-tools/python3.13`);
    expect(out.TZ).toBe('Asia/Tokyo');
  });

  it('keeps a user TZ', () => {
    const lib = makeLibDir('bundled');
    const out = runBash(`${block}${ENV_DUMP}\n`, { SHELLY_LIB_DIR: lib, TZ: 'UTC' });
    expect(out.TZ).toBe('UTC');
    expect(out.PYTHONHOME).toBe(`${lib}/python3.13`);
  });
});

maybe('.bashrc TZ export', () => {
  // First occurrence is the .bashrc environment block (the shim's copy is later).
  const tzBlock = extract('if [ -z "${TZ:-}" ]; then', 'export SHELLY_LIB_DIR="$libDir"').replace(
    /\/system\/bin\/getprop persist\.sys\.timezone/g,
    'echo Europe/Berlin',
  );

  it('sets TZ from persist.sys.timezone only when unset', () => {
    expect(runBash(`${tzBlock}${ENV_DUMP}
`).TZ).toBe('Europe/Berlin');
    expect(runBash(`${tzBlock}${ENV_DUMP}
`, { TZ: 'Asia/Tokyo' }).TZ).toBe('Asia/Tokyo');
  });
});

describe('shelly-agent-driver androidToolEnv (codex app-server)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { androidToolEnv } = require('../scripts/shelly-agent-driver.js');

  it('adds PYTHONHOME/PYTHONPATH (pack fallback) and TZ', () => {
    const lib = makeLibDir('pack');
    const env = androidToolEnv(lib, {}, () => 'Asia/Tokyo');
    expect(posix(env.PYTHONHOME)).toBe(`${lib}/packs/dev-tools/python3.13`);
    expect(posix(env.PYTHONPATH)).toBe(`${lib}/packs/dev-tools/python3.13`);
    expect(env.TZ).toBe('Asia/Tokyo');
  });

  it('respects caller PYTHONHOME/TZ and prepends PYTHONPATH', () => {
    const lib = makeLibDir('bundled');
    expect(androidToolEnv(lib, { PYTHONHOME: '/x', TZ: 'UTC', ANDROID_ROOT: '/r', ANDROID_DATA: '/d' }, () => 'Asia/Tokyo')).toEqual({});
    const env = androidToolEnv(lib, { PYTHONPATH: '/site' }, () => '');
    expect(posix(env.PYTHONPATH)).toBe(`${lib}/python3.13:/site`);
    expect(env.TZ).toBeUndefined();
  });
});

const POLICY_KEYS = ['PYTHONHOME', 'PYTHONPATH', 'TZ', 'ANDROID_ROOT', 'ANDROID_DATA'];

function policyArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '-c') continue;
    const m = argv[i + 1]?.match(/^shell_environment_policy\.set\.([A-Z_]+)="(.*)"$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function argvLines(stdout: string): string[] {
  return stdout.split(/\r?\n/).filter((l) => l.startsWith('ARG:')).map((l) => l.slice(4));
}

maybe('codex() run_tui passes shell_environment_policy.set overrides', () => {
  const toolPath = extract('__shelly_tool_path() {  # $1=tool $2=packId', '__shelly_pack_hint() {  # $1=tool $2=packId');
  const pyBlock = extract("  local __shelly_py=''", '  local -a __codex_args=()');
  const runTui = extract('  __shelly_codex_native_crash_rc() {', "  local __prev=''").replace(
    /\/system\/bin\/toybox date \+%s/g,
    'echo 0',
  );
  const harness = (args: string) =>
    `${toolPath}\n_run() { for a in "$@"; do printf 'ARG:%s\n' "$a"; done; }\n` +
    `__shelly_paste_tui_begin() { :; }\n__shelly_paste_tui_end() { :; }\n` +
    `fakecodex() {\n  local __tui=/x/codex_tui\n${pyBlock}${runTui}  __shelly_codex_run_tui /x/codex_tui ${args}\n}\nfakecodex\n`;

  it('prepends -c set args for the python env, TZ and ANDROID_* before the user args', () => {
    const lib = makeLibDir('pack');
    const argv = argvLines(
      runBashRaw(harness('exec --cd /w hi'), {
        SHELLY_LIB_DIR: lib,
        TZ: 'Asia/Tokyo',
        ANDROID_ROOT: '/system',
        ANDROID_DATA: '/data',
      }),
    );
    expect(argv[0]).toBe('/x/codex_tui');
    expect(argv.slice(-4)).toEqual(['exec', '--cd', '/w', 'hi']);
    expect(policyArgs(argv)).toEqual({
      PYTHONHOME: `${lib}/packs/dev-tools/python3.13`,
      PYTHONPATH: `${lib}/packs/dev-tools/python3.13`,
      TZ: 'Asia/Tokyo',
      ANDROID_ROOT: '/system',
      ANDROID_DATA: '/data',
    });
    // every -c is followed by a set override and nothing else is injected
    expect(argv.length).toBe(1 + 2 * POLICY_KEYS.length + 4);
  });

  it('skips values that would need TOML escaping and unset values', () => {
    const lib = makeLibDir('none');
    const argv = argvLines(runBashRaw(harness('hi'), { SHELLY_LIB_DIR: lib, TZ: 'bad"tz', ANDROID_ROOT: 'a\\b' }));
    expect(policyArgs(argv)).toEqual({});
    expect(argv).toEqual(['/x/codex_tui', 'hi']);
  });
});

maybe('$HOME/bin/codex shim run_tui passes shell_environment_policy.set overrides', () => {
  const shimRunTui = extract('__shelly_codex_run_tui() {', '__dispatch="${1:-}"')
    .replace(/\/system\/bin\/toybox date \+%s/g, 'echo 0')
    .replace(/\/system\/bin\/linker64/g, '__fake_linker');

  it('prepends -c set args (POSIX eval path)', () => {
    const script =
      `__fake_linker() { for a in "$@"; do printf 'ARG:%s\n' "$a"; done; }\n` +
      `__shelly_codex_native_crash_rc() { return 1; }\n${shimRunTui}__shelly_codex_run_tui /x/codex_tui --cd /w\n`;
    const argv = argvLines(
      runBashRaw(script, { SHELLY_LIB_DIR: '/lib', PYTHONHOME: '/py/python3.13', PYTHONPATH: '/py/python3.13', TZ: 'Asia/Tokyo' }),
    );
    expect(argv[0]).toBe('/x/codex_tui');
    expect(argv.slice(-2)).toEqual(['--cd', '/w']);
    expect(policyArgs(argv)).toEqual({ PYTHONHOME: '/py/python3.13', PYTHONPATH: '/py/python3.13', TZ: 'Asia/Tokyo' });
  });
});

describe('.bashrc ANDROID_ROOT/ANDROID_DATA (chrono tzdata lookup)', () => {
  it('exports defaults when unset', () => {
    expect(ktSrc).toContain('sb.appendLine("export ANDROID_ROOT=\\"\\${ANDROID_ROOT:-/system}\\"")');
    expect(ktSrc).toContain('sb.appendLine("export ANDROID_DATA=\\"\\${ANDROID_DATA:-/data}\\"")');
  });
});

describe('shelly-agent-driver codexPolicyEnvArgs (codex app-server)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { codexPolicyEnvArgs, androidToolEnv } = require('../scripts/shelly-agent-driver.js');

  it('emits TOML-quoted set overrides and skips unsafe values', () => {
    expect(
      codexPolicyEnvArgs({ PYTHONHOME: '/p/python3.13', PYTHONPATH: 'a"b', TZ: 'Asia/Tokyo', ANDROID_ROOT: 'x\\y' }),
    ).toEqual(['-c', 'shell_environment_policy.set.PYTHONHOME="/p/python3.13"', '-c', 'shell_environment_policy.set.TZ="Asia/Tokyo"']);
  });

  it('androidToolEnv defaults ANDROID_ROOT/ANDROID_DATA', () => {
    const env = androidToolEnv(makeLibDir('none'), {}, () => '');
    expect(env.ANDROID_ROOT).toBe('/system');
    expect(env.ANDROID_DATA).toBe('/data');
    expect(androidToolEnv(makeLibDir('none'), { ANDROID_ROOT: '/r', ANDROID_DATA: '/d' }, () => '')).toEqual({});
  });
});
