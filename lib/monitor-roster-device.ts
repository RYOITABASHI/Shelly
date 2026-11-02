/**
 * lib/monitor-roster-device.ts — device wiring for the MONITOR staff roster
 * (lib/monitor-roster.ts): the shell that writes monitor-roster.json and the
 * native hook that refreshes the home-screen widget once when it changed.
 * Imported for its side effect by app/_layout.tsx, which also calls
 * startMonitorRoster() once after launch so the widget has the roster
 * without the user opening the chat first.
 */
import '@/lib/agent-role-device';
import { execCommand } from '@/hooks/use-native-exec';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { configureMonitorRosterPublisher, ensureMonitorRoster } from '@/lib/monitor-roster';

async function runShell(cmd: string): Promise<string> {
  const r = await execCommand(cmd, 30_000);
  if (r.exitCode !== 0) throw new Error(r.stderr || `exit ${r.exitCode}`);
  return r.stdout;
}

configureMonitorRosterPublisher({
  run: runShell,
  notify: () => {
    try {
      TerminalEmulator.notifyMonitorWidgetRoster?.()?.catch(() => {});
    } catch {
      // optional native method (absent on web / older builds)
    }
  },
});

/** Load the roles once so the roster is published (no-op when already loaded). */
export function startMonitorRoster(): Promise<void> {
  return ensureMonitorRoster(runShell);
}
