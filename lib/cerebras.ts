/**
 * Cerebras API クライアント
 *
 * - チャット: Qwen3 235B (OpenAI互換 API)
 * - 無料枠: 30 RPM, 60K TPM, 1M tokens/日
 * - API仕様: https://inference-docs.cerebras.ai
 */

export const CEREBRAS_API_BASE = 'https://api.cerebras.ai/v1';

/** デフォルトチャットモデル */
export const CEREBRAS_DEFAULT_MODEL = 'qwen-3-235b-a22b-instruct-2507';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CerebrasMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CerebrasResult {
  success: boolean;
  content?: string;
  error?: string;
  /** True when failure was due to network — caller can fallback to local LLM */
  networkError?: boolean;
}

interface CerebrasStreamDelta {
  choices?: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
}

// ─── Error Handling ──────────────────────────────────────────────────────────

function isNetworkError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('abort') || message.includes('timeout') ||
    message.includes('Network request failed') || message.includes('Failed to fetch') ||
    message.includes('ERR_INTERNET_DISCONNECTED');
}

function formatError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return isNetworkError(err) ? 'オフラインです。ネットワーク接続を確認してください。' : message;
}

async function handleHttpError(res: Response): Promise<CerebrasResult> {
  const errText = await res.text().catch(() => '');
  if (res.status === 401) {
    return { success: false, error: 'Cerebras APIキーが無効です。設定画面で確認してください。' };
  }
  if (res.status === 429) {
    return { success: false, error: 'レート制限に達しました。しばらく待ってから再試行してください。' };
  }
  try {
    const errJson = JSON.parse(errText);
    const msg = errJson?.error?.message ?? errText.slice(0, 100);
    return { success: false, error: `HTTP ${res.status}: ${msg}` };
  } catch {
    return { success: false, error: `HTTP ${res.status}: ${errText.slice(0, 100)}` };
  }
}

// ─── Chat (Streaming) ────────────────────────────────────────────────────────

/**
 * Cerebras API にストリーミングチャットリクエストを送信する。
 *
 * @param apiKey  Cerebras API キー
 * @param prompt  ユーザーのプロンプト
 * @param onChunk チャンクごとのコールバック (text, done)
 * @param model   使用モデル（デフォルト: qwen-3-235b）
 * @param history 会話履歴
 */
export async function cerebrasChatStream(
  apiKey: string,
  prompt: string,
  onChunk: (text: string, done: boolean) => void,
  model: string = CEREBRAS_DEFAULT_MODEL,
  history: CerebrasMessage[] = [],
  externalSignal?: AbortSignal,
  systemPromptOverride?: string,
): Promise<CerebrasResult> {
  if (!apiKey || apiKey.trim() === '') {
    return {
      success: false,
      error: 'Cerebras APIキーが設定されていません。設定画面で入力してください。',
    };
  }

  let systemContent: string;
  if (systemPromptOverride && systemPromptOverride.length > 0) {
    systemContent = systemPromptOverride;
  } else {
    const { getCurrentLocale } = await import('@/lib/i18n');
    const locale = getCurrentLocale();
    systemContent = locale === 'ja'
      ? 'あなたは優秀なAIアシスタントです。日本語で簡潔に回答してください。'
      : 'You are a helpful AI assistant. Reply concisely in English.';
  }

  const messages: CerebrasMessage[] = [
    {
      role: 'system',
      content: systemContent,
    },
    ...history.slice(-6),
    { role: 'user', content: prompt },
  ];

  const url = `${CEREBRAS_API_BASE}/chat/completions`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    if (externalSignal) {
      if (externalSignal.aborted) { clearTimeout(timer); controller.abort(); }
      else { externalSignal.addEventListener('abort', () => { clearTimeout(timer); controller.abort(); }, { once: true }); }
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_completion_tokens: 2048,
        temperature: 0.7,
        top_p: 0.95,
        stream: true,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      return handleHttpError(res);
    }

    const reader = res.body?.getReader();
    if (!reader) {
      // Fallback: ReadableStream not available (React Native polyfill limitation)
      // Read the full response as text and parse SSE manually
      const text = await res.text();
      let fullContent = '';
      const lines = text.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (jsonStr === '[DONE]') break;
        try {
          const chunk = JSON.parse(jsonStr);
          const content = chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content ?? '';
          if (content) fullContent += content;
        } catch {}
      }
      if (fullContent) {
        onChunk(fullContent, true);
        return { success: true, content: fullContent };
      }
      // Try non-streaming parse (Cerebras may return standard completion format)
      try {
        const json = JSON.parse(text);
        const content = json.choices?.[0]?.message?.content ?? '';
        if (content) {
          onChunk(content, true);
          return { success: true, content };
        }
      } catch {}
      return { success: false, error: 'レスポンスの解析に失敗しました' };
    }

    const { fullContent } = await readSSE(reader, onChunk);
    return { success: true, content: fullContent };
  } catch (err) {
    return { success: false, error: formatError(err), networkError: isNetworkError(err) };
  }
}

// ─── SSE Reader ──────────────────────────────────────────────────────────────

async function readSSE(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onChunk: (text: string, done: boolean) => void,
): Promise<{ fullContent: string }> {
  const decoder = new TextDecoder();
  let buffer = '';
  let fullContent = '';
  let finished = false;

  while (!finished) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;

      const jsonStr = trimmed.slice(5).trim();
      if (jsonStr === '[DONE]') {
        if (!finished) { onChunk('', true); finished = true; }
        break;
      }

      try {
        const chunk = JSON.parse(jsonStr) as CerebrasStreamDelta;
        const choice = chunk.choices?.[0];
        const text = choice?.delta?.content ?? '';
        const isDone = choice?.finish_reason === 'stop' || choice?.finish_reason === 'length';

        if (text) {
          fullContent += text;
        }

        if (isDone) {
          onChunk(text || '', true);
          finished = true;
          break;
        } else if (text) {
          onChunk(text, false);
        }
      } catch {
        // JSON parse error, skip
      }
    }
  }

  if (!finished && fullContent) {
    onChunk('', true);
  }

  return { fullContent };
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Cerebras APIキーの有効性を確認する（軽量リクエスト）
 */
export async function validateCerebrasApiKey(
  apiKey: string,
): Promise<{ valid: boolean; error?: string }> {
  if (!apiKey || apiKey.trim() === '') {
    return { valid: false, error: 'APIキーが空です' };
  }

  try {
    const res = await fetch(`${CEREBRAS_API_BASE}/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (res.status === 401) return { valid: false, error: 'APIキーが無効です' };
    if (res.status === 429) return { valid: true }; // レート制限 = キーは有効
    if (res.ok) return { valid: true };

    return { valid: false, error: `HTTP ${res.status}` };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}
