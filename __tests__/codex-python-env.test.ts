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

/**
 * Fake $SHELLY_LIB_DIR layouts. The stdlib is detected by its
 * encodings/__init__.py landmark, never by the binary's exec bit.
 *  - bundled: $lib/python3 + $lib/python3.13/
 *  - pack:    $lib/packs/dev-tools/python3 + $lib/packs/dev-tools/python3.13/
 *  - device:  the real on-device layout from build 2518/2519 — the PATH binary
 *             is $lib/python3 (no exec bit; linker64 runs it anyway) but the
 *             only stdlib present is $lib/packs/dev-tools/python3.13/ (with
 *             lib-dynload/)
 *  - none:    nothing
 */
function makeLibDir(layout: 'bundled' | 'pack' | 'device' | 'none'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-pyenv-'));
  const put = (rel: string, body = '') => {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body, { mode: 0o644 });
  };
  if (layout === 'bundled') {
    put('python3');
    put('python3.13/encodings/__init__.py');
  } else if (layout === 'pack') {
    put('packs/dev-tools/python3');
    put('packs/dev-tools/python3.13/encodings/__init__.py');
  } else if (layout === 'device') {
    put('python3');
    put('packs/dev-tools/python3.13/encodings/__init__.py');
    fs.mkdirSync(path.join(dir, 'packs/dev-tools/python3.13/lib-dynload'), { recursive: true });
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
  it('is bumped to >= 249 for the Codex python/TZ env + policy.set args', () => {
    const m = ktSrc.match(/private const val BASHRC_VERSION = (\d+)\b/);
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(249);
  });
});

maybe('codex() function exports python env to Codex (child processes)', () => {
  const toolPath = extract('__shelly_python_stdlib() {  # [$1=python binary] -> prints stdlib dir', 'export -f __shelly_python_stdlib __shelly_python_path');
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
  const toolPath = extract('__shelly_python_stdlib() {  # [$1=python binary] -> prints stdlib dir', 'export -f __shelly_python_stdlib __shelly_python_path');
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
    expect(argv.length).toBe(1 + 2 * POLICY_KEYS.length + 2 + 4); // +2 = features.shell_snapshot=false;
  });

  it('skips values that would need TOML escaping and unset values', () => {
    const lib = makeLibDir('none');
    const argv = argvLines(runBashRaw(harness('hi'), { SHELLY_LIB_DIR: lib, TZ: 'bad"tz', ANDROID_ROOT: 'a\\b' }));
    expect(policyArgs(argv)).toEqual({});
    expect(argv).toEqual(['/x/codex_tui', '-c', 'features.shell_snapshot=false', 'hi']);
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
    ).toEqual(['-c', 'shell_environment_policy.set.PYTHONHOME="/p/python3.13"', '-c', 'shell_environment_policy.set.TZ="Asia/Tokyo"', '-c', 'features.shell_snapshot=false']);
  });

  it('androidToolEnv defaults ANDROID_ROOT/ANDROID_DATA', () => {
    const env = androidToolEnv(makeLibDir('none'), {}, () => '');
    expect(env.ANDROID_ROOT).toBe('/system');
    expect(env.ANDROID_DATA).toBe('/data');
    expect(androidToolEnv(makeLibDir('none'), { ANDROID_ROOT: '/r', ANDROID_DATA: '/d' }, () => '')).toEqual({});
  });
});

// v248: the real on-device layout (build 2518/2519) — PATH python3 is
// $lib/python3 but the only stdlib is $lib/packs/dev-tools/python3.13.
maybe('device layout: binary in $lib, stdlib only in packs/dev-tools (v248)', () => {
  const helpers = extract(
    '__shelly_python_stdlib() {  # [$1=python binary] -> prints stdlib dir',
    'export -f __shelly_python_stdlib __shelly_python_path',
  );
  const pyBlock = extract("  local __shelly_py=''", '  local -a __codex_args=()');
  const runTui = extract('  __shelly_codex_native_crash_rc() {', "  local __prev=''").replace(
    /\/system\/bin\/toybox date \+%s/g,
    'echo 0',
  );
  const python3Fn = extract('python3() {', 'python() { python3 "$@"; }');

  it('codex() exports PYTHONHOME/PYTHONPATH (with lib-dynload) and emits the PYTHON* set args', () => {
    const lib = makeLibDir('device');
    const std = `${lib}/packs/dev-tools/python3.13`;
    const script =
      `${helpers}\n_run() { for a in "$@"; do printf 'ARG:%s\n' "$a"; done; }\n` +
      `__shelly_paste_tui_begin() { :; }\n__shelly_paste_tui_end() { :; }\n` +
      `fakecodex() {\n  local __tui=/x/codex_tui\n${pyBlock}${runTui}  ${ENV_DUMP}\n  __shelly_codex_run_tui /x/codex_tui hi\n}\nfakecodex\n`;
    const stdout = runBashRaw(script, { SHELLY_LIB_DIR: lib });
    const env = parseEnv(stdout);
    expect(env.PYTHONHOME).toBe(std);
    expect(env.PYTHONPATH).toBe(`${std}:${std}/lib-dynload`);
    const set = policyArgs(argvLines(stdout));
    expect(set.PYTHONHOME).toBe(std);
    expect(set.PYTHONPATH).toBe(`${std}:${std}/lib-dynload`);
  });

  it('logs the failed resolution only under SHELLY_DEBUG', () => {
    const lib = makeLibDir('none');
    const script = `${helpers}\nfakecodex() {\n${pyBlock}}\nfakecodex 2>&1\n`;
    expect(runBashRaw(script, { SHELLY_LIB_DIR: lib })).toBe('');
    expect(runBashRaw(script, { SHELLY_LIB_DIR: lib, SHELLY_DEBUG: '1' })).toContain('python stdlib (encodings/__init__.py) not found');
  });

  it('interactive python3() uses the same resolution', () => {
    const lib = makeLibDir('device');
    const std = `${lib}/packs/dev-tools/python3.13`;
    const script =
      `${helpers}\n__shelly_tool_path() { printf '%s' "$SHELLY_LIB_DIR/python3"; }\n` +
      `_run() { echo "PYTHONHOME=$PYTHONHOME"; echo "PYTHONPATH=$PYTHONPATH"; }\n${python3Fn}python3 hello.py\n`;
    const env = runBash(script, { SHELLY_LIB_DIR: lib });
    expect(env.PYTHONHOME).toBe(std);
    expect(env.PYTHONPATH).toBe(`${std}:${std}/lib-dynload`);
  });

  it('$HOME/bin/codex shim resolves the pack stdlib', () => {
    const shimStart = ktSrc.indexOf("<<'SHELLY_CODEX_SHIM_EOF'");
    const startLine = ktSrc.slice(0, shimStart).split(/\r?\n/).length - 1;
    const block = extract('if [ -z "${PYTHONHOME:-}" ]; then', '__shelly_linker64() {', startLine).replace(
      /\/system\/bin\/getprop persist\.sys\.timezone/g,
      'echo Asia/Tokyo',
    );
    const lib = makeLibDir('device');
    const std = `${lib}/packs/dev-tools/python3.13`;
    const env = runBash(`${block}${ENV_DUMP}\n`, { SHELLY_LIB_DIR: lib });
    expect(env.PYTHONHOME).toBe(std);
    expect(env.PYTHONPATH).toBe(`${std}:${std}/lib-dynload`);
  });

  it('shelly-agent-driver androidToolEnv resolves the pack stdlib', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { androidToolEnv: toolEnv } = require('../scripts/shelly-agent-driver.js');
    const lib = makeLibDir('device');
    const std = `${lib}/packs/dev-tools/python3.13`;
    const env = toolEnv(lib, {}, () => '');
    expect(posix(env.PYTHONHOME)).toBe(std);
    expect(posix(env.PYTHONPATH)).toBe(`${std}:${std}/lib-dynload`);
  });
});

// v249: Codex's shell snapshot (features.shell_snapshot) drops the policy env
// on Android and breaks `!` commands (/proc/self/fd/N); every launch disables it.
maybe('features.shell_snapshot=false on every Codex launch (v249)', () => {
  const runTui = extract('  __shelly_codex_native_crash_rc() {', "  local __prev=''").replace(
    /\/system\/bin\/toybox date \+%s/g,
    'echo 0',
  );
  const shimRunTui = extract('__shelly_codex_run_tui() {', '__dispatch="${1:-}"')
    .replace(/\/system\/bin\/toybox date \+%s/g, 'echo 0')
    .replace(/\/system\/bin\/linker64/g, '__fake_linker');
  const fnScript =
    `_run() { for a in "$@"; do printf 'ARG:%s\n' "$a"; done; }\n` +
    `__shelly_paste_tui_begin() { :; }\n__shelly_paste_tui_end() { :; }\n` +
    `fakecodex() {\n  local __tui=/x/codex_tui\n${runTui}  __shelly_codex_run_tui /x/codex_tui exec hi\n}\nfakecodex\n`;
  const shimScript =
    `__fake_linker() { for a in "$@"; do printf 'ARG:%s\n' "$a"; done; }\n` +
    `__shelly_codex_native_crash_rc() { return 1; }\n${shimRunTui}__shelly_codex_run_tui /x/codex_tui exec hi\n`;

  it.each([
    ['codex()', fnScript],
    ['$HOME/bin/codex shim', shimScript],
  ])('%s passes -c features.shell_snapshot=false before the subcommand', (_name, script) => {
    const argv = argvLines(runBashRaw(script, { SHELLY_LIB_DIR: '/lib', TZ: 'Asia/Tokyo' }));
    const i = argv.indexOf('features.shell_snapshot=false');
    expect(i).toBeGreaterThan(0);
    expect(argv[i - 1]).toBe('-c');
    expect(i).toBeLessThan(argv.indexOf('exec'));
    expect(policyArgs(argv).TZ).toBe('Asia/Tokyo');
  });

  it.each([
    ['codex()', fnScript],
    ['$HOME/bin/codex shim', shimScript],
  ])('%s honours SHELLY_CODEX_SHELL_SNAPSHOT=1 opt-out', (_name, script) => {
    const argv = argvLines(runBashRaw(script, { SHELLY_LIB_DIR: '/lib', SHELLY_CODEX_SHELL_SNAPSHOT: '1' }));
    expect(argv).not.toContain('features.shell_snapshot=false');
  });

  it('shelly-agent-driver app-server args disable it too', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { codexPolicyEnvArgs: policyEnvArgs } = require('../scripts/shelly-agent-driver.js');
    expect(policyEnvArgs({})).toEqual(['-c', 'features.shell_snapshot=false']);
    expect(policyEnvArgs({ SHELLY_CODEX_SHELL_SNAPSHOT: '1' })).toEqual([]);
  });
});
