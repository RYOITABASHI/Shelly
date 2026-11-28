/**
 * shelly-hayato-bridge #6 (2026-11-28): a paste into Claude Code's setup-token
 * prompt arrived 2 characters too long. Claude Code enables bracketed paste
 * (DECSET 2004) without the alternate screen or mouse tracking, so paste()
 * took it for the bash prompt and sent the readline-only BEGIN trigger
 * 0x18 0x02, which Claude Code inserts as two characters. Reproduced on
 * device with tmux send-keys -H: "18 02 abcdef 1b[201~" -> "**abcdef"
 * (cursor 2 cells before the end), "1b[200~ <92 chars> 1b[201~" -> 92 chars.
 *
 * The fix: a foreground process group (tpgid in /proc/<shell>/stat) that is
 * not the shell and holds anything but a Shelly bash is a program, and gets
 * the standard markers. These checks pin that wiring in the Java source.
 */
import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(
  path.join(__dirname, '..', 'modules/terminal-emulator/android/src/main/java/com/termux/terminal/TerminalEmulator.java'),
  'utf8',
);
const pasteBody = src.slice(src.indexOf('public void paste(String text)'), src.indexOf('private boolean hasLineBreak('));

describe('paste() into a foreground program', () => {
  it('counts a foreground program as TUI when choosing the markers', () => {
    expect(pasteBody).toMatch(
      /boolean tuiMode = isAlternateBufferActive\(\) \|\| isMouseTrackingActive\(\) \|\| isForegroundProgramNotShellyBash\(\);/,
    );
  });

  it('sends 0x18 0x02 only on the branch after the TUI check', () => {
    const std = pasteBody.indexOf('} else if (forceTuiPaste || tuiMode || !shellIsBash) {');
    const readline = pasteBody.indexOf('mSession.write("\\u0018\\u0002" + text');
    expect(std).toBeGreaterThan(0);
    expect(readline).toBeGreaterThan(std);
    expect(pasteBody.slice(std, readline)).toContain('mSession.write("\\u001B[200~" + text + "\\u001B[201~");');
  });

  it('reads the foreground group from tpgid and treats only Shelly bash as readline', () => {
    const helper = src.slice(src.indexOf('private boolean isForegroundProgramNotShellyBash()'), src.indexOf('static int procStatField('));
    expect(helper).toContain('procStatField(readProcText("/proc/" + shellPid + "/stat"), 5)');
    expect(helper).toContain('if (tpgid <= 0 || tpgid == shellPid) return false;');
    expect(helper).toContain('if (!isShellyBashCmdline(readProcText("/proc/" + name + "/cmdline"))) return true;');
  });

  it('logs the decision, never the text', () => {
    expect(pasteBody).toContain('+ ", fgProgram=" + fgProgram');
  });
});
