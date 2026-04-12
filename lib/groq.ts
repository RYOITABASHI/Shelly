/**
 * Groq API クライアント
 *
 * - チャット: Llama 3.3 70B (OpenAI互換 API)
 * - 音声文字起こし: Whisper Large v3 Turbo
 * - API仕様: https://console.groq.com/docs
 */

export const GROQ_API_BASE = 'https://api.groq.com/openai/v1';

/** デフォルトチャットモデル */
export const GROQ_DEFAULT_MODEL = 'llama-3.3-70b-versatile';

/** Whisperモデル（音声文字起こし） */
export const GROQ_WHISPER_MODEL = 'whisper-large-v3-turbo';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GroqMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GroqResult {
  success: boolean;
  content?: string;
  error?: string;
  /** True when failure was due to network (offline/timeout) — caller can fallback to local LLM */
  networkError?: boolean;
}

interface GroqStreamDelta {
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

function formatGroqError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return isNetworkError(err) ? 'オフラインです。ネットワーク接続を確認してください。' : message;
}

async function handleGroqHttpError(res: Response): Promise<GroqResult> {
  const errText = await res.text().catch(() => '');
  if (res.status === 401) {
    return { success: false, error: 'Groq APIキーが無効です。設定画面で確認してください。' };
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
 * Groq API にストリーミングチャットリクエストを送信する。
 *
 * @param apiKey  Groq API キー
 * @param prompt  ユーザーのプロンプト
 * @param onChunk チャンクごとのコールバック (text, done)
 * @param model   使用モデル（デフォルト: llama-3.3-70b-versatile）
 * @param history 会話履歴
 */
export async function groqChatStream(
  apiKey: string,
  prompt: string,
  onChunk: (text: string, done: boolean) => void,
  model: string = GROQ_DEFAULT_MODEL,
  history: GroqMessage[] = [],
  externalSignal?: AbortSignal,
  systemPromptOverride?: string,
): Promise<GroqResult> {
  if (!apiKey || apiKey.trim() === '') {
    return {
      success: false,
      error: 'Groq APIキーが設定されていません。設定画面で入力してください。',
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

  const messages: GroqMessage[] = [
    {
      role: 'system',
      content: systemContent,
    },
    ...history.slice(-6),
    { role: 'user', content: prompt },
  ];

  const url = `${GROQ_API_BASE}/chat/completions`;

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
        max_tokens: 2048,
        temperature: 0.7,
        top_p: 0.95,
        stream: true,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      return handleGroqHttpError(res);
    }

    const reader = res.body?.getReader();
    if (!reader) {
      // Fallback: ReadableStream not available (React Native)
      const text = await res.text();
      let fullContent = '';
      for (const line of text.split('\n')) {
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
      try {
        const json = JSON.parse(text);
        const content = json.choices?.[0]?.message?.content ?? '';
        if (content) { onChunk(content, true); return { success: true, content }; }
      } catch {}
      return { success: false, error: 'レスポンスの解析に失敗しました' };
    }

    const { fullContent } = await readGroqSSE(reader, onChunk);
    return { success: true, content: fullContent };
  } catch (err) {
    return { success: false, error: formatGroqError(err), networkError: isNetworkError(err) };
  }
}

// ─── SSE Reader ──────────────────────────────────────────────────────────────

async function readGroqSSE(
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
        const chunk = JSON.parse(jsonStr) as GroqStreamDelta;
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

// ─── Whisper (Audio Transcription) ───────────────────────────────────────────

/**
 * Groq Whisper API で音声を文字起こしする。
 *
 * @param apiKey    Groq API キー
 * @param audioUri  録音ファイルのURI (file://)
 * @param language  言語コード (default: 'ja')
 */
export async function groqTranscribe(
  apiKey: string,
  audioUri: string,
  language: string = 'ja',
): Promise<GroqResult> {
  if (!apiKey || apiKey.trim() === '') {
    return {
      success: false,
      error: 'Groq APIキーが設定されていません。設定画面で入力してください。',
    };
  }

  try {
    // React Native: use { uri, type, name } object instead of Blob
    // (Blob constructor with ArrayBuffer is not supported in RN)
    const formData = new FormData();
    formData.append('file', {
      uri: audioUri,
      type: 'audio/m4a',
      name: 'audio.m4a',
    } as any);
    formData.append('model', GROQ_WHISPER_MODEL);
    formData.append('language', language);
    formData.append('response_format', 'text');

    const url = `${GROQ_API_BASE}/audio/transcriptions`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!res.ok) {
      return handleGroqHttpError(res);
    }

    const text = await res.text();
    return { success: true, content: text.trim() };
  } catch (err) {
    return { success: false, error: formatGroqError(err), networkError: isNetworkError(err) };
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Groq APIキーの有効性を確認する（軽量リクエスト）
 */
export async function validateGroqApiKey(
  apiKey: string,
): Promise<{ valid: boolean; error?: string }> {
  if (!apiKey || apiKey.trim() === '') {
    return { valid: false, error: 'APIキーが空です' };
  }

  try {
    const res = await fetch(`${GROQ_API_BASE}/models`, {
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
