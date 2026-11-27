/**
 * On-device Claude Code, musl channel (shelly-hayato-bridge #6, Step 2).
 *
 * council-facade spawns COUNCIL_CLAUDE_COMMAND without a shell, so the channel
 * is a native `claude_exec` (jni/shelly-claude-exec.c, extracted to
 * termux-libs like codex_exec) that runs the generated runner
 * ~/.shelly-claude-musl-run.sh in Shelly bash. The runner's
 * shelly-claude-musl() is derived from shelly-claude-glibc() by
 * HomeInitializer.claudeMuslFunction: only the binary, its loader and the
 * runtime root change, the proxy / Bash-tool recipe stays one definition.
 *
 * Also BASHRC_VERSION 294: the Bash-tool env file name is fixed before
 * `cat >` runs (an external command's redirect is expanded in the forked
 * child, where $BASHPID differs, so the runner never wrote the file).
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const KT = 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator';
const homeKt = read(`${KT}/HomeInitializer.kt`);

/** Shell text of the appendLine run that starts with `header` (as claude-glibc-snapshot.test.ts). */
function emitted(header: string): string {
  const lines = homeKt.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes(`sb.appendLine("${header}")`));
  expect(start).toBeGreaterThan(-1);
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const m = /^\s*sb\.appendLine\("(.*)"\)\s*$/.exec(lines[i]);
    if (!m) break;
    out.push(m[1].replace(/\$libDir/g, '/libdir').replace(/\\(.)/g, '$1'));
    if (m[1] === '}') break;
  }
  return out.join('\n');
}

const unescapeKt = (s: string) => s.replace(/\\(.)/g, '$1');

/** The swap(from, to, times) calls of claudeMuslFunction, applied to the glibc text. */
function deriveMusl(glibc: string): { text: string; swaps: Array<[string, string, number]> } {
  const fn = homeKt.slice(homeKt.indexOf('internal fun claudeMuslFunction('));
  const body = fn.slice(0, fn.indexOf('internal fun claudeMuslRunnerScript('));
  const swaps: Array<[string, string, number]> = [];
  for (const m of body.matchAll(/swap\("((?:[^"\\]|\\.)*)", "((?:[^"\\]|\\.)*)", (\d+)\)/g)) {
    swaps.push([unescapeKt(m[1]), unescapeKt(m[2]), Number(m[3])]);
  }
  let text = glibc;
  for (const [from, to, times] of swaps) {
    expect([from, text.split(from).length - 1]).toEqual([from, times]);
    text = text.split(from).join(to);
  }
  text = text.split('shelly-claude-glibc:').join('shelly-claude-musl:');
  return { text, swaps };
}

const scrubFn = emitted('__shelly_claude_snapshot_scrub() {');
const glibcFn = emitted('shelly-claude-glibc() {');
const { text: muslFn, swaps } = deriveMusl(glibcFn);

function hasBash(): boolean {
  const r = childProcess.spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
  return !r.error && r.stdout.trim() === 'ok';
}

describe('Claude Bash-tool env file name (BASHRC_VERSION 294)', () => {
  it('bumped BASHRC_VERSION to 294', () => {
    expect(Number(homeKt.match(/private const val BASHRC_VERSION = (\d+)/)![1])).toBeGreaterThanOrEqual(294);
  });

  it('fixes the tmp name in a variable before cat, and renames that same name', () => {
    expect(glibcFn).toContain('__envtmp="$__envf.$BASHPID.tmp"');
    expect(glibcFn).toContain(`cat > "$__envtmp" <<'__SHELLY_CLAUDE_ENV'`);
    expect(glibcFn).toContain('mv -f "$__envtmp" "$__envf"');
    expect(glibcFn).not.toContain('cat > "$__envf.$BASHPID.tmp"');
    expect(glibcFn.indexOf('__envtmp="$__envf.$BASHPID.tmp"')).toBeLessThan(glibcFn.indexOf('cat > "$__envtmp"'));
  });

  (hasBash() ? it : it.skip)('the old form misses its own file under an external cat; the new form does not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-envtmp-'));
    try {
      const d = dir.replace(/\\/g, '/');
      const cat = childProcess.spawnSync('bash', ['-c', 'command -v cat'], { encoding: 'utf8' }).stdout.trim();
      const run = (s: string) => childProcess.spawnSync('bash', ['-c', s, 'test', d, cat], { encoding: 'utf8' });
      const oldForm = run('( "$2" > "$1/old.$BASHPID.tmp" <<<x; mv -f "$1/old.$BASHPID.tmp" "$1/old" 2>/dev/null; [ -f "$1/old" ] && echo HAVE || echo MISSING )');
      const newForm = run('( t="$1/new.$BASHPID.tmp"; "$2" > "$t" <<<x; mv -f "$t" "$1/new"; [ -f "$1/new" ] && echo HAVE || echo MISSING )');
      expect(newForm.stdout.trim()).toBe('HAVE');
      // Documents why: bash expands an external command's redirect after fork.
      expect(oldForm.stdout.trim()).toBe('MISSING');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('shelly-claude-musl() derived from shelly-claude-glibc()', () => {
  it('changes only the binary, its loader, the runtime root and the messages', () => {
    expect(swaps.length).toBe(7);
    expect(muslFn).toContain('shelly-claude-musl() {');
    expect(muslFn).toContain('local __root="$HOME/.shelly-runtime/claude-musl"');
    expect(muslFn).toContain('local __ld="$SHELLY_LIB_DIR/claude-musl/ld-musl-aarch64.so.1"');
    expect(muslFn).toContain('builtin cd -P "$SHELLY_LIB_DIR/claude-musl"');
    expect(muslFn).toContain('"$__ld" --library-path "$SHELLY_LIB_DIR/claude-musl" "$__bin" "${__xargs[@]}" "$@"');
    expect(muslFn).not.toContain('claude-glibc');
    // The recipe is the glibc one, untouched: ulexec loader, private proxy, Bash tool, Grep/Glob deny.
    for (const kept of [
      '"$SHELLY_LIB_DIR/shelly_glibc_exec" \\',
      '__proxy_js="$HOME/.shelly-claude-proxy.js"',
      'CLAUDE_CODE_SHELL="${CLAUDE_CODE_SHELL:-$__sh}" CLAUDE_ENV_FILE="${CLAUDE_ENV_FILE:-$__envf}" \\',
      `__settings='{"permissions":{"deny":["Grep","Glob"]}}'`,
      '__shelly_claude_snapshot_scrub "$__snapd" neutralize',
      'mv -f "$__envtmp" "$__envf"',
    ]) {
      expect(glibcFn).toContain(kept);
      expect(muslFn).toContain(kept);
    }
    // Line for line the same function apart from the swapped lines.
    const g = glibcFn.split('\n');
    const m = muslFn.split('\n');
    expect(m.length).toBe(g.length);
    const changed = g.filter((l, i) => l !== m[i]).length;
    expect(changed).toBeLessThanOrEqual(12);
  });

  it('the generator refuses drift: counted swaps and no glibc path left', () => {
    const fn = homeKt.slice(homeKt.indexOf('internal fun claudeMuslFunction('));
    expect(fn).toContain('check(n == times)');
    expect(fn).toContain('check(!text.contains("claude-glibc"))');
    expect(fn).toContain('appendClaudeGlibcFunction(glibc, libDir)');
    // Still exactly two emitters of the glibc function itself (.bashrc and the glibc runner).
    expect(homeKt.split('appendClaudeGlibcFunction(sb, libDir)').length - 1).toBe(2);
  });

  (hasBash() ? it : it.skip)('the derived function parses as bash', () => {
    const r = childProcess.spawnSync('bash', ['-n'], { input: `${scrubFn}\n${muslFn}\n`, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('the musl runner is written every start, 0700, never an agent runner', () => {
    const runner = homeKt.slice(homeKt.indexOf('internal fun claudeMuslRunnerScript('));
    const body = runner.slice(0, runner.search(/\r?\n {4}\}\r?\n/));
    expect(body).toContain('sb.append(claudeMuslFunction(libDir))');
    expect(body).toContain('sb.appendLine("shelly-claude-musl \\"\\$@\\"")');
    expect(body).toContain('sb.appendLine("__shelly_paste_tui_begin() { :; }")');
    expect(body).toContain('export SHELLY_LIB_DIR=');
    expect(body).not.toContain('__SHELLY_CLAUDE_AGENT_RUN=1');
    expect(homeKt).toContain('val claudeMuslRunner = File(home, ".shelly-claude-musl-run.sh")');
    expect(homeKt).toContain('tmp.writeText(claudeMuslRunnerScript(libDir))');
    const block = homeKt.slice(homeKt.indexOf('val claudeMuslRunner = File('));
    expect(block.slice(0, 700)).toContain('tmp.setExecutable(false, false); tmp.setExecutable(true, true)');
  });
});

describe('claude_exec native entry', () => {
  const c = read('modules/terminal-emulator/android/src/main/jni/shelly-claude-exec.c');
  const libExtractor = read(`${KT}/LibExtractor.kt`);

  it('runs the generated musl runner in Shelly bash through linker64 with a raw execve', () => {
    expect(c).toContain('shelly-claude-exec:v1:musl-runner');
    expect(c).toContain('#define RUNNER_REL "/.shelly-claude-musl-run.sh"');
    expect(c).toContain('"%s/libbash.so"');
    expect(c).toContain('"%s/claude-musl/claude"');
    expect(c).toContain('"%s/libexec_wrapper.so"');
    const argv = c.slice(c.indexOf('args[k++] = (char *)LINKER64;'));
    const order = ['args[k++] = bash;', 'args[k++] = (char *)"--noprofile";', 'args[k++] = (char *)"--norc";', 'args[k++] = runner;', 'for (int i = 1; i < argc; i++) args[k++] = argv[i];'];
    const at = order.map((s) => argv.indexOf(s));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(c).toContain('syscall(SYS_execve, LINKER64, args, env);');
    expect(c).toContain('make_kv("LD_PRELOAD", preload)');
    expect(c).toContain('make_kv("LD_LIBRARY_PATH", lib_dir)');
    expect(c).toContain('make_kv("HOME", home)');
  });

  it('the caller environment never picks the lib dir, HOME, the runner or the recipe', () => {
    expect(c).not.toContain('getenv(');
    expect(c).toContain('"/files/termux-libs"');
    expect(c).toContain('"%s/claude_exec"');
    for (const k of ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'SHELLY_LIB_DIR', 'HOME', 'BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS',
      '__SHELLY_CLAUDE_AGENT_RUN', 'SHELLY_CLAUDE_AGENT_DIR', 'SHELLY_CLAUDE_SETTINGS_JSON', 'CLAUDE_CODE_SHELL', 'CLAUDE_ENV_FILE']) {
      const drop = c.slice(c.indexOf('static const char *const DROP_KEYS[]'), c.indexOf('#define DROP_KEY_COUNT'));
      expect([k, drop.includes(`"${k}"`)]).toEqual([k, true]);
    }
    expect(c).toContain('strncmp(entry, "BASH_FUNC_", 10) == 0');
  });

  it('is extracted as termux-libs/claude_exec on every start', () => {
    expect(libExtractor).toContain('"lib/arm64-v8a/libshelly_claude_exec.so" to "claude_exec"');
    const refresh = libExtractor.slice(libExtractor.indexOf('private val ALWAYS_REFRESH'));
    expect(refresh.slice(0, refresh.search(/\r?\n {4}\)/))).toContain('"claude_exec"');
    expect(homeKt).not.toContain('bin/claude_exec');
  });

  it('is built, cached and marker-checked by both Android workflows', () => {
    for (const wf of ['.github/workflows/build-android.yml', '.github/workflows/build-dev-debug.yml']) {
      const y = read(wf);
      expect(y).toContain('SRC="modules/terminal-emulator/android/src/main/jni/shelly-claude-exec.c"');
      expect(y).toContain('jniLibs/arm64-v8a/libshelly_claude_exec.so');
      expect(y).toContain("check_marker /tmp/libshelly_claude_exec.so 'shelly-claude-exec:v1:musl-runner'");
      // One real command line (a stray literal backslash-n once made clang look for a file named `n`).
      const step = y.slice(y.indexOf('Build Shelly `claude_exec` native launcher'));
      expect(step.slice(0, step.indexOf('chmod 755'))).toContain('-Werror "${SRC}" -o "${OUT}"');
    }
  });
});
