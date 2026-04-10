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
  const done = await isSetupComplete();
  if (done) return;

  logInfo('FirstLaunchSetup', 'Showing MOTD on session ' + sessionId);

  // Wait for shell prompt to appear
  await sleep(1000);

  const welcome = t('motd.welcome');
  const preinstalled = t('motd.cli_preinstalled');
  const loginPrompt = t('motd.login_prompt');

  // Clear screen before MOTD
  await writeToTerminal(sessionId, 'clear');
  await sleep(300);

  // Write MOTD using builtin printf (coreutils printf breaks ANSI escapes)
  const L = (s: string) => writeToTerminal(sessionId, `builtin printf '%b\\n' '${s}'`);
  const B = '\\033[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\\033[0m';
  await L('');
  await L(B);
  await L(`\\033[1;32m  ${welcome}\\033[0m`);
  await L(B);
  await L('');
  await L(`  ${preinstalled}`);
  await L('');
  await L('    \\033[33mclaude\\033[0m    — Claude Code (Anthropic)');
  await L('    \\033[33mgemini\\033[0m    — Gemini CLI  (Google)');
  await L('    \\033[33mcodex\\033[0m     — Codex CLI   (OpenAI)');
  await L('');
  await L(`  ${loginPrompt}`);
  await L('');
  await L('    \\033[90m$\\033[0m claude auth login');
  await L('    \\033[90m$\\033[0m gemini auth login');
  await L('');
  await L(B);
  await L('');

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
