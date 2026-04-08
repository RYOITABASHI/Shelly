/**
 * lib/first-launch-setup.ts — First-launch CLI setup via real PTY
 *
 * On first launch, writes commands directly to the terminal PTY
 * to install and authenticate CLI tools. No fake overlay, no
 * pseudo-shell — just real terminal commands the user can see.
 *
 * Triggered once after the first PTY session becomes alive.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { logInfo } from '@/lib/debug-logger';

const SETUP_KEY = '@shelly/setup_wizard_complete';

const WELCOME = `
\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m
\x1b[1;32m  Welcome to Shelly\x1b[0m
\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m

  Your terminal is ready. Let's install AI coding tools.
  Each step is optional — press \x1b[33mCtrl+C\x1b[0m to skip any install.

\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m
`;

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
 * Reset setup flag (for re-running from ConfigTUI).
 */
export async function resetSetup(): Promise<void> {
  await AsyncStorage.removeItem(SETUP_KEY);
}

/**
 * Run the first-launch setup sequence on the real PTY terminal.
 * Sends commands directly via writeToSession — user sees everything
 * in the actual terminal with real output.
 */
export async function runFirstLaunchSetup(sessionId: string): Promise<void> {
  const done = await isSetupComplete();
  if (done) return;

  logInfo('FirstLaunchSetup', 'Starting first-launch setup on session ' + sessionId);

  // Small delay to let the shell prompt appear
  await sleep(800);

  // Write welcome message
  await writeToTerminal(sessionId, `echo "${escapeForEcho(WELCOME)}"`);
  await sleep(500);

  // Step 1: Check what's already installed
  await writeToTerminal(sessionId, 'echo "\\x1b[1;33m[1/3]\\x1b[0m Checking installed tools..."');
  await sleep(300);
  await writeToTerminal(sessionId, 'which claude 2>/dev/null && echo "  ✓ Claude Code already installed" || echo "  ✗ Claude Code not found"');
  await sleep(300);
  await writeToTerminal(sessionId, 'which gemini 2>/dev/null && echo "  ✓ Gemini CLI already installed" || echo "  ✗ Gemini CLI not found"');
  await sleep(300);
  await writeToTerminal(sessionId, 'which codex 2>/dev/null && echo "  ✓ Codex CLI already installed" || echo "  ✗ Codex CLI not found"');
  await sleep(500);

  // Step 2: Install Gemini CLI (free, recommended)
  await writeToTerminal(sessionId, 'echo ""');
  await writeToTerminal(sessionId, 'echo "\\x1b[1;33m[2/3]\\x1b[0m Installing Gemini CLI (free)..."');
  await writeToTerminal(sessionId, 'echo "  Press Ctrl+C to skip"');
  await sleep(300);
  await writeToTerminal(sessionId, 'which gemini >/dev/null 2>&1 || npm install -g @google/gemini-cli');
  await sleep(500);

  // Step 3: Install Claude Code
  await writeToTerminal(sessionId, 'echo ""');
  await writeToTerminal(sessionId, 'echo "\\x1b[1;33m[3/3]\\x1b[0m Installing Claude Code..."');
  await writeToTerminal(sessionId, 'echo "  Press Ctrl+C to skip"');
  await sleep(300);
  await writeToTerminal(sessionId, 'which claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code');
  await sleep(500);

  // Done
  await writeToTerminal(sessionId, 'echo ""');
  await writeToTerminal(sessionId, `echo "${escapeForEcho(`
\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m
\x1b[1;32m  Setup complete!\x1b[0m

  To authenticate:
    \x1b[33mclaude auth login\x1b[0m
    \x1b[33mgemini auth login\x1b[0m

  To start coding:
    \x1b[33mclaude\x1b[0m  or  \x1b[33mgemini\x1b[0m

  Run \x1b[33mshelly setup\x1b[0m anytime to re-run this setup.
\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m
`)}"`);

  // Mark complete
  await markSetupComplete();
  logInfo('FirstLaunchSetup', 'Setup complete, flag saved');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function writeToTerminal(sessionId: string, command: string): Promise<void> {
  try {
    await TerminalEmulator.writeToSession(sessionId, command + '\n');
  } catch (e) {
    logInfo('FirstLaunchSetup', 'writeToSession failed: ' + e);
  }
}

function escapeForEcho(text: string): string {
  // Escape double quotes and backslashes for bash echo
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
