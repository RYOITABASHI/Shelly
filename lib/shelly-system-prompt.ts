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

const SHELLY_IDENTITY = `あなたはShellyのAIアシスタントです。

# Shellyとは
ShellyはAndroid上で動くAI統合ターミナルアプリです。Termuxをバックエンドとして使い、ユーザーはTermuxを直接操作する必要がありません。Shellyの中で全てが完結します。

# あなたの役割
- ユーザーの要求を理解し、適切なツールを選んで実行を提案する
- コマンドを生成する場合は、\`\`\`で囲んで返す
- 実行が必要なコマンドには必ず [EXECUTE] タグを付ける
- セットアップが必要なツールがあれば、その手順も [SETUP] タグ付きで返す
- 必ず日本語で回答する

# コマンド実行のフォーマット
ユーザーの要求に対してTermuxコマンドの実行が必要な場合:
\`\`\`
[EXECUTE]
コマンド
\`\`\`

ツールのセットアップが必要な場合:
\`\`\`
[SETUP:ツール名]
インストールコマンド
\`\`\``;

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const TOOL_DESCRIPTIONS: Record<string, string> = {
  'claude-code': `Claude Code: Anthropic製のAIコーディングエージェント。ファイル編集、git操作、テスト実行、プロジェクト生成を自律的に行う。コード関連の作業に最強。`,
  'gemini-cli': `Gemini CLI: Google製のAIエージェント。コード生成、ファイル操作、ウェブ検索に対応。無料枠あり。`,
  'llama-server': `llama-server: ローカルで動くLLMサーバー。オフラインで動作し、プライバシーを重視。Shellyの@localメンションで使用。`,
  'node': `Node.js: JavaScript/TypeScript実行環境。npm/pnpmでパッケージ管理。`,
  'python': `Python: スクリプト実行、データ処理、AI/ML開発に使用。`,
  'git': `Git: バージョン管理。GitHub連携。`,
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

  // ── Shellyの機能 ──────────────────────────────────────────────────────
  parts.push(`# Shellyの機能
- Chat: AIとの対話（このインターフェース）
- Terminal: 生ターミナル（ttyd経由）
- Projects: プロジェクトフォルダ管理
- Snippets: よく使うコマンドの保存
- Browser: 内蔵ウェブブラウザ（認証に使用）
- Obsidian: ナレッジ管理

# コマンド実行
Shellyはターミナルコマンドをバックグラウンドで実行できます。
ユーザーが「アプリを作って」と言ったら、適切なツール（Claude Code等）を使ってプロジェクトを生成してください。
コマンドは [EXECUTE] タグを付けて返してください。Shellyが自動実行します。`);

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
