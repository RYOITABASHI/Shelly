/**
 * Google Gemini API クライアント
 *
 * - モデル: gemini-2.0-flash（高速・マルチモーダル対応）
 * - ストリーミング: Server-Sent Events (generateContentStream)
 * - API仕様: https://ai.google.dev/api/generate-content
 */

import { getCurrentLocale } from '@/lib/i18n';

export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** デフォルトモデル（高速・コスト効率が良い） */
export const GEMINI_DEFAULT_MODEL = 'gemini-2.0-flash';

/** Maximum SSE chunk size (1MB) — reject abnormally large chunks */
const MAX_CHUNK_SIZE = 1_000_000;

/** Sanitize URL to remove API key from log output */
function sanitizeUrl(url: string): string {
  return url.replace(/([?&])key=[^&]+/g, '$1key=***');
}

/** Shared SSE stream reader for Gemini responses */
async function readGeminiSSE(
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

      if (jsonStr.length > MAX_CHUNK_SIZE) continue;

      try {
        const chunk = JSON.parse(jsonStr) as GeminiStreamChunk;
        const candidate = chunk.candidates?.[0];
        const text = candidate?.content?.parts?.[0]?.text ?? '';
        const isDone =
          candidate?.finishReason === 'STOP' ||
          candidate?.finishReason === 'MAX_TOKENS';

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

  // Ensure done=true is sent if stream ended without explicit finish
  if (!finished && fullContent) {
    onChunk('', true);
  }

  return { fullContent };
}

/** Shared error handler for Gemini fetch responses */
function formatGeminiError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const sanitized = message.includes('key=') ? sanitizeUrl(message) : message;
  const isTimeout = sanitized.includes('abort') || sanitized.includes('timeout');
  return isTimeout ? 'タイムアウト。ネットワーク接続を確認してください。' : sanitized;
}

/** Shared HTTP error handler for Gemini API responses */
async function handleGeminiHttpError(res: Response): Promise<GeminiResult> {
  const errText = await res.text().catch(() => '');
  if (res.status === 400) {
    return { success: false, error: 'リクエストが無効です。APIキーまたはモデル名を確認してください。' };
  }
  if (res.status === 403) {
    return { success: false, error: 'APIキーが無効またはアクセス権限がありません。' };
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

/** 高精度モデル（複雑な推論・長文向き） */
export const GEMINI_PRO_MODEL = 'gemini-2.0-flash-thinking-exp';

export interface GeminiMessage {
  role: 'user' | 'model';
  parts: { text: string }[];
}

export interface GeminiStreamChunk {
  candidates?: {
    content?: {
      parts?: { text?: string }[];
      role?: string;
    };
    finishReason?: string;
    index?: number;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

export interface GeminiResult {
  success: boolean;
  content?: string;
  error?: string;
}

/**
 * Gemini API にストリーミングリクエストを送信する。
 *
 * @param apiKey  Google AI Studio API キー
 * @param prompt  ユーザーのプロンプト
 * @param onChunk チャンクごとのコールバック (text, done)
 * @param model   使用モデル（デフォルト: gemini-2.0-flash）
 * @param history 会話履歴（直近3往復まで）
 */
export async function geminiChatStream(
  apiKey: string,
  prompt: string,
  onChunk: (text: string, done: boolean) => void,
  model: string = GEMINI_DEFAULT_MODEL,
  history: GeminiMessage[] = [],
  externalSignal?: AbortSignal,
  systemPromptOverride?: string,
): Promise<GeminiResult> {
  if (!apiKey || apiKey.trim() === '') {
    return {
      success: false,
      error: 'Gemini APIキーが設定されていません。設定画面で入力してください。',
    };
  }

  // システム指示（オーバーライド優先 → デフォルトはローカル言語）
  const systemText = systemPromptOverride && systemPromptOverride.length > 0
    ? systemPromptOverride
    : (getCurrentLocale() === 'ja'
      ? 'あなたは優秀なAIアシスタントです。日本語で簡潔に回答してください。'
      : 'You are a helpful AI assistant. Reply concisely in English.');
  const systemInstruction = {
    parts: [{ text: systemText }],
  };

  // 会話履歴 + 現在のメッセージ
  const contents: GeminiMessage[] = [
    ...history.slice(-6), // 直近3往復（6メッセージ）のみ
    { role: 'user', parts: [{ text: prompt }] },
  ];

  const url =
    `${GEMINI_API_BASE}/models/${model}:streamGenerateContent?alt=sse`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    if (externalSignal) {
      if (externalSignal.aborted) { clearTimeout(timer); controller.abort(); }
      else { externalSignal.addEventListener('abort', () => { clearTimeout(timer); controller.abort(); }, { once: true }); }
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        system_instruction: systemInstruction,
        contents,
        generationConfig: {
          maxOutputTokens: 2048,
          temperature: 0.7,
          topP: 0.95,
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      return handleGeminiHttpError(res);
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
          const part = chunk.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
          if (part) fullContent += part;
        } catch {}
      }
      if (!fullContent) {
        try { fullContent = JSON.parse(text).candidates?.[0]?.content?.parts?.[0]?.text ?? ''; } catch {}
      }
      if (fullContent) { onChunk(fullContent, true); return { success: true, content: fullContent }; }
      return { success: false, error: 'レスポンスの解析に失敗しました' };
    }

    const { fullContent } = await readGeminiSSE(reader, onChunk);
    return { success: true, content: fullContent };
  } catch (err) {
    return { success: false, error: formatGeminiError(err) };
  }
}

/**
 * Gemini API にマルチモーダル（テキスト+画像）ストリーミングリクエストを送信する。
 *
 * @param apiKey  Google AI Studio API キー
 * @param prompt  ユーザーのプロンプト
 * @param images  base64画像データの配列（{base64, mimeType}）
 * @param onChunk チャンクごとのコールバック (text, done)
 * @param model   使用モデル（デフォルト: gemini-2.0-flash）
 */
export async function geminiMultimodalStream(
  apiKey: string,
  prompt: string,
  images: Array<{ base64: string; mimeType: string }>,
  onChunk: (text: string, done: boolean) => void,
  model: string = GEMINI_DEFAULT_MODEL,
  externalSignal?: AbortSignal,
): Promise<GeminiResult> {
  if (!apiKey || apiKey.trim() === '') {
    return {
      success: false,
      error: 'Gemini APIキーが設定されていません。設定画面で入力してください。',
    };
  }

  const systemInstruction = {
    parts: [
      {
        text: getCurrentLocale() === 'ja'
          ? 'あなたは優秀なAIアシスタントです。日本語で簡潔に回答してください。画像がある場合は内容を分析してください。'
          : 'You are a helpful AI assistant. Reply concisely in English. If images are attached, analyze their contents.',
      },
    ],
  };

  // Build multimodal parts: images + text
  const parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> = [];
  for (const img of images) {
    parts.push({
      inline_data: {
        mime_type: img.mimeType,
        data: img.base64,
      },
    });
  }
  parts.push({ text: prompt || '画像の内容を説明してください。' });

  const contents = [{ role: 'user' as const, parts }];

  const url =
    `${GEMINI_API_BASE}/models/${model}:streamGenerateContent?alt=sse`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    if (externalSignal) {
      if (externalSignal.aborted) { clearTimeout(timer); controller.abort(); }
      else { externalSignal.addEventListener('abort', () => { clearTimeout(timer); controller.abort(); }, { once: true }); }
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        system_instruction: systemInstruction,
        contents,
        generationConfig: {
          maxOutputTokens: 2048,
          temperature: 0.7,
          topP: 0.95,
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      return handleGeminiHttpError(res);
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
          const part = chunk.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
          if (part) fullContent += part;
        } catch {}
      }
      if (!fullContent) {
        try { fullContent = JSON.parse(text).candidates?.[0]?.content?.parts?.[0]?.text ?? ''; } catch {}
      }
      if (fullContent) { onChunk(fullContent, true); return { success: true, content: fullContent }; }
      return { success: false, error: 'レスポンスの解析に失敗しました' };
    }

    const { fullContent } = await readGeminiSSE(reader, onChunk);
    return { success: true, content: fullContent };
  } catch (err) {
    return { success: false, error: formatGeminiError(err) };
  }
}

/**
 * Gemini APIキーの有効性を確認する（軽量な非ストリーミングリクエスト）
 */
export async function validateGeminiApiKey(
  apiKey: string,
): Promise<{ valid: boolean; error?: string }> {
  if (!apiKey || apiKey.trim() === '') {
    return { valid: false, error: 'APIキーが空です' };
  }

  try {
    const url =
      `${GEMINI_API_BASE}/models/${GEMINI_DEFAULT_MODEL}:generateContent`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: { maxOutputTokens: 5 },
      }),
    });

    if (res.status === 403) return { valid: false, error: 'APIキーが無効です' };
    if (res.status === 429) return { valid: true }; // レート制限 = キーは有効
    if (res.ok) return { valid: true };

    return { valid: false, error: `HTTP ${res.status}` };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}
