/**
 * llm-interpreter.ts
 *
 * シェルコマンド出力をLLMで自然言語に通訳するモジュール。
 *
 * フォールバック順:
 *   1. Cerebras API（高速推論）
 *   2. Groq API（高速推論）
 *   3. Gemini CLI（`gemini -p`、Google OAuth認証済み）
 *   4. ローカルLLM（Ollama / llama-server）
 *
 * 機能:
 * 1. コマンド完了後の出力をLLMで解説（成功/エラー）
 * 2. エラー時は原因と修正コマンドを提案
 * 3. ストリーミング表示対応
 * 4. 5秒デバウンスバッチ翻訳
 */

import type { OutputLine } from '@/store/types';

export type InterpretType = 'success' | 'error' | 'progress';

export type InterpretResult = {
  type: InterpretType;
  text: string;
  suggestedCommand?: string;
  /** どのプロバイダで通訳したか */
  provider?: 'cerebras' | 'groq' | 'gemini-cli' | 'local';
};

export type StreamingCallback = (chunk: string) => void;

/** Local LLM設定 */
export type LlmConfig = {
  baseUrl: string;   // e.g. "http://127.0.0.1:8080"
  model: string;     // e.g. "gemma-3-4b-it-Q4_K_M"
  enabled: boolean;
};

/** フォールバックチェーン設定 */
export type FallbackConfig = {
  cerebrasApiKey?: string;
  cerebrasModel?: string;
  groqApiKey?: string;
  groqModel?: string;
  geminiCliAvailable?: boolean;
  /** Gemini CLIがターミナルで対話実行中かどうか（trueならスキップ） */
  geminiCliInUse?: boolean;
  localLlm: LlmConfig;
};

// ─── Debounce State ──────────────────────────────────────────────────────────

const DEBOUNCE_MS = 5000;
const MAX_BATCH_LINES = 50;

let _translateBuffer: string[] = [];
let _translateTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingResolve: ((batch: string) => void) | null = null;

/**
 * デバウンス付きでターミナル出力行を蓄積する。
 * 5秒間出力が止まった時点でバッチをresolveする。
 *
 * @returns バッチ化された出力テキスト（5秒後にresolve）
 */
export function pushTranslateLine(line: string): Promise<string> | null {
  _translateBuffer.push(line);

  // 既にPromiseが作られている場合は追加のみ（resolveは1回だけ）
  if (_translateTimer) {
    clearTimeout(_translateTimer);
  }

  // 最初の行で新しいPromiseを作る
  const isFirst = _translateBuffer.length === 1;

  const promise = isFirst
    ? new Promise<string>((resolve) => { _pendingResolve = resolve; })
    : null;

  _translateTimer = setTimeout(() => {
    const batch = _translateBuffer.slice(-MAX_BATCH_LINES).join('\n');
    _translateBuffer = [];
    _translateTimer = null;
    _pendingResolve?.(batch);
    _pendingResolve = null;
  }, DEBOUNCE_MS);

  return promise;
}

/** デバウンスタイマーをリセットする（テスト用） */
export function resetTranslateBuffer(): void {
  if (_translateTimer) clearTimeout(_translateTimer);
  _translateBuffer = [];
  _translateTimer = null;
  _pendingResolve = null;
}

// ─── Fallback Chain ──────────────────────────────────────────────────────────

/**
 * フォールバックチェーンでLLM通訳を実行する。
 * Cerebras → Groq → Gemini CLI → ローカルLLM の順に試行。
 */
async function interpretWithFallback(
  systemPrompt: string,
  userContent: string,
  fallback: FallbackConfig,
  onChunk: StreamingCallback,
): Promise<{ text: string; provider: InterpretResult['provider'] }> {
  // 1. Cerebras API
  if (fallback.cerebrasApiKey) {
    try {
      const text = await callOpenAICompatible(
        'https://api.cerebras.ai/v1/chat/completions',
        fallback.cerebrasApiKey,
        fallback.cerebrasModel ?? 'qwen-3-235b-a22b-instruct-2507',
        systemPrompt,
        userContent,
        onChunk,
      );
      if (text) return { text, provider: 'cerebras' };
    } catch { /* fallthrough */ }
  }

  // 2. Groq API
  if (fallback.groqApiKey) {
    try {
      const text = await callOpenAICompatible(
        'https://api.groq.com/openai/v1/chat/completions',
        fallback.groqApiKey,
        fallback.groqModel ?? 'llama-3.3-70b-versatile',
        systemPrompt,
        userContent,
        onChunk,
      );
      if (text) return { text, provider: 'groq' };
    } catch { /* fallthrough */ }
  }

  // 3. Gemini CLI（`gemini -p`）
  if (fallback.geminiCliAvailable && !fallback.geminiCliInUse) {
    try {
      const text = await callGeminiCli(systemPrompt, userContent, onChunk);
      if (text) return { text, provider: 'gemini-cli' };
    } catch { /* fallthrough */ }
  }

  // 4. ローカルLLM
  if (fallback.localLlm.enabled && fallback.localLlm.baseUrl) {
    try {
      const text = await callOpenAICompatible(
        `${fallback.localLlm.baseUrl.replace(/\/$/, '')}/v1/chat/completions`,
        undefined,
        fallback.localLlm.model,
        systemPrompt,
        userContent,
        onChunk,
      );
      if (text) return { text, provider: 'local' };
    } catch { /* fallthrough */ }
  }

  return { text: '', provider: undefined };
}

/** OpenAI互換APIにストリーミングリクエストを送信 */
async function callOpenAICompatible(
  apiUrl: string,
  apiKey: string | undefined,
  model: string,
  systemPrompt: string,
  userContent: string,
  onChunk: StreamingCallback,
): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        max_tokens: 256,
        temperature: 0.3,
        stream: true,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);
    if (!response.ok) return '';

    const reader = response.body?.getReader();
    if (!reader) return '';

    return await readSSEStream(reader, onChunk);
  } catch {
    clearTimeout(timer);
    return '';
  }
}

/** Gemini CLI（`gemini -p`）で通訳 */
async function callGeminiCli(
  systemPrompt: string,
  userContent: string,
  onChunk: StreamingCallback,
): Promise<string> {
  // React Native環境ではchild_processが使えないため、
  // execCommand(JNI)経由でgeminiコマンドを実行する必要がある。
  // llm-interpreterはpure関数なので呼び出し側からrunner相当を渡す設計。
  // 現時点ではスキップしてフォールバック。
  return '';
}

/** SSEストリームを読み取ってテキストを返す */
async function readSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onChunk: StreamingCallback,
): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return fullText;

      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content ?? '';
        if (delta) {
          fullText += delta;
          onChunk(delta);
        }
      } catch {
        // JSON parse error — skip
      }
    }
  }

  return fullText;
}

// ─── Main Functions ──────────────────────────────────────────────────────────

/**
 * シェルコマンドの出力をLLMで通訳する（フォールバックチェーン対応）。
 * ストリーミングでコールバックに逐次チャンクを渡す。
 *
 * @param command   実行されたコマンド
 * @param output    OutputLine配列
 * @param exitCode  終了コード（null = まだ実行中）
 * @param config    Local LLM設定（後方互換）
 * @param onChunk   ストリーミングコールバック
 * @param options   追加オプション
 * @returns         通訳結果（完了後）
 */
export async function interpretShellOutput(
  command: string,
  output: OutputLine[],
  exitCode: number | null,
  config: LlmConfig,
  onChunk: StreamingCallback,
  options?: {
    verbosity?: 'verbose' | 'minimal';
    projectContext?: string;
    fallback?: FallbackConfig;
  },
): Promise<InterpretResult> {
  // fallbackが渡されなければ従来通りLocal LLMのみ
  const fallbackConfig: FallbackConfig = options?.fallback ?? { localLlm: config };

  const anyEnabled = fallbackConfig.cerebrasApiKey
    || fallbackConfig.groqApiKey
    || fallbackConfig.geminiCliAvailable
    || (fallbackConfig.localLlm.enabled && fallbackConfig.localLlm.baseUrl);

  if (!anyEnabled) {
    return { type: 'progress', text: '' };
  }

  const isError = exitCode !== null && exitCode !== 0;
  const verbosity = options?.verbosity ?? 'verbose';

  // 高速モード: 成功時はスキップ（エラー時のみ通訳）
  if (verbosity === 'minimal' && !isError) {
    return { type: 'success', text: '' };
  }

  const stdout = output
    .filter((l) => l.type === 'stdout' || l.type === 'info')
    .map((l) => l.text)
    .join('\n')
    .slice(-2000); // 最大2000文字
  const stderr = output
    .filter((l) => l.type === 'stderr')
    .map((l) => l.text)
    .join('\n')
    .slice(-1000);

  const { getCurrentLocale } = await import('@/lib/i18n');
  const isJa = getCurrentLocale() === 'ja';

  const verboseError = isJa
    ? `あなたはターミナルのエラー解説AIです。
コマンドのエラー出力を見て、以下を日本語で答えてください：
1. エラーの背景と原因（2〜3文で詳しく）
2. 修正方法（具体的なコマンドがあれば必ず提示）
3. 再発防止のヒント
回答は5〜8文。修正コマンドは「修正: コマンド」の形式で末尾に書く。`
    : `You are a terminal error explainer AI.
Analyze the error output and answer:
1. Background and cause of the error (2-3 sentences)
2. How to fix it (include specific commands if possible)
3. Tips to prevent recurrence
Reply in 5-8 sentences. Put fix commands at the end as "Fix: command".`;

  const minimalError = isJa
    ? `あなたはターミナルのエラー解説AIです。
コマンドのエラー出力を見て、以下を日本語で簡潔に答えてください：
1. エラーの原因（1〜2文）
2. 修正方法（具体的なコマンドがあれば必ず提示）
回答は3〜5文以内。修正コマンドは「修正: コマンド」の形式で末尾に書く。`
    : `You are a terminal error explainer AI.
Analyze the error output and answer concisely:
1. Cause of the error (1-2 sentences)
2. How to fix it (include specific commands)
Reply in 3-5 sentences. Put fix commands at the end as "Fix: command".`;

  const verboseSuccess = isJa
    ? `あなたはターミナルの通訳AIです。
コマンドの実行結果を見て、何が起きたかを日本語で3〜5文で丁寧に説明してください。
初心者にも分かるよう、結果の意味や次にできることも触れてください。`
    : `You are a terminal output interpreter AI.
Explain what happened in 3-5 sentences.
Use beginner-friendly language and mention what the user can do next.`;

  const minimalSuccess = isJa
    ? `あなたはターミナルの通訳AIです。
コマンドの実行結果を見て、何が起きたかを日本語で1〜3文で簡潔に説明してください。
専門用語は避け、ユーザーが理解しやすい言葉で。`
    : `You are a terminal output interpreter AI.
Explain what happened in 1-3 concise sentences.
Avoid jargon, use simple language.`;

  let systemPrompt = isError
    ? (verbosity === 'verbose' ? verboseError : minimalError)
    : (verbosity === 'verbose' ? verboseSuccess : minimalSuccess);

  const projectContext = options?.projectContext;
  if (projectContext) {
    systemPrompt += `\n\n--- プロジェクトコンテキスト ---\n${projectContext}\n--- ここまで ---\n\nこのプロジェクト固有の情報を踏まえて回答してください。`;
  }

  const userContent = isError
    ? `コマンド: ${command}\n終了コード: ${exitCode}\n\nstdout:\n${stdout || '(なし)'}\n\nstderr:\n${stderr || '(なし)'}`
    : `コマンド: ${command}\n\n出力:\n${stdout || '(出力なし)'}`;

  const { text: fullText, provider } = await interpretWithFallback(
    systemPrompt,
    userContent,
    fallbackConfig,
    onChunk,
  );

  // 修正コマンドを抽出（「修正: コマンド」形式）
  let suggestedCommand: string | undefined;
  const fixMatch = fullText.match(/修正[:：]\s*(.+)/);
  if (fixMatch) {
    suggestedCommand = fixMatch[1].trim();
  }

  return {
    type: isError ? 'error' : 'success',
    text: fullText,
    suggestedCommand,
    provider,
  };
}

/**
 * コマンド実行前に意図を説明する。
 * ストリーミングでコールバックに逐次チャンクを渡す。
 *
 * @param command  実行予定のコマンド
 * @param config   Local LLM設定
 * @param onChunk  ストリーミングコールバック
 * @returns        説明テキスト（完了後）。LLM無効時は空文字。
 */
export async function explainCommandIntent(
  command: string,
  config: LlmConfig,
  onChunk?: StreamingCallback,
): Promise<string> {
  if (!config.enabled || !config.baseUrl) {
    return '';
  }

  const systemPrompt = `あなたはターミナルコマンド解説AIです。
ユーザーが実行しようとしているコマンドが何をするか、1文で日本語で説明してください。
危険性がある場合は、短い警告も含めてください。
回答は1〜2文以内。`;

  const apiUrl = `${config.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
  let fullText = '';

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `コマンド: ${command}` },
        ],
        max_tokens: 128,
        temperature: 0.2,
        stream: true,
      }),
    });

    if (!response.ok) return '';

    const reader = response.body?.getReader();
    if (!reader) return '';

    fullText = await readSSEStream(reader, onChunk ?? (() => {}));
    return fullText;
  } catch {
    return '';
  }
}
