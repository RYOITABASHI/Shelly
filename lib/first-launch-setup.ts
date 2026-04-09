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
  // TODO: remove debug bypass after CLI launch is confirmed working
  const done = await isSetupComplete();
  // Temporarily always show for debugging
  // if (done) return;

  logInfo('FirstLaunchSetup', 'Showing MOTD on session ' + sessionId);

  // Wait for shell prompt to appear
  await sleep(1000);

  const welcome = t('motd.welcome');
  const preinstalled = t('motd.cli_preinstalled');
  const loginPrompt = t('motd.login_prompt');

  // Debug: show PATH and check launchers
  await writeToTerminal(sessionId, 'echo "DEBUG PATH=$PATH"');
  await sleep(200);
  await writeToTerminal(sessionId, 'ls -la $(echo $PATH | tr ":" "\\n" | head -1)/claude 2>&1');
  await sleep(200);
  await writeToTerminal(sessionId, 'type claude 2>&1');
  await sleep(200);
  await writeToTerminal(sessionId, 'cat $(echo $PATH | tr ":" "\\n" | head -1)/claude 2>&1');
  await sleep(300);

  // Build MOTD with ANSI colors via printf
  const motd = [
    '',
    '\\033[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\\033[0m',
    `\\033[1;32m  ${welcome}\\033[0m`,
    '\\033[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\\033[0m',
    '',
    `  ${preinstalled}`,
    '',
    '    \\033[33mclaude\\033[0m    — Claude Code (Anthropic)',
    '    \\033[33mgemini\\033[0m    — Gemini CLI  (Google)',
    '    \\033[33mcodex\\033[0m     — Codex CLI   (OpenAI)',
    '',
    `  ${loginPrompt}`,
    '',
    '    \\033[90m$\\033[0m claude auth login',
    '    \\033[90m$\\033[0m gemini auth login',
    '',
    '\\033[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\\033[0m',
    '',
  ].join('\\n');

  await writeToTerminal(sessionId, `printf '${motd}'`);

  // Mark complete
  await markSetupComplete();
  logInfo('FirstLaunchSetup', 'MOTD shown, flag saved');
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
