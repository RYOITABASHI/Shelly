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

  // CLI実行キーワード（特定のAIツール名を含む → code扱い）
  const cliExecKeywords = [
    'claude code', 'クロードコード', 'クロード', 'claude',
    'gemini cli', 'ジェミニ', 'codex', 'コデックス',
    '実行して', '起動して', '使って', '動かして', '走らせて', '立ち上げて',
    'run ', 'start ', 'launch ', 'execute ',
  ];
  const hasCliName = ['claude', 'クロード', 'gemini', 'ジェミニ', 'codex', 'コデックス'].some((k) => input.includes(k));
  const hasExecVerb = ['実行', '起動', '使って', '動かして', '走らせ', '立ち上げ', 'run', 'start', 'launch', 'execute'].some((k) => input.includes(k));
  if (hasCliName && hasExecVerb) return 'code';

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
      if (!res.ok) { clearTimeout(timer); return { available: false, models: [], error: `HTTP ${res.status}` }; }
      // /v1/models からモデル一覧を取得（同じcontrollerを再利用してタイムアウトを共有）
      try {
        const modelsRes = await fetch(`${baseUrl}/v1/models`, { signal: controller.signal });
        clearTimeout(timer);
        if (modelsRes.ok) {
          const data = await modelsRes.json();
          const models = (data.data ?? []).map((m: { id: string }) => m.id);
          return { available: true, models };
        }
      } catch {
        clearTimeout(timer);
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
  externalSignal?: AbortSignal,
  maxTokens = 512,
  _retried = false,
): Promise<{ success: boolean; content: string; error?: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (externalSignal) {
      if (externalSignal.aborted) { clearTimeout(timer); controller.abort(); }
      else { externalSignal.addEventListener('abort', () => { clearTimeout(timer); controller.abort(); }, { once: true }); }
    }
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
        max_tokens: maxTokens,
      };
      body = JSON.stringify(req);
    } else {
      // Ollama: /api/chat
      url = `${config.baseUrl}/api/chat`;
      const req: OllamaChatRequest = {
        model: config.model,
        messages,
        stream: false,
        options: { temperature: 0.7, num_predict: maxTokens },
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
      if (!content) return { success: false, content: '', error: 'Empty response' };
      return { success: true, content };
    } else {
      const ollamaData = data as OllamaChatResponse;
      return { success: true, content: ollamaData.message.content };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isAbort = externalSignal?.aborted ?? false;
    const isTimeout = !isAbort && (message.includes('abort') || message.includes('timeout'));

    if (isTimeout || isAbort) {
      return {
        success: false,
        content: '',
        error: isTimeout ? 'Timeout (60s). The model may be too large.' : message, // Keep English for debugging (not user-facing)
      };
    }

    // Connection-level error — retry once if server is still alive
    if (!_retried) {
      const check = await checkOllamaConnection(config.baseUrl);
      if (check.available) {
        return ollamaChat(config, messages, timeoutMs, externalSignal, maxTokens, true);
      }
    }

    return { success: false, content: '', error: message };
  }
}

/**
 * チャットリクエストを送信（ストリーミング）。
 * llama-server（OpenAI互換 SSE）とOllama両方に対応。
 * onChunk: 各チャンクのテキストを受け取るコールバック
 *
 * React Native環境ではXMLHttpRequest + onprogressを使用。
 * Web環境ではfetch + ReadableStreamを使用。
 */
export async function ollamaChatStream(
  config: LocalLlmConfig,
  messages: OllamaMessage[],
  onChunk: (text: string, done: boolean) => void,
  timeoutMs = 120000,
  externalSignal?: AbortSignal,
  _retried = false,
): Promise<{ success: boolean; content?: string; error?: string }> {
  const apiType = detectApiType(config.baseUrl);
  const isReactNative = typeof navigator !== 'undefined' && navigator.product === 'ReactNative';

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

  // React Native: XMLHttpRequest でストリーミング
  if (isReactNative) {
    return xhrStream(url, body, apiType, onChunk, timeoutMs, externalSignal, config.baseUrl, _retried);
  }

  // Web: fetch + ReadableStream
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (externalSignal) {
      if (externalSignal.aborted) { clearTimeout(timer); controller.abort(); }
      else { externalSignal.addEventListener('abort', () => { clearTimeout(timer); controller.abort(); }, { once: true }); }
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });

    if (!res.ok) {
      clearTimeout(timer);
      return { success: false, error: `HTTP ${res.status}: ${res.statusText}` };
    }

    const reader = res.body?.getReader?.();
    if (!reader) {
      // Fallback: ReadableStream not available (React Native)
      clearTimeout(timer);
      const text = await res.text();
      let fullContent = '';
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const json = JSON.parse(trimmed);
          // Ollama format: { message: { content: "..." } }
          const content = json.message?.content ?? json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.message?.content ?? '';
          if (content) fullContent += content;
        } catch {}
      }
      if (fullContent) {
        onChunk(fullContent, true);
        return { success: true, content: fullContent };
      }
      return { success: false, error: 'ReadableStream not supported and fallback parse failed' };
    }

    const decoder = new TextDecoder();
    let buffer = '';
    const MAX_BUFFER_SIZE = 102400;

    try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_BUFFER_SIZE) {
        const lastNewline = buffer.lastIndexOf('\n');
        buffer = lastNewline >= 0 ? buffer.slice(lastNewline + 1) : '';
      }
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        parseSSELine(line, apiType, onChunk);
      }
    }
    } finally {
      clearTimeout(timer);
    }

    return { success: true };
  } catch (err) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    const isAbort = externalSignal?.aborted ?? false;
    const isTimeout = !isAbort && (message.includes('abort') || message.includes('timeout'));

    if (isTimeout || isAbort) {
      return { success: false, error: isTimeout ? 'Timeout. The model may be too large.' : message };
    }

    // Connection-level error — retry once if server is still alive
    if (!_retried) {
      const check = await checkOllamaConnection(config.baseUrl);
      if (check.available) {
        return ollamaChatStream(config, messages, onChunk, timeoutMs, externalSignal, true);
      }
    }

    return { success: false, error: message };
  }
}

/**
 * SSE行をパースしてonChunkを呼ぶ共通ヘルパー。
 */
function parseSSELine(
  line: string,
  apiType: 'openai' | 'ollama',
  onChunk: (text: string, done: boolean) => void,
): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  if (apiType === 'openai') {
    if (!trimmed.startsWith('data:')) return;
    const jsonStr = trimmed.slice(5).trim();
    if (jsonStr === '[DONE]') { onChunk('', true); return; }
    try {
      const chunk = JSON.parse(jsonStr) as OpenAIStreamChunk;
      const content = chunk.choices?.[0]?.delta?.content ?? '';
      const isDone = chunk.choices?.[0]?.finish_reason === 'stop';
      if (content) onChunk(content, isDone);
      else if (isDone) onChunk('', true);
    } catch { /* skip */ }
  } else {
    try {
      const chunk = JSON.parse(trimmed) as OllamaStreamChunk;
      onChunk(chunk.message.content, chunk.done);
    } catch { /* skip */ }
  }
}

/**
 * React Native用: XMLHttpRequest + onprogressでストリーミング。
 * RNのXHRはresponseTextが逐次更新されるので、差分を抽出してonChunkに渡す。
 */
function xhrStream(
  url: string,
  body: string,
  apiType: 'openai' | 'ollama',
  onChunk: (text: string, done: boolean) => void,
  timeoutMs: number,
  externalSignal?: AbortSignal,
  baseUrl?: string,
  _retried = false,
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    let lastIndex = 0;
    let settled = false;

    const finish = (result: { success: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.timeout = timeoutMs;

    if (externalSignal) {
      if (externalSignal.aborted) { finish({ success: false, error: 'Aborted' }); return; }
      externalSignal.addEventListener('abort', () => { xhr.abort(); }, { once: true });
    }

    // Throttle onprogress to prevent UI thread saturation
    let progressTimer: ReturnType<typeof setTimeout> | null = null;
    const processNewData = () => {
      const text = xhr.responseText;
      if (!text || text.length <= lastIndex) return;

      const newData = text.slice(lastIndex);
      lastIndex = text.length;

      const lines = newData.split('\n');
      for (const line of lines) {
        parseSSELine(line, apiType, onChunk);
      }
    };

    xhr.onprogress = () => {
      if (progressTimer) return; // Already scheduled
      progressTimer = setTimeout(() => {
        progressTimer = null;
        processNewData();
      }, 80);
    };

    xhr.onload = () => {
      if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
      if (xhr.status < 200 || xhr.status >= 300) {
        finish({ success: false, error: `HTTP ${xhr.status}` });
        return;
      }
      // Process any remaining data
      processNewData();
      onChunk('', true);
      finish({ success: true });
    };

    xhr.onerror = () => {
      // Connection-level error — retry once if server is still alive (and not already retried)
      if (!_retried && baseUrl && !(externalSignal?.aborted)) {
        checkOllamaConnection(baseUrl).then((check) => {
          if (check.available) {
            xhrStream(url, body, apiType, onChunk, timeoutMs, externalSignal, baseUrl, true)
              .then(finish);
          } else {
            finish({ success: false, error: 'XHR network error' });
          }
        });
      } else {
        finish({ success: false, error: 'XHR network error' });
      }
    };

    xhr.ontimeout = () => {
      finish({ success: false, error: 'Timeout. The model may be too large.' });
    };

    xhr.onabort = () => {
      finish({ success: false, error: 'Aborted' });
    };

    xhr.send(body);
  });
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
      reasoning: `${routing.tool} not installed. Suggesting setup.`,
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
          reasoning: `Local LLM error (${result.error}), falling back to Claude Code`,
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
  externalSignal?: AbortSignal,
  forceLocal?: boolean,
): Promise<OrchestrationResult> {
  // @localで明示指定された場合はルーティングをスキップ
  if (forceLocal) {
    const systemContent = buildSystemPrompt({ toolStatuses, projectContext, userProfileSummary, customContext });
    const messages: OllamaMessage[] = [
      { role: 'system', content: systemContent },
      ...conversationHistory,
      { role: 'user', content: userInput },
    ];
    // ストリーミング（RN: XHR, Web: ReadableStream）
    const result = await ollamaChatStream(config, messages, onChunk, 120000, externalSignal);
    if (result.success) {
      return { category: 'chat', handledBy: 'local_llm', response: '', reasoning: 'Direct @local mention' };
    }
    // ストリーミング失敗時は非ストリーミングにフォールバック
    const fallback = await ollamaChat(config, messages, 60000, externalSignal);
    if (fallback.success && fallback.content) {
      onChunk(fallback.content, true);
      return { category: 'chat', handledBy: 'local_llm', response: fallback.content, reasoning: 'Direct @local mention' };
    }
    onChunk('Could not connect to local LLM. Make sure llama-server is running.', true);
    return { category: 'chat', handledBy: 'local_llm', response: '', reasoning: 'Connection failed' };
  }

  // LLMベースのインテントルーティング
  const routing = await routeIntent(userInput, config, toolStatuses ?? [], defaultAgent);

  // セットアップが必要 → 通常フローに委譲（セットアップ案内を返す）
  if (routing.setupRequired) {
    return orchestrateTask(userInput, config, conversationHistory, projectContext, userProfileSummary, customContext, toolStatuses, defaultAgent);
  }

  // local-llm以外にルーティングされても、chatストリームとして呼ばれた場合は
  // まずローカルLLMで応答を試みる（応答テキストが表示されない問題を防止）。
  // delegatedCommandが必要な場合はフォールバックで処理する。
  if (routing.tool !== 'local-llm') {
    // ただしtermux/file_ops判定の場合はそのまま委譲
    if (routing.tool === 'termux') {
      return orchestrateTask(userInput, config, conversationHistory, projectContext, userProfileSummary, customContext, toolStatuses, defaultAgent);
    }
    // code/research系: delegatedCommandを返しつつ、AiBlockにもルーティング情報を載せる
    const result = await orchestrateTask(userInput, config, conversationHistory, projectContext, userProfileSummary, customContext, toolStatuses, defaultAgent);
    // orchestrateTaskがlocal_llmで応答を返した場合はonChunk経由で渡す
    if (result.handledBy === 'local_llm' && result.response) {
      onChunk(result.response, true);
      return result;
    }
    return result;
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

  // ストリーミング（RN: XHR, Web: ReadableStream）
  const streamResult = await ollamaChatStream(config, messages, onChunk, 120000, externalSignal);
  if (streamResult.success) {
    return {
      category: 'chat',
      handledBy: 'local_llm',
      reasoning: `Local LLM (${config.model}) streaming response`,
    };
  }

  // ストリーミング失敗時は非ストリーミングにフォールバック
  const fallback = await ollamaChat(config, messages, 60000, externalSignal);
  if (fallback.success && fallback.content) {
    onChunk(fallback.content, true);
    return {
      category: 'chat',
      handledBy: 'local_llm',
      reasoning: `Local LLM (${config.model}) response`,
    };
  }

  return {
    category: 'chat',
    handledBy: 'claude',
    delegatedCommand: buildClaudeCommand(userInput),
    reasoning: `Local LLM error (${fallback.error}), falling back to Claude Code`,
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
    chat: 'Chat',
    code: 'Code Generation',
    research: 'Research',
    file_ops: 'File Operations',
    unknown: 'Unknown',
  };
  return labels[category];
}

/**
 * 委譲先のラベル
 */
export function getHandlerLabel(handler: OrchestrationResult['handledBy']): string {
  const labels: Record<OrchestrationResult['handledBy'], string> = {
    local_llm: 'Local LLM',
    claude: 'Claude Code',
    gemini: 'Gemini CLI',
    codex: 'Codex CLI',
    termux: 'Termux',
  };
  return labels[handler];
}
