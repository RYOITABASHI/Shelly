/**
 * hooks/use-ai-dispatch.ts
 *
 * AI agent dispatcher hook — extracted from ChatScreen's handleSend.
 * Handles routing to Local LLM, Gemini, Perplexity, Claude, Team, Git.
 * Provides conversation context (last N messages) to each AI.
 */

import { useCallback, useRef, useMemo, useEffect } from 'react';
import { Linking } from 'react-native';
import { useChatStore, type ChatMessage, type ChatAgent } from '@/store/chat-store';
import { useTerminalStore } from '@/store/terminal-store';
import { useNativeExec } from '@/hooks/use-native-exec';
import { orchestrateChatStream } from '@/lib/local-llm';
import { detectGitIntent, generateGuide } from '@/lib/git-assistant';
import { loadProjectContext } from '@/lib/project-context';
import { loadUserProfile, formatProfileForPrompt } from '@/lib/user-profile';
import { loadCustomContext } from '@/lib/shelly-system-prompt';
import { getDecisionLogForPrompt, autoLogFromResponse } from '@/lib/decision-log';
import { getActiveLlmLabel } from '@/hooks/use-tool-discovery';
import type { ImageAttachment, FileAttachment } from '@/components/input/CommandInput';
import type { GeminiMessage } from '@/lib/gemini';
import type { OllamaMessage } from '@/lib/local-llm';

import { generateId } from '@/lib/id';
import { parsePlanOutput } from '@/lib/parse-plan';
import { usePlanStore } from '@/store/plan-store';
import { useArenaStore } from '@/store/arena-store';
import { selectArenaAgents } from '@/lib/arena-selector';
import { t } from '@/lib/i18n';
import { useExecutionLogStore } from '@/store/execution-log-store';
import { groqChatStream, type GroqMessage } from '@/lib/groq';
import { hasTerminalReference, getTerminalIntent, type TerminalIntent } from '@/lib/input-router';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';

// ─── Auth URL detection ──────────────────────────────────────────────────────

/** URLs already opened in this session (avoid re-opening on every stream chunk) */
const _openedAuthUrls = new Set<string>();

/**
 * Detect OAuth/auth URLs in CLI output and open them in external browser.
 * Patterns: accounts.google.com, console.anthropic.com, github.com/login/device, etc.
 */
function detectAndOpenAuthUrls(text: string): void {
  const urlRegex = /https?:\/\/[^\s"'<>\])\u3000-\u30FF\u4E00-\u9FFF]+/g;
  const authDomains = [
    'accounts.google.com',
    'console.anthropic.com',
    'github.com/login',
    'login.microsoftonline.com',
    'oauth',
    'authorize',
    'auth',
    'device',
  ];
  const matches = text.match(urlRegex);
  if (!matches) return;

  for (const url of matches) {
    const lower = url.toLowerCase();
    const isAuth = authDomains.some((d) => lower.includes(d));
    if (isAuth && !_openedAuthUrls.has(url)) {
      _openedAuthUrls.add(url);
      Linking.openURL(url).catch(() => {});
    }
  }
}

// ─── CLI output filtering ───────────────────────────────────────────────────

/** Lines to strip from CLI streaming output (internal context, warnings) */
const CLI_OUTPUT_FILTER_PATTERNS = [
  /^\[Conversation Context\]$/,
  /^User: .{0,500}$/,
  /^Assistant: .{0,500}$/,
  /^Warning: no stdin data received in \d+s/,
  /^Warning:.*redirect stdin explicitly/,
  /^--- stderr ---$/,
];

/**
 * Filter internal context and warnings from CLI output displayed to user.
 * Strips [Conversation Context] blocks and stdin warnings.
 */
function filterCliOutput(text: string): string {
  const lines = text.split('\n');
  let inContextBlock = false;
  const filtered: string[] = [];

  for (const line of lines) {
    // Detect start of [Conversation Context] block
    if (/^\[Conversation Context\]/.test(line.trim())) {
      inContextBlock = true;
      continue;
    }
    // End of context block: empty line after context entries
    if (inContextBlock) {
      if (line.trim() === '' || line.trim() === '"') {
        inContextBlock = false;
        continue;
      }
      // Skip User:/Assistant: lines within context block
      if (/^(User|Assistant):/.test(line.trim())) continue;
      // Non-context line — end the block and keep this line
      inContextBlock = false;
    }
    // Filter individual warning patterns
    if (CLI_OUTPUT_FILTER_PATTERNS.some((p) => p.test(line.trim()))) continue;
    filtered.push(line);
  }
  return filtered.join('\n');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function mapTargetToAgent(target: string): ChatAgent | undefined {
  const map: Record<string, ChatAgent> = {
    claude: 'claude', gemini: 'gemini', local: 'local',
    perplexity: 'perplexity', team: 'team', git: 'git', codex: 'codex',
    agent: 'gemini', // agent mode uses Gemini function calling
  };
  return map[target];
}

/** Convert chat messages to Gemini history format (last N pairs) */
function toGeminiHistory(messages: ChatMessage[], maxPairs = 4): GeminiMessage[] {
  const history: GeminiMessage[] = [];
  const recent = messages.slice(-(maxPairs * 2));
  for (const m of recent) {
    if (m.role === 'user') {
      history.push({ role: 'user', parts: [{ text: m.content }] });
    } else if (m.role === 'assistant' && m.content) {
      history.push({ role: 'model', parts: [{ text: m.content }] });
    }
  }
  return history;
}

/** Convert chat messages to Ollama history format (last N pairs) */
function toOllamaHistory(messages: ChatMessage[], maxPairs = 4): OllamaMessage[] {
  const history: OllamaMessage[] = [];
  const recent = messages.slice(-(maxPairs * 2));
  for (const m of recent) {
    if (m.role === 'user') {
      history.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant' && m.content) {
      history.push({ role: 'assistant', content: m.content });
    }
  }
  return history;
}

/** Build file context string from attachments (wrapped in code blocks to prevent prompt injection) */
function buildFileContext(files: FileAttachment[]): string {
  return files
    .filter((f) => f.content)
    .map((f) => `--- ${f.name} ---\n\`\`\`\n${f.content}\n\`\`\``)
    .join('\n\n');
}

/** Build conversation context as plain text (for CLI-based agents like Claude) */
/** Max characters per message in context (prevents prompt bloat) */
const CONTEXT_MSG_MAX_CHARS = 500;

/**
 * Estimate token count from text.
 * ASCII chars ≈ 4 chars/token, CJK chars ≈ 1.5 chars/token.
 */
function estimateTokens(text: string): number {
  let cjk = 0;
  let ascii = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // CJK Unified Ideographs + Hiragana + Katakana + Fullwidth
    if ((code >= 0x3000 && code <= 0x9FFF) || (code >= 0xF900 && code <= 0xFAFF) || (code >= 0xFF00 && code <= 0xFFEF)) {
      cjk++;
    } else {
      ascii++;
    }
  }
  return Math.round(cjk / 1.5 + ascii / 4);
}

function toTextContext(messages: ChatMessage[], maxPairs = 4): string {
  const recent = messages.slice(-(maxPairs * 2));
  if (recent.length === 0) return '';
  const lines = recent.map((m) => {
    const role = m.role === 'user' ? 'User' : 'Assistant';
    // Sanitize: strip control characters and limit length per message
    const sanitized = m.content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').slice(0, CONTEXT_MSG_MAX_CHARS);
    return `${role}: ${sanitized}`;
  });
  return `\n\n[Conversation Context]\n${lines.join('\n')}\n`;
}

/** Convert chat messages to Perplexity messages format */
function toPerplexityHistory(messages: ChatMessage[], maxPairs = 4): Array<{ role: string; content: string }> {
  const history: Array<{ role: string; content: string }> = [];
  const recent = messages.slice(-(maxPairs * 2));
  for (const m of recent) {
    if (m.role === 'user') {
      history.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant' && m.content) {
      history.push({ role: 'assistant', content: m.content });
    }
  }
  return history;
}

// ─── Cross-pane terminal context injection ──────────────────────────────────

const TERMINAL_CONTEXT_SUFFIXES: Record<TerminalIntent, string> = {
  'reference': '\n---\nThe user is referring to the terminal output shown above. Analyze it and respond to their request.\nIf your response includes commands or code that can fix the issue, format them as fenced code blocks (```) so the user can execute them directly.',
  'second-opinion': '\n---\nThe user wants a second opinion on what is happening in the terminal. Review the approach, code, or process shown above. Point out potential issues, suggest improvements, or confirm the approach is sound. Be objective and constructive.',
  'session-summary': '\n---\nThe user wants a summary of their terminal session. Based on the output above, summarize: what commands were run, what was accomplished, and what the current state is. Be concise and organized.',
};

/**
 * Build terminal output context for AI injection.
 * Returns empty string if no context available (= fallback to normal response).
 *
 * Wide mode: always inject terminal context (terminal is always visible)
 * Single pane: only when user explicitly references terminal
 * Empty output: always fallback to normal response
 */
async function getTerminalContextForPrompt(prompt: string, isWide: boolean): Promise<string> {
  const intent = getTerminalIntent(prompt);
  const shouldInject = isWide || intent !== null;
  if (!shouldInject) return '';

  // Primary: snapshot from native TerminalEmulator (captures pre-split output)
  const activeSessionId = useTerminalStore.getState().activeSessionId;
  let termOutput = '';
  if (activeSessionId) {
    try {
      termOutput = await TerminalEmulator.getTranscriptText(activeSessionId, 100);
    } catch {}
  }
  // Fallback: execution-log buffer (for sessions without native emulator)
  if (!termOutput) {
    termOutput = useExecutionLogStore.getState().getRecentOutput(50, 5, activeSessionId);
  }
  if (!termOutput) return '';

  const suffix = TERMINAL_CONTEXT_SUFFIXES[intent ?? 'reference'];

  // Include recently changed files from preview store (Flow Awareness)
  let fileContext = '';
  try {
    const { usePreviewStore } = require('@/store/preview-store');
    const recentFiles = usePreviewStore.getState().recentFiles;
    if (recentFiles && recentFiles.length > 0) {
      const paths = recentFiles.slice(0, 10).map((f: { path: string }) => f.path);
      fileContext = `\n--- Recently Changed Files ---\n${paths.join('\n')}`;
    }
  } catch {}

  return `\n\n--- Terminal Output (Session: ${activeSessionId}, last 100 lines) ---\n${termOutput}${fileContext}${suffix}`;
}

// ─── Types ──────────────────────────────────────────────────────────────────

type DispatchParams = {
  target: string;
  prompt: string;
  chatSessionId: string;
  messages: ChatMessage[];
  images?: ImageAttachment[];
  files?: FileAttachment[];
  /** Whether device is in wide/multi-pane layout (for cross-pane intelligence) */
  isWide?: boolean;
};

type DispatchResult = {
  handled: boolean;
};

// ─── Hook ───────────────────────────────────────────────────────────────────

/** Create a throttled version of updateMessage for streaming (50ms) */
function createThrottledUpdate(updateFn: (sid: string, mid: string, updates: Partial<ChatMessage>) => void) {
  let pending: { sid: string; mid: string; updates: Partial<ChatMessage> } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const throttled = (sid: string, mid: string, updates: Partial<ChatMessage>) => {
    // Always flush immediately for final updates (isStreaming: false)
    if (updates.isStreaming === false) {
      if (timer) { clearTimeout(timer); timer = null; }
      pending = null;
      updateFn(sid, mid, updates);
      return;
    }
    // Throttle streaming updates
    pending = { sid, mid, updates };
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        if (pending) {
          updateFn(pending.sid, pending.mid, pending.updates);
          pending = null;
        }
      }, 50);
    }
  };

  throttled.cleanup = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    pending = null;
  };

  return throttled;
}

export function useAIDispatch() {
  const { addMessage, updateMessage: rawUpdateMessage } = useChatStore();
  const throttledUpdate = useMemo(() => createThrottledUpdate(rawUpdateMessage), [rawUpdateMessage]);
  useEffect(() => () => throttledUpdate.cleanup(), [throttledUpdate]);
  const updateMessage = throttledUpdate;
  const settings = useTerminalStore((s) => s.settings);
  const { runCommand: bridgeRunCommand, readFile: bridgeReadFile, writeFile: bridgeWriteFile, editFile: bridgeEditFile, listFiles: bridgeListFiles } = useNativeExec();
  const terminalRunCommand = useTerminalStore((s) => s.runCommand);

  // AbortController for streaming cancellation
  const abortRef = useRef<AbortController | null>(null);
  // Track current streaming message for cleanup on cancel
  const streamingMsgRef = useRef<{ sessionId: string; msgId: string } | null>(null);

  const addAssistantMessage = useCallback((sessionId: string, agent?: ChatAgent, content?: string): string => {
    const msg: ChatMessage = {
      id: generateId(),
      role: 'assistant',
      content: content ?? '',
      timestamp: Date.now(),
      agent,
      isStreaming: !content,
    };
    addMessage(sessionId, msg);
    return msg.id;
  }, [addMessage]);

  /** Cancel any in-progress AI streaming — saves partial content */
  const cancelStreaming = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (streamingMsgRef.current) {
      const { sessionId, msgId } = streamingMsgRef.current;
      // Find the message to preserve partial streamingText as content
      const session = useChatStore.getState().sessions.find(s => s.id === sessionId);
      const msg = session?.messages.find(m => m.id === msgId);
      const partialContent = msg?.streamingText || msg?.content || '';
      rawUpdateMessage(sessionId, msgId, {
        content: partialContent ? partialContent + '\n\n*[Cancelled]*' : '',
        isStreaming: false,
        streamingText: undefined,
      });
      streamingMsgRef.current = null;
    }
  }, [rawUpdateMessage]);

  /** Main dispatch function */
  const dispatch = useCallback(async (params: DispatchParams): Promise<DispatchResult> => {
    const { target, prompt, chatSessionId, messages, images, files, isWide } = params;
    const fileContext = files?.length ? buildFileContext(files) : '';
    const promptWithFiles = fileContext ? `${prompt}\n\n[Attached Files]\n${fileContext}` : prompt;

    // Abort any previous in-flight request before starting a new one
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

    // ── Image-attached → Gemini multimodal ──
    if (images && images.length > 0) {
      const msgId = addAssistantMessage(chatSessionId, 'gemini');
      streamingMsgRef.current = { sessionId: chatSessionId, msgId };
      const apiKey = settings.geminiApiKey ?? '';
      if (!apiKey) {
        updateMessage(chatSessionId, msgId, {
          content: t('dispatch.gemini_no_key'),
          isStreaming: false,
          error: t('dispatch.api_key_not_set'),
        });
        return { handled: true };
      }

      let accumulated = '';
      updateMessage(chatSessionId, msgId, { isStreaming: true, streamingText: '', streamingStartTime: Date.now() });

      try {
        const { geminiMultimodalStream } = await import('@/lib/gemini');
        const result = await geminiMultimodalStream(
          apiKey, promptWithFiles,
          images.map((img) => ({ base64: img.base64, mimeType: img.mimeType })),
          (chunk, done) => {
            if (signal.aborted) return;
            if (chunk) {
              accumulated += chunk;
              updateMessage(chatSessionId, msgId, {
                streamingText: accumulated,
                tokenCount: estimateTokens(accumulated),
                isStreaming: !done,
              });
            }
            if (done) {
              updateMessage(chatSessionId, msgId, {
                content: accumulated,
                streamingText: undefined,
                isStreaming: false,
                tokenCount: estimateTokens(accumulated),
              });
            }
          },
          undefined, // default model
          signal,
        );
        if (!result.success && !accumulated) {
          updateMessage(chatSessionId, msgId, {
            content: '',
            error: `Gemini error: ${result.error ?? 'Unknown error'}`,
            isStreaming: false,
          });
        }
      } catch (err) {
        if (!signal.aborted) {
          updateMessage(chatSessionId, msgId, {
            content: '', error: `Gemini error: ${err instanceof Error ? err.message : String(err)}`,
            isStreaming: false,
          });
        }
      }
      return { handled: true };
    }

    // ── Local LLM ──
    if (target === 'local') {
      const msgId = addAssistantMessage(chatSessionId, 'local');
      streamingMsgRef.current = { sessionId: chatSessionId, msgId };

      try {
        const config = {
          baseUrl: settings.localLlmUrl,
          model: settings.localLlmModel,
          enabled: settings.localLlmEnabled,
        };

        let accumulatedText = '';
        updateMessage(chatSessionId, msgId, { isStreaming: true, streamingText: '', tokenCount: 0, streamingStartTime: Date.now() });

        // Cross-pane: inject terminal context
        const termCtx = await getTerminalContextForPrompt(prompt, isWide ?? false);

        // Load all context layers in parallel
        const ollamaHistory = toOllamaHistory(messages);
        const activeSession = useTerminalStore.getState().sessions.find(
          (s) => s.id === useTerminalStore.getState().activeSessionId,
        );
        const cwd = activeSession?.currentDir || '';
        const [projectCtx, userProfile, customCtx, decisionLog] = await Promise.all([
          cwd ? loadProjectContext(cwd, (cmd: string) =>
            bridgeRunCommand(cmd, {}).then((r) => r.stdout ?? '').catch(() => ''),
          ).catch(() => '') : Promise.resolve(''),
          loadUserProfile().then((p) => p ? formatProfileForPrompt(p) : '').catch(() => ''),
          loadCustomContext().catch(() => ''),
          getDecisionLogForPrompt().catch(() => ''),
        ]);

        const result = await orchestrateChatStream(
          promptWithFiles, config,
          (chunk, done) => {
            if (signal.aborted) return;
            if (chunk) {
              accumulatedText += chunk;
              updateMessage(chatSessionId, msgId, {
                streamingText: accumulatedText,
                tokenCount: estimateTokens(accumulatedText),
                isStreaming: !done,
              });
            }
            if (done) {
              updateMessage(chatSessionId, msgId, {
                content: accumulatedText,
                streamingText: undefined,
                isStreaming: false,
                tokenCount: estimateTokens(accumulatedText),
                llmModelLabel: getActiveLlmLabel(),
              });
              // Auto-log important decisions from AI response
              autoLogFromResponse(accumulatedText).catch(() => {});
              // Log to shared execution log (visible in Terminal tab)
              useExecutionLogStore.getState().addEntry({
                source: 'ai-agent',
                agent: 'Local LLM',
                userInput: prompt,
                aiResponse: accumulatedText.slice(0, 200),
              });
            }
          },
          ollamaHistory,
          projectCtx || undefined,
          userProfile || undefined,
          [customCtx, decisionLog ? `\n# Past Design Decisions\n${decisionLog}` : '', termCtx].filter(Boolean).join('\n') || undefined,
          undefined, // toolStatuses
          undefined, // defaultAgent
          signal,
          true, // forceLocal — skip routing for local model (avoids double-inference penalty)
        );

        if (result.handledBy !== 'local_llm') {
          updateMessage(chatSessionId, msgId, { isStreaming: false, streamingText: undefined });
          if (result.delegatedCommand) {
            const toolLabel = result.handledBy === 'gemini' ? 'Gemini CLI' : result.handledBy === 'codex' ? 'Codex CLI' : 'Claude Code';
            updateMessage(chatSessionId, msgId, {
              content: t('dispatch.delegated_to', { tool: toolLabel, reason: result.reasoning || '' }),
              agent: mapTargetToAgent(result.handledBy ?? '') ?? 'local',
              isStreaming: false,
            });
            terminalRunCommand(result.delegatedCommand);
          } else if (result.response) {
            updateMessage(chatSessionId, msgId, { content: result.response, isStreaming: false });
          } else {
            updateMessage(chatSessionId, msgId, {
              content: '',
              error: t('dispatch.local_llm_error'),
              isStreaming: false,
            });
          }
        }
      } catch (err) {
        if (!signal.aborted) {
          updateMessage(chatSessionId, msgId, {
            content: '',
            error: `Local LLM error: ${err instanceof Error ? err.message : String(err)}`,
            isStreaming: false,
          });
        }
      }
      return { handled: true };
    }

    // ── Cerebras (fastest frontier chat, Qwen3-235B, offline → local LLM fallback) ──
    if (target === 'cerebras') {
      const cerebrasKey = settings.cerebrasApiKey ?? '';
      if (!cerebrasKey) {
        // No key — fall through to next provider (don't create empty bubble)
        return { handled: false };
      }

      const msgId = addAssistantMessage(chatSessionId, 'cerebras');
      streamingMsgRef.current = { sessionId: chatSessionId, msgId };

      try {
        const { cerebrasChatStream } = await import('@/lib/cerebras');
        let accumulatedText = '';
        updateMessage(chatSessionId, msgId, { isStreaming: true, streamingText: '', tokenCount: 0, streamingStartTime: Date.now() });

        const cerebrasHistory = messages.slice(-6).map((m: ChatMessage) => ({
          role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
          content: m.content,
        }));

        // Memories: inject custom context as system message
        const customCtx = await loadCustomContext().catch(() => '');
        if (customCtx) {
          cerebrasHistory.unshift({ role: 'user' as const, content: `[System Context]\n${customCtx}` });
        }

        // Cross-pane: inject terminal context
        const termCtx = await getTerminalContextForPrompt(prompt, isWide ?? false);
        const cerebrasPrompt = termCtx ? promptWithFiles + termCtx : promptWithFiles;

        const result = await cerebrasChatStream(
          cerebrasKey,
          cerebrasPrompt,
          (chunk, done) => {
            if (signal.aborted) return;
            if (chunk) {
              accumulatedText += chunk;
              updateMessage(chatSessionId, msgId, {
                streamingText: accumulatedText,
                tokenCount: estimateTokens(accumulatedText),
                isStreaming: !done,
              });
            }
            if (done) {
              updateMessage(chatSessionId, msgId, {
                content: accumulatedText,
                streamingText: undefined,
                isStreaming: false,
                tokenCount: estimateTokens(accumulatedText),
              });
              useExecutionLogStore.getState().addEntry({
                source: 'ai-agent',
                agent: 'Cerebras',
                userInput: prompt,
                aiResponse: accumulatedText.slice(0, 200),
              });
            }
          },
          settings.cerebrasModel || 'qwen-3-235b-a22b-instruct-2507',
          cerebrasHistory,
          signal,
        );

        // Offline fallback: try local LLM
        if (!result.success && result.networkError && settings.localLlmEnabled) {
          updateMessage(chatSessionId, msgId, {
            content: '',
            streamingText: t('dispatch.offline_fallback'),
            isStreaming: true,
          });

          accumulatedText = '';
          const { ollamaChatStream } = await import('@/lib/local-llm');
          const config = {
            baseUrl: settings.localLlmUrl,
            model: settings.localLlmModel,
            enabled: settings.localLlmEnabled,
          };
          const ollamaHistory: OllamaMessage[] = messages.slice(-6).map((m) => ({
            role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
            content: m.content,
          }));
          const ollamaMessages: OllamaMessage[] = [
            ...ollamaHistory,
            { role: 'user', content: promptWithFiles },
          ];
          await ollamaChatStream(
            config, ollamaMessages,
            (chunk, done) => {
              if (signal.aborted) return;
              if (chunk) {
                accumulatedText += chunk;
                updateMessage(chatSessionId, msgId, {
                  streamingText: accumulatedText,
                  tokenCount: estimateTokens(accumulatedText),
                  isStreaming: !done,
                });
              }
              if (done) {
                updateMessage(chatSessionId, msgId, {
                  content: accumulatedText,
                  streamingText: undefined,
                  isStreaming: false,
                  tokenCount: estimateTokens(accumulatedText),
                  llmModelLabel: `${settings.localLlmModel} (offline fallback)`,
                });
              }
            },
            120000,
            signal,
          );
        } else if (!result.success && !accumulatedText) {
          updateMessage(chatSessionId, msgId, {
            content: '', error: result.error ?? 'Cerebras error',
            isStreaming: false,
          });
        }
      } catch (err) {
        if (!signal.aborted) {
          updateMessage(chatSessionId, msgId, {
            content: '', error: `Cerebras error: ${err instanceof Error ? err.message : String(err)}`,
            isStreaming: false,
          });
        }
      }
      return { handled: true };
    }

    // ── Groq (fast chat fallback, offline → local LLM fallback) ──
    if (target === 'groq') {
      const groqKey = settings.groqApiKey ?? '';
      if (!groqKey) {
        // No key — shouldn't reach here, but handle gracefully
        return { handled: false };
      }

      const msgId = addAssistantMessage(chatSessionId, 'groq');
      streamingMsgRef.current = { sessionId: chatSessionId, msgId };

      try {
        let accumulatedText = '';
        updateMessage(chatSessionId, msgId, { isStreaming: true, streamingText: '', tokenCount: 0, streamingStartTime: Date.now() });

        const groqHistory: GroqMessage[] = messages.slice(-6).map((m) => ({
          role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
          content: m.content,
        }));

        // Memories: inject custom context as system message
        const groqCustomCtx = await loadCustomContext().catch(() => '');
        if (groqCustomCtx) {
          groqHistory.unshift({ role: 'user' as const, content: `[System Context]\n${groqCustomCtx}` });
        }

        // Cross-pane: inject terminal context
        const termCtx = await getTerminalContextForPrompt(prompt, isWide ?? false);
        const groqPrompt = termCtx ? promptWithFiles + termCtx : promptWithFiles;

        const result = await groqChatStream(
          groqKey,
          groqPrompt,
          (chunk, done) => {
            if (signal.aborted) return;
            if (chunk) {
              accumulatedText += chunk;
              updateMessage(chatSessionId, msgId, {
                streamingText: accumulatedText,
                tokenCount: estimateTokens(accumulatedText),
                isStreaming: !done,
              });
            }
            if (done) {
              updateMessage(chatSessionId, msgId, {
                content: accumulatedText,
                streamingText: undefined,
                isStreaming: false,
                tokenCount: estimateTokens(accumulatedText),
              });
              useExecutionLogStore.getState().addEntry({
                source: 'ai-agent',
                agent: 'Groq',
                userInput: prompt,
                aiResponse: accumulatedText.slice(0, 200),
              });
            }
          },
          settings.groqModel || 'llama-3.3-70b-versatile',
          groqHistory,
          signal,
        );

        // Offline fallback: if Groq failed due to network, try local LLM
        if (!result.success && result.networkError && settings.localLlmEnabled) {
          // Clear the failed Groq message
          updateMessage(chatSessionId, msgId, {
            content: '',
            streamingText: t('dispatch.offline_fallback'),
            isStreaming: true,
          });

          accumulatedText = '';
          const { ollamaChatStream } = await import('@/lib/local-llm');
          const config = {
            baseUrl: settings.localLlmUrl,
            model: settings.localLlmModel,
            enabled: settings.localLlmEnabled,
          };
          const ollamaHistory: OllamaMessage[] = messages.slice(-6).map((m) => ({
            role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
            content: m.content,
          }));

          const ollamaMessages: OllamaMessage[] = [
            ...ollamaHistory,
            { role: 'user', content: promptWithFiles },
          ];
          const localResult = await ollamaChatStream(
            config, ollamaMessages,
            (chunk, done) => {
              if (signal.aborted) return;
              if (chunk) {
                accumulatedText += chunk;
                updateMessage(chatSessionId, msgId, {
                  streamingText: accumulatedText,
                  tokenCount: estimateTokens(accumulatedText),
                  isStreaming: !done,
                });
              }
              if (done) {
                updateMessage(chatSessionId, msgId, {
                  content: accumulatedText,
                  streamingText: undefined,
                  isStreaming: false,
                  tokenCount: estimateTokens(accumulatedText),
                  llmModelLabel: `${settings.localLlmModel} (offline fallback)`,
                });
                useExecutionLogStore.getState().addEntry({
                  source: 'ai-agent',
                  agent: 'Local LLM (offline fallback)',
                  userInput: prompt,
                  aiResponse: accumulatedText.slice(0, 200),
                });
              }
            },
            120000,
            signal,
          );

          if (!localResult.success && !accumulatedText) {
            updateMessage(chatSessionId, msgId, {
              content: '', error: t('dispatch.offline_no_local'),
              isStreaming: false,
            });
          }
        } else if (!result.success && !accumulatedText) {
          updateMessage(chatSessionId, msgId, {
            content: '', error: result.error ?? 'Groq error',
            isStreaming: false,
          });
        }
      } catch (err) {
        if (!signal.aborted) {
          updateMessage(chatSessionId, msgId, {
            content: '', error: `Groq error: ${err instanceof Error ? err.message : String(err)}`,
            isStreaming: false,
          });
        }
      }
      return { handled: true };
    }

    // ── Perplexity ──
    if (target === 'perplexity') {
      const msgId = addAssistantMessage(chatSessionId, 'perplexity');
      streamingMsgRef.current = { sessionId: chatSessionId, msgId };
      const apiKey = settings.perplexityApiKey ?? '';
      if (!apiKey) {
        updateMessage(chatSessionId, msgId, {
          content: t('dispatch.perplexity_no_key'),
          isStreaming: false, error: t('dispatch.api_key_not_set'),
        });
        return { handled: true };
      }

      let accumulated = '';
      let citations: Array<{ url: string; title?: string }> = [];
      updateMessage(chatSessionId, msgId, { isStreaming: true, streamingText: '', streamingStartTime: Date.now() });

      try {
        const { perplexitySearchStream } = await import('@/lib/perplexity');
        const pplxHistory = toPerplexityHistory(messages);
        // Cross-pane: inject terminal context
        const termCtx = await getTerminalContextForPrompt(prompt, isWide ?? false);
        const pplxPrompt = termCtx ? promptWithFiles + termCtx : promptWithFiles;
        await perplexitySearchStream(apiKey, pplxPrompt, (chunk, done, cits) => {
          if (signal.aborted) return;
          if (chunk) {
            accumulated += chunk;
            updateMessage(chatSessionId, msgId, {
              streamingText: accumulated,
              tokenCount: estimateTokens(accumulated),
              isStreaming: !done,
            });
          }
          if (cits && cits.length > 0) citations = cits;
          if (done) {
            updateMessage(chatSessionId, msgId, {
              content: accumulated, streamingText: undefined, isStreaming: false,
              tokenCount: estimateTokens(accumulated), citations,
            });
          }
        }, settings.perplexityModel ?? undefined, pplxHistory, signal);
      } catch (err) {
        if (!signal.aborted) {
          updateMessage(chatSessionId, msgId, {
            content: accumulated || '',
            error: `Perplexity error: ${err instanceof Error ? err.message : String(err)}`,
            isStreaming: false,
          });
        }
      }
      return { handled: true };
    }

    // ── Gemini ──
    if (target === 'gemini') {
      const msgId = addAssistantMessage(chatSessionId, 'gemini');
      streamingMsgRef.current = { sessionId: chatSessionId, msgId };
      const apiKey = settings.geminiApiKey ?? '';

      // APIキーなし → Gemini CLIをネイティブ実行
      if (!apiKey) {
        const termCtx = await getTerminalContextForPrompt(prompt, isWide ?? false);
        const contextualPrompt = promptWithFiles + toTextContext(messages) + termCtx;
        const escaped = contextualPrompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
        const cliCommand = `gemini --prompt "${escaped}"`;
        let accumulated = `$ ${cliCommand}\n\n`;
        updateMessage(chatSessionId, msgId, { isStreaming: true, streamingText: accumulated, streamingStartTime: Date.now() });

        try {
          const result = await bridgeRunCommand(cliCommand, {
            onStream: (type, data) => {
              if (signal.aborted) return;
              accumulated += data;
              detectAndOpenAuthUrls(data);
              updateMessage(chatSessionId, msgId, {
                streamingText: filterCliOutput(accumulated),
                tokenCount: estimateTokens(accumulated),
              });
            },
          });
          let output = result.stdout || '';
          if (result.stderr) {
            const filteredStderr = filterCliOutput(result.stderr).trim();
            if (filteredStderr) output += `\n--- stderr ---\n${filteredStderr}`;
          }
          output = filterCliOutput(output);
          updateMessage(chatSessionId, msgId, {
            content: output, streamingText: undefined, isStreaming: false,
            tokenCount: estimateTokens(output),
            executions: [{ command: cliCommand, output, exitCode: result.exitCode, isCollapsed: output.split('\n').length > 10 }],
          });
          useExecutionLogStore.getState().addEntry({
            source: 'ai-agent', agent: 'Gemini CLI', command: cliCommand,
            output: output.slice(0, 500), exitCode: result.exitCode, userInput: prompt,
          });
        } catch (err) {
          if (!signal.aborted) {
            updateMessage(chatSessionId, msgId, {
              content: '', error: `Gemini CLI error: ${err instanceof Error ? err.message : String(err)}`, isStreaming: false,
            });
          }
        }
        return { handled: true };
      }

      let accumulated = '';
      updateMessage(chatSessionId, msgId, { isStreaming: true, streamingText: '', streamingStartTime: Date.now() });

      try {
        const { geminiChatStream } = await import('@/lib/gemini');
        const geminiHistory = toGeminiHistory(messages);
        // Cross-pane: inject terminal context
        const termCtx = await getTerminalContextForPrompt(prompt, isWide ?? false);
        const geminiPrompt = termCtx ? promptWithFiles + termCtx : promptWithFiles;
        const result = await geminiChatStream(apiKey, geminiPrompt, (chunk, done) => {
          if (signal.aborted) return;
          if (chunk) {
            accumulated += chunk;
            updateMessage(chatSessionId, msgId, {
              streamingText: accumulated,
              tokenCount: estimateTokens(accumulated),
              isStreaming: !done,
            });
          }
          if (done) {
            updateMessage(chatSessionId, msgId, {
              content: accumulated, streamingText: undefined, isStreaming: false,
              tokenCount: estimateTokens(accumulated),
            });
          }
        }, settings.geminiModel ?? 'gemini-2.0-flash', geminiHistory, signal);
        if (!result.success && !accumulated) {
          updateMessage(chatSessionId, msgId, {
            content: '', error: `Gemini error: ${result.error ?? 'Unknown error'}`,
            isStreaming: false,
          });
        }
      } catch (err) {
        if (!signal.aborted) {
          updateMessage(chatSessionId, msgId, {
            content: '', error: `Gemini error: ${err instanceof Error ? err.message : String(err)}`,
            isStreaming: false,
          });
        }
      }
      return { handled: true };
    }

    // ── Team roundtable ──
    if (target === 'team') {
      const msgId = addAssistantMessage(chatSessionId, 'team');
      streamingMsgRef.current = { sessionId: chatSessionId, msgId };
      const { runTeamRoundtable } = await import('@/lib/team-roundtable');
      const teamMembers = settings.teamMembers ?? { claude: true, gemini: true, codex: false, perplexity: true, local: true };
      const teamSettingsObj = {
        claudeEnabled: teamMembers.claude,
        geminiEnabled: teamMembers.gemini,
        codexEnabled: teamMembers.codex,
        perplexityEnabled: teamMembers.perplexity && !!settings.perplexityApiKey,
        localEnabled: teamMembers.local && settings.localLlmEnabled,
        facilitatorPriority: settings.teamFacilitatorPriority ?? ['local', 'claude', 'gemini', 'codex', 'perplexity'],
        codexCmd: settings.codexCmd ?? 'codex',
        claudeCmd: 'claude',
        geminiCmd: 'gemini',
      };
      const enabledCount = [teamSettingsObj.claudeEnabled, teamSettingsObj.geminiEnabled, teamSettingsObj.codexEnabled, teamSettingsObj.perplexityEnabled, teamSettingsObj.localEnabled].filter(Boolean).length;
      if (enabledCount === 0) {
        updateMessage(chatSessionId, msgId, {
          content: t('dispatch.team_no_agents'),
          isStreaming: false,
        });
        return { handled: true };
      }

      let teamAccumulated = `${t('dispatch.team_asking', { count: enabledCount })}\n\n`;
      updateMessage(chatSessionId, msgId, { isStreaming: true, streamingText: teamAccumulated, streamingStartTime: Date.now() });

      try {
        const teamResult = await runTeamRoundtable(promptWithFiles, teamSettingsObj, {
          runCommand: (cmd: string) => bridgeRunCommand(cmd).then((r) => r.stdout ?? '').catch(() => ''),
          perplexityApiKey: settings.perplexityApiKey,
          perplexityModel: settings.perplexityModel,
          geminiApiKey: settings.geminiApiKey,
          geminiModel: settings.geminiModel,
          localLlmUrl: settings.localLlmUrl,
          localLlmModel: settings.localLlmModel,
          onMemberResult: (memberResult) => {
            teamAccumulated += `\n\n--- ${memberResult.label} ---\n${memberResult.response}`;
            updateMessage(chatSessionId, msgId, { streamingText: teamAccumulated });
          },
          onFacilitatorChunk: (chunk: string) => {
            teamAccumulated += chunk;
            updateMessage(chatSessionId, msgId, { streamingText: teamAccumulated });
          },
        });
        const facilitatorLabel = teamResult.facilitator?.label ?? 'Facilitator';
        const memberDetails = teamResult.members.filter(m => !m.isFacilitator).map(m => `\n--- ${m.label} ---\n${m.response}`).join('\n');
        const finalText = `=== Summary (${facilitatorLabel}) ===\n${teamResult.facilitatorSummary}\n\n──── Agent Responses ────${memberDetails}`;
        updateMessage(chatSessionId, msgId, { content: finalText, streamingText: undefined, isStreaming: false, tokenCount: estimateTokens(finalText) });
      } catch (err) {
        updateMessage(chatSessionId, msgId, { content: '', error: `@team error: ${err instanceof Error ? err.message : String(err)}`, isStreaming: false });
      }
      return { handled: true };
    }

    // ── Claude (via native CLI) ──
    if (target === 'claude') {
      const msgId = addAssistantMessage(chatSessionId, 'claude');
      streamingMsgRef.current = { sessionId: chatSessionId, msgId };

      try {
        const { buildChatModeClaudeCommand, detectPermissionPrompt, shouldAutoApprove } = await import('@/lib/cli-permission-proxy');
        const autoApprove = (settings.autoApproveLevel ?? 'safe') as import('@/lib/cli-permission-proxy').AutoApproveLevel;
        const contextualPrompt = promptWithFiles + toTextContext(messages);
        const cliCommand = buildChatModeClaudeCommand(contextualPrompt, autoApprove);
        let accumulated = `$ ${cliCommand}\n\n`;
        updateMessage(chatSessionId, msgId, { isStreaming: true, streamingText: accumulated, streamingStartTime: Date.now() });

        const result = await bridgeRunCommand(cliCommand, {
          onStream: (type, data) => {
            if (signal.aborted) return;
            accumulated += data;
            detectAndOpenAuthUrls(data);
            updateMessage(chatSessionId, msgId, {
              streamingText: filterCliOutput(accumulated),
              tokenCount: estimateTokens(accumulated),
            });
          },
        });
        let output = result.stdout || '';
        if (result.stderr) {
          // Filter stderr warnings before appending
          const filteredStderr = filterCliOutput(result.stderr).trim();
          if (filteredStderr) output += `\n--- stderr ---\n${filteredStderr}`;
        }
        output = filterCliOutput(output);
        updateMessage(chatSessionId, msgId, {
          content: output, streamingText: undefined, isStreaming: false,
          tokenCount: estimateTokens(output),
          executions: [{ command: cliCommand, output, exitCode: result.exitCode, isCollapsed: output.split('\n').length > 10 }],
        });
        // Log to shared execution log (visible in Terminal tab)
        useExecutionLogStore.getState().addEntry({
          source: 'ai-agent',
          agent: 'Claude',
          command: cliCommand,
          output: output.slice(0, 500),
          exitCode: result.exitCode,
          userInput: prompt,
        });
      } catch (err) {
        if (!signal.aborted) {
          updateMessage(chatSessionId, msgId, {
            content: '', error: `Claude Code error: ${err instanceof Error ? err.message : String(err)}`, isStreaming: false,
          });
        }
      }
      return { handled: true };
    }

    // ── Codex (via native CLI) ──
    if (target === 'codex') {
      const msgId = addAssistantMessage(chatSessionId, 'codex');
      streamingMsgRef.current = { sessionId: chatSessionId, msgId };

      try {
        const codexCmd = settings.codexCmd ?? 'codex';
        const escaped = promptWithFiles.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
        const cliCommand = `${codexCmd} -p '${escaped}'`;
        let accumulated = `$ ${cliCommand}\n\n`;
        updateMessage(chatSessionId, msgId, { isStreaming: true, streamingText: accumulated, streamingStartTime: Date.now() });

        const result = await bridgeRunCommand(cliCommand, {
          onStream: (type, data) => {
            if (signal.aborted) return;
            accumulated += data;
            detectAndOpenAuthUrls(data);
            updateMessage(chatSessionId, msgId, {
              streamingText: filterCliOutput(accumulated),
              tokenCount: estimateTokens(accumulated),
            });
          },
        });
        let output = result.stdout || '';
        if (result.stderr) {
          const filteredStderr = filterCliOutput(result.stderr).trim();
          if (filteredStderr) output += `\n--- stderr ---\n${filteredStderr}`;
        }
        output = filterCliOutput(output);
        updateMessage(chatSessionId, msgId, {
          content: output, streamingText: undefined, isStreaming: false,
          tokenCount: estimateTokens(output),
          executions: [{ command: cliCommand, output, exitCode: result.exitCode, isCollapsed: output.split('\n').length > 10 }],
        });
        useExecutionLogStore.getState().addEntry({
          source: 'ai-agent', agent: 'Codex', command: cliCommand,
          output: output.slice(0, 500), exitCode: result.exitCode, userInput: prompt,
        });
      } catch (err) {
        if (!signal.aborted) {
          updateMessage(chatSessionId, msgId, {
            content: '', error: `Codex error: ${err instanceof Error ? err.message : String(err)}`, isStreaming: false,
          });
        }
      }
      return { handled: true };
    }

    // ── Agent mode (Gemini function calling + bridge tools) ──
    if (target === 'agent') {
      const msgId = addAssistantMessage(chatSessionId, 'gemini');
      streamingMsgRef.current = { sessionId: chatSessionId, msgId };
      const apiKey = settings.geminiApiKey ?? '';
      if (!apiKey) {
        updateMessage(chatSessionId, msgId, {
          content: t('dispatch.agent_no_key'),
          isStreaming: false,
          error: t('dispatch.api_key_not_set'),
        });
        return { handled: true };
      }

      let accumulated = `🤖 ${t('dispatch.agent_started')}\n`;
      updateMessage(chatSessionId, msgId, { isStreaming: true, streamingText: accumulated, streamingStartTime: Date.now() });

      try {
        const { runAgentLoop } = await import('@/lib/ai-tool-agent');

        const tools = {
          readFile: bridgeReadFile,
          writeFile: bridgeWriteFile,
          editFile: bridgeEditFile,
          listFiles: bridgeListFiles,
          runCommand: bridgeRunCommand,
        };

        const result = await runAgentLoop(
          apiKey,
          promptWithFiles,
          tools,
          (text) => {
            if (signal.aborted) return;
            accumulated += text;
            updateMessage(chatSessionId, msgId, {
              streamingText: accumulated,
              tokenCount: estimateTokens(accumulated),
            });
          },
          (toolName, args) => {
            // Tool call notification — already streamed in onStream
          },
          settings.geminiModel ?? 'gemini-2.0-flash',
          signal,
        );

        // result.response is already streamed via onStream, no need to append again
        updateMessage(chatSessionId, msgId, {
          content: accumulated,
          streamingText: undefined,
          isStreaming: false,
          tokenCount: estimateTokens(accumulated),
        });
      } catch (err) {
        if (!signal.aborted) {
          updateMessage(chatSessionId, msgId, {
            content: accumulated || '',
            error: `Agent error: ${err instanceof Error ? err.message : String(err)}`,
            isStreaming: false,
          });
        }
      }
      return { handled: true };
    }

    // ── Git guide ──
    if (target === 'git') {
      const msgId = addAssistantMessage(chatSessionId, 'git');
      const intent = detectGitIntent(prompt);
      const guide = generateGuide(intent, prompt);
      if (guide.prereqCommand) {
        terminalRunCommand(guide.prereqCommand);
      }
      const stepsText = guide.steps?.map((s) =>
        s.type === 'command' ? `\`${s.command}\`\n${s.explanation}` : s.explanation
      ).join('\n\n') ?? '';
      updateMessage(chatSessionId, msgId, {
        content: `## ${guide.title}\n\n${guide.overview ?? ''}\n\n${stepsText}`,
        isStreaming: false,
      });
      return { handled: true };
    }

    // ── @plan → Plan Mode via best available API ──
    if (target === 'plan') {
      // Pick best available provider
      const planProvider = settings.cerebrasApiKey ? 'cerebras'
        : settings.groqApiKey ? 'groq'
        : settings.localLlmEnabled ? 'local'
        : 'gemini-cli';

      const msgId = addAssistantMessage(chatSessionId, planProvider === 'cerebras' ? 'cerebras' : planProvider === 'groq' ? 'groq' : 'gemini');
      streamingMsgRef.current = { sessionId: chatSessionId, msgId };

      const planSystemPrompt = `You are a project planner. Respond ONLY in a structured Plan format. Use a numbered list with clear steps. Include code blocks for commands. Start with "## Plan" header. Respond in the same language as the user's request.

Example:
## Plan
1. Create project structure
   - src/index.html
   - src/style.css
2. Install dependencies
   \`\`\`bash
   npm install express
   \`\`\`
3. Configure build system`;

      const fullPrompt = `${planSystemPrompt}\n\nUser request: ${promptWithFiles}`;

      updateMessage(chatSessionId, msgId, { isStreaming: true, streamingText: '', streamingStartTime: Date.now() });
      let accumulated = '';

      try {
        if (planProvider === 'cerebras') {
          const { cerebrasChatStream } = await import('@/lib/cerebras');
          await cerebrasChatStream(settings.cerebrasApiKey!, fullPrompt, (chunk: string) => {
            accumulated += chunk;
            updateMessage(chatSessionId, msgId, { streamingText: accumulated });
          });
        } else if (planProvider === 'groq') {
          const { groqChatStream } = await import('@/lib/groq');
          await groqChatStream(settings.groqApiKey!, fullPrompt, (chunk: string) => {
            accumulated += chunk;
            updateMessage(chatSessionId, msgId, { streamingText: accumulated });
          });
        } else if (planProvider === 'local') {
          const { ollamaChatStream } = await import('@/lib/local-llm');
          await ollamaChatStream(
            { baseUrl: settings.localLlmUrl, model: settings.localLlmModel, enabled: true },
            [{ role: 'user' as const, content: fullPrompt }],
            (chunk: string) => {
              accumulated += chunk;
              updateMessage(chatSessionId, msgId, { streamingText: accumulated });
            },
          );
        } else if (planProvider === 'gemini-cli') {
          const result = await bridgeRunCommand(`gemini "${fullPrompt.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`);
          accumulated = result.stdout || '';
        } else {
          accumulated = `## Plan\n\n1. No AI provider available\n   - Configure Cerebras, Groq, or Local LLM in Settings\n   - Or install Gemini CLI for CLI access`;
        }
      } catch (e) {
        accumulated = accumulated || `## Plan\n\n1. Error generating plan\n   - ${String(e)}`;
      }

      // Parse and store plan
      const plan = parsePlanOutput(accumulated, planProvider || 'unknown');
      if (plan) {
        usePlanStore.getState().setActivePlan(plan);
      }

      updateMessage(chatSessionId, msgId, {
        content: accumulated,
        isStreaming: false,
      });
      return { handled: true };
    }

    // ── @arena → Blind AI comparison ──
    if (target === 'arena') {
      const agents = selectArenaAgents(settings);
      const arenaId = useArenaStore.getState().startArena(promptWithFiles, agents);

      // Add arena bubble to chat
      const arenaMsg: ChatMessage = {
        id: generateId(),
        role: 'system',
        content: '',
        timestamp: Date.now(),
        arenaId,
      };
      useChatStore.getState().addMessage(chatSessionId, arenaMsg);

      // Dispatch to both agents sequentially (OOM-safe for Termux)
      for (let i = 0; i < agents.length; i++) {
        const agent = agents[i];
        const candidateId = `${arenaId}-${i}`;

        try {
          let accumulated = '';

          if (agent === 'local' && settings.localLlmEnabled) {
            const { ollamaChatStream } = await import('@/lib/local-llm');
            await ollamaChatStream(
              { baseUrl: settings.localLlmUrl, model: settings.localLlmModel, enabled: true },
              [{ role: 'user' as const, content: promptWithFiles }],
              (chunk: string) => {
                accumulated += chunk;
                useArenaStore.getState().updateCandidate(arenaId, candidateId, { response: accumulated });
              },
            );
          } else if (agent === 'groq' && settings.groqApiKey) {
            const { groqChatStream } = await import('@/lib/groq');
            await groqChatStream(
              settings.groqApiKey, promptWithFiles,
              (chunk: string) => {
                accumulated += chunk;
                useArenaStore.getState().updateCandidate(arenaId, candidateId, { response: accumulated });
              },
            );
          } else if (agent === 'cerebras' && settings.cerebrasApiKey) {
            const { cerebrasChatStream } = await import('@/lib/cerebras');
            await cerebrasChatStream(
              settings.cerebrasApiKey, promptWithFiles,
              (chunk: string) => {
                accumulated += chunk;
                useArenaStore.getState().updateCandidate(arenaId, candidateId, { response: accumulated });
              },
            );
          } else if (agent === 'claude' || agent === 'gemini') {
            const cli = agent === 'claude' ? 'claude' : 'gemini';
            try {
              const escaped = promptWithFiles.replace(/"/g, '\\"').replace(/\n/g, '\\n');
              const result = await bridgeRunCommand(`${cli} "${escaped}"`);
              accumulated = result.stdout || '';
            } catch (e) {
              accumulated = `Error: ${String(e)}`;
            }
          } else {
            accumulated = `(${agent} not available)`;
          }

          useArenaStore.getState().updateCandidate(arenaId, candidateId, {
            response: accumulated || '(no response)',
            isStreaming: false,
          });
        } catch (e) {
          useArenaStore.getState().updateCandidate(arenaId, candidateId, {
            response: '',
            isStreaming: false,
            error: String(e),
          });
        }
      }

      return { handled: true };
    }

    return { handled: false };
  }, [updateMessage, settings, terminalRunCommand, bridgeRunCommand, addAssistantMessage]);

  return { dispatch, cancelStreaming };
}
