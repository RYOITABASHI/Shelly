/**
 * Typed, pasted and dictated text must not reach logcat: every process of the
 * app's uid can read it, and a password typed at `read -s` still comes through
 * the IME and paste paths. The Java, Kotlin and C here do not run under Jest, so
 * this reads their source.
 */
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

const EMULATOR = 'modules/terminal-emulator/android/src/main/java/com/termux/terminal/TerminalEmulator.java';
const VIEW = 'modules/terminal-view/android/src/main/java/com/termux/view/TerminalView.java';
const MODULE = 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/TerminalEmulatorModule.kt';
const VOICE = 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/VoiceBridge.kt';
const EXEC_C = 'modules/terminal-emulator/android/src/main/jni/shelly-exec.c';

/** Each log statement, joined across lines, up to its closing `);`. */
function logStatements(source: string): string[] {
  const out: string[] = [];
  const re = /(?:\bLog\.[dviwe]\(|mClient\.log(?:Info|Verbose|Error)\()/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const end = source.indexOf(');', m.index);
    out.push(source.slice(m.index, end + 2));
  }
  return out;
}

describe('no input in native logs', () => {
  const view = logStatements(read(VIEW));
  const emulator = logStatements(read(EMULATOR));

  it('finds the log statements it is meant to check', () => {
    expect(view.filter((s) => s.includes('ShellyIME')).length).toBeGreaterThan(5);
    expect(emulator.filter((s) => s.includes('ShellyPaste'))).toHaveLength(1);
  });

  it.each([
    ['the composing text', /\+\s*mComposingRun\s*\+|\+\s*mComposingRun\s*\)/],
    ['the committed text', /\+\s*commitStr\s*\+|\+\s*commitStr\s*\)/],
    ['IME text', /\+\s*text\s*\+|\+\s*text\s*\)/],
    ['a character', /Integer\.toHexString|\bcodePoint=|\+\s*code\s*\)|\+\s*result\s*\)/],
  ])('TerminalView logs no %s', (_name, pattern) => {
    expect(view.filter((s) => pattern.test(s))).toEqual([]);
  });

  it('the paste trace keeps its lengths and has no preview', () => {
    const [paste] = emulator.filter((s) => s.includes('ShellyPaste'));
    expect(paste).toContain('"paste(raw=" + rawLen');
    expect(paste).toContain('", nl=" + nlCount');
    expect(paste).not.toMatch(/preview/i);
    expect(read(EMULATOR)).not.toContain('text.substring(0, 32)');
  });

  it('the IME events keep their names and lengths', () => {
    const joined = view.join('\n');
    for (const event of ['setComposing len=', 'finishComposing flush len=', 'commit SUPPRESSED', 'commit-as-typed len=', 'commit-as-paste len=']) {
      expect(joined).toContain(event);
    }
  });

  it('a failed command logs lengths, not the command or its stderr', () => {
    const line = read(MODULE).split(String.fromCharCode(10)).filter((s) => s.includes('execCommand FAILED'));
    expect(line).toHaveLength(1);
    expect(line[0]).toContain('stderrLen=');
    expect(line[0]).not.toMatch(/stderr=|cmd=|command\.take/);
  });

  it('a bad voice control line is not printed', () => {
    expect(read(VOICE)).not.toContain('unparseable control line: $line');
  });

  it('the exec JNI does not print the command', () => {
    expect(read(EXEC_C)).not.toMatch(/LOG[A-Z]\([^;]*cmd=%[.\d]*s/);
  });
});

describe('no input in JS logs', () => {
  it.each([
    ['store/terminal-store.ts', 'runCommand'],
    ['hooks/use-native-exec.ts', 'exec'],
  ])('%s logs the command length only', (rel, event) => {
    const source = read(rel);
    expect(source).toContain(`${event} len=`);
    expect(source).not.toMatch(/log(?:Info|Error)\([^;]*command\.slice/);
  });
});

describe('no stream feed content in logs (put_stream_feed, launcher ingress C7)', () => {
  /** Each JS log call, joined across lines, up to its closing `);`. */
  function jsLogCalls(source: string, re: RegExp): string[] {
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
      const end = source.indexOf(');', m.index);
      out.push(source.slice(m.index, end + 2));
    }
    return out;
  }

  it.each([
    ['lib/mcp-server-bridge.ts', /\blog(?:Info|Error|Warn)\(/g],
    ['lib/mcp-stream-feed.ts', /\blog(?:Info|Error|Warn)\(/g],
    ['scripts/shelly-mcp-server.js', /\blog\(/g],
  ])('%s never logs the feed', (rel, re) => {
    const calls = jsLogCalls(read(rel), re);
    expect(calls.filter((c) => /feedJson|\bdoc\b|valid\.args\b/.test(c))).toEqual([]);
  });

  it('lib/mcp-stream-feed.ts logs nothing at all', () => {
    expect(read('lib/mcp-stream-feed.ts')).not.toMatch(/debug-logger|console\./);
  });

  it('the RN bridge sends the feed to native streamFeedPut and nowhere else', () => {
    const bridge = read('lib/mcp-server-bridge.ts');
    const uses = bridge.split('\n').filter((l) => /\bfeedJson\b/.test(l));
    expect(uses.every((l) => /const \{ feedJson, expectedSha256, expectedBytes \} = valid\.args|streamFeedPut!\(feedJson,/.test(l))).toBe(true);
    expect(uses).toHaveLength(2);
  });
});

describe('no launcher instruction text in logs or audit lines (launcher ingress Phase 2)', () => {
  const KT = 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator';
  const PHASE2_KT = ['LauncherSubmissions.kt', 'LauncherSubmissionCore.kt', 'LauncherApprovalNotifier.kt', 'McpTypedOpConsumer.kt', 'McpRunTickets.kt'];

  it.each(PHASE2_KT)('%s logs no text, prompt or reply body', (file) => {
    // Kotlin has no `;`: every Log call in these files is one line, checked whole.
    const logs = read(`${KT}/${file}`).split('\n').filter((l) => /\bLog\.[dviwe]\(/.test(l));
    // The pure core logs nothing at all; the I/O files do log (and are checked).
    if (file === 'LauncherSubmissionCore.kt') expect(logs).toEqual([]);
    else expect(logs.length).toBeGreaterThan(0);
    // Only string templates of fixed names: no text / prompt / JSON value is interpolated.
    const interpolated = logs.flatMap((l) => [...l.matchAll(/\$\{([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_.]*)/g)].map((m) => m[1] ?? m[2]));
    expect(interpolated.filter((v) => /\btext\b|prompt|detail|json|instruction|answer|reply|added/i.test(v))).toEqual([]);
  });

  it('the decision / expiry / reader audit lines carry fixed fields only (no text parameter exists)', () => {
    const core = read(`${KT}/LauncherSubmissionCore.kt`);
    const recordLine = core.slice(core.indexOf('fun recordLine('), core.indexOf('// ── The owner'));
    expect(recordLine).not.toMatch(/\btext\s*=/);
    expect(recordLine).toContain('textSha256 = s.textSha256');
    const writer = read(`${KT}/IngressAuditWriter.kt`);
    const reader = writer.slice(writer.indexOf('fun buildSubmissionReaderLine('), writer.indexOf('fun appendSubmissionReaderLine('));
    expect(reader).not.toMatch(/\btext\b/);
  });

  it('lib/launcher-approval.ts never logs the prompt text', () => {
    const source = read('lib/launcher-approval.ts');
    const calls: string[] = [];
    const re = /\blog(?:Info|Warn|Error)\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) calls.push(source.slice(m.index, source.indexOf(');', m.index) + 2));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((c) => /\.text\b|\bdetail\b|prompt\)/.test(c))).toEqual([]);
    expect(source).not.toMatch(/console\./);
  });
});
