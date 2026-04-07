/**
 * hooks/use-ai-pane-dispatch.ts
 *
 * Streaming dispatch hook for the AI Pane.
 * Routes user messages to the appropriate AI backend (local LLM or stub),
 * streams chunks into ai-pane-store, and injects terminal context automatically.
 *
 * Multi-agent routing can be extracted from use-ai-dispatch.ts later;
 * for now the focus is a solid local-LLM streaming path.
 */

import { useCallback, useRef, useMemo, useEffect } from 'react';
import { useAIPaneStore } from '@/store/ai-pane-store';
import { usePaneStore } from '@/store/pane-store';
import { useSettingsStore } from '@/store/settings-store';
import { getTerminalSnapshot, buildAIPaneSystemPrompt } from '@/lib/ai-pane-context';
import type { ChatMessage } from '@/store/chat-store';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Very lightweight token estimator (mirrors the one in use-ai-dispatch.ts).
 * ASCII chars ≈ 4 chars/token; CJK chars ≈ 1.5 chars/token.
 */
function estimateTokens(text: string): number {
  let cjk = 0;
  let ascii = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x3000 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk++;
    } else {
      ascii++;
    }
  }
  return Math.round(cjk / 1.5 + ascii / 4);
}

/** Convert AI-pane messages to OpenAI-compatible chat format for the local LLM. */
function toOpenAIHistory(
  messages: ChatMessage[],
  maxPairs = 8,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const result: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  const recent = messages.slice(-(maxPairs * 2));
  for (const m of recent) {
    if (m.role === 'user' && m.content) {
      result.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant' && m.content) {
      result.push({ role: 'assistant', content: m.content });
    }
  }
  return result;
}

// ─── Throttled update ─────────────────────────────────────────────────────────

type UpdateFn = (paneId: string, msgId: string, updates: Partial<ChatMessage>) => void;

/** 50 ms throttle for streaming partial updates — same pattern as use-ai-dispatch.ts. */
function createThrottledUpdate(updateFn: UpdateFn) {
  let pending: { paneId: string; msgId: string; updates: Partial<ChatMessage> } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const throttled = (paneId: string, msgId: string, updates: Partial<ChatMessage>) => {
    // Flush immediately when streaming ends
    if (updates.isStreaming === false) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
      updateFn(paneId, msgId, updates);
      return;
    }
    pending = { paneId, msgId, updates };
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        if (pending) {
          updateFn(pending.paneId, pending.msgId, pending.updates);
          pending = null;
        }
      }, 50);
    }
  };

  throttled.cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pending = null;
  };

  return throttled;
}

// ─── streamToAgent ─────────────────────────────────────────────────────────────

type StreamConfig = {
  baseUrl: string;
  model: string;
  systemPrompt: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  userText: string;
  signal: AbortSignal;
  onChunk: (chunk: string) => void;
};

/**
 * Stream a response from the local LLM (OpenAI-compatible /v1/chat/completions).
 * Uses SSE when available; falls back to a single JSON response.
 */
async function streamLocalLLM(cfg: StreamConfig): Promise<void> {
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;

  const messages = [
    { role: 'system' as const, content: cfg.systemPrompt },
    ...cfg.history,
    { role: 'user' as const, content: cfg.userText },
  ];

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      stream: true,
      temperature: 0.7,
      max_tokens: 2048,
    }),
    signal: cfg.signal,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => String(response.status));
    throw new Error(`Local LLM error ${response.status}: ${errText.slice(0, 200)}`);
  }

  // ── SSE streaming path ──
  const reader = response.body?.getReader();
  if (reader) {
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
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') return;

        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const chunk = parsed.choices?.[0]?.delta?.content;
          if (chunk) cfg.onChunk(chunk);
        } catch {
          // Malformed SSE line — skip
        }
      }
    }
    return;
  }

  // ── Fallback: non-streaming JSON ──
  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content ?? '';
  if (content) cfg.onChunk(content);
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * `useAIPaneDispatch(paneId)` — call `dispatch(text)` to send a message.
 *
 * Routing:
 * - `local` agent → streams from local LLM (OpenAI-compatible)
 * - other agents  → shows a configure-API-key stub (full routing TODO)
 */
export function useAIPaneDispatch(paneId: string) {
  const abortRef = useRef<AbortController | null>(null);

  const rawUpdateMessage = useAIPaneStore((s) => s.updateMessage);
  const throttledUpdate = useMemo(
    () => createThrottledUpdate(rawUpdateMessage),
    [rawUpdateMessage],
  );
  useEffect(() => () => throttledUpdate.cleanup(), [throttledUpdate]);

  const dispatch = useCallback(
    async (userText: string) => {
      if (!userText.trim()) return;

      const store = useAIPaneStore.getState();
      const agent = usePaneStore.getState().paneAgents[paneId] ?? 'local';
      const { settings } = useSettingsStore.getState();

      // ── Add user message ──
      const userMsg: ChatMessage = {
        id: generateId(),
        role: 'user',
        content: userText,
        timestamp: Date.now(),
        agent: agent as ChatMessage['agent'],
      };
      store.addMessage(paneId, userMsg);

      // ── Snapshot terminal context ──
      const terminalCtx = getTerminalSnapshot();
      store.setTerminalContext(paneId, terminalCtx);

      // ── Create assistant placeholder ──
      const assistantId = generateId();
      const assistantPlaceholder: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        agent: agent as ChatMessage['agent'],
        isStreaming: true,
        streamingText: '',
      };
      store.addMessage(paneId, assistantPlaceholder);
      store.setStreaming(paneId, true);

      // Abort any previous in-flight request
      abortRef.current?.abort();
      abortRef.current = new AbortController();
      const signal = abortRef.current.signal;

      try {
        const systemPrompt = buildAIPaneSystemPrompt(terminalCtx, agent);
        const conv = store.getOrCreate(paneId);
        // Exclude the streaming placeholder we just added
        const history = toOpenAIHistory(
          conv.messages.filter((m) => m.id !== assistantId),
          8,
        );

        if (agent === 'local') {
          // ── Local LLM streaming ──
          if (!settings.localLlmEnabled || !settings.localLlmUrl) {
            throw new Error(
              'Local LLM is not enabled. Enable it in Settings → Local LLM.',
            );
          }

          let accumulated = '';
          throttledUpdate(paneId, assistantId, {
            isStreaming: true,
            streamingText: '',
          });

          await streamLocalLLM({
            baseUrl: settings.localLlmUrl,
            model: settings.localLlmModel ?? 'default',
            systemPrompt,
            history,
            userText,
            signal,
            onChunk: (chunk) => {
              if (signal.aborted) return;
              accumulated += chunk;
              throttledUpdate(paneId, assistantId, {
                streamingText: accumulated,
                tokenCount: estimateTokens(accumulated),
                isStreaming: true,
              });
            },
          });

          if (!signal.aborted) {
            store.updateMessage(paneId, assistantId, {
              content: accumulated,
              streamingText: undefined,
              isStreaming: false,
              tokenCount: estimateTokens(accumulated),
            });
          }
        } else {
          // ── Other agents: stub until full routing is wired ──
          store.updateMessage(paneId, assistantId, {
            content: `Agent "${agent}" is not yet wired in the AI Pane.\nConfigure your API keys in Settings, or switch the pane agent to "local".`,
            isStreaming: false,
            streamingText: undefined,
          });
        }
      } catch (err: unknown) {
        if (signal.aborted) {
          // Cancelled by user — leave partial content as-is
          store.updateMessage(paneId, assistantId, {
            isStreaming: false,
            streamingText: undefined,
          });
          return;
        }
        const message =
          err instanceof Error ? err.message : 'Failed to get response';
        store.updateMessage(paneId, assistantId, {
          content: `Error: ${message}`,
          isStreaming: false,
          streamingText: undefined,
        });
      } finally {
        store.setStreaming(paneId, false);
      }
    },
    [paneId, throttledUpdate],
  );

  const cancelStreaming = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    useAIPaneStore.getState().setStreaming(paneId, false);
  }, [paneId]);

  const isStreaming = useAIPaneStore(
    (s) => s.conversations[paneId]?.isStreaming ?? false,
  );

  return { dispatch, cancelStreaming, isStreaming };
}
