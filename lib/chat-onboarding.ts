/**
 * lib/chat-onboarding.ts — チャットベースのオンボーディング
 *
 * SetupWizard完了後、Chatタブで自動的に開始される。
 * ユーザーにチャットの使い方を体験させながら、
 * Cerebras/GroqのAPIキー設定を完了させる。
 *
 * ステップ:
 * 1. 歓迎メッセージ + 「ファイル一覧」を試すよう促す
 * 2. コマンド実行結果を見せた後、Cerebrasセットアップを促す
 * 3. Cerebras設定完了後、Groqセットアップを促す（任意）
 * 4. 完了メッセージ
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const ONBOARDING_KEY = '@shelly/chat_onboarding_step';
const ONBOARDING_DONE_KEY = '@shelly/chat_onboarding_done';

export type OnboardingStep =
  | 'welcome'             // 歓迎 + 「ファイル一覧」を試すよう促す
  | 'after_first_cmd'     // コマンド実行後 → Gemini CLIブリッジステップへ
  | 'gemini_cli_bridge'   // Gemini CLI案内 → Cerebrasセットアップへ
  | 'cerebras_setup'      // Cerebras APIキー入力待ち
  | 'cerebras_done'       // Cerebras設定完了 → Groq促す
  | 'groq_setup'          // Groq APIキー入力待ち
  | 'complete'            // 全完了
  | 'skipped';            // スキップ済み

/**
 * オンボーディングが完了済みかチェック
 */
export async function isOnboardingDone(): Promise<boolean> {
  const val = await AsyncStorage.getItem(ONBOARDING_DONE_KEY).catch(() => null);
  return val === 'true';
}

/**
 * 現在のオンボーディングステップを取得
 */
export async function getOnboardingStep(): Promise<OnboardingStep> {
  const done = await isOnboardingDone();
  if (done) return 'complete';
  const step = await AsyncStorage.getItem(ONBOARDING_KEY).catch(() => null);
  return (step as OnboardingStep) || 'welcome';
}

/**
 * オンボーディングステップを保存
 */
export async function setOnboardingStep(step: OnboardingStep): Promise<void> {
  if (step === 'complete' || step === 'skipped') {
    await AsyncStorage.setItem(ONBOARDING_DONE_KEY, 'true').catch(() => {});
  }
  await AsyncStorage.setItem(ONBOARDING_KEY, step).catch(() => {});
}

/**
 * オンボーディングをリセット（設定画面から）
 */
export async function resetOnboarding(): Promise<void> {
  await AsyncStorage.multiRemove([ONBOARDING_KEY, ONBOARDING_DONE_KEY]).catch(() => {});
}
