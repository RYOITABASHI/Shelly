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
import { logInfo, logError } from '@/lib/debug-logger';
import { groqChatStream, GROQ_DEFAULT_MODEL } from '@/lib/groq';
import { geminiChatStream, GEMINI_DEFAULT_MODEL } from '@/lib/gemini';
import { perplexitySearchStream, PERPLEXITY_DEFAULT_MODEL } from '@/lib/perplexity';
import { cerebrasChatStream, CEREBRAS_DEFAULT_MODEL } from '@/lib/cerebras';
import { claudeCliStream } from '@/lib/claude-cli';
import { parseInput } from '@/lib/input-router';
import { parseAgentCommand, createAgent } from '@/lib/agent-manager';
import { suggestTool } from '@/lib/agent-tool-router';
import { tryAutoStageFromTerminal, getStagedEdit } from '@/lib/ai-edit';
import { useTerminalStore } from '@/store/terminal-store';
import { playSound } from '@/lib/sounds';
import type { GroqMessage } from '@/lib/groq';
import type { GeminiMessage } from '@/lib/gemini';
import type { CerebrasMessage } from '@/lib/cerebras';

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
      logInfo('AIPaneDispatch', 'Dispatching to agent: ' + agent);

      // ── Add user message ──
      const userMsg: ChatMessage = {
        id: generateId(),
        role: 'user',
        content: userText,
        timestamp: Date.now(),
        agent: agent as ChatMessage['agent'],
      };
      store.addMessage(paneId, userMsg);

      // bug: @agent used to only be wired into TerminalPane.onBlockCompleted,
      // so typing `@agent status` in the AI pane fell through to the LLM
      // (which has no idea what it means). The AI pane is the natural home
      // for @mention commands — intercept here and run the agent-manager
      // handler inline, appending a synthetic assistant message with the
      // result so the UX matches every other chat response.
      const parsed = parseInput(userText);
      if (parsed.layer === 'mention' && parsed.target === 'agent') {
        let resultMessage: string;
        try {
          const agentResult = parseAgentCommand(parsed.prompt);
          if (agentResult.type === 'create') {
            const promptText = agentResult.message;
            const firstWord = promptText.split(/\s+/)[0] || 'agent';
            const name = firstWord.replace(/[^a-zA-Z0-9_-]/g, '') || `agent-${Date.now().toString(36)}`;
            const suggestion = agentResult.data?.suggestion ?? suggestTool(promptText);
            const created = createAgent({
              name,
              description: promptText.slice(0, 120),
              prompt: promptText,
              schedule: null,
              tool: suggestion.tool,
              outputPath: `$HOME/.shelly/agents/${name}/output.md`,
            });
            resultMessage = `✅ Agent "${created.name}" registered (${suggestion.label}).\nRun it with: @agent run ${created.name}`;
          } else {
            resultMessage = agentResult.message;
          }
        } catch (err) {
          resultMessage = `[@agent] error: ${err instanceof Error ? err.message : String(err)}`;
        }
        store.addMessage(paneId, {
          id: generateId(),
          role: 'assistant',
          content: resultMessage,
          timestamp: Date.now(),
          agent: agent as ChatMessage['agent'],
        });
        return;
      }

      // ── Snapshot terminal context ──
      const terminalCtx = getTerminalSnapshot();
      logInfo('AIPaneDispatch', 'Terminal context: ' + (terminalCtx ? terminalCtx.length + ' chars' : 'none'));
      store.setTerminalContext(paneId, terminalCtx);

      // Auto-stage a referenced file so InlineDiff's Accept can actually
      // write the patch back to disk without the user first opening the
      // file in a Code pane. This is the backbone of cross-pane
      // intelligence: terminal shows "user.ts:4:12 error ..." → user asks
      // "fix it" → we preload user.ts now, AI returns a diff, Accept
      // writes the file.
      let stagedFile: { path: string; content: string } | null = null;
      const existing = getStagedEdit();
      if (existing) {
        // Explicit stageAiEdit() from a Code pane always wins; surface its
        // content into the prompt so the model edits the right file.
        stagedFile = { path: existing.path, content: existing.originalContent };
      } else if (terminalCtx) {
        try {
          const sess = useTerminalStore.getState();
          const active = sess.sessions.find((s) => s.id === sess.activeSessionId);
          const cwd = active?.cwd || '/data/data/dev.shelly.terminal/files/home';
          stagedFile = await tryAutoStageFromTerminal(cwd, terminalCtx);
          if (stagedFile) {
            logInfo('AIPaneDispatch', 'Auto-staged from terminal: ' + stagedFile.path);
          }
        } catch (err) {
          logInfo('AIPaneDispatch', 'Auto-stage failed: ' + (err instanceof Error ? err.message : String(err)));
        }
      }

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

      // Superset-style lifecycle chime: fire as the assistant bubble
      // flips to streaming so the user gets the "the agent heard you"
      // feedback even before the first token arrives.
      try { playSound('ai_start'); } catch {}

      // Abort any previous in-flight request
      abortRef.current?.abort();
      abortRef.current = new AbortController();
      const signal = abortRef.current.signal;

      try {
        const systemPrompt = buildAIPaneSystemPrompt(terminalCtx, agent, stagedFile);
        const conv = store.getOrCreate(paneId);
        // Exclude the streaming placeholder we just added
        const history = toOpenAIHistory(
          conv.messages.filter((m) => m.id !== assistantId),
          8,
        );

        if (agent === 'local') {
          // ── Local LLM streaming ──
          // Plan B: llama.cpp Setup 画面で Start すると localLlmUrl が
          // セットされる (LlamaCppSectionWrapper)。localLlmEnabled トグルは
          // Plan B 移行後は旧チャット画面専用で、Setup フローからは更新
          // されない (bug #68)。従ってここでは URL が設定されているか
          // だけをゲートに使い、実サーバーが落ちていれば streamLocalLLM
          // が connection エラーを返すので UX 的にはそれで十分。
          if (!settings.localLlmUrl) {
            throw new Error(
              'Local LLM server is not configured. Open Settings → Local LLM and start llama.cpp.',
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
            logInfo('AIPaneDispatch', 'Response complete');
            store.updateMessage(paneId, assistantId, {
              content: accumulated,
              streamingText: undefined,
              isStreaming: false,
              tokenCount: estimateTokens(accumulated),
            });
          }
        } else if (agent === 'cerebras') {
          // ── Cerebras Qwen3-235B (frontier-class, fastest, 1M tok/day) ──
          const apiKey = settings.cerebrasApiKey ?? '';
          if (!apiKey) {
            store.updateMessage(paneId, assistantId, {
              content: 'Cerebras API key is not set. Add it in Settings (gear icon) → Cerebras API Key.',
              isStreaming: false,
              streamingText: undefined,
            });
          } else {
            const cerebrasHistory: CerebrasMessage[] = history.map((m) => ({
              role: m.role as 'user' | 'assistant',
              content: m.content,
            }));
            let accumulated = '';
            throttledUpdate(paneId, assistantId, { isStreaming: true, streamingText: '' });

            const result = await cerebrasChatStream(
              apiKey,
              userText,
              (chunk, done) => {
                if (signal.aborted) return;
                if (!done && chunk) {
                  accumulated += chunk;
                  throttledUpdate(paneId, assistantId, {
                    streamingText: accumulated,
                    tokenCount: estimateTokens(accumulated),
                    isStreaming: true,
                  });
                }
              },
              settings.cerebrasModel ?? CEREBRAS_DEFAULT_MODEL,
              cerebrasHistory,
              signal,
              systemPrompt,
            );

            if (!signal.aborted) {
              const finalContent = result.content ?? accumulated;
              if (!result.success && result.error) {
                store.updateMessage(paneId, assistantId, {
                  content: `Cerebras error: ${result.error}`,
                  isStreaming: false,
                  streamingText: undefined,
                });
              } else {
                store.updateMessage(paneId, assistantId, {
                  content: finalContent,
                  streamingText: undefined,
                  isStreaming: false,
                  tokenCount: estimateTokens(finalContent),
                });
              }
              logInfo('AIPaneDispatch', 'Cerebras response complete');
            }
          }
        } else if (agent === 'groq') {
          // ── Groq (Llama 3.3 70B, OpenAI-compatible SSE) ──
          const apiKey = settings.groqApiKey ?? '';
          if (!apiKey) {
            store.updateMessage(paneId, assistantId, {
              content: 'Groq API key is not set. Add it in Settings (gear icon) → Groq API Key.',
              isStreaming: false,
              streamingText: undefined,
            });
          } else {
            const groqHistory: GroqMessage[] = history.map((m) => ({
              role: m.role as 'user' | 'assistant',
              content: m.content,
            }));
            // Prepend system prompt as a user/assistant exchange isn't possible in Groq
            // groqChatStream accepts history and appends the system prompt internally,
            // but we pass our richer terminal-aware system prompt via the first history entry.
            // We inject it as the first message if the history is empty, otherwise trust groq.ts.
            let accumulated = '';
            throttledUpdate(paneId, assistantId, { isStreaming: true, streamingText: '' });

            const result = await groqChatStream(
              apiKey,
              userText,
              (chunk, done) => {
                if (signal.aborted) return;
                if (!done && chunk) {
                  accumulated += chunk;
                  throttledUpdate(paneId, assistantId, {
                    streamingText: accumulated,
                    tokenCount: estimateTokens(accumulated),
                    isStreaming: true,
                  });
                }
              },
              settings.groqModel ?? GROQ_DEFAULT_MODEL,
              groqHistory,
              signal,
              systemPrompt,
            );

            if (!signal.aborted) {
              const finalContent = result.content ?? accumulated;
              if (!result.success && result.error) {
                store.updateMessage(paneId, assistantId, {
                  content: `Groq error: ${result.error}`,
                  isStreaming: false,
                  streamingText: undefined,
                });
              } else {
                store.updateMessage(paneId, assistantId, {
                  content: finalContent,
                  streamingText: undefined,
                  isStreaming: false,
                  tokenCount: estimateTokens(finalContent),
                });
              }
              logInfo('AIPaneDispatch', 'Groq response complete');
            }
          }
        } else if (agent === 'gemini') {
          // ── Gemini (SSE via Google AI Studio) ──
          const apiKey = settings.geminiApiKey ?? '';
          if (!apiKey) {
            store.updateMessage(paneId, assistantId, {
              content: 'Gemini API key is not set. Add it in Settings (gear icon) → Gemini API Key.',
              isStreaming: false,
              streamingText: undefined,
            });
          } else {
            const geminiHistory: GeminiMessage[] = history.map((m) => ({
              role: m.role === 'user' ? 'user' : 'model',
              parts: [{ text: m.content }],
            }));

            let accumulated = '';
            throttledUpdate(paneId, assistantId, { isStreaming: true, streamingText: '' });

            const result = await geminiChatStream(
              apiKey,
              userText,
              (chunk, done) => {
                if (signal.aborted) return;
                if (!done && chunk) {
                  accumulated += chunk;
                  throttledUpdate(paneId, assistantId, {
                    streamingText: accumulated,
                    tokenCount: estimateTokens(accumulated),
                    isStreaming: true,
                  });
                }
              },
              settings.geminiModel ?? GEMINI_DEFAULT_MODEL,
              geminiHistory,
              signal,
              systemPrompt,
            );

            if (!signal.aborted) {
              const finalContent = result.content ?? accumulated;
              if (!result.success && result.error) {
                store.updateMessage(paneId, assistantId, {
                  content: `Gemini error: ${result.error}`,
                  isStreaming: false,
                  streamingText: undefined,
                });
              } else {
                store.updateMessage(paneId, assistantId, {
                  content: finalContent,
                  streamingText: undefined,
                  isStreaming: false,
                  tokenCount: estimateTokens(finalContent),
                });
              }
              logInfo('AIPaneDispatch', 'Gemini response complete');
            }
          }
        } else if (agent === 'perplexity') {
          // ── Perplexity Sonar (web-search SSE) ──
          const apiKey = settings.perplexityApiKey ?? '';
          if (!apiKey) {
            store.updateMessage(paneId, assistantId, {
              content: 'Perplexity API key is not set. Add it in Settings (gear icon) → Perplexity API Key.',
              isStreaming: false,
              streamingText: undefined,
            });
          } else {
            const pplxHistory = history.map((m) => ({ role: m.role, content: m.content }));

            let accumulated = '';
            throttledUpdate(paneId, assistantId, { isStreaming: true, streamingText: '' });

            const result = await perplexitySearchStream(
              apiKey,
              userText,
              (chunk, done, citations) => {
                if (signal.aborted) return;
                if (!done && chunk) {
                  accumulated += chunk;
                  throttledUpdate(paneId, assistantId, {
                    streamingText: accumulated,
                    tokenCount: estimateTokens(accumulated),
                    isStreaming: true,
                  });
                }
                if (done && citations && citations.length > 0) {
                  // Append formatted citations to the final message
                  const citationText = '\n\n**Sources:**\n' +
                    citations.map((c, i) => `${i + 1}. [${c.title ?? c.url}](${c.url})`).join('\n');
                  accumulated += citationText;
                }
              },
              settings.perplexityModel ?? PERPLEXITY_DEFAULT_MODEL,
              pplxHistory,
              signal,
              systemPrompt,
            );

            if (!signal.aborted) {
              const finalContent = result.content
                ? (result.citations && result.citations.length > 0
                  ? result.content + '\n\n**Sources:**\n' +
                    result.citations.map((c, i) => `${i + 1}. [${c.title ?? c.url}](${c.url})`).join('\n')
                  : result.content)
                : accumulated;

              if (!result.success && result.error) {
                store.updateMessage(paneId, assistantId, {
                  content: `Perplexity error: ${result.error}`,
                  isStreaming: false,
                  streamingText: undefined,
                });
              } else {
                store.updateMessage(paneId, assistantId, {
                  content: finalContent,
                  streamingText: undefined,
                  isStreaming: false,
                  tokenCount: estimateTokens(finalContent),
                });
              }
              logInfo('AIPaneDispatch', 'Perplexity response complete');
            }
          }
        } else if (agent === 'claude') {
          // ── Claude (bundled CLI via JNI fork+exec) ──
          logInfo('AIPaneDispatch', `Claude dispatch start: prompt=${userText.slice(0, 80)}`);
          let accumulated = '';
          throttledUpdate(paneId, assistantId, { isStreaming: true, streamingText: '' });

          const result = await claudeCliStream(
            userText,
            (chunk, done) => {
              if (signal.aborted) return;
              if (!done && chunk) {
                accumulated += chunk;
                logInfo('AIPaneDispatch', `Claude chunk: +${chunk.length} chars (total=${accumulated.length})`);
                throttledUpdate(paneId, assistantId, {
                  streamingText: accumulated,
                  tokenCount: estimateTokens(accumulated),
                  isStreaming: true,
                });
              }
            },
            {
              autoApprove: (settings.autoApproveLevel ?? 'safe') as any,
              systemPrompt,
            },
            signal,
          );

          if (!signal.aborted) {
            const finalContent = result.content || accumulated;
            logInfo('AIPaneDispatch', `Claude dispatch end: success=${result.success} exitCode=${result.exitCode} contentLen=${finalContent.length}`);
            if (!result.success) {
              logError('AIPaneDispatch', `Claude failed: ${result.error ?? '(no error msg)'}`);
              store.updateMessage(paneId, assistantId, {
                content: result.error
                  ? `Claude CLI error: ${result.error}`
                  : finalContent || 'Claude returned no output.',
                isStreaming: false,
                streamingText: undefined,
              });
            } else {
              store.updateMessage(paneId, assistantId, {
                content: finalContent,
                streamingText: undefined,
                isStreaming: false,
                tokenCount: estimateTokens(finalContent),
              });
            }
            logInfo('AIPaneDispatch', 'Claude response complete');
          }
        } else {
          // ── Unknown agent ──
          store.updateMessage(paneId, assistantId, {
            content: `Unknown agent "${agent}". Switch the pane agent in the pane header.`,
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
        logError('AIPaneDispatch', 'Dispatch failed', err);
        const message =
          err instanceof Error ? err.message : 'Failed to get response';
        store.updateMessage(paneId, assistantId, {
          content: `Error: ${message}`,
          isStreaming: false,
          streamingText: undefined,
        });
      } finally {
        store.setStreaming(paneId, false);
        // Agent-complete chime to match Superset.sh — user can be
        // looking at another pane and still know the response landed.
        try { playSound('ai_complete'); } catch {}
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
