/**
 * lib/termux-intent.ts — Termux command execution via native module
 *
 * Uses the TermuxBridge native module to invoke Termux's RunCommandService
 * directly via Android Intent (startService), bypassing the Activity limitation
 * of expo-intent-launcher.
 *
 * No user interaction needed — commands run in Termux background.
 */

import { Platform, Linking } from 'react-native';
import TermuxBridgeModule from '../modules/termux-bridge';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface RunCommandOptions {
  /** 実行するコマンド文字列 */
  command: string;
  /** バックグラウンド実行 (デフォルト: true) */
  background?: boolean;
}

// ── Package check ──────────────────────────────────────────────────────────────

export async function checkTermuxPackages(): Promise<{
  termuxInstalled: boolean;
  taskerInstalled: boolean;
  bootInstalled: boolean;
}> {
  if (Platform.OS !== 'android') {
    return { termuxInstalled: false, taskerInstalled: false, bootInstalled: false };
  }

  const [termuxInstalled, taskerInstalled, bootInstalled] = await Promise.all([
    TermuxBridgeModule.isPackageInstalled('com.termux'),
    TermuxBridgeModule.isPackageInstalled('com.termux.tasker'),
    TermuxBridgeModule.isPackageInstalled('com.termux.boot'),
  ]);

  return { termuxInstalled, taskerInstalled, bootInstalled };
}

// ── RUN_COMMAND ────────────────────────────────────────────────────────────────

/**
 * Termux RunCommandService経由でコマンドをバックグラウンド実行する。
 * ユーザーにTermuxを見せずにコマンドを実行できる。
 */
export async function runTermuxCommand(
  options: RunCommandOptions,
): Promise<{ success: boolean; error?: string }> {
  if (Platform.OS !== 'android') {
    return { success: false, error: 'Android only' };
  }

  const { command, background = true } = options;

  try {
    const result = await TermuxBridgeModule.runCommand(command, background);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

// ── Fallback: Open Termux ────────────────────────────────────────────────────

export async function openTermux(): Promise<void> {
  try {
    await Linking.openURL('com.termux://');
  } catch {
    await Linking.openURL('https://f-droid.org/packages/com.termux/').catch(() => {});
  }
}

// ── Store URLs ──────────────────────────────────────────────────────────────────

export function getStoreUrl(pkg: 'termux' | 'tasker' | 'boot'): { fdroid: string; playStore: string | null } {
  const map: Record<string, { fdroid: string; playStore: string | null }> = {
    termux: {
      fdroid: 'https://f-droid.org/packages/com.termux/',
      playStore: 'https://play.google.com/store/apps/details?id=com.termux',
    },
    tasker: {
      fdroid: 'https://f-droid.org/packages/com.termux.tasker/',
      playStore: null,
    },
    boot: {
      fdroid: 'https://f-droid.org/packages/com.termux.boot/',
      playStore: null,
    },
  };
  return map[pkg];
}
