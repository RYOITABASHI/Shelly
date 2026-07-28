/**
 * OpenRouter's OpenAI-compatible streaming chat client.
 *
 * This client is intentionally foreground-only. Background agent routing
 * classifies OpenRouter as an API-key backend and resolveForAutonomous()
 * therefore rejects it.
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
  const abort = () => controller.abort();
  externalSignal?.addEventListener('abort', abort, { once: true });

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

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let detail = text;
      try {
        detail = JSON.parse(text)?.error?.message ?? text;
      } catch {}
      return { success: false, error: errorMessage(response.status, detail) };
    }

    const raw = await response.text();
    let content = '';
    let completed = false;
    for (const line of raw.split('\n')) {
      const data = line.trim().replace(/^data:\s*/, '');
      if (!line.trim().startsWith('data:') || !data) continue;
      if (data === '[DONE]') {
        completed = true;
        onChunk('', true);
        break;
      }
      try {
        const chunk = JSON.parse(data);
        const delta = chunk.choices?.[0]?.delta?.content ?? '';
        if (delta) {
          content += delta;
          onChunk(delta, false);
        }
      } catch {}
    }
    if (!completed && content) onChunk('', true);
    return content
      ? { success: true, content }
      : { success: false, error: 'OpenRouter response could not be parsed.' };
  } catch (error) {
    const networkError = isNetworkError(error);
    return {
      success: false,
      error: networkError ? 'Network connection failed.' : String((error as Error)?.message || error),
      networkError,
    };
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abort);
  }
}
