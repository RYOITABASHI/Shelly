/**
 * Perplexity Sonar API クライアント
 *
 * 論文・学術検索に特化した実装。
 * - モデル: sonar-reasoning-pro（Chain of Thought + 引用付き）
 * - ストリーミング: SSE (OpenAI互換形式)
 * - 引用: citations フィールドで参照URLを返す
 *
 * API仕様: https://docs.perplexity.ai/docs/sonar/quickstart
 */

import { getCurrentLocale } from '@/lib/i18n';

export const PERPLEXITY_API_BASE = 'https://api.perplexity.ai';

/** 論文検索に使用するデフォルトモデル */
export const PERPLEXITY_DEFAULT_MODEL = 'sonar-reasoning-pro';

/** 汎用検索（軽量・高速） */
export const PERPLEXITY_FAST_MODEL = 'sonar';

export interface PerplexityMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface PerplexityCitation {
  url: string;
  title?: string;
}

export interface PerplexityStreamChunk {
  id: string;
  model: string;
  object: string;
  choices: {
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }[];
  citations?: string[];
}

export interface PerplexityResult {
  success: boolean;
  content?: string;
  citations?: PerplexityCitation[];
  error?: string;
}

/**
 * Perplexity Sonar API にストリーミングリクエストを送信する。
 *
 * @param apiKey  Perplexity API キー
 * @param query   ユーザーの検索クエリ
 * @param onChunk チャンクごとのコールバック (text, done, citations)
 * @param model   使用モデル（デフォルト: sonar-reasoning-pro）
 */
export async function perplexitySearchStream(
  apiKey: string,
  query: string,
  onChunk: (text: string, done: boolean, citations?: PerplexityCitation[]) => void,
  model: string = PERPLEXITY_DEFAULT_MODEL,
  history?: Array<{ role: string; content: string }>,
  externalSignal?: AbortSignal,
  systemPromptOverride?: string,
): Promise<PerplexityResult> {
  if (!apiKey || apiKey.trim() === '') {
    return { success: false, error: 'Perplexity APIキーが設定されていません。設定画面で入力してください。' };
  }

  const systemContent = systemPromptOverride && systemPromptOverride.length > 0
    ? systemPromptOverride
    : (getCurrentLocale() === 'ja'
      ? 'あなたは学術論文・研究の専門家です。日本語で回答してください。引用元を示し、要点を箇条書きでまとめてください。'
      : 'You are an expert in academic papers and research. Reply in English. Always cite sources and summarize key points in bullet points.');

  const messages: PerplexityMessage[] = [
    { role: 'system', content: systemContent },
    ...(history ?? []).map((m) => ({ role: m.role as PerplexityMessage['role'], content: m.content })),
    {
      role: 'user' as const,
      content: query,
    },
  ];

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    // Link external AbortSignal to internal controller
    if (externalSignal) {
      if (externalSignal.aborted) { clearTimeout(timer); controller.abort(); }
      else { externalSignal.addEventListener('abort', () => { clearTimeout(timer); controller.abort(); }, { once: true }); }
    }

    const res = await fetch(`${PERPLEXITY_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        max_tokens: 2048,
        temperature: 0.2,
        return_citations: true,
        return_related_questions: false,
        search_recency_filter: 'month',
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      if (res.status === 401) {
        return { success: false, error: 'APIキーが無効です。設定画面で正しいキーを入力してください。' };
      }
      if (res.status === 429) {
        return { success: false, error: 'レート制限に達しました。しばらく待ってから再試行してください。' };
      }
      return { success: false, error: `HTTP ${res.status}: ${errText.slice(0, 100)}` };
    }

    const reader = res.body?.getReader();
    if (!reader) {
      return { success: false, error: 'レスポンスボディが読み取れません' };
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    let finalCitations: PerplexityCitation[] = [];
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
          if (!finished) { onChunk('', true, finalCitations); finished = true; }
          break;
        }

        try {
          const chunk = JSON.parse(jsonStr) as PerplexityStreamChunk;
          const content = chunk.choices?.[0]?.delta?.content ?? '';
          const isDone = chunk.choices?.[0]?.finish_reason === 'stop';

          // citationsはストリームの最後のチャンクに含まれることが多い
          if (chunk.citations && chunk.citations.length > 0) {
            finalCitations = chunk.citations.map((url, i) => ({
              url,
              title: `[${i + 1}] ${url}`,
            }));
          }

          if (content) {
            fullContent += content;
          }

          if (isDone) {
            onChunk(content || '', true, finalCitations);
            finished = true;
            break;
          } else if (content) {
            onChunk(content, false);
          }
        } catch {
          // JSON parse error, skip
        }
      }
    }

    return {
      success: true,
      content: fullContent,
      citations: finalCitations,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = message.includes('abort') || message.includes('timeout');
    return {
      success: false,
      error: isTimeout ? 'タイムアウト。ネットワーク接続を確認してください。' : message,
    };
  }
}

/**
 * Perplexity APIキーの有効性を確認する（軽量な非ストリーミングリクエスト）
 */
export async function validatePerplexityApiKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
  if (!apiKey || apiKey.trim() === '') {
    return { valid: false, error: 'APIキーが空です' };
  }

  try {
    const res = await fetch(`${PERPLEXITY_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: PERPLEXITY_FAST_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 5,
        stream: false,
      }),
    });

    if (res.status === 401) return { valid: false, error: 'APIキーが無効です' };
    if (res.status === 429) return { valid: true }; // レート制限 = キーは有効
    if (res.ok) return { valid: true };

    return { valid: false, error: `HTTP ${res.status}` };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}
