/**
 * lib/mcp-skip-approval.ts — RN side of "MCP: Run without approval".
 *
 * The switch that matters is native (McpSkipApprovalStore.kt: SharedPreferences
 * + Android Keystore HMAC, fail closed to OFF). While it is on, the native
 * McpRawToolConsumer runs MCP run_command / write_file itself — after the same
 * gate RN uses, but without the approval tap and without RN, so it works while
 * Shelly is in the background or the screen is locked. settings.mcpSkipApproval
 * only mirrors it for the Settings row; the native value wins.
 *
 * Rules:
 *  - ON: only [setMcpSkipApprovalFromToggle] with `true`, and only the Settings
 *    toggle (components/config/ConfigTUI.tsx) calls it. Nothing else here can
 *    pass `true` to the native call (a test scans the sources).
 *  - Load / sync ([syncMcpSkipApprovalFromNative]): reads native and copies it
 *    into the setting; it never turns native ON. A setting that says ON while
 *    native says OFF is corrected to OFF.
 *  - OFF from anywhere: the toggle, MCP token regeneration
 *    ([turnOffMcpSkipApproval], lib/mcp-server-bridge.ts revokePendingMCPRequests),
 *    and STOP-ALL (native turns it off when it sees the `.halted` sentinel).
 */
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { useSettingsStore } from '@/store/settings-store';
import { logError, logInfo } from '@/lib/debug-logger';

async function readNative(): Promise<boolean> {
  try {
    return (await TerminalEmulator.getMcpSkipApproval?.()) === true;
  } catch {
    return false;
  }
}

function mirror(value: boolean): void {
  const store = useSettingsStore.getState();
  if ((store.settings.mcpSkipApproval === true) !== value) store.updateSettings({ mcpSkipApproval: value });
}

/**
 * The Settings toggle. The only caller allowed to turn the native switch on.
 * Resolves the verified native state, which is also written to the setting.
 */
export async function setMcpSkipApprovalFromToggle(enabled: boolean): Promise<boolean> {
  let state = false;
  try {
    if (typeof TerminalEmulator.setMcpSkipApproval !== 'function') {
      state = false;
    } else if (enabled) {
      state = (await TerminalEmulator.setMcpSkipApproval(true, 'settings toggle')) === true;
    } else {
      await TerminalEmulator.setMcpSkipApproval(false, 'settings toggle');
      state = await readNative();
    }
  } catch (e) {
    logError('MCPSkipApproval', 'could not change the native switch', e);
    state = await readNative();
  }
  mirror(state);
  logInfo('MCPSkipApproval', `settings toggle → ${state ? 'on' : 'off'}`);
  return state;
}

/** Turns the native switch OFF (token regeneration, …). Throws when it could not be confirmed off. */
export async function turnOffMcpSkipApproval(reason: string): Promise<void> {
  if (typeof TerminalEmulator.setMcpSkipApproval === 'function') {
    const still = await TerminalEmulator.setMcpSkipApproval(false, reason);
    if (still === true) throw new Error('could not turn off MCP: Run without approval');
  }
  mirror(false);
}

/** Load / foreground: copy the native state into the setting (never turns native on). */
export async function syncMcpSkipApprovalFromNative(): Promise<boolean> {
  const state = await readNative();
  mirror(state);
  return state;
}
