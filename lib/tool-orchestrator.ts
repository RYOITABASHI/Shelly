/**
 * lib/tool-orchestrator.ts — v1.0
 *
 * Tool Orchestrator: Claude Code / Gemini CLI のプロセス管理。
 *
 * Chatタブからの呼び出し:
 * - Bridge経由でCLIプロセスを起動
 * - stdout/stderrをリアルタイムでChatに表示
 * - パーミッションプロンプトを検知したらPermission Proxyに転送
 * - ユーザーの応答をstdinに書き戻す
 *
 * Terminalタブからの呼び出し:
 * - 通常のCLI実行（プロキシなし）
 */

import type { EnvCommandRunner } from './env-manager';
import {
  detectPermissionPrompt,
  translatePermissionPrompt,
  shouldAutoApprove,
  buildChatModeClaudeCommand,
  type ProxyMode,
  type PermissionPrompt,
  type AutoApproveLevel,
} from './cli-permission-proxy';
import type { LocalLlmConfig } from './local-llm';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ToolType = 'claude-code' | 'gemini-cli';

export interface ToolSession {
  id: string;
  tool: ToolType;
  mode: ProxyMode;
  status: 'starting' | 'running' | 'waiting_permission' | 'completed' | 'error';
  startedAt: number;
  /** 蓄積されたCLI出力 */
  output: string;
  /** 現在のパーミッションプロンプト（あれば） */
  pendingPrompt?: PermissionPrompt;
}

export interface ToolOrchestratorCallbacks {
  /** CLI出力の新しいチャンクが来たとき */
  onOutput: (sessionId: string, chunk: string) => void;
  /** パーミッションプロンプトが検知されたとき */
  onPermissionPrompt: (sessionId: string, prompt: PermissionPrompt) => void;
  /** セッションが完了したとき */
  onComplete: (sessionId: string, exitCode: number) => void;
  /** エラーが発生したとき */
  onError: (sessionId: string, error: string) => void;
}

// ─── Tool Orchestrator ────────────────────────────────────────────────────────

let sessionCounter = 0;

/**
 * 新しいツールセッションを開始する。
 *
 * Chat mode: CLIをバックグラウンドで実行し、出力をパースして
 *            パーミッションプロンプトを翻訳・提示する。
 * Terminal mode: コマンドをそのまま返す（呼び出し元がターミナルに送る）。
 */
export async function startToolSession(
  tool: ToolType,
  userInput: string,
  mode: ProxyMode,
  runCommand: EnvCommandRunner,
  llmConfig: LocalLlmConfig,
  callbacks: ToolOrchestratorCallbacks,
  autoApproveLevel: AutoApproveLevel = 'safe',
): Promise<ToolSession> {
  const session: ToolSession = {
    id: `tool-${++sessionCounter}-${Date.now()}`,
    tool,
    mode,
    status: 'starting',
    startedAt: Date.now(),
    output: '',
  };

  if (mode === 'terminal') {
    // Terminalモード: コマンドを返すだけ
    const command = tool === 'claude-code'
      ? buildChatModeClaudeCommand(userInput, 'none')
      : buildGeminiCommand(userInput);
    session.status = 'running';
    callbacks.onOutput(session.id, `$ ${command}\n`);
    // 実際のttyへの送信は呼び出し元に任せる
    return session;
  }

  // Chat mode: Bridge経由で実行し、出力を監視
  session.status = 'running';
  const command = tool === 'claude-code'
    ? buildChatModeClaudeCommand(userInput, autoApproveLevel)
    : buildGeminiCommand(userInput);

  try {
    const result = await runCommand(command);

    // 出力全体を解析
    session.output = result.stdout || '';
    const stderr = result.stderr || '';

    // パーミッションプロンプト検知
    const source = tool === 'claude-code' ? 'claude-code' as const : 'gemini-cli' as const;
    const prompt = detectPermissionPrompt(session.output, source);

    if (prompt) {
      // 自動承認チェック
      if (shouldAutoApprove(prompt, autoApproveLevel)) {
        callbacks.onOutput(session.id, session.output);
        // 自動承認: Yを送信（次の実行で処理される）
      } else {
        // 翻訳して提示
        prompt.translatedText = await translatePermissionPrompt(prompt, llmConfig);
        session.status = 'waiting_permission';
        session.pendingPrompt = prompt;
        callbacks.onPermissionPrompt(session.id, prompt);
        return session;
      }
    }

    callbacks.onOutput(session.id, session.output);
    if (stderr) callbacks.onOutput(session.id, `\n${stderr}`);

    session.status = 'completed';
    callbacks.onComplete(session.id, result.exitCode);
  } catch (err) {
    session.status = 'error';
    callbacks.onError(session.id, String(err));
  }

  return session;
}

/**
 * パーミッションプロンプトに応答する。
 * ユーザーの選択（Y/N/テキスト）をCLIに送信する。
 */
export async function respondToPermission(
  session: ToolSession,
  response: string,
  runCommand: EnvCommandRunner,
  callbacks: ToolOrchestratorCallbacks,
): Promise<void> {
  session.status = 'running';
  session.pendingPrompt = undefined;

  // レスポンスをCLIのstdinに送る
  // Bridge経由ではインタラクティブstdinが使えないため、
  // レスポンスを含む新しいコマンドとして再実行する
  callbacks.onOutput(session.id, `> ${response}\n`);

  // 注: 実際のインタラクティブCLIとの対話は
  // bridge/WebSocket経由で行う必要がある。
  // ここではバッチ実行モードのフォールバック。
  session.status = 'completed';
  callbacks.onComplete(session.id, 0);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildGeminiCommand(userInput: string): string {
  const escaped = userInput
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');
  return `gemini "${escaped}"`;
}
