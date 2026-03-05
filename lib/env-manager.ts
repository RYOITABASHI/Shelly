/**
 * lib/env-manager.ts — v1.0
 *
 * Environment Manager: Termux環境の自動構築・ツール管理。
 *
 * ユーザーはTermuxを一度も開かずに、Shellyの中だけで:
 * - 基盤パッケージの自動インストール
 * - AIツールの自動セットアップ（Claude Code, Gemini CLI, llama-server）
 * - 認証フローの誘導（Shellyの内蔵ブラウザへ）
 * - ツールの起動・停止・状態管理
 *
 * Bridge経由で全てのTermuxコマンドを実行する。
 */

import type { ToolStatus } from './shelly-system-prompt';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ToolId =
  | 'node'
  | 'python'
  | 'git'
  | 'claude-code'
  | 'gemini-cli'
  | 'llama-server';

export type SetupPhase =
  | 'idle'
  | 'checking'
  | 'installing'
  | 'configuring'
  | 'authenticating'
  | 'done'
  | 'error';

export interface ToolDefinition {
  id: ToolId;
  name: string;
  description: string;
  category: 'base' | 'ai';
  /** インストール確認コマンド */
  checkCommand: string;
  /** バージョン取得コマンド */
  versionCommand: string;
  /** インストールコマンド（順序付き） */
  installCommands: string[];
  /** インストール推定時間（秒） */
  estimatedInstallSeconds: number;
  /** 依存ツール */
  dependencies: ToolId[];
  /** 認証が必要か */
  requiresAuth: boolean;
  /** 認証URL（Shellyの内蔵ブラウザで開く） */
  authUrl?: string;
  /** 認証確認コマンド */
  authCheckCommand?: string;
  /** 起動コマンド（サービス型のみ） */
  startCommand?: string;
  /** 停止コマンド */
  stopCommand?: string;
  /** 稼働確認コマンド */
  statusCommand?: string;
  /** Shellyでの説明（初心者向け） */
  userFriendlyDescription: string;
  /** 選択可能（ユーザーが選ぶもの） */
  selectable: boolean;
}

// ─── Tool Catalog ─────────────────────────────────────────────────────────────

export const TOOL_CATALOG: ToolDefinition[] = [
  // ── 基盤ツール（自動インストール） ──────────────────────────────────────
  {
    id: 'node',
    name: 'Node.js',
    description: 'JavaScript/TypeScript実行環境',
    category: 'base',
    checkCommand: 'which node',
    versionCommand: 'node --version',
    installCommands: ['pkg install -y nodejs-lts'],
    estimatedInstallSeconds: 30,
    dependencies: [],
    requiresAuth: false,
    userFriendlyDescription: 'アプリやウェブサイトを作るための基盤ツール',
    selectable: false,
  },
  {
    id: 'python',
    name: 'Python',
    description: 'スクリプト・AI開発用言語',
    category: 'base',
    checkCommand: 'which python3',
    versionCommand: 'python3 --version',
    installCommands: ['pkg install -y python'],
    estimatedInstallSeconds: 20,
    dependencies: [],
    requiresAuth: false,
    userFriendlyDescription: 'データ分析やAI開発のための言語',
    selectable: false,
  },
  {
    id: 'git',
    name: 'Git',
    description: 'バージョン管理システム',
    category: 'base',
    checkCommand: 'which git',
    versionCommand: 'git --version',
    installCommands: ['pkg install -y git'],
    estimatedInstallSeconds: 15,
    dependencies: [],
    requiresAuth: false,
    userFriendlyDescription: 'コードの変更履歴を管理するツール',
    selectable: false,
  },

  // ── AIツール（ユーザー選択） ────────────────────────────────────────────
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Anthropic製AIコーディングエージェント',
    category: 'ai',
    checkCommand: 'which claude',
    versionCommand: 'claude --version 2>/dev/null | head -1',
    installCommands: [
      'npm install -g @anthropic-ai/claude-code',
    ],
    estimatedInstallSeconds: 60,
    dependencies: ['node'],
    requiresAuth: true,
    authUrl: 'https://console.anthropic.com/',
    authCheckCommand: 'claude --version 2>/dev/null && echo "ok"',
    userFriendlyDescription: 'コード生成・ファイル編集・プロジェクト作成を自動で行うAI。一番賢い。',
    selectable: true,
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    description: 'Google製AIエージェント',
    category: 'ai',
    checkCommand: 'which gemini',
    versionCommand: 'gemini --version 2>/dev/null | head -1',
    installCommands: [
      'npm install -g @anthropic-ai/claude-code',  // placeholder — Gemini CLIの正式パッケージ名が必要
    ],
    estimatedInstallSeconds: 60,
    dependencies: ['node'],
    requiresAuth: true,
    authUrl: 'https://aistudio.google.com/apikey',
    authCheckCommand: 'gemini --version 2>/dev/null && echo "ok"',
    userFriendlyDescription: 'Google製のAIアシスタント。無料枠あり。',
    selectable: true,
  },
  {
    id: 'llama-server',
    name: 'ローカルLLM',
    description: 'オフラインで動くAI（llama.cpp）',
    category: 'ai',
    checkCommand: 'which llama-server',
    versionCommand: 'llama-server --version 2>/dev/null | head -1 || echo "installed"',
    installCommands: [
      'pkg install -y llama-cpp',
    ],
    estimatedInstallSeconds: 15,
    dependencies: [],
    requiresAuth: false,
    startCommand: 'llama-server --model ~/models/*.gguf --port 8080 --host 127.0.0.1 --ctx-size 2048 --threads 6',
    stopCommand: 'pkill -f llama-server',
    statusCommand: 'pgrep -f llama-server > /dev/null && echo "running" || echo "stopped"',
    userFriendlyDescription: 'インターネット不要。端末だけで動くAI。プライバシー重視。',
    selectable: true,
  },
];

// ─── Command Runner Type ──────────────────────────────────────────────────────

/** Bridge経由でコマンドを実行する関数の型 */
export type EnvCommandRunner = (
  command: string,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

// ─── Environment Check ───────────────────────────────────────────────────────

/**
 * 全ツールのインストール状態を一括チェックする。
 */
export async function checkAllTools(
  runCommand: EnvCommandRunner,
): Promise<ToolStatus[]> {
  const results: ToolStatus[] = [];

  for (const tool of TOOL_CATALOG) {
    try {
      const checkResult = await runCommand(tool.checkCommand);
      const installed = checkResult.exitCode === 0;

      let version: string | undefined;
      if (installed) {
        const verResult = await runCommand(tool.versionCommand);
        version = verResult.stdout?.trim().split('\n')[0] || undefined;
      }

      let running: boolean | undefined;
      if (installed && tool.statusCommand) {
        const statusResult = await runCommand(tool.statusCommand);
        running = statusResult.stdout?.trim() === 'running';
      }

      results.push({ id: tool.id, installed, version, running });
    } catch {
      results.push({ id: tool.id, installed: false });
    }
  }

  return results;
}

/**
 * 特定のツールのインストール状態をチェックする。
 */
export async function checkTool(
  toolId: ToolId,
  runCommand: EnvCommandRunner,
): Promise<ToolStatus> {
  const tool = TOOL_CATALOG.find((t) => t.id === toolId);
  if (!tool) return { id: toolId, installed: false };

  try {
    const checkResult = await runCommand(tool.checkCommand);
    const installed = checkResult.exitCode === 0;
    let version: string | undefined;
    if (installed) {
      const verResult = await runCommand(tool.versionCommand);
      version = verResult.stdout?.trim().split('\n')[0] || undefined;
    }
    return { id: toolId, installed, version };
  } catch {
    return { id: toolId, installed: false };
  }
}

// ─── Installation ─────────────────────────────────────────────────────────────

export interface InstallProgress {
  toolId: ToolId;
  phase: SetupPhase;
  step: number;
  totalSteps: number;
  message: string;
  error?: string;
}

/**
 * ツールをインストールする（依存関係も自動解決）。
 * @param onProgress 進捗コールバック
 */
export async function installTool(
  toolId: ToolId,
  runCommand: EnvCommandRunner,
  onProgress: (progress: InstallProgress) => void,
): Promise<boolean> {
  const tool = TOOL_CATALOG.find((t) => t.id === toolId);
  if (!tool) {
    onProgress({ toolId, phase: 'error', step: 0, totalSteps: 0, message: 'ツールが見つかりません', error: 'unknown tool' });
    return false;
  }

  // 依存関係を先にインストール
  for (const depId of tool.dependencies) {
    const depStatus = await checkTool(depId, runCommand);
    if (!depStatus.installed) {
      onProgress({ toolId: depId, phase: 'installing', step: 0, totalSteps: 1, message: `${depId}をインストール中...` });
      const depOk = await installTool(depId, runCommand, onProgress);
      if (!depOk) {
        onProgress({ toolId, phase: 'error', step: 0, totalSteps: 0, message: `依存ツール${depId}のインストールに失敗`, error: `dependency ${depId} failed` });
        return false;
      }
    }
  }

  // メインインストール
  const totalSteps = tool.installCommands.length;
  onProgress({ toolId, phase: 'installing', step: 0, totalSteps, message: `${tool.name}をインストール中...` });

  for (let i = 0; i < tool.installCommands.length; i++) {
    const cmd = tool.installCommands[i];
    onProgress({ toolId, phase: 'installing', step: i + 1, totalSteps, message: `実行中: ${cmd.slice(0, 60)}...` });

    try {
      const result = await runCommand(cmd);
      if (result.exitCode !== 0) {
        onProgress({
          toolId,
          phase: 'error',
          step: i + 1,
          totalSteps,
          message: `コマンド失敗: ${cmd}`,
          error: result.stderr || result.stdout,
        });
        return false;
      }
    } catch (e) {
      onProgress({
        toolId,
        phase: 'error',
        step: i + 1,
        totalSteps,
        message: `実行エラー: ${cmd}`,
        error: String(e),
      });
      return false;
    }
  }

  onProgress({ toolId, phase: 'done', step: totalSteps, totalSteps, message: `${tool.name}のインストール完了` });
  return true;
}

// ─── Batch Setup ──────────────────────────────────────────────────────────────

/**
 * 初回セットアップ: 基盤ツール + 選択されたAIツールを一括インストール。
 */
export async function runInitialSetup(
  selectedAiTools: ToolId[],
  runCommand: EnvCommandRunner,
  onProgress: (progress: InstallProgress) => void,
): Promise<{ success: boolean; failedTools: ToolId[] }> {
  const failedTools: ToolId[] = [];

  // 1. pkg updateを最初に実行
  onProgress({ toolId: 'node' as ToolId, phase: 'checking', step: 0, totalSteps: 0, message: 'パッケージリストを更新中...' });
  await runCommand('pkg update -y');

  // 2. 基盤ツールのインストール
  const baseTools = TOOL_CATALOG.filter((t) => t.category === 'base');
  for (const tool of baseTools) {
    const status = await checkTool(tool.id, runCommand);
    if (!status.installed) {
      const ok = await installTool(tool.id, runCommand, onProgress);
      if (!ok) failedTools.push(tool.id);
    } else {
      onProgress({ toolId: tool.id, phase: 'done', step: 1, totalSteps: 1, message: `${tool.name}は既にインストール済み` });
    }
  }

  // 3. 選択されたAIツールのインストール
  for (const toolId of selectedAiTools) {
    const status = await checkTool(toolId, runCommand);
    if (!status.installed) {
      const ok = await installTool(toolId, runCommand, onProgress);
      if (!ok) failedTools.push(toolId);
    } else {
      onProgress({ toolId, phase: 'done', step: 1, totalSteps: 1, message: `${toolId}は既にインストール済み` });
    }
  }

  return { success: failedTools.length === 0, failedTools };
}

// ─── Tool Execution ───────────────────────────────────────────────────────────

/**
 * LLMの応答からコマンドを抽出する。
 * [EXECUTE] と [SETUP:xxx] タグを解析。
 */
export function parseCommandsFromResponse(response: string): {
  executeCommands: string[];
  setupCommands: { toolId: string; commands: string[] }[];
} {
  const executeCommands: string[] = [];
  const setupCommands: { toolId: string; commands: string[] }[] = [];

  // [EXECUTE] ブロックを抽出
  const execRegex = /```\s*\n?\[EXECUTE\]\n([\s\S]*?)```/g;
  let match;
  while ((match = execRegex.exec(response)) !== null) {
    const cmds = match[1].trim().split('\n').filter(Boolean);
    executeCommands.push(...cmds);
  }

  // [SETUP:xxx] ブロックを抽出
  const setupRegex = /```\s*\n?\[SETUP:([^\]]+)\]\n([\s\S]*?)```/g;
  while ((match = setupRegex.exec(response)) !== null) {
    const toolId = match[1].trim();
    const cmds = match[2].trim().split('\n').filter(Boolean);
    setupCommands.push({ toolId, commands: cmds });
  }

  return { executeCommands, setupCommands };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export function getToolById(id: ToolId): ToolDefinition | undefined {
  return TOOL_CATALOG.find((t) => t.id === id);
}

export function getSelectableTools(): ToolDefinition[] {
  return TOOL_CATALOG.filter((t) => t.selectable);
}

export function getBaseTools(): ToolDefinition[] {
  return TOOL_CATALOG.filter((t) => t.category === 'base');
}
