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
import { getCurrentLocale } from '@/lib/i18n';

// ─── Shelly Core Identity ─────────────────────────────────────────────────────

function getShellyIdentity(): string {
  const locale = getCurrentLocale();
  const langInstruction = locale === 'ja'
    ? 'あなたはShellyのAIアシスタントです。日本語で簡潔に回答してください。'
    : 'You are Shelly\'s AI assistant. Reply concisely in English.';

  const appDesc = locale === 'ja'
    ? 'Shellyは Android のAI統合ターミナルアプリです。'
    : 'Shelly is an AI-integrated terminal app for Android.';

  const cmdHeader = locale === 'ja'
    ? '# 利用可能なコマンド（正確な名前を使うこと）'
    : '# Available commands (use exact names)';

  const cmdDesc = locale === 'ja'
    ? `- codex — Codex CLI（AIコーディング）
- local LLM — オフライン相談・下書き
- git, node, python, pnpm — 開発ツール`
    : `- codex — Codex CLI (AI coding)
- local LLM — offline chat and drafting
- git, node, python, pnpm — dev tools`;

  const execNote = locale === 'ja'
    ? 'コマンド実行が必要な場合のみ:'
    : 'Only when command execution is needed:';

  return `${langInstruction}

${appDesc}

${cmdHeader}
${cmdDesc}

${execNote}
\`\`\`
[EXECUTE]
command
\`\`\``;
}

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const TOOL_DESCRIPTIONS: Record<string, string> = {
  'codex': 'Codex CLI (command: codex)',
  'llama-server': 'llama-server: local LLM',
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
  const parts: string[] = [getShellyIdentity()];

  // ── ツール状態 ────────────────────────────────────────────────────────
  if (ctx.toolStatuses && ctx.toolStatuses.length > 0) {
    const locale = getCurrentLocale();
    const isJa = locale === 'ja';
    const lines = [isJa ? '# 利用可能なツール' : '# Available tools'];
    for (const tool of ctx.toolStatuses) {
      const desc = TOOL_DESCRIPTIONS[tool.id] || tool.id;
      const status = tool.installed
        ? (isJa
          ? `インストール済み${tool.version ? ` (${tool.version})` : ''}${tool.running ? ' - 稼働中' : ''}`
          : `installed${tool.version ? ` (${tool.version})` : ''}${tool.running ? ' - running' : ''}`)
        : (isJa ? '未インストール' : 'not installed');
      lines.push(`- ${desc}\n  ${isJa ? '状態' : 'status'}: ${status}`);
    }
    lines.push('');
    lines.push(isJa
      ? '未インストールのツールが必要な場合は [SETUP:ツール名] で自動セットアップを提案してください。'
      : 'If an uninstalled tool is needed, suggest auto-setup with [SETUP:tool-name].');
    parts.push(lines.join('\n'));
  }

  // ── 機能は SHELLY_IDENTITY に含めたので個別セクション不要 ──

  // ── プロジェクトコンテキスト ──────────────────────────────────────────
  const locale = getCurrentLocale();
  const isJa = locale === 'ja';

  if (ctx.projectContext) {
    parts.push(`# ${isJa ? '現在のプロジェクト' : 'Current project'}\n${ctx.projectContext}`);
  }

  if (ctx.userProfileSummary) {
    parts.push(`# ${isJa ? 'ユーザー情報' : 'User info'}\n${ctx.userProfileSummary}`);
  }

  if (ctx.decisionLog) {
    const header = isJa ? '過去の設計判断・修正履歴' : 'Past design decisions';
    const note = isJa
      ? '以下はセッション跨ぎで保存された重要な判断です。矛盾する変更を避けてください。'
      : 'These are important decisions preserved across sessions. Avoid contradicting them.';
    parts.push(`# ${header}\n${note}\n${ctx.decisionLog}`);
  }

  if (ctx.customContext) {
    parts.push(`# ${isJa ? 'ユーザー定義コンテキスト' : 'Custom context'}\n${ctx.customContext}`);
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

export function getDefaultCustomContext(): string {
  const locale = getCurrentLocale();
  if (locale === 'ja') {
    return `# カスタムコンテキスト
# ここに書いた内容がAIのシステムプロンプトに追加されます。
# 例:
# - このプロジェクトではReact + TypeScriptを使っています
# - コードにはコメントを多めにつけてください
`;
  }
  return `# Custom Context
# What you write here is added to the AI system prompt.
# Examples:
# - This project uses React + TypeScript
# - Add plenty of comments to code
`;
}

// Legacy export for backwards compatibility
export const DEFAULT_CUSTOM_CONTEXT = `# Custom Context
# What you write here is added to the AI system prompt.
`;
