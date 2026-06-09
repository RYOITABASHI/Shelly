/**
 * lib/local-llm.ts — v2.4.2
 *
 * Local LLM (Ollama) APIクライアントとAI Orchestrationロジック。
 *
 * 設計方針:
 * - Ollama互換API（http://127.0.0.1:11434）に直接HTTPリクエスト
 * - タスク分類: 「基本チャット」はLocal LLMで処理、「コード生成」はCodexに委譲
 * - Local LLM無効時はCodexに送信
 * - ストリーミングレスポンス対応（Ollama /api/chat）
 */

import { buildSystemPrompt } from './shelly-system-prompt';
import type { ToolStatus } from './shelly-system-prompt';
import { routeIntent, formatRoutingMessage, type RoutingDecision } from './intent-router';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TaskCategory =
  | 'chat'          // 基本的な質問・会話 → Local LLM
  | 'code'          // コード生成・修正 → Codex
  | 'research'      // 調査・情報収集 → Codex / Local LLM
  | 'file_ops'      // ファイル操作 → シェル直接実行
  | 'unknown';      // 判定不能 → Codex / Local LLM

export interface OllamaMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream?: boolean;
  think?: boolean;
  options?: {
    temperature?: number;
    num_ctx?: number;
    num_predict?: number;
  };
}

const DEFAULT_LOCAL_MAX_TOKENS = 384;
const DEFAULT_LOCAL_CONTEXT_TOKENS = 1024;
const XHR_PROGRESS_FLUSH_MS = 50;

export interface OllamaChatResponse {
  model: string;
  message: OllamaMessage;
  done: boolean;
  total_duration?: number;
  eval_count?: number;
}

export interface OllamaStreamChunk {
  model: string;
  message?: { role?: string; content?: string; thinking?: string };
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
  chat_template_kwargs?: {
    enable_thinking?: boolean;
  };
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
    delta: { role?: string; content?: string | null; reasoning_content?: string | null };
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

function shouldDisableThinking(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  if (!normalized || normalized === 'default' || normalized === 'local') return true;
  return /qwen[\s._-]*3/i.test(normalized);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withOpenAIChatTemplateOptions(req: OpenAIChatRequest): OpenAIChatRequest {
  if (!shouldDisableThinking(req.model)) return req;
  return {
    ...req,
    chat_template_kwargs: {
      ...req.chat_template_kwargs,
      enable_thinking: false,
    },
  };
}

function withOllamaThinkingOptions(req: OllamaChatRequest): OllamaChatRequest {
  if (!shouldDisableThinking(req.model)) return req;
  return {
    ...req,
    think: false,
  };
}

function safeEmitChunk(
  onChunk: (text: string, done: boolean) => void,
  text: string,
  done: boolean,
): void {
  try {
    onChunk(text, done);
  } catch {
    // Keep provider stream parsing from taking down the app UI.
  }
}

export interface OrchestrationResult {
  category: TaskCategory;
  handledBy: 'local_llm' | 'codex';
  response?: string;         // Local LLMが直接回答した場合
  delegatedCommand?: string; // Codexに委譲する場合のコマンド
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

  // CLI実行キーワード（Codexを含む → code扱い）
  const cliExecKeywords = [
    'codex', 'コデックス',
    '実行して', '起動して', '使って', '動かして', '走らせて', '立ち上げて',
    'run ', 'start ', 'launch ', 'execute ',
  ];
  const hasCliName = ['codex', 'コデックス'].some((k) => input.includes(k));
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
export async function checkOllamaConnection(baseUrl: string, timeoutMs = 5000): Promise<{
  available: boolean;
  models: string[];
  error?: string;
}> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
  maxTokens = DEFAULT_LOCAL_MAX_TOKENS,
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
      const req = withOpenAIChatTemplateOptions({
        model: config.model,
        messages,
        stream: false,
        temperature: 0.4,
        max_tokens: maxTokens,
      });
      body = JSON.stringify(req);
    } else {
      // Ollama: /api/chat
      url = `${config.baseUrl}/api/chat`;
      const req = withOllamaThinkingOptions({
        model: config.model,
        messages,
        stream: false,
        options: {
          temperature: 0.4,
          num_ctx: DEFAULT_LOCAL_CONTEXT_TOKENS,
          num_predict: maxTokens,
        },
      });
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
  maxTokens = DEFAULT_LOCAL_MAX_TOKENS,
): Promise<{ success: boolean; content?: string; error?: string }> {
  const apiType = detectApiType(config.baseUrl);
  const isReactNative = typeof navigator !== 'undefined' && navigator.product === 'ReactNative';

  let url: string;
  let body: string;

  if (apiType === 'openai') {
    url = `${config.baseUrl}/v1/chat/completions`;
    const req = withOpenAIChatTemplateOptions({
      model: config.model,
      messages,
      stream: true,
      temperature: 0.4,
      max_tokens: maxTokens,
    });
    body = JSON.stringify(req);
  } else {
    url = `${config.baseUrl}/api/chat`;
    const req = withOllamaThinkingOptions({
      model: config.model,
      messages,
      stream: true,
      options: {
        temperature: 0.4,
        num_ctx: DEFAULT_LOCAL_CONTEXT_TOKENS,
        num_predict: maxTokens,
      },
    });
    body = JSON.stringify(req);
  }

  // React Native: XMLHttpRequest でストリーミング
  if (isReactNative) {
    return xhrStream(url, body, apiType, onChunk, timeoutMs, externalSignal, config.baseUrl, _retried, maxTokens);
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
        safeEmitChunk(onChunk, fullContent, true);
        return { success: true, content: fullContent };
      }
      return { success: false, error: 'ReadableStream not supported and fallback parse failed' };
    }

    const decoder = new TextDecoder();
    let buffer = '';
    const MAX_BUFFER_SIZE = 102400;
    let emittedChunks = 0;
    let emittedDone = false;
    const handleChunk = (text: string, done: boolean) => {
      if (text) emittedChunks += 1;
      if (done) emittedDone = true;
      safeEmitChunk(onChunk, text, done);
    };

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
          parseSSELine(line, apiType, handleChunk);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        parseSSELine(buffer, apiType, handleChunk);
      }
    } finally {
      clearTimeout(timer);
    }

    if (emittedChunks === 0) {
      return {
        success: false,
        error: 'Local LLM returned an empty response. The model may have crashed or returned an unexpected stream format.',
      };
    }
    if (!emittedDone) safeEmitChunk(onChunk, '', true);
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
        return ollamaChatStream(config, messages, onChunk, timeoutMs, externalSignal, true, maxTokens);
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
      const content = chunk.message?.content ?? '';
      const isDone = chunk.done === true;
      if (content) onChunk(content, isDone);
      else if (isDone) onChunk('', true);
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
  maxTokens = 1024,
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    let lastIndex = 0;
    let lineBuffer = '';
    let settled = false;
    let emittedChunks = 0;
    let progressTimer: ReturnType<typeof setTimeout> | null = null;
    let abortHandler: (() => void) | null = null;

    const handleChunk = (text: string, done: boolean) => {
      if (settled) return;
      if (text) emittedChunks += 1;
      safeEmitChunk(onChunk, text, done);
    };

    const finish = (result: { success: boolean; error?: string }) => {
      if (settled) return;
      if (progressTimer) {
        clearTimeout(progressTimer);
        progressTimer = null;
      }
      if (abortHandler && externalSignal) {
        externalSignal.removeEventListener('abort', abortHandler);
        abortHandler = null;
      }
      settled = true;
      resolve(result);
    };

    let xhr: XMLHttpRequest;
    try {
      xhr = new XMLHttpRequest();
    } catch (err) {
      finish({ success: false, error: errorMessage(err) });
      return;
    }

    const failFromException = (err: unknown) => {
      if (settled) return;
      finish({ success: false, error: errorMessage(err) });
      try {
        xhr.abort();
      } catch {}
    };

    try {
      xhr.open('POST', url);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.timeout = timeoutMs;
    } catch (err) {
      failFromException(err);
      return;
    }

    if (externalSignal) {
      if (externalSignal.aborted) { finish({ success: false, error: 'Aborted' }); return; }
      abortHandler = () => {
        if (settled) return;
        try {
          xhr.abort();
        } catch (err) {
          failFromException(err);
        }
      };
      externalSignal.addEventListener('abort', abortHandler, { once: true });
    }

    const processNewData = (flush = false) => {
      if (settled) return;
      const text = xhr.responseText;
      if (!text || text.length <= lastIndex) {
        if (flush && lineBuffer) {
          parseSSELine(lineBuffer, apiType, handleChunk);
          lineBuffer = '';
        }
        return;
      }

      const newData = text.slice(lastIndex);
      lastIndex = text.length;

      const lines = (lineBuffer + newData).split('\n');
      if (!flush) {
        lineBuffer = lines.pop() ?? '';
      } else {
        lineBuffer = '';
      }
      for (const line of lines) {
        parseSSELine(line, apiType, handleChunk);
      }
    };
    const processNewDataSafely = (flush = false): boolean => {
      try {
        processNewData(flush);
        return true;
      } catch (err) {
        failFromException(err);
        return false;
      }
    };

    // Throttle onprogress to prevent UI thread saturation
    xhr.onprogress = () => {
      if (settled) return;
      if (progressTimer) return; // Already scheduled
      progressTimer = setTimeout(() => {
        progressTimer = null;
        if (settled) return;
        processNewDataSafely();
      }, XHR_PROGRESS_FLUSH_MS);
    };

    xhr.onload = () => {
      if (settled) return;
      if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
      if (xhr.status < 200 || xhr.status >= 300) {
        if (xhr.status === 503 && !_retried && baseUrl && !(externalSignal?.aborted)) {
          waitForLocalLlmReady(baseUrl, Math.min(timeoutMs, 120000), externalSignal).then((ready) => {
            if (settled) return;
            if (ready) {
              xhrStream(url, body, apiType, onChunk, timeoutMs, externalSignal, baseUrl, true, maxTokens)
                .then(finish, failFromException);
            } else {
              finish({ success: false, error: 'HTTP 503: local LLM is still loading or failed to load the model' });
            }
          }, failFromException);
          return;
        }
        finish({ success: false, error: `HTTP ${xhr.status}` });
        return;
      }
      // Process any remaining data
      if (!processNewDataSafely(true)) return;
      if (emittedChunks === 0) {
        finish({
          success: false,
          error: 'Local LLM returned an empty response. The model may have crashed or returned an unexpected stream format.',
        });
        return;
      }
      handleChunk('', true);
      finish({ success: true });
    };

    xhr.onerror = () => {
      if (settled) return;
      // Connection-level error — retry once if server is still alive (and not already retried)
      if (!_retried && baseUrl && !(externalSignal?.aborted)) {
        checkOllamaConnection(baseUrl).then((check) => {
          if (settled) return;
          if (check.available) {
            xhrStream(url, body, apiType, onChunk, timeoutMs, externalSignal, baseUrl, true, maxTokens)
              .then(finish, failFromException);
          } else {
            finish({ success: false, error: 'XHR network error' });
          }
        }, failFromException);
      } else {
        finish({ success: false, error: 'XHR network error' });
      }
    };

    xhr.ontimeout = () => {
      if (settled) return;
      finish({ success: false, error: 'Timeout. The model may be too large.' });
    };

    xhr.onabort = () => {
      if (settled) return;
      finish({ success: false, error: 'Aborted' });
    };

    try {
      xhr.send(body);
    } catch (err) {
      failFromException(err);
    }
  });
}

async function waitForLocalLlmReady(
  baseUrl: string,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (externalSignal?.aborted) return false;
    const check = await checkOllamaConnection(baseUrl);
    if (check.available) return true;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

// ─── AI Orchestrator ──────────────────────────────────────────────────────────

/**
 * AI Orchestration: LLMベースでタスクを分類し、適切なAIに委譲する。
 *
 * フロー:
 * 1. LLMベースのインテントルーターでユーザー意図を解析
 * 2. 最適なツールを選択（Codex / ローカルLLM / Shell）
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
  defaultAgent?: 'codex',
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
          handledBy: 'codex',
          delegatedCommand: buildCodexCommand(userInput),
          reasoning: `Local LLM error (${result.error}), falling back to Codex`,
          routingDecision: routing,
        };
      }
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

    default: {
      return {
        category: 'unknown',
        handledBy: 'codex',
        delegatedCommand: buildCodexCommand(userInput),
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
  defaultAgent?: 'codex',
  externalSignal?: AbortSignal,
  forceLocal?: boolean,
): Promise<OrchestrationResult> {
  const emitChunk = (text: string, done: boolean) => {
    safeEmitChunk(onChunk, text, done);
  };

  // ローカルモデル（127.0.0.1/localhost）またはforceLocal指定の場合はルーティングをスキップ
  // → double-inference（ルーティング用LLM呼び出し + 実際の応答用LLM呼び出し）を防止
  const isLocalEndpoint = config.baseUrl?.includes('127.0.0.1') || config.baseUrl?.includes('localhost');
  if (forceLocal || isLocalEndpoint) {
    const systemContent = buildSystemPrompt({ toolStatuses, projectContext, userProfileSummary, customContext });
    const messages: OllamaMessage[] = [
      { role: 'system', content: systemContent },
      ...conversationHistory,
      { role: 'user', content: userInput },
    ];
    // ストリーミング（RN: XHR, Web: ReadableStream）
    const result = await ollamaChatStream(config, messages, emitChunk, 120000, externalSignal);
    if (result.success) {
      return { category: 'chat', handledBy: 'local_llm', response: '', reasoning: 'Local model — routing skipped' };
    }
    // ストリーミング失敗時は非ストリーミングにフォールバック
    const fallback = await ollamaChat(config, messages, 60000, externalSignal);
    if (fallback.success && fallback.content) {
      emitChunk(fallback.content, true);
      return { category: 'chat', handledBy: 'local_llm', response: fallback.content, reasoning: 'Local model — routing skipped' };
    }
    emitChunk('Could not connect to local LLM. Make sure llama-server is running.', true);
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
    // code/research系: delegatedCommandを返しつつ、AiBlockにもルーティング情報を載せる
    const result = await orchestrateTask(userInput, config, conversationHistory, projectContext, userProfileSummary, customContext, toolStatuses, defaultAgent);
    // orchestrateTaskがlocal_llmで応答を返した場合はonChunk経由で渡す
    if (result.handledBy === 'local_llm' && result.response) {
      emitChunk(result.response, true);
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
  const streamResult = await ollamaChatStream(config, messages, emitChunk, 120000, externalSignal);
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
    emitChunk(fallback.content, true);
    return {
      category: 'chat',
      handledBy: 'local_llm',
      reasoning: `Local LLM (${config.model}) response`,
    };
  }

  return {
    category: 'chat',
    handledBy: 'codex',
    delegatedCommand: buildCodexCommand(userInput),
    reasoning: `Local LLM error (${fallback.error}), falling back to Codex`,
  };
}

// ─── Command Builders ─────────────────────────────────────────────────────────

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
    codex: 'Codex CLI',
  };
  return labels[handler];
}
