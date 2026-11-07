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
