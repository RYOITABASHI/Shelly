/**
 * lib/termux-intent.ts — Termux RUN_COMMAND Intent wrapper
 *
 * Termux:Taskerプラグイン経由でTermux上のコマンドをバックグラウンド実行する。
 * ユーザーがTermuxを手動で開く必要がなくなる。
 *
 * 必要: com.termux.tasker (Termux:Tasker) がインストール済みであること。
 * 権限: com.termux.permission.RUN_COMMAND
 */

import { Platform, Linking } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface RunCommandOptions {
  /** 実行するコマンド文字列 */
  command: string;
  /** 作業ディレクトリ (デフォルト: $HOME) */
  workdir?: string;
  /** バックグラウンド実行 (デフォルト: true) */
  background?: boolean;
}

export interface TermuxCheckResult {
  termuxInstalled: boolean;
  taskerInstalled: boolean;
  bootInstalled: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const TERMUX_PACKAGE = 'com.termux';
const TASKER_PACKAGE = 'com.termux.tasker';
const BOOT_PACKAGE = 'com.termux.boot';

const RUN_COMMAND_SERVICE = 'com.termux.app.RunCommandService';
const RUN_COMMAND_ACTION = 'com.termux.RUN_COMMAND';

// ── Package check ──────────────────────────────────────────────────────────────

/**
 * Termux関連パッケージのインストール状態をチェック
 */
export async function checkTermuxPackages(): Promise<TermuxCheckResult> {
  if (Platform.OS !== 'android') {
    return { termuxInstalled: false, taskerInstalled: false, bootInstalled: false };
  }

  const check = async (pkg: string): Promise<boolean> => {
    try {
      // Intent起動でパッケージの存在確認
      const url = `package:${pkg}`;
      return await Linking.canOpenURL(url).catch(() => false);
    } catch {
      return false;
    }
  };

  // Android: IntentLauncherでパッケージ確認
  const [termuxInstalled, taskerInstalled, bootInstalled] = await Promise.all([
    check(TERMUX_PACKAGE),
    check(TASKER_PACKAGE),
    check(BOOT_PACKAGE),
  ]);

  return { termuxInstalled, taskerInstalled, bootInstalled };
}

// ── RUN_COMMAND ────────────────────────────────────────────────────────────────

/**
 * Termux:Tasker RUN_COMMANDでコマンドをバックグラウンド実行する。
 *
 * 内部的には com.termux.RUN_COMMAND Intentを送信。
 * Termux:Taskerがインストールされ、権限が許可されている必要がある。
 */
export async function runTermuxCommand(options: RunCommandOptions): Promise<{ success: boolean; error?: string }> {
  if (Platform.OS !== 'android') {
    return { success: false, error: 'Android only' };
  }

  const { command, workdir, background = true } = options;

  try {
    // Termux RUN_COMMAND Intent
    // bin/sh -c を使って複合コマンドを実行
    await IntentLauncher.startActivityAsync(RUN_COMMAND_ACTION, {
      packageName: TERMUX_PACKAGE,
      className: RUN_COMMAND_SERVICE,
      extra: {
        'com.termux.RUN_COMMAND_PATH': '/data/data/com.termux/files/usr/bin/sh',
        'com.termux.RUN_COMMAND_ARGUMENTS': ['-c', command],
        'com.termux.RUN_COMMAND_WORKDIR': workdir ?? '/data/data/com.termux/files/home',
        'com.termux.RUN_COMMAND_BACKGROUND': background,
      },
    });

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // よくあるエラーを親切なメッセージに変換
    if (message.includes('permission') || message.includes('Permission')) {
      return {
        success: false,
        error: 'PERMISSION_DENIED',
      };
    }
    if (message.includes('not found') || message.includes('resolve')) {
      return {
        success: false,
        error: 'TASKER_NOT_INSTALLED',
      };
    }

    return { success: false, error: message };
  }
}

// ── Fallback: Linking ──────────────────────────────────────────────────────────

/**
 * Termux:Taskerが使えない場合のフォールバック。
 * Termuxアプリを直接開く（ユーザーが手動操作する必要がある）。
 */
export async function openTermux(): Promise<void> {
  try {
    await Linking.openURL('com.termux://');
  } catch {
    try {
      await Linking.openURL('market://details?id=com.termux');
    } catch {
      await Linking.openURL('https://f-droid.org/packages/com.termux/').catch(() => {});
    }
  }
}

/**
 * ストアへのリンク
 */
export function getStoreUrl(pkg: 'termux' | 'tasker' | 'boot'): { fdroid: string; playStore: string } {
  const map = {
    termux: {
      fdroid: 'https://f-droid.org/packages/com.termux/',
      playStore: 'https://play.google.com/store/apps/details?id=com.termux',
    },
    tasker: {
      fdroid: 'https://f-droid.org/packages/com.termux.tasker/',
      playStore: 'https://play.google.com/store/apps/details?id=com.termux.tasker',
    },
    boot: {
      fdroid: 'https://f-droid.org/packages/com.termux.boot/',
      playStore: 'https://play.google.com/store/apps/details?id=com.termux.boot',
    },
  };
  return map[pkg];
}
