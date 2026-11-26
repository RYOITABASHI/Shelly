/**
 * Payload freshness (A1 / A2 / A4): source invariants for the native side.
 * Kotlin is not compiled in jest; the behaviour itself is covered by the JVM
 * unit test PayloadHygieneTest.kt (`./gradlew :terminal-emulator:testDebugUnitTest`,
 * not wired into CI yet). These pin the wiring so it can't silently drift.
 */
import fs from 'fs';
import path from 'path';

const kdir = path.join(__dirname, '..', 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator');
const read = (f: string) => fs.readFileSync(path.join(kdir, f), 'utf8');
const lib = read('LibExtractor.kt');
const home = read('HomeInitializer.kt');
const hygiene = read('PayloadHygiene.kt');
const test = fs.readFileSync(
  path.join(__dirname, '..', 'modules/terminal-emulator/android/src/test/java/expo/modules/terminalemulator/PayloadHygieneTest.kt'),
  'utf8',
);

function libsValues(): string[] {
  const start = lib.indexOf('private val LIBS = mapOf(');
  const end = lib.indexOf('\n    )', start);
  return [...lib.slice(start, end).matchAll(/"lib\/arm64-v8a\/[^"]+" to "([^"]+)"/g)].map((m) => m[1]);
}

function retired(): string[] {
  const start = hygiene.indexOf('val RETIRED_LIB_FILES: List<String> = listOf(');
  const end = hygiene.indexOf(')', start + 'val RETIRED_LIB_FILES: List<String> = listOf('.length);
  return [...hygiene.slice(start, end).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function extractAllBody(): string {
  const start = lib.indexOf('fun extractAll(context: Context): File {');
  return lib.slice(start, lib.indexOf('\n    private fun appVersionMarker', start));
}

describe('PayloadHygiene stays plain-JVM and java.io only', () => {
  it('has no android.* or java.nio.file imports (minSdk 24; JVM-testable)', () => {
    expect(hygiene).not.toMatch(/^import android\./m);
    expect(hygiene).not.toMatch(/import java\.nio|java\.nio\.file\.\w/);
  });
});

describe('A1: retired payloads', () => {
  it('no retired name is still extracted (codex_exec is the launcher again, not retired)', () => {
    const r = retired();
    expect(r).not.toContain('codex_exec');
    const values = libsValues();
    expect(values).toContain('codex_exec');
    expect(values.length).toBeGreaterThan(50);
    expect(values).toContain('codex_tui');
    for (const name of r) expect(values).not.toContain(name);
  });

  it('extractAll removes them before extracting, on every call, with logging', () => {
    const body = extractAllBody();
    const call = body.indexOf('PayloadHygiene.removeRetired(libDir, PayloadHygiene.RETIRED_LIB_FILES, LIBS.values.toSet())');
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(body.indexOf('for ((apkEntry, fileName) in LIBS)'));
    // Not behind the refresh gate.
    expect(body.slice(0, call)).not.toMatch(/if \(forceRefresh[^\n]*\{\s*$/);
    expect(body.slice(call, call + 200)).toContain('logHygiene(TAG, it)');
    expect(hygiene).toContain('retired payload removed: termux-libs/$name');
  });

  it('documents why (v231 retired codex_exec; a stale copy runs silently)', () => {
    expect(hygiene).toMatch(/setup v231/);
    expect(hygiene).toMatch(/silently runs a binary/);
  });

  it('checks presence without following links, so a dangling link is removed too (P2-3)', () => {
    const fn = hygiene.slice(hygiene.indexOf('fun existsNoFollow(f: File): Boolean {'), hygiene.indexOf('fun removeRetired('));
    expect(fn).toContain('if (f.exists()) return true');
    // readdir on the parent: lists a dangling link that File.exists() misses.
    expect(fn).toContain('parent.list()?.contains(f.name) == true');
    expect(fn).toContain('fun isDanglingSymlink(f: File): Boolean = !f.exists() && existsNoFollow(f)');
    const rr = hygiene.slice(hygiene.indexOf('fun removeRetired('), hygiene.indexOf('Name of a LibExtractor temp file'));
    expect(rr).toContain('if (!existsNoFollow(f)) continue');
    expect(rr).toContain('val link = isDanglingSymlink(f) || isSymlink(f)');
    expect(rr).not.toMatch(/if \(!f\.exists\(\)\) continue/);
  });

  it('is unit-tested on the JVM', () => {
    expect(test).toContain('a dangling retired symlink is removed too');
    expect(test).toContain('a retired name is removed, other files stay');
    expect(test).toContain('a retired symlink is removed without touching its target');
  });
});

describe('A4: stale *.new temp files', () => {
  it('extractAll cleans them on a refresh pass only, before the lib loop', () => {
    const body = extractAllBody();
    const gate = body.indexOf('if (forceRefresh || !alwaysRefreshDoneInProcess) {');
    const call = body.indexOf('PayloadHygiene.removeStaleTempFiles(');
    expect(gate).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(gate);
    expect(call).toBeLessThan(body.indexOf('for ((apkEntry, fileName) in LIBS)'));
    expect(body.slice(call, call + 300)).toContain('LIBS.values.toSet()');
    expect(body.slice(call, call + 300)).toContain('android.os.Process.myPid()');
  });

  it('parses the exact name newTempFile produces', () => {
    expect(lib).toContain('File(libDir, "$fileName.${android.os.Process.myPid()}.${Thread.currentThread().id}.${System.nanoTime()}.new")');
    const re = hygiene.match(/private val TEMP_NAME = Regex\("(.+)"\)/);
    expect(re).not.toBeNull();
    const js = new RegExp(re![1].replace(/\\\\/g, '\\'));
    const m = js.exec('libz.so.1.12345.2.987654321.new');
    expect(m && m[1]).toBe('libz.so.1');
    expect(m && m[2]).toBe('12345');
    expect(js.exec('libz.so.1.new')).toBeNull();
    expect(js.exec('codex_tui')).toBeNull();
  });

  it('is unit-tested on the JVM', () => {
    expect(test).toContain('stale temp files of dead writers are removed, live and foreign files stay');
  });
});

describe('A2: ~/.shelly-mcp-server.js equals the APK asset after initialize()', () => {
  const initStart = home.indexOf('fun initialize(context: Context): File {');
  const initBody = home.slice(initStart, initStart + 4000);

  it('syncs first thing in initialize(), before any statement that could throw', () => {
    const sync = initBody.indexOf('syncMcpServerScript(context, home)');
    expect(sync).toBeGreaterThan(0);
    const before = initBody.slice(0, sync).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
    expect(before).toEqual(['fun initialize(context: Context): File {', 'val home = getHomeDir(context)']);
  });

  it('compares bytes with the asset and verifies by read-back (no gate, no trust in the copy)', () => {
    const fn = home.slice(home.indexOf('private fun syncMcpServerScript('), home.indexOf('private fun java.io.InputStream.copyToAtomically'));
    expect(fn).toContain('context.assets.open("shelly-mcp-server.js").use { it.readBytes() }');
    expect(fn).toContain('PayloadHygiene.syncExact(\n');
    expect(fn).toContain('File(home, ".shelly-mcp-server.js")');
    expect(fn).toMatch(/catch \(e: Exception\)/);
    expect(hygiene).toMatch(/fun syncExact\(\n\s+expected: ByteArray,\n\s+target: File,\n\s+log: \(String\) -> Unit,\n\s+writeTemp: \(File, ByteArray\) -> Unit = .*\n\s+\): SyncOutcome \{\n\s+if \(contentEquals\(target, expected\)\) return SyncOutcome\.UNCHANGED/);
  });

  it('no syncExact call passes a trailing lambda; production names its log (P3-1)', () => {
    // syncExact's last parameter is writeTemp, so a trailing lambda would bind
    // there and leave the required log missing (a compile error in the APK
    // build, which jest cannot see). Walk every call in main and test sources.
    const roots = [kdir, path.join(__dirname, '..', 'modules/terminal-emulator/android/src/test/java/expo/modules/terminalemulator')];
    const calls: { file: string; args: string; after: string }[] = [];
    for (const dir of roots) {
      for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.kt'))) {
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        for (const m of src.matchAll(/syncExact\(/g)) {
          if (src.slice(Math.max(0, m.index! - 4), m.index!) === 'fun ') continue;
          let depth = 0;
          let i = m.index! + 'syncExact'.length;
          for (; i < src.length; i++) {
            if (src[i] === '(') depth++;
            else if (src[i] === ')' && --depth === 0) break;
          }
          calls.push({ file: f, args: src.slice(m.index!, i + 1), after: src.slice(i + 1).trimStart()[0] });
        }
      }
    }
    expect(calls.filter((c) => c.file === 'HomeInitializer.kt')).toHaveLength(1);
    expect(calls.filter((c) => c.file === 'PayloadHygieneTest.kt').length).toBeGreaterThan(0);
    for (const c of calls) expect({ file: c.file, after: c.after }).toEqual({ file: c.file, after: expect.not.stringMatching(/^\{$/) });
    const prod = calls.find((c) => c.file === 'HomeInitializer.kt')!;
    expect(prod.args).toMatch(/,\s*log = \{ msg -> LibExtractor\.logHygiene\("HomeInitializer", msg\) \},?\s*\)$/);
    expect(prod.args).not.toContain('writeTemp');
    // log precedes writeTemp in the signature, and writeTemp keeps a default.
    const sig = hygiene.slice(hygiene.indexOf('fun syncExact('), hygiene.indexOf('): SyncOutcome {'));
    expect(sig.indexOf('log: (String) -> Unit,')).toBeLessThan(sig.indexOf('writeTemp: (File, ByteArray) -> Unit = '));
  });

  it('never removes the existing file before a verified replacement is ready (P2-1)', () => {
    const fn = hygiene.slice(hygiene.indexOf('fun syncExact('), hygiene.indexOf('fun contentEquals('));
    // No pre-delete of the target, no recursive delete anywhere.
    expect(hygiene).not.toMatch(/clearPath|deleteTreeNoFollow|deleteRecursively/);
    expect(fn).not.toMatch(/target\.delete\(\)/);
    // A directory at the name fails without being touched, before any write.
    const dirCheck = fn.indexOf('if (!isSymlink(target) && target.isDirectory) {');
    expect(dirCheck).toBeGreaterThan(0);
    expect(fn.slice(dirCheck, dirCheck + 250)).toContain('return SyncOutcome.FAILED');
    expect(dirCheck).toBeLessThan(fn.indexOf('replaceVerified('));
    // Temp file -> its bytes verified -> only then rename over the name.
    const rep = hygiene.slice(hygiene.indexOf('private fun replaceVerified('));
    const verify = rep.indexOf('if (!contentEquals(tmp, bytes))');
    const rename = rep.indexOf('tmp.renameTo(target)');
    expect(rep.indexOf('writeTemp(tmp, bytes)')).toBeGreaterThan(0);
    expect(verify).toBeGreaterThan(rep.indexOf('writeTemp(tmp, bytes)'));
    expect(rename).toBeGreaterThan(verify);
    expect(rep.slice(verify, rename)).toContain('throw java.io.IOException(');
  });

  it('the keep-the-old-file scenarios are unit-tested on the JVM', () => {
    expect(test).toContain('both attempts failing keep the old script readable');
    expect(test).toContain('a short write that does not throw is caught before the rename');
    expect(test).toContain('a first attempt failing and a second succeeding replaces the script');
    expect(test).toContain('a directory at the name is left untouched and the sync fails');
    expect(test).not.toContain('a directory at the name is cleared on the retry');
  });

  it('a failed sync leaves that part of initialize() unfinished: error log, retried, no done-mark (P2-2)', () => {
    const fn = home.slice(home.indexOf('private fun syncMcpServerScript('), home.indexOf('private fun java.io.InputStream.copyToAtomically'));
    // (b) both failure paths log an error and say it is retried.
    const errors = fn.match(/android\.util\.Log\.e\("HomeInitializer", "initialize\(\) incomplete: [^\n]*will retry on the next initialize\(\)"\)/g);
    expect(errors).toHaveLength(2);
    // The outcome is recorded: FAILED or an exception -> false.
    expect(fn).toContain('outcome != PayloadHygiene.SyncOutcome.FAILED');
    expect(fn).toMatch(/catch \(e: Exception\) \{\n[^\n]*\n\s+false\n\s+\}/);
    expect(fn).toContain('mcpServerScriptInSync = inSync');
    expect(fn).toMatch(/@Volatile\n\s+var mcpServerScriptInSync: Boolean = false\n\s+private set/);
    // (a) every initialize() runs the sync: not behind a marker or flag.
    const initBody = home.slice(home.indexOf('fun initialize(context: Context): File {'), home.indexOf('fun initialize(context: Context): File {') + 600);
    expect(initBody).toMatch(/\n {8}syncMcpServerScript\(context, home\)\n/);
    // (c) the one cached "initialize() is done" flag needs the verified sync.
    const sup = fs.readFileSync(path.join(kdir, 'McpServerSupervisor.kt'), 'utf8');
    const ensure = sup.slice(sup.indexOf('private fun ensureRuntime('), sup.indexOf('private fun newBridgeKey('));
    expect(ensure).toContain('homeInitialized = HomeInitializer.mcpServerScriptInSync');
    expect(ensure).not.toContain('homeInitialized = true');
    expect(sup.match(/^\s+homeInitialized = /gm)).toHaveLength(1);
  });

  it('the supervisor does not latch its mark: every ensureRuntime re-reads the sync state (P3-2)', () => {
    const sup = fs.readFileSync(path.join(kdir, 'McpServerSupervisor.kt'), 'utf8');
    const ensure = sup.slice(sup.indexOf('private fun ensureRuntime('), sup.indexOf('private fun newBridgeKey('));
    // The guard consults the current HomeInitializer state, not only the
    // supervisor's own flag, so a failure seen by another caller re-runs it.
    // (Comment lines between the statements are allowed, nothing else.)
    expect(ensure).toMatch(/\n\s+if \(!homeInitialized \|\| !HomeInitializer\.mcpServerScriptInSync\) \{\n\s+HomeInitializer\.initialize\(app\)\n(?:\s+\/\/[^\n]*\n)*\s+homeInitialized = HomeInitializer\.mcpServerScriptInSync\n/);
    // The old latched guard (flag alone in front of initialize()) is gone.
    expect(ensure).not.toMatch(/if \(!homeInitialized\) \{\n\s+HomeInitializer\.initialize\(app\)/);
    // Exactly one guarded initialize() call, and the runtime extraction still
    // runs on every call (outside the guard).
    expect(ensure.match(/HomeInitializer\.initialize\(app\)/g)).toHaveLength(1);
    expect(ensure).toMatch(/\n {8}\}\n {8}LibExtractor\.ensureExtracted\(app\)\n/);
    // The flag is only ever written from the sync state (never true by fiat).
    expect(sup.match(/homeInitialized = /g)).toHaveLength(2); // declaration + the one assignment
    expect(sup).toMatch(/@Volatile private var homeInitialized = false\n/);
  });

  it('the old unverified copy is gone (exactly one writer of the file)', () => {
    expect(home).not.toContain('input.copyToAtomically(mcpServerScript)');
    expect(home.match(/"shelly-mcp-server\.js"/g)).toHaveLength(1);
  });

  it('is unit-tested from a stale file that is already there', () => {
    expect(test).toContain('a stale script that is already there is replaced by the asset bytes');
    expect(test).toContain('a stale script with the same size is still replaced');
    expect(test).toContain('a symlink at the name is replaced and its target is never written');
  });
});
