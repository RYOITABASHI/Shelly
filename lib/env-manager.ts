/**
 * lib/env-manager.ts — v2.0
 *
 * Environment Manager: ツール可用性チェック・状態管理。
 *
 * ツールのインストール・バージョン確認を行い、
 * 未インストールの場合はユーザーへのガイダンスを返す。
 * インストール自体は行わない。
 */

import type { ToolStatus } from './shelly-system-prompt';
import { execCommand } from '@/hooks/use-native-exec';

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
  /** 存在確認コマンド */
  checkCommand: string;
  /** バージョン取得コマンド */
  versionCommand: string;
  /** ツールが見つからない場合のインストール案内 */
  installGuidance: string;
  /** 依存ツール */
  dependencies: ToolId[];
  /** 認証が必要か */
  requiresAuth: boolean;
  /** 認証URL */
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
  // ── 基盤ツール ──────────────────────────────────────────────────────────
  {
    id: 'node',
    name: 'Node.js',
    description: 'JavaScript/TypeScript実行環境',
    category: 'base',
    checkCommand: 'which node',
    versionCommand: 'node --version',
    installGuidance: 'Node.js is not installed. Download from https://nodejs.org or install via your system package manager.',
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
    installGuidance: 'Python 3 is not installed. Download from https://www.python.org or install via your system package manager.',
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
    installGuidance: 'Git is not installed. Download from https://git-scm.com or install via your system package manager.',
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
    installGuidance: 'Claude Code is not installed. Run: npm install -g @anthropic-ai/claude-code',
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
    installGuidance: 'Gemini CLI is not installed. Run: npm install -g @google/gemini-cli',
    dependencies: ['node'],
    requiresAuth: true,
    authUrl: 'https://aistudio.google.com/apikey',
    authCheckCommand: 'gemini --version 2>/dev/null && echo "ok"',
    userFriendlyDescription: 'Google製のAIアシスタント。無料枠あり。セットアップが簡単で初心者におすすめ。',
    selectable: true,
  },
  {
    id: 'llama-server',
    name: 'ローカルLLM',
    description: 'オフラインで動くAI（llama.cpp）',
    category: 'ai',
    checkCommand: 'which llama-server',
    versionCommand: 'llama-server --version 2>/dev/null | head -1 || echo "installed"',
    installGuidance: 'llama-server is not installed. Build from source at https://github.com/ggerganov/llama.cpp or install a pre-built binary for your platform.',
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

/** コマンドを実行する関数の型 */
export type EnvCommandRunner = (
  command: string,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

// ─── Tool Check ──────────────────────────────────────────────────────────────

export interface CheckToolResult {
  id: ToolId;
  installed: boolean;
  version?: string;
  running?: boolean;
  /** ツールが見つからない場合のガイダンス */
  guidance?: string;
}

/**
 * 全ツールの存在をチェックする。インストールは行わない。
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
 * 特定ツールの存在をチェックする。
 * ツールが見つからない場合はガイダンスを返す。
 */
export async function checkTool(
  toolId: ToolId,
  runCommand: EnvCommandRunner,
): Promise<CheckToolResult> {
  const tool = TOOL_CATALOG.find((t) => t.id === toolId);
  if (!tool) return { id: toolId, installed: false, guidance: `Unknown tool: ${toolId}` };

  try {
    const checkResult = await runCommand(tool.checkCommand);
    const installed = checkResult.exitCode === 0;

    if (!installed) {
      return { id: toolId, installed: false, guidance: tool.installGuidance };
    }

    const verResult = await runCommand(tool.versionCommand);
    const version = verResult.stdout?.trim().split('\n')[0] || undefined;
    return { id: toolId, installed: true, version };
  } catch {
    return { id: toolId, installed: false, guidance: tool.installGuidance };
  }
}

// ─── Setup Check (replaces installTool / runInitialSetup) ─────────────────────

export interface InstallProgress {
  toolId: ToolId;
  phase: SetupPhase;
  step: number;
  totalSteps: number;
  message: string;
  error?: string;
}

/**
 * ツールの存在確認を行い、見つからない場合はガイダンスを通知する。
 * インストールは行わない。
 */
export async function ensureTool(
  toolId: ToolId,
  runCommand: EnvCommandRunner,
  onProgress: (progress: InstallProgress) => void,
): Promise<boolean> {
  const tool = TOOL_CATALOG.find((t) => t.id === toolId);
  if (!tool) {
    onProgress({ toolId, phase: 'error', step: 0, totalSteps: 0, message: 'ツールが見つかりません', error: 'unknown tool' });
    return false;
  }

  onProgress({ toolId, phase: 'checking', step: 0, totalSteps: 1, message: `${tool.name}を確認中...` });

  // 依存関係の確認
  for (const depId of tool.dependencies) {
    const depResult = await checkTool(depId, runCommand);
    if (!depResult.installed) {
      const depTool = TOOL_CATALOG.find((t) => t.id === depId);
      onProgress({
        toolId,
        phase: 'error',
        step: 0,
        totalSteps: 1,
        message: `依存ツール ${depId} が見つかりません`,
        error: depTool?.installGuidance ?? `Tool not found: ${depId}`,
      });
      return false;
    }
  }

  const result = await checkTool(toolId, runCommand);

  if (result.installed) {
    onProgress({ toolId, phase: 'done', step: 1, totalSteps: 1, message: `${tool.name} found: ${result.version ?? 'installed'}` });
    return true;
  }

  onProgress({
    toolId,
    phase: 'error',
    step: 0,
    totalSteps: 1,
    message: `${tool.name} が見つかりません`,
    error: result.guidance,
  });
  return false;
}

/**
 * 初回セットアップチェック: 基盤ツール + 選択されたAIツールの存在を確認。
 * 不足ツールがあればガイダンスを返す。インストールは行わない。
 */
export async function runInitialSetup(
  selectedAiTools: ToolId[],
  runCommand: EnvCommandRunner,
  onProgress: (progress: InstallProgress) => void,
): Promise<{ success: boolean; failedTools: ToolId[] }> {
  const failedTools: ToolId[] = [];

  onProgress({ toolId: 'node' as ToolId, phase: 'checking', step: 0, totalSteps: 0, message: '環境を確認中...' });

  // 基盤ツールの確認
  const baseTools = TOOL_CATALOG.filter((t) => t.category === 'base');
  for (const tool of baseTools) {
    const result = await checkTool(tool.id, runCommand);
    if (result.installed) {
      onProgress({ toolId: tool.id, phase: 'done', step: 1, totalSteps: 1, message: `${tool.name} found: ${result.version ?? 'installed'}` });
    } else {
      onProgress({
        toolId: tool.id,
        phase: 'error',
        step: 0,
        totalSteps: 1,
        message: `${tool.name} が見つかりません`,
        error: result.guidance,
      });
      failedTools.push(tool.id);
    }
  }

  // 選択されたAIツールの確認
  for (const toolId of selectedAiTools) {
    const ok = await ensureTool(toolId, runCommand, onProgress);
    if (!ok) failedTools.push(toolId);
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
