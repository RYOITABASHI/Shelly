/**
 * lib/first-launch-setup.ts — First-launch MOTD via real PTY
 *
 * On first launch, displays a simple welcome message with info
 * about pre-installed CLI tools. No wizard, no install steps.
 * CLIs are bundled in the APK and ready to use immediately.
 *
 * Triggered once after the first PTY session becomes alive.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import * as Notifications from 'expo-notifications';
import { logInfo } from '@/lib/debug-logger';
import { t } from '@/lib/i18n';

const SETUP_KEY = '@shelly/setup_wizard_complete';

/**
 * Check if first-launch setup has been completed.
 */
export async function isSetupComplete(): Promise<boolean> {
  const val = await AsyncStorage.getItem(SETUP_KEY);
  return val === 'true';
}

/**
 * Mark first-launch setup as complete.
 */
export async function markSetupComplete(): Promise<void> {
  await AsyncStorage.setItem(SETUP_KEY, 'true');
}

/**
 * Reset setup flag (for re-running via `shelly setup`).
 */
export async function resetSetup(): Promise<void> {
  await AsyncStorage.removeItem(SETUP_KEY);
}

/**
 * Show a simple welcome MOTD on first launch.
 * CLIs are pre-installed — just tell the user they're ready.
 */
export async function runFirstLaunchSetup(sessionId: string): Promise<void> {
  const done = await isSetupComplete();
  if (done) {
    // Even if setup was already marked complete in a prior session, re-check
    // the all-files-access permission every launch. Users can revoke it from
    // system settings; we want to surface the request again so the shell
    // isn't silently locked out of /sdcard (bug #92).
    await ensureAllFilesAccess();
    await ensureNotificationPermission();
    return;
  }

  logInfo('FirstLaunchSetup', 'MOTD now handled by .bashrc — marking complete');

  // bug #92: first-launch is the natural moment to ask for MANAGE_EXTERNAL_STORAGE
  // so the "adb push a script, source it from the shell" workflow works. See
  // ensureAllFilesAccess below for the non-blocking approach used.
  await ensureAllFilesAccess();
  await ensureNotificationPermission();

  // MOTD is now displayed by .bashrc on first launch (checks ~/.shelly_motd_shown)
  // This function just marks the TS-side flag as complete
  await markSetupComplete();
  logInfo('FirstLaunchSetup', 'Setup flag saved');
}

/**
 * bug #92: Ensure the app holds MANAGE_EXTERNAL_STORAGE. Android 11+ gates
 * /sdcard direct access behind this special permission; without it any
 * `source /sdcard/Download/*.sh` fails with EACCES even with the legacy
 * READ/WRITE_EXTERNAL_STORAGE permissions declared in the manifest.
 *
 * Non-blocking: if the user doesn't already have the permission, we just
 * fire an Intent to the settings page and return. The call is idempotent
 * so we can safely call it on every launch; the native side short-circuits
 * when the permission is already granted.
 */
async function ensureAllFilesAccess(): Promise<void> {
  try {
    const has = await TerminalEmulator.hasAllFilesAccess();
    if (has) {
      logInfo('FirstLaunchSetup', 'MANAGE_EXTERNAL_STORAGE already granted');
      return;
    }
    logInfo('FirstLaunchSetup', 'requesting MANAGE_EXTERNAL_STORAGE');
    await TerminalEmulator.requestAllFilesAccess();
  } catch (e) {
    logInfo('FirstLaunchSetup', 'ensureAllFilesAccess failed: ' + e);
  }
}

/**
 * Request POST_NOTIFICATIONS (Android 13+) so the Scouter notifications can
 * actually appear — when the bound Codex needs approval / a choice, hits a
 * rate limit, or finishes a reply. Without it Android silently suppresses
 * them. Non-blocking and idempotent (expo-notifications no-ops once granted);
 * safe to call every launch since the user can revoke from system settings.
 */
async function ensureNotificationPermission(): Promise<void> {
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted || current.status === 'granted') {
      logInfo('FirstLaunchSetup', 'POST_NOTIFICATIONS already granted');
      return;
    }
    if (!current.canAskAgain) {
      logInfo('FirstLaunchSetup', 'POST_NOTIFICATIONS denied (cannot ask again)');
      return;
    }
    logInfo('FirstLaunchSetup', 'requesting POST_NOTIFICATIONS');
    await Notifications.requestPermissionsAsync();
  } catch (e) {
    logInfo('FirstLaunchSetup', 'ensureNotificationPermission failed: ' + e);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function writeToTerminal(sessionId: string, command: string): Promise<void> {
  try {
    await TerminalEmulator.writeToSession(sessionId, command + '\n');
  } catch (e) {
    logInfo('FirstLaunchSetup', 'writeToSession failed: ' + e);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
