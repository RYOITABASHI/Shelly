/**
 * lib/local-llm.ts — v2.4.2
 *
 * Local LLM (Ollama) APIクライアントとAI Orchestrationロジック。
 *
 * 設計方針:
 * - Ollama互換API（http://127.0.0.1:11434）に直接HTTPリクエスト
 * - タスク分類: 「基本チャット」はLocal LLMで処理、「コード生成」「調査」はClaude/Geminiに委譲
 * - Local LLM無効時はすべてClaude Code / Gemini CLIに送信
 * - ストリーミングレスポンス対応（Ollama /api/chat）
 */

import { buildSystemPrompt } from './shelly-system-prompt';
import type { ToolStatus } from './shelly-system-prompt';
import { routeIntent, formatRoutingMessage, type RoutingDecision } from './intent-router';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TaskCategory =
  | 'chat'          // 基本的な質問・会話 → Local LLM
  | 'code'          // コード生成・修正 → Claude Code
  | 'research'      // 調査・情報収集 → Gemini CLI
  | 'file_ops'      // ファイル操作 → Termux直接実行
  | 'unknown';      // 判定不能 → Claude Code（デフォルト）

export interface OllamaMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream?: boolean;
  options?: {
    temperature?: number;
    num_ctx?: number;
    num_predict?: number;
  };
}

export interface OllamaChatResponse {
  model: string;
  message: OllamaMessage;
  done: boolean;
  total_duration?: number;
  eval_count?: number;
}

export interface OllamaStreamChunk {
  model: string;
  message: { role: string; content: string };
  done: boolean;
}

export interface OllamaTagsResponse {
  models: Array<{
    name: string;
    modified_at: string;
    size: number;
  }>;
}

// ─── OpenAI-compatible types (for llama-server) ───────────────────────────────

export interface OpenAIChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

export interface OpenAIChatResponse {
  id: string;
  object: string;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
}

export interface OpenAIStreamChunk {
  id: string;
  object: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }>;
}

/**
 * APIタイプを自動判定する。
 * llama-server: /v1/chat/completions (OpenAI互換)
 * Ollama:       /api/chat
 */
export function detectApiType(baseUrl: string): 'openai' | 'ollama' {
  // ポート8080はllama-server（OpenAI互換）
  if (baseUrl.includes(':8080')) return 'openai';
  // ポート11434はOllama
  if (baseUrl.includes(':11434')) return 'ollama';
  // デフォルトはOpenAI互換（llama-serverが主流）
  return 'openai';
}

export interface LocalLlmConfig {
  baseUrl: string;   // e.g. "http://127.0.0.1:11434"
  model: string;     // e.g. "llama3.2:3b"
  enabled: boolean;
}

export interface OrchestrationResult {
  category: TaskCategory;
  handledBy: 'local_llm' | 'claude' | 'gemini' | 'codex' | 'termux';
  response?: string;         // Local LLMが直接回答した場合
  delegatedCommand?: string; // Claude/Geminiに委譲する場合のコマンド
  reasoning: string;         // 判定理由（デバッグ用）
  /** ツール未インストール時のセットアップ案内 */
  setupRequired?: boolean;
  setupMessage?: string;
  setupToolId?: string;
  /** ルーティング判定の詳細 */
  routingDecision?: RoutingDecision;
}

// ─── Task Classifier ──────────────────────────────────────────────────────────

/**
 * ユーザー入力からタスクカテゴリを分類する。
 * ルールベース（LLM不要）で高速判定。
 */
export function classifyTask(userInput: string): TaskCategory {
  const input = userInput.toLowerCase();

  // ファイル操作キーワード
  const fileOpsKeywords = [
    'ファイルを', 'フォルダを', 'ディレクトリを', 'mkdir', 'touch', 'rm ', 'cp ',
    'mv ', 'ls ', 'cat ', 'echo ', 'chmod', 'chown', 'find ', 'grep ',
    'create file', 'delete file', 'move file', 'copy file',
  ];
  if (fileOpsKeywords.some((k) => input.includes(k))) return 'file_ops';

  // コード生成キーワード
  const codeKeywords = [
    'コードを書いて', 'コードを作って', '実装して', 'プログラムを',
    'スクリプトを', 'バグを直して', 'リファクタ', 'テストを書いて',
    'write code', 'implement', 'create a function', 'fix bug', 'refactor',
    'typescript', 'javascript', 'python', 'react', 'html', 'css',
    '.ts', '.js', '.py', '.tsx', '.jsx',
    'コンポーネント', 'クラス', '関数', 'メソッド', 'api', 'endpoint',
  ];
  if (codeKeywords.some((k) => input.includes(k))) return 'code';

  // 調査・検索キーワード
  const researchKeywords = [
    '調べて', '検索して', '最新の', 'ニュース', '情報を集めて',
    'search', 'research', 'find information', 'latest', 'news',
    'what is', 'how does', 'explain', '説明して', 'とは何', 'について教えて',
    'ドキュメント', 'documentation', 'spec', '仕様',
  ];
  if (researchKeywords.some((k) => input.includes(k))) return 'research';

  // 基本チャット（デフォルト）
  const chatKeywords = [
    'こんにちは', 'ありがとう', 'おはよう', 'こんばんは',
    'hello', 'hi', 'thanks', 'help me', 'can you',
    '教えて', '質問', '相談', 'どう思う', 'アドバイス',
    'おすすめ', '比較', 'メリット', 'デメリット',
  ];
  if (chatKeywords.some((k) => input.includes(k))) return 'chat';

  // 短い入力（50文字以下）は基本チャットとみなす
  if (userInput.trim().length <= 50) return 'chat';

  return 'unknown';
}

// ─── Ollama API Client ────────────────────────────────────────────────────────

/**
 * 接続確認。llama-server（/health）とOllama（/api/tags）両方に対応。
 */
export async function checkOllamaConnection(baseUrl: string): Promise<{
  available: boolean;
  models: string[];
  error?: string;
}> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const apiType = detectApiType(baseUrl);

    if (apiType === 'openai') {
      // llama-server: /health エンドポイント
      const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return { available: false, models: [], error: `HTTP ${res.status}` };
      // /v1/models からモデル一覧を取得
      try {
        const modelsRes = await fetch(`${baseUrl}/v1/models`, { signal: new AbortController().signal });
        if (modelsRes.ok) {
          const data = await modelsRes.json();
          const models = (data.data ?? []).map((m: { id: string }) => m.id);
          return { available: true, models };
        }
      } catch {
        // /v1/models が失敗してもhealthがOKなら接続成功
      }
      return { available: true, models: [] };
    } else {
      // Ollama: /api/tags
      const res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return { available: false, models: [], error: `HTTP ${res.status}` };
      const data: OllamaTagsResponse = await res.json();
      const models = data.models.map((m) => m.name);
      return { available: true, models };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { available: false, models: [], error: message };
  }
}

/**
 * チャットリクエストを送信（非ストリーミング）。
 * llama-server（OpenAI互換）とOllama両方に対応。
 */
export async function ollamaChat(
  config: LocalLlmConfig,
  messages: OllamaMessage[],
  timeoutMs = 60000,
): Promise<{ success: boolean; content: string; error?: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const apiType = detectApiType(config.baseUrl);

    let url: string;
    let body: string;

    if (apiType === 'openai') {
      // llama-server: OpenAI互換 /v1/chat/completions
      url = `${config.baseUrl}/v1/chat/completions`;
      const req: OpenAIChatRequest = {
        model: config.model,
        messages,
        stream: false,
        temperature: 0.7,
        max_tokens: 512,
      };
      body = JSON.stringify(req);
    } else {
      // Ollama: /api/chat
      url = `${config.baseUrl}/api/chat`;
      const req: OllamaChatRequest = {
        model: config.model,
        messages,
        stream: false,
        options: { temperature: 0.7, num_predict: 1024 },
      };
      body = JSON.stringify(req);
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      return { success: false, content: '', error: `HTTP ${res.status}: ${errText}` };
    }

    const data = await res.json();

    if (apiType === 'openai') {
      const openAiData = data as OpenAIChatResponse;
      const content = openAiData.choices?.[0]?.message?.content ?? '';
      if (!content) return { success: false, content: '', error: 'レスポンスが空です' };
      return { success: true, content };
    } else {
      const ollamaData = data as OllamaChatResponse;
      return { success: true, content: ollamaData.message.content };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = message.includes('abort') || message.includes('timeout');
    return {
      success: false,
      content: '',
      error: isTimeout ? 'タイムアウト（60秒）。モデルが重すぎる可能性があります。' : message,
    };
  }
}

/**
 * チャットリクエストを送信（ストリーミング）。
 * llama-server（OpenAI互換 SSE）とOllama両方に対応。
 * onChunk: 各チャンクのテキストを受け取るコールバック
 */
export async function ollamaChatStream(
  config: LocalLlmConfig,
  messages: OllamaMessage[],
  onChunk: (text: string, done: boolean) => void,
  timeoutMs = 120000,
): Promise<{ success: boolean; error?: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const apiType = detectApiType(config.baseUrl);

    let url: string;
    let body: string;

    if (apiType === 'openai') {
      url = `${config.baseUrl}/v1/chat/completions`;
      const req: OpenAIChatRequest = {
        model: config.model,
        messages,
        stream: true,
        temperature: 0.7,
        max_tokens: 2048,
      };
      body = JSON.stringify(req);
    } else {
      url = `${config.baseUrl}/api/chat`;
      const req: OllamaChatRequest = {
        model: config.model,
        messages,
        stream: true,
        options: { temperature: 0.7, num_predict: 2048 },
      };
      body = JSON.stringify(req);
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return { success: false, error: `HTTP ${res.status}: ${res.statusText}` };
    }

    // React Native's fetch doesn't support ReadableStream.getReader()
    // Return error so orchestrateChatStream can fall back to non-streaming ollamaChat
    const reader = res.body?.getReader?.();
    if (!reader) {
      return { success: false, error: 'ReadableStream not supported (React Native)' };
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (apiType === 'openai') {
          // OpenAI SSE形式: "data: {...}" または "data: [DONE]"
          if (!trimmed.startsWith('data:')) continue;
          const jsonStr = trimmed.slice(5).trim();
          if (jsonStr === '[DONE]') {
            onChunk('', true);
            break;
          }
          try {
            const chunk = JSON.parse(jsonStr) as OpenAIStreamChunk;
            const content = chunk.choices?.[0]?.delta?.content ?? '';
            const isDone = chunk.choices?.[0]?.finish_reason === 'stop';
            if (content) onChunk(content, isDone);
            if (isDone) break;
          } catch {
            // JSON parse error, skip
          }
        } else {
          // Ollama形式: "{...}"
          try {
            const chunk = JSON.parse(trimmed) as OllamaStreamChunk;
            onChunk(chunk.message.content, chunk.done);
            if (chunk.done) break;
          } catch {
            // JSON parse error, skip
          }
        }
      }
    }

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = message.includes('abort') || message.includes('timeout');
    return {
      success: false,
      error: isTimeout ? 'タイムアウト。モデルが重すぎる可能性があります。' : message,
    };
  }
}

// ─── AI Orchestrator ──────────────────────────────────────────────────────────

/**
 * AI Orchestration: LLMベースでタスクを分類し、適切なAIに委譲する。
 *
 * フロー:
 * 1. LLMベースのインテントルーターでユーザー意図を解析
 * 2. 最適なツールを選択（Claude Code / Gemini CLI / Codex / ローカルLLM / Termux）
 * 3. ツール未インストールの場合、セットアップを提案
 * 4. LLM無効時はキーワードベースにフォールバック
 */
export async function orchestrateTask(
  userInput: string,
  config: LocalLlmConfig,
  conversationHistory: OllamaMessage[] = [],
  projectContext?: string,
  userProfileSummary?: string,
  customContext?: string,
  toolStatuses?: ToolStatus[],
  defaultAgent?: 'gemini-cli' | 'claude-code' | 'codex',
): Promise<OrchestrationResult> {
  // LLMベースのインテントルーティング
  const routing = await routeIntent(userInput, config, toolStatuses ?? [], defaultAgent);

  // ツール未インストール → セットアップ案内を返す
  if (routing.setupRequired) {
    return {
      category: 'unknown',
      handledBy: 'local_llm',
      response: routing.setupMessage,
      reasoning: `${routing.tool}が未インストール。セットアップを提案。`,
      setupRequired: true,
      setupMessage: routing.setupMessage,
      setupToolId: routing.setupToolId,
      routingDecision: routing,
    };
  }

  // ルーティング結果に基づいて処理
  switch (routing.tool) {
    case 'local-llm': {
      // Local LLMで直接回答（動的システムプロンプト使用）
      const systemContent = buildSystemPrompt({
        toolStatuses,
        projectContext,
        userProfileSummary,
        customContext,
      });

      const messages: OllamaMessage[] = [
        { role: 'system', content: systemContent },
        ...conversationHistory,
        { role: 'user', content: userInput },
      ];

      const result = await ollamaChat(config, messages);

      if (result.success) {
        return {
          category: 'chat',
          handledBy: 'local_llm',
          response: result.content,
          reasoning: routing.reason,
          routingDecision: routing,
        };
      } else {
        return {
          category: 'chat',
          handledBy: 'claude',
          delegatedCommand: buildClaudeCommand(userInput),
          reasoning: `Local LLMエラー（${result.error}）のため、Claude Codeにフォールバック`,
          routingDecision: routing,
        };
      }
    }

    case 'claude-code': {
      return {
        category: 'code',
        handledBy: 'claude',
        delegatedCommand: buildClaudeCommand(userInput),
        reasoning: routing.reason,
        routingDecision: routing,
      };
    }

    case 'gemini-cli': {
      return {
        category: 'research',
        handledBy: 'gemini',
        delegatedCommand: buildGeminiCommand(userInput),
        reasoning: routing.reason,
        routingDecision: routing,
      };
    }

    case 'codex': {
      return {
        category: 'code',
        handledBy: 'codex',
        delegatedCommand: buildCodexCommand(userInput),
        reasoning: routing.reason,
        routingDecision: routing,
      };
    }

    case 'termux': {
      return {
        category: 'file_ops',
        handledBy: 'termux',
        delegatedCommand: userInput,
        reasoning: routing.reason,
        routingDecision: routing,
      };
    }

    default: {
      return {
        category: 'unknown',
        handledBy: 'claude',
        delegatedCommand: buildClaudeCommand(userInput),
        reasoning: routing.reason,
        routingDecision: routing,
      };
    }
  }
}

/**
 * AI Orchestration ストリーミング版。
 * chatカテゴリのみollamaChatStreamを使用し、リアルタイムでテキストを返す。
 * onChunk: 各チャンクのテキストと完了フラグを受け取るコールバック
 */
export async function orchestrateChatStream(
  userInput: string,
  config: LocalLlmConfig,
  onChunk: (text: string, done: boolean) => void,
  conversationHistory: OllamaMessage[] = [],
  projectContext?: string,
  userProfileSummary?: string,
  customContext?: string,
  toolStatuses?: ToolStatus[],
  defaultAgent?: 'gemini-cli' | 'claude-code' | 'codex',
): Promise<OrchestrationResult> {
  // LLMベースのインテントルーティング
  const routing = await routeIntent(userInput, config, toolStatuses ?? [], defaultAgent);

  // セットアップが必要 or ローカルLLM以外 → 通常フローに委譲
  if (routing.setupRequired || routing.tool !== 'local-llm') {
    return orchestrateTask(userInput, config, conversationHistory, projectContext, userProfileSummary, customContext, toolStatuses, defaultAgent);
  }

  const systemContent = buildSystemPrompt({
    toolStatuses,
    projectContext,
    userProfileSummary,
    customContext,
  });

  const messages: OllamaMessage[] = [
    { role: 'system', content: systemContent },
    ...conversationHistory,
    { role: 'user', content: userInput },
  ];

  // React Native's fetch doesn't support ReadableStream and will hang on SSE responses.
  // Always use non-streaming on React Native to avoid 120s timeout.
  const isReactNative = typeof navigator !== 'undefined' && navigator.product === 'ReactNative';

  if (!isReactNative) {
    const result = await ollamaChatStream(config, messages, onChunk);
    if (result.success) {
      return {
        category: 'chat',
        handledBy: 'local_llm',
        reasoning: `Local LLM (${config.model}) ストリーミング回答`,
      };
    }
  }

  // Non-streaming request (always used on React Native, fallback on web)
  const fallback = await ollamaChat(config, messages);
  if (fallback.success && fallback.content) {
    onChunk(fallback.content, true);
    return {
      category: 'chat',
      handledBy: 'local_llm',
      reasoning: `Local LLM (${config.model}) 回答`,
    };
  }

  return {
    category: 'chat',
    handledBy: 'claude',
    delegatedCommand: buildClaudeCommand(userInput),
    reasoning: `Local LLMエラー（${fallback.error}）のため、Claude Codeにフォールバック`,
  };
}

// ─── Command Builders ─────────────────────────────────────────────────────────

function buildClaudeCommand(userInput: string): string {
  const escaped = userInput.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
  return `claude --print "${escaped}"`;
}

function buildGeminiCommand(userInput: string): string {
  const escaped = userInput.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
  return `gemini --prompt "${escaped}"`;
}

function buildCodexCommand(userInput: string): string {
  const escaped = userInput.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
  return `codex "${escaped}"`;
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * タスクカテゴリの日本語ラベル
 */
export function getCategoryLabel(category: TaskCategory): string {
  const labels: Record<TaskCategory, string> = {
    chat: '基本チャット',
    code: 'コード生成',
    research: '調査・検索',
    file_ops: 'ファイル操作',
    unknown: '不明',
  };
  return labels[category];
}

/**
 * 委譲先のラベル
 */
export function getHandlerLabel(handler: OrchestrationResult['handledBy']): string {
  const labels: Record<OrchestrationResult['handledBy'], string> = {
    local_llm: 'ローカルLLM',
    claude: 'Claude Code',
    gemini: 'Gemini CLI',
    codex: 'Codex CLI',
    termux: 'Termux',
  };
  return labels[handler];
}
