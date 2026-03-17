/**
 * hooks/use-ai-dispatch.ts
 *
 * AI agent dispatcher hook — extracted from ChatScreen's handleSend.
 * Handles routing to Local LLM, Gemini, Perplexity, Claude, Team, Git.
 * Provides conversation context (last N messages) to each AI.
 */

import { useCallback, useRef, useMemo, useEffect } from 'react';
import { useChatStore, type ChatMessage, type ChatAgent } from '@/store/chat-store';
import { useTerminalStore } from '@/store/terminal-store';
import { useTermuxBridge } from '@/hooks/use-termux-bridge';
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
import { t } from '@/lib/i18n';
import { useExecutionLogStore } from '@/store/execution-log-store';

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

// ─── Types ──────────────────────────────────────────────────────────────────

type DispatchParams = {
  target: string;
  prompt: string;
  chatSessionId: string;
  messages: ChatMessage[];
  images?: ImageAttachment[];
  files?: FileAttachment[];
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
  const connectionMode = useTerminalStore((s) => s.connectionMode);
  const { sendCommand, runCommand: bridgeRunCommand, readFile: bridgeReadFile, writeFile: bridgeWriteFile, editFile: bridgeEditFile, listFiles: bridgeListFiles } = useTermuxBridge();
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
    const { target, prompt, chatSessionId, messages, images, files } = params;
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
          [customCtx, decisionLog ? `\n# Past Design Decisions\n${decisionLog}` : ''].filter(Boolean).join('\n') || undefined,
          undefined, // toolStatuses
          undefined, // defaultAgent
          signal,
          true, // forceLocal — @local mention skips routing
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
            if (connectionMode === 'termux') {
              sendCommand(result.delegatedCommand);
            } else {
              terminalRunCommand(result.delegatedCommand);
            }
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
        await perplexitySearchStream(apiKey, promptWithFiles, (chunk, done, cits) => {
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
      if (!apiKey) {
        updateMessage(chatSessionId, msgId, {
          content: t('dispatch.gemini_no_key'),
          isStreaming: false, error: t('dispatch.api_key_not_set'),
        });
        return { handled: true };
      }

      let accumulated = '';
      updateMessage(chatSessionId, msgId, { isStreaming: true, streamingText: '', streamingStartTime: Date.now() });

      try {
        const { geminiChatStream } = await import('@/lib/gemini');
        const geminiHistory = toGeminiHistory(messages);
        const result = await geminiChatStream(apiKey, promptWithFiles, (chunk, done) => {
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
          runCommand: (cmd: string) => new Promise((resolve) => {
            if (connectionMode === 'termux') {
              sendCommand(cmd);
              setTimeout(() => resolve('(CLI running)'), 3000);
            } else {
              resolve(`[Disconnected] ${cmd}`);
            }
          }),
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

    // ── Claude (via Termux CLI) ──
    if (target === 'claude') {
      const msgId = addAssistantMessage(chatSessionId, 'claude');
      streamingMsgRef.current = { sessionId: chatSessionId, msgId };
      if (connectionMode !== 'termux') {
        updateMessage(chatSessionId, msgId, {
          content: t('dispatch.claude_connect'),
          isStreaming: false,
        });
        return { handled: true };
      }

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
            updateMessage(chatSessionId, msgId, {
              streamingText: accumulated,
              tokenCount: estimateTokens(accumulated),
            });
          },
        });
        let output = result.stdout || '';
        if (result.stderr) output += `\n--- stderr ---\n${result.stderr}`;
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

      if (connectionMode !== 'termux') {
        updateMessage(chatSessionId, msgId, {
          content: t('dispatch.agent_no_termux'),
          isStreaming: false,
          error: t('dispatch.termux_not_connected'),
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
      if (guide.prereqCommand && connectionMode === 'termux') {
        sendCommand(guide.prereqCommand);
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

    return { handled: false };
  }, [updateMessage, settings, connectionMode, sendCommand, terminalRunCommand, bridgeRunCommand, addAssistantMessage]);

  return { dispatch, cancelStreaming };
}
