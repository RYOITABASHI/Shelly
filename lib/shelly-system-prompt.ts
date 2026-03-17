/**
 * lib/shelly-system-prompt.ts — v1.0
 *
 * Shellyのシステムプロンプト自動生成。
 *
 * ローカルLLMに注入するsystem promptを動的に構築する:
 * - Shellyの設計思想・機能説明（固定）
 * - インストール済みツールの状態（動的）
 * - プロジェクトコンテキスト（動的）
 * - ユーザープロファイル（動的）
 * - ユーザーカスタムコンテキスト（Settings編集可能）
 *
 * ユーザーがLLMをONにした瞬間、LLMはShellyの全機能を理解した状態になる。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Shelly Core Identity ─────────────────────────────────────────────────────

const SHELLY_IDENTITY = `あなたはShellyのAIアシスタントです。日本語で簡潔に回答してください。

Shellyは Android のAI統合ターミナルアプリです（バックエンドはTermux）。

# 利用可能なコマンド（正確な名前を使うこと）
- claude — Claude Code（AIコーディング）
- gemini — Gemini CLI（AI検索・コード生成）
- codex — Codex CLI（軽量コード修正）
- git, node, python, pnpm — 開発ツール

コマンド実行が必要な場合のみ:
\`\`\`
[EXECUTE]
コマンド
\`\`\``;

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const TOOL_DESCRIPTIONS: Record<string, string> = {
  'claude-code': 'Claude Code: AIコーディング（コマンド: claude）',
  'gemini-cli': 'Gemini CLI: AI検索・コード生成（コマンド: gemini）',
  'llama-server': 'llama-server: ローカルLLM',
  'node': 'Node.js',
  'python': 'Python',
  'git': 'Git',
};

// ─── Dynamic Prompt Builder ───────────────────────────────────────────────────

export interface ToolStatus {
  id: string;
  installed: boolean;
  version?: string;
  running?: boolean;
}

export interface SystemPromptContext {
  toolStatuses?: ToolStatus[];
  projectContext?: string;
  userProfileSummary?: string;
  customContext?: string;
  decisionLog?: string;
}

/**
 * Shellyのシステムプロンプトを動的に構築する。
 * LLMに送信するmessagesのsystem roleに使用。
 */
export function buildSystemPrompt(ctx: SystemPromptContext = {}): string {
  const parts: string[] = [SHELLY_IDENTITY];

  // ── ツール状態 ────────────────────────────────────────────────────────
  if (ctx.toolStatuses && ctx.toolStatuses.length > 0) {
    const lines = ['# 利用可能なツール'];
    for (const tool of ctx.toolStatuses) {
      const desc = TOOL_DESCRIPTIONS[tool.id] || tool.id;
      const status = tool.installed
        ? `インストール済み${tool.version ? ` (${tool.version})` : ''}${tool.running ? ' - 稼働中' : ''}`
        : '未インストール';
      lines.push(`- ${desc}\n  状態: ${status}`);
    }
    lines.push('');
    lines.push('未インストールのツールが必要な場合は [SETUP:ツール名] で自動セットアップを提案してください。');
    parts.push(lines.join('\n'));
  }

  // ── 機能は SHELLY_IDENTITY に含めたので個別セクション不要 ──

  // ── プロジェクトコンテキスト ──────────────────────────────────────────
  if (ctx.projectContext) {
    parts.push(`# 現在のプロジェクト\n${ctx.projectContext}`);
  }

  // ── ユーザープロファイル ──────────────────────────────────────────────
  if (ctx.userProfileSummary) {
    parts.push(`# ユーザー情報\n${ctx.userProfileSummary}`);
  }

  // ── 判断ログ（永続メモリ） ──────────────────────────────────────────
  if (ctx.decisionLog) {
    parts.push(`# 過去の設計判断・修正履歴\n以下はセッション跨ぎで保存された重要な判断です。矛盾する変更を避けてください。\n${ctx.decisionLog}`);
  }

  // ── ユーザーカスタムコンテキスト ──────────────────────────────────────
  if (ctx.customContext) {
    parts.push(`# ユーザー定義コンテキスト\n${ctx.customContext}`);
  }

  return parts.join('\n\n');
}

// ─── Custom Context Persistence ───────────────────────────────────────────────

const CUSTOM_CONTEXT_KEY = '@shelly/custom-context';

/**
 * ユーザーが設定画面で編集したカスタムコンテキストを保存する。
 */
export async function saveCustomContext(content: string): Promise<void> {
  await AsyncStorage.setItem(CUSTOM_CONTEXT_KEY, content);
}

/**
 * カスタムコンテキストを読み込む。
 */
export async function loadCustomContext(): Promise<string> {
  return (await AsyncStorage.getItem(CUSTOM_CONTEXT_KEY)) ?? '';
}

// ─── Default Custom Context Template ──────────────────────────────────────────

export const DEFAULT_CUSTOM_CONTEXT = `# カスタムコンテキスト
# ここに書いた内容がAIのシステムプロンプトに追加されます。
# 例:
# - このプロジェクトではReact + TypeScriptを使っています
# - 日本語で回答してください
# - コードにはコメントを多めにつけてください
`;
