/**
 * lib/intent-router.ts — v1.0
 *
 * LLMベースのインテントルーター。
 *
 * ユーザーの自然言語入力をローカルLLMが解析し、最適なツールを選択する。
 * キーワードマッチではなく、LLMの文脈理解でルーティングする。
 *
 * フロー:
 * 1. ユーザー入力 + 利用可能ツール状態をLLMに送信
 * 2. LLMがJSON形式で {tool, reason, setupRequired} を返す
 * 3. setupRequired=true の場合、env-manager経由で自動セットアップを提案
 * 4. フォールバック: LLM未接続時はキーワードベースの classifyTask() を使用
 */

import type { ToolStatus } from './shelly-system-prompt';
import type { LocalLlmConfig, OllamaMessage, TaskCategory } from './local-llm';
import { ollamaChat, classifyTask } from './local-llm';
import type { ToolId } from './env-manager';
import { TOOL_CATALOG, getToolById } from './env-manager';

// ─── Types ────────────────────────────────────────────────────────────────────

export type RoutingTool = 'claude-code' | 'gemini-cli' | 'codex' | 'local-llm' | 'termux';

export interface RoutingDecision {
  /** 選択されたツール */
  tool: RoutingTool;
  /** LLMの判断理由（ユーザーに表示） */
  reason: string;
  /** ツールが未インストールでセットアップが必要か */
  setupRequired: boolean;
  /** セットアップが必要なツールのID */
  setupToolId?: ToolId;
  /** セットアップの誘導メッセージ */
  setupMessage?: string;
  /** ユーザーに送るプロンプト（ツールに渡すテキスト） */
  prompt: string;
  /** フォールバックで判定されたか */
  usedFallback: boolean;
}

// ─── Routing System Prompt ────────────────────────────────────────────────────

function buildRoutingPrompt(toolStatuses: ToolStatus[]): string {
  const toolDescriptions = [
    {
      id: 'claude-code',
      name: 'Claude Code',
      strengths: 'コード生成、ファイル編集、プロジェクト作成、バグ修正、リファクタリング、git操作。自律的にファイルを読み書きしながら開発を進められる。最も賢く、複雑なタスクに強い。',
    },
    {
      id: 'gemini-cli',
      name: 'Gemini CLI',
      strengths: 'ウェブ検索、最新情報の調査、ドキュメント調査、コード生成。Google検索と連携した情報収集が得意。無料枠あり。',
    },
    {
      id: 'codex',
      name: 'Codex CLI',
      strengths: '高速で軽量なコード修正、簡単なファイル編集、シンプルなタスク。Claude Codeより軽く、素早い修正に向いている。',
    },
    {
      id: 'local-llm',
      name: 'ローカルLLM',
      strengths: '一般的な質問・会話、簡単な相談、概念の説明。オフラインで動作し、プライバシーを保てる。ただしコード生成や実行はできない。',
    },
    {
      id: 'termux',
      name: 'Termuxコマンド',
      strengths: '単純なファイル操作（ls, mkdir, cp, mv, rm）、パッケージ管理、シェルスクリプト実行。AIが不要な直接的なコマンド実行。',
    },
  ];

  const statusLines = toolDescriptions.map((t) => {
    const status = toolStatuses.find((s) => s.id === t.id);
    const available = status?.installed ? '利用可能' : '未インストール';
    return `- ${t.name} (${t.id}): ${t.strengths}\n  状態: ${available}`;
  }).join('\n');

  return `あなたはShellyアプリのインテントルーターです。
ユーザーの入力を分析し、最適なツールを1つ選んでください。

# 利用可能なツール
${statusLines}

# ルール
1. ユーザーの意図を正確に理解し、最も適切なツールを選ぶ
2. 複合タスク（調査+実装）の場合は、主要な作業に最適なツールを選ぶ
3. 未インストールのツールでも、最適であれば選んでよい（セットアップを案内する）
4. 簡単な会話・質問はlocal-llmで処理する（外部ツール不要）
5. 単純なファイル操作（ls, mkdir等）はtermuxで直接実行する

# 出力形式（必ずこのJSON形式で返してください）
{"tool":"ツールID","reason":"選択理由（日本語、1-2文）"}

JSONのみを返してください。説明やマークダウンは不要です。`;
}

// ─── LLM-based Router ────────────────────────────────────────────────────────

/**
 * ローカルLLMでユーザー入力を解析し、最適なツールを選択する。
 * LLM未接続時はキーワードベースにフォールバック。
 */
export async function routeIntent(
  userInput: string,
  config: LocalLlmConfig,
  toolStatuses: ToolStatus[] = [],
  defaultAgent?: 'gemini-cli' | 'claude-code' | 'codex',
): Promise<RoutingDecision> {
  // LLM無効時はフォールバック
  if (!config.enabled) {
    return fallbackRoute(userInput, toolStatuses, defaultAgent);
  }

  const messages: OllamaMessage[] = [
    { role: 'system', content: buildRoutingPrompt(toolStatuses) },
    { role: 'user', content: userInput },
  ];

  const result = await ollamaChat(config, messages, 15000);

  if (!result.success || !result.content) {
    return fallbackRoute(userInput, toolStatuses);
  }

  // LLMの出力からJSONをパース
  try {
    const parsed = parseRoutingResponse(result.content);
    if (parsed) {
      return buildDecision(parsed.tool, parsed.reason, userInput, toolStatuses, false);
    }
  } catch {
    // パース失敗 → フォールバック
  }

  return fallbackRoute(userInput, toolStatuses, defaultAgent);
}

/**
 * LLMレスポンスからJSONを抽出する。
 * LLMが余計なテキストを付けることがあるので、JSON部分だけ取り出す。
 */
function parseRoutingResponse(content: string): { tool: RoutingTool; reason: string } | null {
  // JSON部分を探す
  const jsonMatch = content.match(/\{[^{}]*"tool"\s*:\s*"[^"]+?"[^{}]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const validTools: RoutingTool[] = ['claude-code', 'gemini-cli', 'codex', 'local-llm', 'termux'];
    if (validTools.includes(parsed.tool)) {
      return { tool: parsed.tool, reason: parsed.reason || '' };
    }
  } catch {
    // JSON parse error
  }

  return null;
}

// ─── Decision Builder ─────────────────────────────────────────────────────────

function buildDecision(
  tool: RoutingTool,
  reason: string,
  userInput: string,
  toolStatuses: ToolStatus[],
  usedFallback: boolean,
): RoutingDecision {
  const decision: RoutingDecision = {
    tool,
    reason,
    setupRequired: false,
    prompt: userInput,
    usedFallback,
  };

  // ツールのインストール状態をチェック
  const toolIdMap: Partial<Record<RoutingTool, ToolId>> = {
    'claude-code': 'claude-code',
    'gemini-cli': 'gemini-cli',
  };

  const toolId = toolIdMap[tool];
  if (toolId) {
    const status = toolStatuses.find((s) => s.id === toolId);
    if (status && !status.installed) {
      const toolDef = getToolById(toolId);
      decision.setupRequired = true;
      decision.setupToolId = toolId;
      decision.setupMessage = toolDef
        ? `${toolDef.name}がまだインストールされていません。${toolDef.userFriendlyDescription}\n\nセットアップを開始しますか？`
        : `${toolId}のセットアップが必要です。インストールを開始しますか？`;
    }
  }

  return decision;
}

// ─── Fallback (Keyword-based) ─────────────────────────────────────────────────

/**
 * LLM無効時のフォールバックルーティング。
 *
 * ペルソナB（ローカルLLM無し）のデフォルト:
 * - chatカテゴリ → Gemini CLI（無料枠あり、セットアップ簡単、自然言語対応）
 * - code → インストール済みのCLIを優先、なければGemini CLI
 * - research → Gemini CLI
 * - file_ops → Termux直接実行
 * - unknown → Gemini CLI
 *
 * ローカルLLMが無い = フォールバック = 初心者の可能性が高い。
 * Geminiをデフォルトにすることで、コスト・ハードル・汎用性のバランスを取る。
 */
function fallbackRoute(
  userInput: string,
  toolStatuses: ToolStatus[],
  defaultAgent: RoutingTool = 'gemini-cli',
): RoutingDecision {
  const category = classifyTask(userInput);

  // インストール済みのCLIを確認
  const hasClaudeCode = toolStatuses.some((s) => s.id === 'claude-code' && s.installed);

  // ツール名の日本語ラベル
  const agentLabels: Record<string, string> = {
    'gemini-cli': 'Gemini CLI',
    'claude-code': 'Claude Code',
    'codex': 'Codex CLI',
  };
  const defaultLabel = agentLabels[defaultAgent] || defaultAgent;

  // codeカテゴリ: Claude Codeがあればそちら、なければデフォルトエージェント
  const codeTool: RoutingTool = hasClaudeCode ? 'claude-code' : defaultAgent;
  const codeReason = hasClaudeCode
    ? 'コード関連のタスクのため、Claude Codeに委譲します'
    : `コード関連のタスクです。${defaultLabel}で対応します`;

  const categoryToTool: Record<TaskCategory, RoutingTool> = {
    chat: defaultAgent,
    code: codeTool,
    research: 'gemini-cli',  // 調査は常にGemini（検索連携が強い）
    file_ops: 'termux',
    unknown: defaultAgent,
  };

  const categoryReasons: Record<TaskCategory, string> = {
    chat: `${defaultLabel}で回答します`,
    code: codeReason,
    research: '調査・検索タスクのため、Gemini CLIに委譲します',
    file_ops: 'ファイル操作のため、直接実行します',
    unknown: `${defaultLabel}で対応します`,
  };

  const tool = categoryToTool[category];
  const reason = categoryReasons[category];

  return buildDecision(tool, reason, userInput, toolStatuses, true);
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * ルーティング結果をユーザー向けメッセージに変換する。
 * Chatタブで表示する。
 */
export function formatRoutingMessage(decision: RoutingDecision): string {
  const toolLabels: Record<RoutingTool, string> = {
    'claude-code': 'Claude Code',
    'gemini-cli': 'Gemini CLI',
    'codex': 'Codex CLI',
    'local-llm': 'ローカルLLM',
    'termux': 'ターミナル',
  };

  const label = toolLabels[decision.tool];

  if (decision.setupRequired && decision.setupMessage) {
    return decision.setupMessage;
  }

  return `${label}で処理します。\n理由: ${decision.reason}`;
}
