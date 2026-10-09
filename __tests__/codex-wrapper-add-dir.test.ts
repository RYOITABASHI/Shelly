/**
 * __tests__/codex-wrapper-add-dir.test.ts
 *
 * Behavioral test for the generated Codex wrappers in HomeInitializer.kt
 * (BASHRC_VERSION 245): the bash `codex()` function's
 * `__shelly_codex_prepare_args` and the `$HOME/bin/codex` shim's
 * `__shelly_codex_prepare_exec_args`. The `sb.appendLine("...")` literals are
 * extracted from the real .kt source, Kotlin-unescaped, and run in bash with
 * the Android-only bits (`/system/bin/toybox pwd -P`, physical-path
 * canonicalization, the codex_tui launch) stubbed, then the final argv is
 * asserted.
 *
 * Regression: Codex's TUI exits with "Error adding directories: Ignoring
 * --add-dir (...) because the effective permissions do not allow additional
 * writable roots" whenever --add-dir is passed and the effective sandbox is
 * read-only (the upstream default for a folder with no trust decision).
 * Interactive `codex` must therefore never pass --add-dir unless the sandbox
 * is known to be writable, and must not pass duplicate roots.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const ktPath = path.resolve(
  __dirname,
  '..',
  'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt',
);

const HOME_L = '/data/user/0/dev.shelly.terminal/files/home';
const HOME_P = '/data/data/dev.shelly.terminal/files/home';

function unescapeKotlin(lit: string): string {
  let out = '';
  for (let i = 0; i < lit.length; i++) {
    const ch = lit[i];
    if (ch === '\\' && i + 1 < lit.length) {
      const nx = lit[++i];
      out += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx;
      continue;
    }
    if (ch === '$' && /[A-Za-z{]/.test(lit[i + 1] ?? '')) {
      throw new Error(`unescaped Kotlin template in generated codex wrapper: ${lit}`);
    }
    out += ch;
  }
  return out;
}

function extract(startLine: string, endLine: string): string {
  const lines = fs.readFileSync(ktPath, 'utf8').split(/\r?\n/);
  const body: string[] = [];
  let on = false;
  for (const line of lines) {
    const m = line.match(/^\s*sb\.appendLine\("(.*)"\)\s*$/);
    if (!m) continue;
    if (!on && m[1] === startLine) on = true;
    if (!on) continue;
    const text = unescapeKotlin(m[1]);
    if (text === endLine) {
      return body.join('\n').replace(/\/system\/bin\/toybox pwd -P/g, '__test_pwd_P') + '\n';
    }
    body.push(text);
  }
  throw new Error(`could not extract ${startLine} .. ${endLine}`);
}

const fnSrc = extract('  __shelly_codex_alias_for_path() {', '  __shelly_codex_mark_tui_failed() {');
const shimSrc = extract('__shelly_codex_alias_for() {', '__shelly_codex_strip_exec_and_run() {');

const hasBash = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok';
const maybe = hasBash ? describe : describe.skip;

interface Ctx {
  pwd: string;
  canon: string;
}

function runBash(script: string, ctx: Ctx, args: string[]): string[] {
  const r = spawnSync('bash', ['-c', script, 'harness', ...args], {
    env: { ...process.env, TEST_PWD: ctx.pwd, TEST_CANON: ctx.canon },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`bash failed (${r.status}): ${r.stderr}`);
  return r.stdout.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''));
}

/** codex() bare/TUI (skip=0) or exec (skip=1) argument preparation. */
function prepare(skip: 0 | 1, ctx: Ctx, args: string[]): string[] {
  const script = [
    fnSrc,
    '__test_pwd_P() { printf "%s" "$TEST_CANON"; }',
    // Canonicalize the stubbed Android paths without needing them on disk.
    '__shelly_codex_canon_for_path() { case "$1" in "$TEST_PWD") printf "%s" "$TEST_CANON" ;; *) printf "%s" "$1" ;; esac; }',
    'PWD="$TEST_PWD"',
    `__shelly_codex_prepare_args ${skip} "$@"`,
    'printf "%s\\n" "${__codex_args[@]}"',
  ].join('\n');
  return runBash(script, ctx, args);
}

/** $HOME/bin/codex shim `exec` argument preparation. */
function prepareShimExec(ctx: Ctx, args: string[]): string[] {
  const script = [
    shimSrc,
    '__test_pwd_P() { printf "%s" "$TEST_CANON"; }',
    'pwd() { printf "%s" "$TEST_PWD"; }',
    '__shelly_codex_canon_for() { case "$1" in "$TEST_PWD") printf "%s" "$TEST_CANON" ;; *) printf "%s" "$1" ;; esac; }',
    '__tui=/stub/codex_tui',
    '__shelly_codex_run_tui() { shift; printf "%s\\n" "$@"; }',
    '__shelly_codex_prepare_exec_args "$@"',
  ].join('\n');
  return runBash(script, ctx, args);
}

function addDirs(argv: string[]): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if (a === '--add-dir') out.push(argv[i + 1]);
  });
  return out;
}

const myapp: Ctx = { pwd: `${HOME_L}/myapp`, canon: `${HOME_P}/myapp` };
const home: Ctx = { pwd: HOME_L, canon: HOME_P };
const plain: Ctx = { pwd: '/sdcard/proj', canon: '/sdcard/proj' };

maybe('codex() interactive TUI wrapper', () => {
  it('cwd under home (logical alias): no --add-dir, alias passed as workspace-write writable_roots', () => {
    expect(prepare(0, myapp, [])).toEqual([
      '--cd',
      `${HOME_P}/myapp`,
      '-c',
      `sandbox_workspace_write.writable_roots=["${HOME_L}/myapp"]`,
    ]);
  });

  it('cwd == home: same shape, single deduped root', () => {
    expect(prepare(0, home, ['fix the bug'])).toEqual([
      '--cd',
      HOME_P,
      '-c',
      `sandbox_workspace_write.writable_roots=["${HOME_L}"]`,
      'fix the bug',
    ]);
  });

  it('cwd already physical (/data/data): alias still registered once', () => {
    const ctx = { pwd: `${HOME_P}/myapp`, canon: `${HOME_P}/myapp` };
    expect(prepare(0, ctx, [])).toEqual([
      '--cd',
      `${HOME_P}/myapp`,
      '-c',
      `sandbox_workspace_write.writable_roots=["${HOME_L}/myapp"]`,
    ]);
  });

  it('non-app-data cwd: only --cd, no extra roots', () => {
    expect(prepare(0, plain, [])).toEqual(['--cd', '/sdcard/proj']);
  });

  it('explicit -s workspace-write: uses --add-dir (deduped)', () => {
    const argv = prepare(0, myapp, ['-s', 'workspace-write']);
    expect(addDirs(argv)).toEqual([`${HOME_L}/myapp`]);
    expect(argv).not.toContain('-c');
    expect(argv.slice(-2)).toEqual(['-s', 'workspace-write']);
  });

  it('explicit --sandbox=danger-full-access / --full-auto: uses --add-dir', () => {
    expect(addDirs(prepare(0, myapp, ['--sandbox=danger-full-access']))).toEqual([`${HOME_L}/myapp`]);
    expect(addDirs(prepare(0, myapp, ['--full-auto']))).toEqual([`${HOME_L}/myapp`]);
  });

  it('explicit read-only (flag or -c sandbox_mode): no --add-dir and no writable_roots', () => {
    for (const args of [['-s', 'read-only'], ['--sandbox', 'read-only'], ['-c', 'sandbox_mode="read-only"']]) {
      const argv = prepare(0, myapp, args);
      expect(addDirs(argv)).toEqual([]);
      expect(argv.filter((a) => a.startsWith('sandbox_workspace_write'))).toEqual([]);
    }
  });

  it('user-provided writable_roots override is not clobbered', () => {
    const argv = prepare(0, myapp, ['-c', 'sandbox_workspace_write.writable_roots=["/x"]']);
    expect(argv).toEqual(['--cd', `${HOME_P}/myapp`, '-c', 'sandbox_workspace_write.writable_roots=["/x"]']);
  });

  it('explicit -C alias path: no injected --cd, canonical + aliases as roots minus cwd', () => {
    const argv = prepare(0, myapp, ['-C', `${HOME_L}/myapp`]);
    expect(argv).toEqual([
      '-c',
      `sandbox_workspace_write.writable_roots=["${HOME_P}/myapp"]`,
      '-C',
      `${HOME_L}/myapp`,
    ]);
  });

  it('never passes duplicate roots', () => {
    for (const ctx of [myapp, home]) {
      const dirs = addDirs(prepare(0, ctx, ['-s', 'workspace-write']));
      expect(new Set(dirs).size).toBe(dirs.length);
    }
  });
});

maybe('codex() exec wrapper (danger-full-access by default)', () => {
  it('keeps --add-dir for the alias root, deduped, with injected danger-full-access', () => {
    expect(prepare(1, myapp, ['do it'])).toEqual([
      '--cd',
      `${HOME_P}/myapp`,
      '--add-dir',
      `${HOME_L}/myapp`,
      '--sandbox',
      'danger-full-access',
      '--skip-git-repo-check',
      'do it',
    ]);
  });

  it('respects an explicit read-only exec sandbox (no roots, no injected sandbox)', () => {
    const argv = prepare(1, myapp, ['-s', 'read-only', 'do it']);
    expect(addDirs(argv)).toEqual([]);
    expect(argv).not.toContain('danger-full-access');
  });
});

maybe('$HOME/bin/codex shim exec', () => {
  it('default: --cd canon, danger-full-access, alias --add-dir once', () => {
    expect(prepareShimExec(myapp, ['do it'])).toEqual([
      'exec',
      '--cd',
      `${HOME_P}/myapp`,
      '--skip-git-repo-check',
      '--sandbox',
      'danger-full-access',
      '--add-dir',
      `${HOME_L}/myapp`,
      'do it',
    ]);
  });

  it('explicit read-only: no --add-dir', () => {
    const argv = prepareShimExec(myapp, ['-s', 'read-only', 'do it']);
    expect(addDirs(argv)).toEqual([]);
    expect(argv).not.toContain('danger-full-access');
  });

  it('explicit --cd alias: canonical root added, no duplicates', () => {
    const argv = prepareShimExec(myapp, ['--cd', `${HOME_L}/myapp`, 'do it']);
    const dirs = addDirs(argv);
    expect(dirs).toEqual([`${HOME_P}/myapp`]);
    expect(argv).toContain('danger-full-access');
  });
});
