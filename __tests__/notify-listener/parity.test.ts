import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const withTerminalService = require('../../plugins/with-terminal-service.js');

// Offline gate for a native/Manifest change (mirrors boot-autostart/parity.test.ts):
// the jest layer can't run a NotificationListenerService, so this asserts the
// Manifest/plugin surface is declared and the listener ships dormant/plumbing-only.
// Real behavior (actual notification capture, Special Access grant flow) is
// device-verify-only — offline 緑 ≠ 実機緑. This is NOTIFY-001 Increment 0: no
// notification content reaches an agent yet, so there is no taint-tagging
// behavior to test here — that lands in Increment 1 alongside the first
// consumer of captured notification content (see CAP-001 / classifyEgress in
// lib/capability-envelope.ts for what "tainted" means once that day comes).
const root = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('NOTIFY-001 Increment 0 Manifest + native parity (dormant, flag-OFF)', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  const listener = read(
    'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/ShellyNotificationListener.kt',
  );
  const module = read(
    'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/TerminalEmulatorModule.kt',
  );

  it('declares the ShellyNotificationListener service in the checked-in AndroidManifest', () => {
    expect(manifest).toContain('expo.modules.terminalemulator.ShellyNotificationListener');
    expect(manifest).toContain('android.service.notification.NotificationListenerService');
    expect(manifest).toContain('android:permission="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE"');
  });

  it('the listener is flag-gated (no-op, no content read, when disabled)', () => {
    expect(listener).toContain('notificationListenerEnabled(context)');
    // dormant guard: logs and returns before reading any notification content
    expect(listener).toContain('listener disabled (dormant), nothing captured');
  });

  it('the listener flag defaults OFF', () => {
    expect(listener).toContain('getBoolean(ENABLED_KEY, false)');
  });

  it('only reads the four named extras fields, never the whole Bundle', () => {
    expect(listener).toContain('Notification.EXTRA_TITLE');
    expect(listener).toContain('Notification.EXTRA_TEXT');
    expect(listener).toContain('sbn.packageName');
    expect(listener).toContain('sbn.postTime');
  });

  it('reuses the existing permission-check/deep-link AsyncFunction pattern', () => {
    expect(module).toContain('hasNotificationListenerAccess');
    expect(module).toContain('requestNotificationListenerAccess');
    expect(module).toContain('ACTION_NOTIFICATION_LISTENER_SETTINGS');
  });

  // REGRESSION-STYLE (mirrors boot-autostart/parity.test.ts): a hand-edited-
  // manifest-only component can survive every string-matching assertion above
  // (they read the checked-in source file directly) yet still be absent from
  // every built APK, because `expo prebuild` (run in CI without --clean) can
  // report the android project as malformed and wipe+regenerate android/ from
  // config plugins alone, discarding any manual XML edit with no corresponding
  // plugin. This test exercises the REAL prebuild code path (the plugin's
  // manifest mod function, called the same way expo-cli calls it) instead of
  // reading the source file, so it would catch that class of bug for
  // ShellyNotificationListener too.
  it('the with-terminal-service plugin programmatically registers ShellyNotificationListener (survives a prebuild wipe)', async () => {
    const baseManifest = {
      manifest: {
        application: [
          {
            service: [
              { $: { 'android:name': 'some.other.PreExistingService' } },
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
    const serviceNames = application.service.map(
      (s: { $: Record<string, string> }) => s.$['android:name'],
    );
    expect(serviceNames).toContain(
      'expo.modules.terminalemulator.TerminalSessionService',
    );
    expect(serviceNames).toContain(
      'expo.modules.terminalemulator.ShellyNotificationListener',
    );
    // Pre-existing, unrelated services in the manifest are preserved, not replaced.
    expect(serviceNames).toContain('some.other.PreExistingService');

    const notificationListener = application.service.find(
      (s: { $: Record<string, string> }) =>
        s.$['android:name'] === 'expo.modules.terminalemulator.ShellyNotificationListener',
    );
    expect(notificationListener.$['android:exported']).toBe('true');
    expect(notificationListener.$['android:permission']).toBe(
      'android.permission.BIND_NOTIFICATION_LISTENER_SERVICE',
    );
    expect(notificationListener['intent-filter'][0].action[0].$['android:name']).toBe(
      'android.service.notification.NotificationListenerService',
    );

    // Idempotent: running the plugin twice must not duplicate the service
    // (expo prebuild can invoke mods more than once in some flows).
    const result2 = await configWithPlugin.mods.android.manifest({
      modResults: result.modResults,
    });
    const namesAfterSecondRun = result2.modResults.manifest.application[0].service.filter(
      (s: { $: Record<string, string> }) =>
        s.$['android:name'] === 'expo.modules.terminalemulator.ShellyNotificationListener',
    );
    expect(namesAfterSecondRun).toHaveLength(1);
  });
});
