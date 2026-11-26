// codex_exec native entry point (BASHRC_VERSION 294): council-facade's node
// spawns COUNCIL_CODEX_COMMAND=codex_exec without a shell, so it must be an
// app-data ELF on PATH ($HOME/bin/codex_exec -> $SHELLY_LIB_DIR/shelly_codex_exec)
// that runs `codex_tui exec "$@"` with the agent driver's Codex choice.
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const KT = 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator';

describe('codex_exec native entry', () => {
  const c = read('modules/terminal-emulator/android/src/main/jni/shelly-codex-exec.c');
  const libExtractor = read(`${KT}/LibExtractor.kt`);
  const home = read(`${KT}/HomeInitializer.kt`);
  const hygiene = read(`${KT}/PayloadHygiene.kt`);

  it('runs the reviewed Codex (agent-current when healthy, else bundled) as `exec`', () => {
    expect(c).toContain('shelly-codex-exec:v1:agent-current-or-bundled');
    expect(c).toContain('"/.shelly-runtime/codex/agent-current"');
    for (const f of ['/.healthy', '/manifest.json', '/codex_tui']) expect(c).toContain(`"%s${f}"`);
    // Never the TUI channel, never a caller-supplied path.
    expect(c).not.toMatch(/codex\/current"/);
    expect(c).not.toContain('getenv("SHELLY_CODEX_TUI_PATH")');
    // `exec` follows the global -c options, then the caller's arguments.
    const execAt = c.indexOf('args[k++] = (char *)"exec";');
    expect(execAt).toBeGreaterThan(c.indexOf('"features.shell_snapshot=false"'));
    expect(c.indexOf('for (int i = 1; i < argc; i++) args[k++] = argv[i];')).toBeGreaterThan(execAt);
  });

  it('uses the driver/codex() launch recipe through linker64 with a raw execve', () => {
    for (const v of ['SHELLY_CODEX_EXEC_PATH', 'SHELLY_CODEX_PROC_EXE_SHIM', 'SHELLY_CODEX_PROC_EXE_OPEN_SHIM', 'LD_PRELOAD', 'LD_LIBRARY_PATH']) {
      expect(c).toContain(`make_kv("${v}"`);
    }
    expect(c).toContain('"%s/libexec_wrapper.so"');
    expect(c).toContain('syscall(SYS_execve, LINKER64, args, env);');
  });

  it('is extracted, always refreshed, and linked from $HOME/bin without reviving the retired name', () => {
    expect(libExtractor).toContain('"lib/arm64-v8a/libshelly_codex_exec.so" to "shelly_codex_exec"');
    const refresh = libExtractor.slice(libExtractor.indexOf('private val ALWAYS_REFRESH'));
    expect(refresh.slice(0, refresh.search(/\r?\n {4}\)/))).toContain('"shelly_codex_exec"');
    // The retired termux-libs/codex_exec stays retired and is not an extracted name.
    expect(hygiene).toMatch(/RETIRED_LIB_FILES[^)]*"codex_exec"/);
    expect(libExtractor).not.toMatch(/to "codex_exec"/);
    expect(Number(home.match(/private const val BASHRC_VERSION = (\d+)/)![1])).toBeGreaterThanOrEqual(294);
    expect(home).toContain('__shelly_ln -s \\"\\$SHELLY_LIB_DIR/shelly_codex_exec\\" \\"\\$HOME/bin/codex_exec\\"');
  });

  it('is built and marker-checked by both Android workflows', () => {
    for (const wf of ['.github/workflows/build-android.yml', '.github/workflows/build-dev-debug.yml']) {
      const y = read(wf);
      expect(y).toContain('jni/shelly-codex-exec.c');
      expect(y).toContain('jniLibs/arm64-v8a/libshelly_codex_exec.so');
      expect(y).toContain("check_marker /tmp/libshelly_codex_exec.so 'shelly-codex-exec:v1:agent-current-or-bundled'");
    }
  });
});
