jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: { scheduleAgent: jest.fn(), cancelAgent: jest.fn() },
}));

import * as fs from 'fs';
import * as path from 'path';

import { BOOT_AUTOSTART_ENABLED } from '@/lib/boot-autostart';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const withTerminalService = require('../../plugins/with-terminal-service.js');

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

  it('registers BootCompletedReceiver for BOOT_COMPLETED (exported, no receiver-level permission)', () => {
    expect(manifest).toContain('expo.modules.terminalemulator.BootCompletedReceiver');
    expect(manifest).toContain('android.intent.action.BOOT_COMPLETED');
    expect(manifest).toContain('android:exported="true"');
    // Device-verify (2026-07-04) found android:permission="..." on the <receiver>
    // element itself silently broke delivery: that attribute requires the SENDER
    // (system_server) to hold the named permission, which dumpsys activity
    // broadcasts history showed being denied for other apps' receivers using
    // this same mistaken pattern ("Permission Denial ... due to sender null
    // (uid 1000)"). The <uses-permission> at the manifest root (asserted above)
    // is what actually grants receiving rights; the receiver itself must NOT
    // additionally declare android:permission for BOOT_COMPLETED.
    const receiverBlock = manifest.slice(
      manifest.indexOf('<receiver android:name="expo.modules.terminalemulator.BootCompletedReceiver"'),
      manifest.indexOf('</receiver>', manifest.indexOf('BootCompletedReceiver')) + '</receiver>'.length,
    );
    expect(receiverBlock).not.toContain('android:permission');
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

  // REGRESSION (2026-07-04): a hand-edited-manifest-only BootCompletedReceiver
  // survived every string-matching assertion above (they read the checked-in
  // source file directly) yet was absent from every built APK across 4
  // on-device reboot cycles. Root cause: `expo prebuild` (run in CI without
  // --clean) reported the android project as malformed and wiped+regenerated
  // android/ from config plugins alone, discarding any manual XML edit with no
  // corresponding plugin. AgentAlarmReceiver survived because
  // with-terminal-service.js already registers it programmatically;
  // BootCompletedReceiver did not, because it was only ever added by hand.
  // This test exercises the REAL prebuild code path (the plugin's manifest
  // mod function, called the same way expo-cli calls it) instead of reading
  // the source file, so it would have caught the original bug.
  it('the with-terminal-service plugin programmatically registers BootCompletedReceiver (survives a prebuild wipe)', async () => {
    const baseManifest = {
      manifest: {
        application: [
          {
            receiver: [
              { $: { 'android:name': 'some.other.PreExistingReceiver' } },
            ],
          },
        ],
      },
    };
    const configWithPlugin = withTerminalService({});
    const result = await configWithPlugin.mods.android.manifest({
      modResults: baseManifest,
    });
    const application = result.modResults.manifest.application[0];
    const receiverNames = application.receiver.map(
      (r: { $: Record<string, string> }) => r.$['android:name'],
    );
    expect(receiverNames).toContain(
      'expo.modules.terminalemulator.AgentAlarmReceiver',
    );
    expect(receiverNames).toContain(
      'expo.modules.terminalemulator.BootCompletedReceiver',
    );
    // Pre-existing, unrelated receivers in the manifest are preserved, not replaced.
    expect(receiverNames).toContain('some.other.PreExistingReceiver');

    const bootReceiver = application.receiver.find(
      (r: { $: Record<string, string> }) =>
        r.$['android:name'] === 'expo.modules.terminalemulator.BootCompletedReceiver',
    );
    expect(bootReceiver.$['android:exported']).toBe('true');
    expect(bootReceiver.$['android:permission']).toBeUndefined();
    expect(bootReceiver['intent-filter'][0].action[0].$['android:name']).toBe(
      'android.intent.action.BOOT_COMPLETED',
    );

    // Idempotent: running the plugin twice must not duplicate the receiver
    // (expo prebuild can invoke mods more than once in some flows).
    const result2 = await configWithPlugin.mods.android.manifest({
      modResults: result.modResults,
    });
    const namesAfterSecondRun = result2.modResults.manifest.application[0].receiver.filter(
      (r: { $: Record<string, string> }) =>
        r.$['android:name'] === 'expo.modules.terminalemulator.BootCompletedReceiver',
    );
    expect(namesAfterSecondRun).toHaveLength(1);
  });
});
