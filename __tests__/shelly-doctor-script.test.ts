/**
 * Regression test for a real on-device crash found 2026-07-27: running the
 * bare `shelly-doctor` terminal command (human-readable mode, no `--json`)
 * threw `TypeError: Cannot read properties of undefined (reading 'version')`
 * at printHuman()'s "codex exec" line. codexReport() had been refactored to
 * fold the "codex exec --help" check into `tui.execHelp` (codex_tui handles
 * both the TUI and `exec` subcommand from one binary), but printHuman() was
 * never updated and kept reading the old `data.codex.exec.version` shape,
 * which no longer exists. The `--json` path (used by the Settings > Doctor
 * UI button) was unaffected — it just JSON.stringifies the data object
 * directly, never touching printHuman() — so this crash was reachable only
 * from the bare terminal command referenced in the codex-login confirm hint
 * ("Run `shelly doctor` afterwards to confirm").
 *
 * This is a plain standalone Node script (not a TS template-literal
 * generator like lib/agent-executor.ts), so the most direct regression
 * coverage is running the REAL file with a real node child process — the
 * same "don't hand-copy, execute the actual artifact" principle used
 * throughout this test suite (see agent-quality-gate-shell-emit.test.ts).
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPT_PATH = path.join(__dirname, '..', 'modules', 'terminal-emulator', 'android', 'src', 'main', 'assets', 'shelly-doctor.js');

describe('shelly-doctor.js — real script execution (2026-07-27 crash regression)', () => {
  it('human-readable mode (bare `shelly-doctor`, no --json) runs to completion without throwing', () => {
    const output = execFileSync(process.execPath, [SCRIPT_PATH], { encoding: 'utf8' });
    expect(output).toContain('Shelly doctor');
    expect(output).toContain('codex exec:');
    expect(output).not.toContain('TypeError');
    expect(output).not.toContain('at printHuman');
  });

  it('--json mode runs to completion and produces parseable JSON with a codex.tui.execHelp field', () => {
    const output = execFileSync(process.execPath, [SCRIPT_PATH, '--json'], { encoding: 'utf8' });
    const data = JSON.parse(output);
    expect(data.codex).toBeDefined();
    expect(data.codex.tui).toBeDefined();
    expect(data.codex.tui.execHelp).toBeDefined();
    expect(typeof data.codex.tui.execHelp.ok).toBe('boolean');
    // The stale field this bug referenced must not silently reappear.
    expect(data.codex.exec).toBeUndefined();
  });

  it('--report prints a Markdown device report with the issue-template hint and no home path', () => {
    const output = execFileSync(process.execPath, [SCRIPT_PATH, '--report'], { encoding: 'utf8' });
    expect(output).toContain('### Shelly device report');
    expect(output).toContain('- All-files access:');
    expect(output).toContain('- Codex signed in:');
    expect(output).toContain('issues/new?template=device-report.yml');
    expect(output).not.toContain(process.env.HOME || process.env.USERPROFILE || 'NO_HOME_SET_SENTINEL');
  });
  it('--report takes version, notifications and battery state from the app-info snapshot', () => {
    // An app uid cannot run dumpsys, so on the phone these come from
    // $HOME/.shelly/app-info.json written by AppInfoSnapshot.kt.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-home-'));
    try {
      fs.mkdirSync(path.join(home, '.shelly'));
      fs.writeFileSync(
        path.join(home, '.shelly', 'app-info.json'),
        JSON.stringify({ versionName: '8.1.1', versionCode: 2650, notificationsEnabled: true, ignoringBatteryOptimizations: false }),
      );
      const output = execFileSync(process.execPath, [SCRIPT_PATH, '--report'], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home },
      });
      expect(output).toContain('- Shelly: 8.1.1 (versionCode 2650)');
      expect(output).toContain('- Notification permission: granted');
      expect(output).toContain('- Battery optimization: NOT exempt');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
