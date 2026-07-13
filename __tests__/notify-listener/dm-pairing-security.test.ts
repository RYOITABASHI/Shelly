import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '..', '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('DM pairing native safety parity', () => {
  const listener = read('modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/ShellyNotificationListener.kt');
  const module = read('modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/TerminalEmulatorModule.kt');
  const store = read('store/dm-pairing-store.ts');
  const plugin = read('plugins/with-terminal-service.js');
  const manifest = read('android/app/src/main/AndroidManifest.xml');

  it('keeps independent read and reply flags default-off', () => {
    expect(listener).toContain('getBoolean(ENABLED_KEY, false)');
    expect(listener).toContain('getBoolean(REPLY_ENABLED_KEY, false)');
    expect(listener).toContain('REPLY_ENABLED_KEY = "reply_enabled"');
  });

  it('checks both flags natively at the actual paired send', () => {
    const body = listener.slice(listener.indexOf('fun sendPairedDmReply'), listener.indexOf('\n    }', listener.indexOf('fun sendPairedDmReply')));
    expect(body).toContain('notificationListenerEnabled(context)');
    expect(body).toContain('notificationReplyEnabled(context)');
    expect(module).toContain('ShellyNotificationListener.sendPairedDmReply(context, dmPairingId, replyText)');
  });

  it('re-reads disk without caching and exact-matches a live replyable fingerprint', () => {
    expect(listener).toContain('JSONArray(file.readText())');
    expect(listener).toContain('sbn.notification?.shortcutId == record.shortcutId');
    expect(listener).toContain('sbn.id == record.notificationId && sbn.tag == record.notificationTag');
    expect(listener).toContain('findReplyAction(sbn) == null');
    expect(listener).not.toContain('cachedPairing');
  });

  it('uses a separate 10s send debounce from the 60s trigger debounce', () => {
    expect(listener).toContain('REPLY_DEBOUNCE_MS = 10_000L');
    expect(listener).toContain('TRIGGER_DEBOUNCE_MS = 60_000L');
    expect(listener).toContain('lastReplyAtMs');
    expect(listener).toContain('triggerDebouncer');
  });

  it('never interpolates raw reply text into logs', () => {
    expect(listener).not.toMatch(/\$replyText(?!\.length)/);
    expect(listener).not.toContain('Log.i(TAG, replyText');
    expect(listener).not.toContain('"readDmPairingRecord: malformed or unavailable pairing mirror", error');
  });

  it('flushes before and after atomic mirror publication', () => {
    expect(store).toContain('sensitive payload intentionally begins after native log preview boundary');
    expect(store).toContain('dm-pairings.json.tmp && sync');
    expect(store).toContain('dm-pairings.json && sync');
  });

  it('scans expanded notification text fields without persisting notification content', () => {
    expect(listener).toContain('Notification.EXTRA_BIG_TEXT');
    expect(listener).toContain('Notification.EXTRA_SUB_TEXT');
    expect(listener).toContain('Notification.EXTRA_SUMMARY_TEXT');
    expect(listener).toContain('Notification.EXTRA_TEXT_LINES');
  });

  it('registers the self-test receiver as non-exported in both manifest sources', () => {
    expect(plugin).toContain('expo.modules.terminalemulator.DmReplyTestReceiver');
    expect(plugin).toContain('"android:exported": "false"');
    expect(manifest).toContain('DmReplyTestReceiver" android:exported="false"');
  });
});
