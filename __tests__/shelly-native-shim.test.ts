/**
 * __tests__/shelly-native-shim.test.ts
 *
 * BASHRC_VERSION 255: `$HOME/bin/shelly` is a symlink to the native launcher
 * `$SHELLY_LIB_DIR/shelly_cmd` (jni/shelly-cmd.c) instead of a generated
 * `#!/system/bin/sh` script, which Knox refused to exec outside the
 * interactive shelly() bash function ("bad interpreter: Permission denied").
 * The generated helper moves out of PATH to `$HOME/.shelly/shelly-helper.sh`.
 *
 * Source invariants for the launcher, its packaging (LibExtractor + CI) and
 * the generated .bashrc, plus a behavioral run of the generated migration
 * block under a real bash when one with working symlinks is available.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const ktDir = 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator';
const homeKt = read(`${ktDir}/HomeInitializer.kt`);
const libExtractor = read(`${ktDir}/LibExtractor.kt`);
const cmdC = read('modules/terminal-emulator/android/src/main/jni/shelly-cmd.c');
const ci = read('.github/workflows/build-android.yml');

/** Kotlin string literal -> generated text (only the escapes the file uses). */
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

const generated = homeKt
  .split(/\r?\n/)
  .map((l) => l.match(/^\s*sb\.appendLine\("(.*)"\)\s*$/))
  .filter((m): m is RegExpMatchArray => !!m)
  .map((m) => unescapeKotlin(m[1]));

describe('native shelly launcher (jni/shelly-cmd.c)', () => {
  it('carries the CI marker and replays the interactive linker64 route', () => {
    expect(cmdC).toContain('"shelly-cmd:v1:native-path-shim"');
    expect(cmdC).toContain('#define LINKER64 "/system/bin/linker64"');
    expect(cmdC).toContain('#define HELPER_REL "/.shelly/shelly-helper.sh"');
    expect(cmdC).toMatch(/args\[k\+\+\] = \(char \*\)LINKER64;\s*args\[k\+\+\] = bash_path;\s*args\[k\+\+\] = helper_path;/);
  });

  it('does not depend on LD_PRELOAD: raw execve syscall, LD_PRELOAD dropped from the helper env', () => {
    expect(cmdC).toContain('syscall(SYS_execve, LINKER64, args, env)');
    expect(cmdC).toMatch(/env_is\(e, "LD_PRELOAD"\)[^\n]*continue;/);
  });

  it('never relies on argv[0] naming (wrapper exec makes it /proc/self/fd/N)', () => {
    expect(cmdC).toContain('"/proc/self/fd/"');
    expect(cmdC).not.toMatch(/strcmp\([^)]*argv\[0\][^)]*"shelly"/);
  });
});

describe('packaging', () => {
  it('LibExtractor extracts and always refreshes shelly_cmd', () => {
    expect(libExtractor).toContain('"lib/arm64-v8a/libshelly_cmd.so" to "shelly_cmd"');
    const refresh = libExtractor.slice(libExtractor.indexOf('ALWAYS_REFRESH = setOf('));
    expect(refresh.slice(0, refresh.search(/\n\s*\)/))).toContain('"shelly_cmd"');
  });

  it('CI builds, caches and validates libshelly_cmd.so', () => {
    expect(ci).toContain('SRC="modules/terminal-emulator/android/src/main/jni/shelly-cmd.c"');
    expect(ci).toContain('OUT="${GITHUB_WORKSPACE}/${JNILIBS}/libshelly_cmd.so"');
    expect(ci).toContain('modules/terminal-emulator/android/src/main/jniLibs/arm64-v8a/libshelly_cmd.so');
    expect(ci).toContain("check_marker /tmp/libshelly_cmd.so 'shelly-cmd:v1:native-path-shim'");
  });
});

describe('generated .bashrc (BASHRC_VERSION >= 255)', () => {
  it('bumps BASHRC_VERSION', () => {
    const m = homeKt.match(/private const val BASHRC_VERSION = (\d+)\b/);
    expect(Number(m![1])).toBeGreaterThanOrEqual(255);
  });

  it('writes the helper out of PATH and never as a #! script in $HOME/bin', () => {
    expect(generated).toContain(`__shelly_cat > "$HOME/.shelly/shelly-helper.sh.tmp.$$" <<'SHELLY_HELPER_EOF'`);
    expect(generated.join('\n')).not.toMatch(/__shelly_cat > "\$HOME\/bin\/shelly"/);
    const start = generated.findIndex((l) => l.includes("<<'SHELLY_HELPER_EOF'"));
    expect(generated.slice(start + 1, start + 3).join('\n')).not.toContain('#!');
  });

  it('keeps the empty-file / marker regeneration guard on the new path', () => {
    expect(generated).toContain(
      'if [ ! -s "$HOME/.shelly/shelly-helper.sh" ] || __shelly_grep -q SHELLY_HELPER_SHIM "$HOME/.shelly/shelly-helper.sh" 2>/dev/null; then',
    );
  });

  it('shelly() reads the helper through linker64 bash at the new path (3 call sites)', () => {
    const fnStart = generated.indexOf('shelly() {');
    const fn = generated.slice(fnStart, generated.indexOf('}', fnStart) + 1).join('\n');
    const calls = generated.filter((l) => l.includes('_run "$SHELLY_LIB_DIR/libbash.so" "$HOME/.shelly/shelly-helper.sh"'));
    expect(calls).toHaveLength(3);
    expect(generated.join('\n')).not.toContain('"$HOME/bin/shelly" workflow');
    expect(generated).toContain('  SHELLY_CALLER_PID=$$ _run "$SHELLY_LIB_DIR/libbash.so" "$HOME/.shelly/shelly-helper.sh" "$@"');
    expect(fn).toBeTruthy();
  });

  it('links $HOME/bin/shelly to the native launcher', () => {
    expect(generated).toContain('  __shelly_ln -s "$SHELLY_LIB_DIR/shelly_cmd" "$HOME/bin/shelly" 2>/dev/null || true');
  });

  it('bash()/sh() preload the exec wrapper only from an interactive caller with args', () => {
    const bashFn = generated.find((l) => l.startsWith('bash() {'))!;
    const shFn = generated.find((l) => l.startsWith('sh() {'))!;
    expect(bashFn).toMatch(/^bash\(\) \{ case "\$-" in \*i\*\) if \[ "\$#" -gt 0 \]; then LD_PRELOAD="[^"]*\/libexec_wrapper\.so" _run [^ ]*\/libbash\.so "\$@"; return; fi ;; esac; _run [^ ]*\/libbash\.so "\$@"; \}$/);
    expect(shFn).toMatch(/^sh\(\) \{ case "\$-" in \*i\*\) if \[ "\$#" -gt 0 \]; then LD_PRELOAD="[^"]*\/libexec_wrapper\.so" \/system\/bin\/sh "\$@"; return; fi ;; esac; \/system\/bin\/sh "\$@"; \}$/);
  });
});

// ---- behavioral: bash()/sh() never override a non-interactive opt-out -------
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
(hasBash ? describe : describe.skip)('bash()/sh() LD_PRELOAD scoping (bash)', () => {
  // Stubs: _run / the system sh just report the LD_PRELOAD they were given.
  const fns = () =>
    [
      'libDir=/lib',
      '_run() { printf "%s|%s\\n" "${LD_PRELOAD-NONE}" "$*"; }',
      '__sys_sh() { printf "%s|%s\\n" "${LD_PRELOAD-NONE}" "$*"; }',
      generated.find((l) => l.startsWith('bash() {'))!,
      generated.find((l) => l.startsWith('sh() {'))!.split('/system/bin/sh').join('__sys_sh'),
    ].join('\n');
  const run = (flags: string[], body: string, env: Record<string, string | undefined> = {}) => {
    const e: Record<string, string | undefined> = { ...process.env, ...env };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete e[k];
    const r = spawnSync('bash', [...flags, '-c', `${fns()}\n${body}`], { encoding: 'utf8', env: e as NodeJS.ProcessEnv });
    return r.stdout.trim().split('\n').pop()!;
  };

  it('non-interactive caller with LD_PRELOAD unset: child gets NO LD_PRELOAD', () => {
    expect(run([], 'unset LD_PRELOAD; bash x.sh')).toBe('NONE|/lib/libbash.so x.sh');
    expect(run([], 'unset LD_PRELOAD; sh -c true')).toBe('NONE|-c true');
  });

  it('non-interactive caller keeps an inherited LD_PRELOAD unchanged', () => {
    expect(run([], 'export LD_PRELOAD=/inherited.so; bash x.sh')).toBe('/inherited.so|/lib/libbash.so x.sh');
  });

  it('interactive caller with args gets the wrapper; a bare interactive bash does not', () => {
    expect(run(['--norc', '--noprofile', '-i'], 'unset LD_PRELOAD; bash x.sh')).toBe('/lib/libexec_wrapper.so|/lib/libbash.so x.sh');
    expect(run(['--norc', '--noprofile', '-i'], 'unset LD_PRELOAD; sh -c true')).toBe('/lib/libexec_wrapper.so|-c true');
    expect(run(['--norc', '--noprofile', '-i'], 'unset LD_PRELOAD; bash')).toBe('NONE|/lib/libbash.so');
  });
});

// ---- behavioral: the generated $HOME/bin/shelly migration block -----------
function migrationBlock(): string {
  const start = generated.indexOf('if [ -L "$HOME/bin/shelly" ]; then');
  let end = start;
  while (generated[end] !== 'fi') end++;
  return generated.slice(start, end + 1).join('\n');
}

function bashWithSymlinks(): string | null {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-ln-probe-'));
  try {
    const r = spawnSync('bash', ['-c', 'ln -s target "$1/l" && [ -L "$1/l" ]', 'x', probeDir], {
      encoding: 'utf8',
      env: { ...process.env, MSYS: 'winsymlinks:nativestrict' },
    });
    return r.status === 0 ? 'bash' : null;
  } catch {
    return null;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

const maybe = bashWithSymlinks() ? describe : describe.skip;

maybe('$HOME/bin/shelly migration (bash)', () => {
  let home: string;
  const libDir = '/data/user/0/dev.shelly.terminal/files/termux-libs';
  const run = () => {
    const script = [
      '__shelly_readlink() { readlink "$@"; }',
      '__shelly_rm() { rm "$@"; }',
      '__shelly_ln() { ln "$@"; }',
      '__shelly_grep() { grep "$@"; }',
      migrationBlock(),
    ].join('\n');
    const r = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, SHELLY_LIB_DIR: libDir, MSYS: 'winsymlinks:nativestrict' },
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  };
  const shim = () => path.join(home, 'bin', 'shelly');
  // Git Bash on Windows resolves POSIX link targets under its install root.
  const link = () => fs.readlinkSync(shim()).replace(/\\/g, '/');

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-native-shim-'));
    fs.mkdirSync(path.join(home, 'bin'));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('replaces a legacy generated script with the symlink (idempotent)', () => {
    fs.writeFileSync(shim(), '#!/system/bin/sh\n# SHELLY_HELPER_SHIM v9 — generated by Shelly\n');
    run();
    expect(link().endsWith(`${libDir}/shelly_cmd`)).toBe(true);
    run();
    expect(link().endsWith(`${libDir}/shelly_cmd`)).toBe(true);
  });

  it('creates the symlink when missing or empty', () => {
    run();
    expect(link().endsWith(`${libDir}/shelly_cmd`)).toBe(true);
    fs.rmSync(shim());
    fs.writeFileSync(shim(), '');
    run();
    expect(link().endsWith(`${libDir}/shelly_cmd`)).toBe(true);
  });

  it('re-points a stale Shelly symlink but leaves custom files and foreign symlinks alone', () => {
    fs.symlinkSync('/old/termux-libs/shelly_cmd', shim());
    run();
    expect(link().endsWith(`${libDir}/shelly_cmd`)).toBe(true);

    fs.rmSync(shim());
    fs.writeFileSync(shim(), '#!/bin/sh\necho mine\n');
    run();
    expect(fs.lstatSync(shim()).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(shim(), 'utf8')).toContain('echo mine');

    fs.rmSync(shim());
    fs.symlinkSync('/somewhere/else', shim());
    run();
    expect(link().endsWith("/somewhere/else")).toBe(true);
  });
});
