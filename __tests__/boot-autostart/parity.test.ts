jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: { scheduleAgent: jest.fn(), cancelAgent: jest.fn() },
}));

import * as fs from 'fs';
import * as path from 'path';

import { BOOT_AUTOSTART_ENABLED } from '@/lib/boot-autostart';

// Offline gate for a native/Manifest change (mirrors plan-executor-parity): the
// jest layer can't run the receiver, so it asserts the L1 permission surface is
// declared and the boot path ships dormant. Real behavior (agent fires after a
// reboot / survives Doze) is device-verify-only — offline 緑 ≠ 実機緑.
const root = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('BOOT-AUTOSTART Manifest + native parity (dormant, flag-OFF)', () => {
  const appConfig = read('app.config.ts');
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  const receiver = read(
    'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/BootCompletedReceiver.kt',
  );
  const scheduler = read(
    'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/AgentAlarmScheduler.kt',
  );
  const module = read(
    'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/TerminalEmulatorModule.kt',
  );

  it('ships dormant on the TS side', () => {
    expect(BOOT_AUTOSTART_ENABLED).toBe(false);
  });

  it('declares the two L1 permissions in app.config.ts', () => {
    expect(appConfig).toContain('RECEIVE_BOOT_COMPLETED');
    expect(appConfig).toContain('REQUEST_IGNORE_BATTERY_OPTIMIZATIONS');
  });

  it('declares the two L1 permissions in the checked-in AndroidManifest', () => {
    expect(manifest).toContain('android.permission.RECEIVE_BOOT_COMPLETED');
    expect(manifest).toContain('android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS');
  });

  it('registers BootCompletedReceiver for BOOT_COMPLETED (exported, permission-guarded)', () => {
    expect(manifest).toContain('expo.modules.terminalemulator.BootCompletedReceiver');
    expect(manifest).toContain('android.intent.action.BOOT_COMPLETED');
    expect(manifest).toContain('android:exported="true"');
    expect(manifest).toContain('android:permission="android.permission.RECEIVE_BOOT_COMPLETED"');
  });

  it('the boot receiver is flag-gated (no-op when autostart is disabled)', () => {
    expect(receiver).toContain('AgentAlarmScheduler.bootAutostartEnabled(app)');
    expect(receiver).toContain('rearmAllFromPersistedSchedules');
    // dormant guard: returns before re-arming when disabled
    expect(receiver).toContain('nothing to re-arm');
  });

  it('the scheduler defaults boot autostart OFF and only persists when enabled (byte-preserve)', () => {
    expect(scheduler).toContain('getBoolean(BOOT_ENABLED_KEY, false)');
    expect(scheduler).toContain('if (bootAutostartEnabled(context)) persistScheduleForBoot');
    expect(scheduler).toContain('if (!bootAutostartEnabled(context)) return 0');
  });

  it('reuses the existing battery-optimization request path (unblocked by the new permission)', () => {
    expect(module).toContain('isIgnoringBatteryOptimizations');
    expect(module).toContain('ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS');
  });
});
