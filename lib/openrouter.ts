/**
 * OpenRouter's OpenAI-compatible streaming chat client.
 *
 * This client is intentionally foreground-only. Background agent routing
 * classifies OpenRouter as an API-key backend and resolveForAutonomous()
 * therefore rejects it.
 *
 * 2026-08-25 (Fable5 review item #4): the original implementation buffered
 * the entire response body via `await response.text()` before parsing SSE
 * frames, so the AI Pane's onChunk callback only ever fired once the whole
 * reply had already arrived -- it never streamed incrementally like
 * groqChatStream / cerebrasChatStream do. Switched to a real
 * ReadableStreamDefaultReader loop (readOpenRouterSSE, same shape as
 * lib/groq.ts's readGroqSSE / lib/cerebras.ts's readSSE) so chunks are
 * decoded and forwarded as bytes arrive over the network.
 */
export const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';
export const OPENROUTER_DEFAULT_MODEL = 'openrouter/auto';

export interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenRouterResult {
  success: boolean;
  content?: string;
  error?: string;
  networkError?: boolean;
}

interface OpenRouterStreamDelta {
  choices?: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
}

function isNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /abort|timeout|Network request failed|Failed to fetch|ERR_INTERNET_DISCONNECTED/i.test(message);
}

function errorMessage(status: number, detail: string): string {
  if (status === 401) return 'OpenRouter API key is invalid. Check it in Settings.';
  if (status === 429) return 'OpenRouter rate limit reached. Try again later.';
  return `HTTP ${status}: ${detail.slice(0, 100)}`;
}

export async function openRouterChatStream(
  apiKey: string,
  prompt: string,
  onChunk: (text: string, done: boolean) => void,
  model: string = OPENROUTER_DEFAULT_MODEL,
  history: OpenRouterMessage[] = [],
  externalSignal?: AbortSignal,
  systemPrompt = 'You are a helpful AI assistant. Reply concisely.',
): Promise<OpenRouterResult> {
  if (!apiKey.trim()) {
    return { success: false, error: 'OpenRouter API key is not configured.' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  if (externalSignal) {
    if (externalSignal.aborted) { clearTimeout(timer); controller.abort(); }
    else { externalSignal.addEventListener('abort', () => { clearTimeout(timer); controller.abort(); }, { once: true }); }
  }

  try {
    const response = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://shelly.dev',
        'X-Title': 'Shelly',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...history.slice(-6),
          { role: 'user', content: prompt },
        ],
        stream: true,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let detail = text;
      try {
        detail = JSON.parse(text)?.error?.message ?? text;
      } catch {}
      return { success: false, error: errorMessage(response.status, detail) };
    }

    const reader = response.body?.getReader();
    if (!reader) {
      // Fallback: ReadableStream not available (React Native polyfill limitation).
      // Read the full response as text and parse SSE manually.
      const text = await response.text();
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
      return { success: false, error: 'OpenRouter response could not be parsed.' };
    }

    const { fullContent } = await readOpenRouterSSE(reader, onChunk);
    return fullContent
      ? { success: true, content: fullContent }
      : { success: false, error: 'OpenRouter response could not be parsed.' };
  } catch (error) {
    clearTimeout(timer);
    const networkError = isNetworkError(error);
    return {
      success: false,
      error: networkError ? 'Network connection failed.' : String((error as Error)?.message || error),
      networkError,
    };
  }
}

// ─── SSE Reader ──────────────────────────────────────────────────────────────

async function readOpenRouterSSE(
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
        const chunk = JSON.parse(jsonStr) as OpenRouterStreamDelta;
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
