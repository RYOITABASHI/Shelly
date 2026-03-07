/**
 * app/(tabs)/index.tsx
 *
 * Chat-first UI — GPT/Claude style.
 * User messages on right, AI responses on left.
 * Shell commands also routed through chat bubbles.
 */

import React, { useEffect, useCallback, useState, useRef } from 'react';
import {
  View,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  StatusBar,
  Modal,
  Text,
  Pressable,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTerminalStore, useActiveSession } from '@/store/terminal-store';
import { useChatStore, type ChatMessage, type ChatAgent } from '@/store/chat-store';
import { ChatMessageList } from '@/components/chat/ChatMessageList';
import { ChatHeader } from '@/components/chat/ChatHeader';
import { CommandInput, type ImageAttachment } from '@/components/input/CommandInput';
import { useTermuxBridge } from '@/hooks/use-termux-bridge';
import { parseInput, buildRoutingDetail } from '@/lib/input-router';
import { orchestrateTask, orchestrateChatStream } from '@/lib/local-llm';
import { interpretTermuxOutput, explainCommandIntent } from '@/lib/llm-interpreter';
import { loadProjectContext, generateProjectContext, clearProjectContextCache } from '@/lib/project-context';
import { loadUserProfile, learnFromCommand, learnFromAgentUse, learnFromUserInput, learnFromProject, formatProfileForPrompt } from '@/lib/user-profile';
import { requestNotificationPermission } from '@/lib/command-notifier';
import { checkCommandSafety, needsConfirmation, dangerLevelColor } from '@/lib/command-safety';
import { detectGitIntent, generateGuide } from '@/lib/git-assistant';
import { useTheme } from '@/hooks/use-theme';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function mapTargetToAgent(target: string): ChatAgent | undefined {
  const agentMap: Record<string, ChatAgent> = {
    claude: 'claude',
    gemini: 'gemini',
    local: 'local',
    perplexity: 'perplexity',
    team: 'team',
    git: 'git',
    codex: 'codex',
  };
  return agentMap[target];
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function ChatScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  // ── Terminal store (settings, bridge config) ──
  const {
    runCommand,
    navigateHistory,
    loadSettings,
    connectionMode,
    pendingCommand,
    settings,
    setLastInputMode,
  } = useTerminalStore();
  const activeSession = useActiveSession();

  // ── Chat store ──
  const {
    load: loadChat,
    isLoaded: chatLoaded,
    createSession: createChatSession,
    addMessage,
    updateMessage,
  } = useChatStore();
  // Reactive selector for active session (re-renders when session/messages change)
  const chatSession = useChatStore((s) =>
    s.sessions.find((sess) => sess.id === s.activeSessionId) ?? null
  );

  // Load chat store on mount
  useEffect(() => {
    loadChat();
  }, []);

  // Ensure there's always an active chat session
  useEffect(() => {
    if (!chatLoaded) return;
    if (!chatSession) {
      createChatSession('New Chat');
    }
  }, [chatLoaded, chatSession]);

  // Get current chat session messages
  const messages = chatSession?.messages ?? [];
  const chatSessionId = chatSession?.id ?? '';

  // ── Bridge ──
  const { sendCommand, cancelCurrent, isConnected: isBridgeConnected, runCommand: bridgeRunCommand } = useTermuxBridge();

  const execForContext = useCallback(
    async (cmd: string): Promise<string> => {
      const result = await bridgeRunCommand(cmd);
      return result.stdout;
    },
    [bridgeRunCommand],
  );

  // ── Refs ──
  const commandInputRef = useRef<{ setText: (t: string) => void } | null>(null);
  const userProfileRef = useRef<string>('');
  const projectContextRef = useRef<string>('');

  // ── Init ──
  useEffect(() => {
    loadSettings();
    requestNotificationPermission();
  }, []);

  useEffect(() => {
    if (pendingCommand) {
      commandInputRef.current?.setText(pendingCommand);
      useTerminalStore.setState({ pendingCommand: null });
    }
  }, [pendingCommand]);

  // ── User profile ──
  useEffect(() => {
    loadUserProfile().then((p) => {
      userProfileRef.current = formatProfileForPrompt(p);
    });
  }, []);

  // ── Project context ──
  useEffect(() => {
    if (!isBridgeConnected || !settings.localLlmEnabled) return;
    const cwd = activeSession.currentDir;
    loadProjectContext(cwd, execForContext).then(async (ctx) => {
      if (ctx) {
        projectContextRef.current = ctx;
      } else {
        const hasProject = await execForContext(
          `test -f "${cwd}/package.json" -o -f "${cwd}/Cargo.toml" -o -f "${cwd}/go.mod" -o -f "${cwd}/pyproject.toml" -o -f "${cwd}/Makefile" && echo "yes" || echo "no"`,
        );
        if (hasProject.trim() === 'yes') {
          const generated = await generateProjectContext(cwd, execForContext);
          projectContextRef.current = generated;
          const projName = cwd.split('/').pop() ?? cwd;
          learnFromProject(cwd, projName).catch(() => {});
        }
      }
    });
  }, [isBridgeConnected, settings.localLlmEnabled, activeSession.currentDir]);

  // ── Safety dialog state ──
  const [safetyDialog, setSafetyDialog] = useState<{
    visible: boolean;
    message: string;
    level: string;
    color: string;
    command: string;
  } | null>(null);
  const [intentExplanation, setIntentExplanation] = useState<string>('');
  const [isExplainingIntent, setIsExplainingIntent] = useState(false);

  useEffect(() => {
    if (!safetyDialog?.visible) {
      setIntentExplanation('');
      setIsExplainingIntent(false);
      return;
    }
    const effectiveMode = settings.experienceMode ?? 'learning';
    if (effectiveMode === 'fast') return;
    if (!settings.localLlmEnabled) return;

    setIsExplainingIntent(true);
    setIntentExplanation('');
    let accumulated = '';

    explainCommandIntent(
      safetyDialog.command,
      {
        baseUrl: settings.localLlmUrl,
        model: settings.localLlmModel,
        enabled: settings.localLlmEnabled,
      },
      (chunk) => {
        accumulated += chunk;
        setIntentExplanation(accumulated);
      },
    ).then(() => {
      setIsExplainingIntent(false);
    });
  }, [safetyDialog?.visible, safetyDialog?.command, settings.experienceMode, settings.localLlmEnabled, settings.localLlmUrl, settings.localLlmModel]);

  const executeCommandSafely = useCallback((command: string) => {
    if (connectionMode === 'termux') {
      sendCommand(command);
    } else {
      runCommand(command);
    }
  }, [connectionMode, sendCommand, runCommand]);

  // ── Chat message helpers ──
  const addUserMessage = useCallback((text: string): string => {
    if (!chatSessionId) return '';
    const msg: ChatMessage = {
      id: generateId(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    addMessage(chatSessionId, msg);

    // Auto-name session from first user message
    if (messages.length === 0 && chatSession?.title === 'New Chat') {
      const title = text.length > 40 ? text.slice(0, 40) + '...' : text;
      useChatStore.setState((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === chatSessionId ? { ...s, title } : s
        ),
      }));
    }

    return msg.id;
  }, [chatSessionId, addMessage, messages.length, chatSession?.title]);

  const addAssistantMessage = useCallback((agent?: ChatAgent, content?: string): string => {
    if (!chatSessionId) return '';
    const msg: ChatMessage = {
      id: generateId(),
      role: 'assistant',
      content: content ?? '',
      timestamp: Date.now(),
      agent,
      isStreaming: !content,
    };
    addMessage(chatSessionId, msg);
    return msg.id;
  }, [chatSessionId, addMessage]);

  // ── handleSend: unified input handler ──
  const handleSend = useCallback(async (input: string, images?: ImageAttachment[]) => {
    if (!chatSessionId) return;
    const parsed = parseInput(input);

    // Auto-learn (background)
    if (parsed.layer === 'command') {
      learnFromCommand(parsed.prompt).catch(() => {});
    } else {
      learnFromUserInput(parsed.prompt).catch(() => {});
      if (parsed.target !== 'termux' && parsed.target !== 'suggest') {
        learnFromAgentUse(parsed.target).catch(() => {});
      }
    }
    loadUserProfile().then((p) => {
      userProfileRef.current = formatProfileForPrompt(p);
    });

    setLastInputMode(parsed.layer === 'command' ? 'shell' : 'natural');

    // ── Image-attached → Gemini multimodal ──
    if (images && images.length > 0) {
      addUserMessage(input);
      const msgId = addAssistantMessage('gemini');

      const apiKey = settings.geminiApiKey ?? '';
      if (!apiKey) {
        updateMessage(chatSessionId, msgId, {
          content: 'Gemini APIキーが設定されていません。\nhttps://aistudio.google.com/app/apikey で無料取得できます。',
          isStreaming: false,
          error: 'APIキー未設定',
        });
        return;
      }

      let accumulated = '';
      updateMessage(chatSessionId, msgId, { isStreaming: true, streamingText: '', streamingStartTime: Date.now() });

      const { geminiMultimodalStream } = await import('@/lib/gemini');
      const result = await geminiMultimodalStream(
        apiKey, input,
        images.map((img) => ({ base64: img.base64, mimeType: img.mimeType })),
        (chunk, done) => {
          if (chunk) {
            accumulated += chunk;
            updateMessage(chatSessionId, msgId, {
              streamingText: accumulated,
              tokenCount: Math.round(accumulated.length / 4),
              isStreaming: !done,
            });
          }
          if (done) {
            updateMessage(chatSessionId, msgId, {
              content: accumulated,
              streamingText: undefined,
              isStreaming: false,
              tokenCount: Math.round(accumulated.length / 4),
            });
          }
        },
        settings.geminiModel ?? 'gemini-2.0-flash',
      );
      if (!result.success && !accumulated) {
        updateMessage(chatSessionId, msgId, {
          content: '',
          error: `Geminiエラー: ${result.error ?? '不明なエラー'}`,
          isStreaming: false,
        });
      }
      return;
    }

    // ── shelly context ──
    if (parsed.layer === 'command' && /^shelly\s+context/i.test(parsed.prompt.trim())) {
      addUserMessage(input);
      const msgId = addAssistantMessage('local');
      updateMessage(chatSessionId, msgId, { isStreaming: true, streamingText: '解析中...' });
      try {
        const cwd = activeSession.currentDir;
        const ctx = await generateProjectContext(cwd, execForContext);
        projectContextRef.current = ctx;
        updateMessage(chatSessionId, msgId, {
          content: `.shelly/context.md を生成しました (${ctx.length}文字)\n\n${ctx.slice(0, 1500)}${ctx.length > 1500 ? '\n...(省略)' : ''}`,
          isStreaming: false,
        });
      } catch (err) {
        updateMessage(chatSessionId, msgId, {
          content: '',
          error: `context.md 生成失敗: ${err instanceof Error ? err.message : String(err)}`,
          isStreaming: false,
        });
      }
      return;
    }

    // ── Shell command → direct execution ──
    if (parsed.layer === 'command') {
      if (settings.enableCommandSafety) {
        const safety = checkCommandSafety(parsed.prompt);
        const effectiveMode = settings.experienceMode ?? 'learning';
        const threshold = effectiveMode === 'learning' ? 'MEDIUM'
          : effectiveMode === 'fast' ? 'CRITICAL'
          : (settings.safetyConfirmLevel ?? 'HIGH');
        const safetyIdx = ['SAFE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].indexOf(safety.level);
        const thresholdIdx = ['SAFE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].indexOf(threshold);
        if (needsConfirmation(safety) && safetyIdx >= thresholdIdx) {
          setSafetyDialog({
            visible: true,
            message: safety.message,
            level: safety.level,
            color: dangerLevelColor(safety.level),
            command: parsed.prompt,
          });
          return;
        }
      }

      // Add user message for the command, then add assistant message with execution result
      addUserMessage(`$ ${parsed.prompt}`);
      const msgId = addAssistantMessage(undefined);
      updateMessage(chatSessionId, msgId, { isStreaming: true, streamingText: '実行中...' });

      if (connectionMode === 'termux') {
        try {
          const result = await bridgeRunCommand(parsed.prompt);
          const output = result.stdout || '';
          const stderr = result.stderr ? `\n--- stderr ---\n${result.stderr}` : '';
          updateMessage(chatSessionId, msgId, {
            content: output + stderr,
            isStreaming: false,
            executions: [{
              command: parsed.prompt,
              output: output + stderr,
              exitCode: result.exitCode,
              isCollapsed: (output + stderr).split('\n').length > 10,
            }],
          });
        } catch (err) {
          updateMessage(chatSessionId, msgId, {
            content: '',
            error: `実行エラー: ${err instanceof Error ? err.message : String(err)}`,
            isStreaming: false,
          });
        }
      } else {
        updateMessage(chatSessionId, msgId, {
          content: 'Termuxに接続してください。',
          isStreaming: false,
          error: '未接続',
        });
      }
      return;
    }

    // ── AI routing (layers 1-3) ──
    addUserMessage(input);

    let target = parsed.target;
    const agent = mapTargetToAgent(target) ?? 'local';

    // Natural language → default to local LLM
    if (parsed.layer === 'natural') {
      if (settings.localLlmEnabled) {
        target = 'local';
      } else {
        const msgId = addAssistantMessage(undefined);
        updateMessage(chatSessionId, msgId, {
          content: '@mentionでツールを指定してください。例: @claude, @gemini, @local',
          isStreaming: false,
        });
        return;
      }
    }

    if (target === 'local') {
      const msgId = addAssistantMessage('local');
      const config = {
        baseUrl: settings.localLlmUrl,
        model: settings.localLlmModel,
        enabled: settings.localLlmEnabled,
      };

      let accumulatedText = '';
      updateMessage(chatSessionId, msgId, {
        isStreaming: true,
        streamingText: '',
        tokenCount: 0,
        streamingStartTime: Date.now(),
      });

      const result = await orchestrateChatStream(
        parsed.prompt, config,
        (chunk, done) => {
          if (chunk) {
            accumulatedText += chunk;
            updateMessage(chatSessionId, msgId, {
              streamingText: accumulatedText,
              tokenCount: Math.round(accumulatedText.length / 4),
              isStreaming: !done,
            });
          }
          if (done) {
            updateMessage(chatSessionId, msgId, {
              content: accumulatedText,
              streamingText: undefined,
              isStreaming: false,
              tokenCount: Math.round(accumulatedText.length / 4),
            });
          }
        },
        [],
        projectContextRef.current,
        userProfileRef.current,
      );

      if (result.handledBy !== 'local_llm') {
        updateMessage(chatSessionId, msgId, { isStreaming: false, streamingText: undefined });
        if (result.delegatedCommand) {
          const toolLabel = result.handledBy === 'gemini' ? 'Gemini CLI' : result.handledBy === 'codex' ? 'Codex CLI' : 'Claude Code';
          updateMessage(chatSessionId, msgId, {
            content: `${toolLabel}に委譲しました。\n理由: ${(result as any).reasoning || ''}`,
            agent: mapTargetToAgent(result.handledBy ?? '') ?? 'local',
            isStreaming: false,
          });
          if (connectionMode === 'termux') {
            sendCommand(result.delegatedCommand);
          } else {
            runCommand(result.delegatedCommand);
          }
        } else if ((result as any).response) {
          updateMessage(chatSessionId, msgId, {
            content: (result as any).response,
            isStreaming: false,
          });
        } else {
          updateMessage(chatSessionId, msgId, {
            content: '',
            error: 'Local LLMに接続できませんでした。Settingsで接続を確認してください。',
            isStreaming: false,
          });
        }
      }
    } else if (target === 'perplexity') {
      const msgId = addAssistantMessage('perplexity');
      const apiKey = settings.perplexityApiKey ?? '';
      if (!apiKey) {
        updateMessage(chatSessionId, msgId, {
          content: 'Perplexity APIキーが設定されていません。\nhttps://www.perplexity.ai/settings/api で取得できます。',
          isStreaming: false,
          error: 'APIキー未設定',
        });
        return;
      }

      let accumulated = '';
      let citations: Array<{ url: string; title?: string }> = [];
      updateMessage(chatSessionId, msgId, { isStreaming: true, streamingText: '', streamingStartTime: Date.now() });

      const { perplexitySearchStream } = await import('@/lib/perplexity');
      await perplexitySearchStream(apiKey, parsed.prompt, (chunk, done, cits) => {
        if (chunk) {
          accumulated += chunk;
          updateMessage(chatSessionId, msgId, {
            streamingText: accumulated,
            tokenCount: Math.round(accumulated.length / 4),
            isStreaming: !done,
          });
        }
        if (cits && cits.length > 0) citations = cits;
        if (done) {
          updateMessage(chatSessionId, msgId, {
            content: accumulated,
            streamingText: undefined,
            isStreaming: false,
            tokenCount: Math.round(accumulated.length / 4),
            citations,
          });
        }
      }, settings.perplexityModel ?? undefined);
    } else if (target === 'gemini') {
      const msgId = addAssistantMessage('gemini');
      const apiKey = settings.geminiApiKey ?? '';
      if (!apiKey) {
        updateMessage(chatSessionId, msgId, {
          content: 'Gemini APIキーが設定されていません。\nhttps://aistudio.google.com/app/apikey で無料取得できます。',
          isStreaming: false,
          error: 'APIキー未設定',
        });
        return;
      }

      let accumulated = '';
      updateMessage(chatSessionId, msgId, { isStreaming: true, streamingText: '', streamingStartTime: Date.now() });

      const { geminiChatStream } = await import('@/lib/gemini');
      const result = await geminiChatStream(apiKey, parsed.prompt, (chunk, done) => {
        if (chunk) {
          accumulated += chunk;
          updateMessage(chatSessionId, msgId, {
            streamingText: accumulated,
            tokenCount: Math.round(accumulated.length / 4),
            isStreaming: !done,
          });
        }
        if (done) {
          updateMessage(chatSessionId, msgId, {
            content: accumulated,
            streamingText: undefined,
            isStreaming: false,
            tokenCount: Math.round(accumulated.length / 4),
          });
        }
      }, settings.geminiModel ?? 'gemini-2.0-flash');
      if (!result.success && !accumulated) {
        updateMessage(chatSessionId, msgId, {
          content: '',
          error: `Geminiエラー: ${result.error ?? '不明なエラー'}`,
          isStreaming: false,
        });
      }
    } else if (target === 'team') {
      const msgId = addAssistantMessage('team');
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
          content: '@team に参加できるエージェントがいません。\n設定画面でエージェントを有効化してください。',
          isStreaming: false,
        });
        return;
      }

      let teamAccumulated = `${enabledCount}名のエージェントに質問中...\n\n`;
      updateMessage(chatSessionId, msgId, { isStreaming: true, streamingText: teamAccumulated, streamingStartTime: Date.now() });

      try {
        const teamResult = await runTeamRoundtable(parsed.prompt, teamSettingsObj, {
          runCommand: (cmd: string) => new Promise((resolve) => {
            if (connectionMode === 'termux') {
              sendCommand(cmd);
              setTimeout(() => resolve('(CLI実行中)'), 3000);
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
        const facilitatorLabel = teamResult.facilitator?.label ?? 'ファシリ';
        const memberDetails = teamResult.members
          .filter(m => !m.isFacilitator)
          .map(m => `\n--- ${m.label} ---\n${m.response}`)
          .join('\n');
        const finalText = `=== まとめ (${facilitatorLabel}) ===\n${teamResult.facilitatorSummary}\n\n──── 各エージェントの回答 ────${memberDetails}`;
        updateMessage(chatSessionId, msgId, {
          content: finalText,
          streamingText: undefined,
          isStreaming: false,
          tokenCount: Math.round(finalText.length / 4),
        });
      } catch (err) {
        updateMessage(chatSessionId, msgId, {
          content: '',
          error: `@teamエラー: ${err instanceof Error ? err.message : String(err)}`,
          isStreaming: false,
        });
      }
    } else if (target === 'claude') {
      const msgId = addAssistantMessage('claude');
      if (connectionMode !== 'termux') {
        updateMessage(chatSessionId, msgId, {
          content: 'Termuxに接続してください。Claude Codeの実行にはTermuxブリッジが必要です。',
          isStreaming: false,
        });
        return;
      }

      const { buildChatModeClaudeCommand } = await import('@/lib/cli-permission-proxy');
      const autoApprove = settings.autoApproveLevel ?? 'safe';
      const cliCommand = buildChatModeClaudeCommand(parsed.prompt, autoApprove);

      updateMessage(chatSessionId, msgId, {
        isStreaming: true,
        streamingText: `$ ${cliCommand}\n\n`,
        streamingStartTime: Date.now(),
      });

      try {
        const result = await bridgeRunCommand(cliCommand);
        let output = result.stdout || '';
        if (result.stderr) output += `\n--- stderr ---\n${result.stderr}`;
        updateMessage(chatSessionId, msgId, {
          content: output,
          streamingText: undefined,
          isStreaming: false,
          tokenCount: Math.round(output.length / 4),
          executions: [{
            command: cliCommand,
            output,
            exitCode: result.exitCode,
            isCollapsed: output.split('\n').length > 10,
          }],
        });
      } catch (err) {
        updateMessage(chatSessionId, msgId, {
          content: '',
          error: `Claude Code実行エラー: ${err instanceof Error ? err.message : String(err)}`,
          isStreaming: false,
        });
      }
    } else if (target === 'git') {
      const msgId = addAssistantMessage('git');
      const intent = detectGitIntent(parsed.prompt);
      const guide = generateGuide(intent, parsed.prompt);
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
    } else if (target === 'browser') {
      const url = parsed.prompt.trim();
      addUserMessage(`@open ${url}`);
      const msgId = addAssistantMessage(undefined);
      updateMessage(chatSessionId, msgId, {
        content: `ブラウザで開きます: ${url}`,
        isStreaming: false,
      });
      useTerminalStore.setState({ pendingBrowserUrl: url } as any);
      router.push('/(tabs)/browser' as any);
    }
  }, [chatSessionId, connectionMode, sendCommand, runCommand, activeSession.id, activeSession.currentDir, settings, addMessage, updateMessage, setLastInputMode, router, addUserMessage, addAssistantMessage, bridgeRunCommand, execForContext]);

  const handleCancel = useCallback(() => {
    cancelCurrent();
  }, [cancelCurrent]);

  const handleHistoryUp = useCallback((): string => {
    return navigateHistory('up');
  }, [navigateHistory]);

  const handleHistoryDown = useCallback((): string => {
    return navigateHistory('down');
  }, [navigateHistory]);

  // ── Render ──
  return (
    <View style={[styles.root, { paddingTop: insets.top, backgroundColor: colors.background }]}>
      {/* Safety confirmation dialog */}
      {safetyDialog && (
        <Modal
          transparent
          animationType="fade"
          visible={safetyDialog.visible}
          onRequestClose={() => setSafetyDialog(null)}
        >
          <View style={styles.safetyOverlay}>
            <View style={[styles.safetyDialog, { backgroundColor: colors.surfaceHigh }]}>
              <View style={[styles.safetyHeader, { borderLeftColor: safetyDialog.color }]}>
                <Text style={[styles.safetyLevel, { color: safetyDialog.color }]}>
                  {safetyDialog.level} RISK
                </Text>
                <Text style={[styles.safetyTitle, { color: colors.foreground }]}>
                  実行前に確認
                </Text>
              </View>
              <Text style={[styles.safetyMessage, { color: colors.muted }]}>
                {safetyDialog.message}
              </Text>
              {(settings.experienceMode ?? 'learning') === 'learning' && settings.localLlmEnabled && (intentExplanation || isExplainingIntent) && (
                <View style={styles.intentBox}>
                  {isExplainingIntent && !intentExplanation && (
                    <ActivityIndicator size="small" color="#A78BFA" style={{ marginRight: 8 }} />
                  )}
                  <Text style={styles.intentText}>
                    {intentExplanation || '解析中...'}
                  </Text>
                </View>
              )}
              <View style={[styles.commandBox, { borderColor: colors.border }]}>
                <Text style={styles.commandPrompt}>$ </Text>
                <Text style={[styles.commandText, { color: colors.foreground }]}>
                  {safetyDialog.command}
                </Text>
              </View>
              <View style={styles.safetyButtons}>
                <Pressable
                  style={[styles.safetyBtn, { backgroundColor: colors.surface }]}
                  onPress={() => setSafetyDialog(null)}
                >
                  <Text style={[styles.safetyBtnText, { color: colors.muted }]}>キャンセル</Text>
                </Pressable>
                <Pressable
                  style={[styles.safetyBtn, { backgroundColor: safetyDialog.color }]}
                  onPress={() => {
                    const cmd = safetyDialog.command;
                    const level = safetyDialog.level;
                    const warning = safetyDialog.message;
                    setSafetyDialog(null);
                    // Record safety warning + execution in chat
                    if (chatSessionId) {
                      addMessage(chatSessionId, {
                        id: generateId(),
                        role: 'system',
                        content: `⚠️ ${level} RISK: ${warning}`,
                        timestamp: Date.now(),
                        dangerLevel: level as ChatMessage['dangerLevel'],
                      });
                    }
                    addUserMessage(`$ ${cmd}`);
                    executeCommandSafely(cmd);
                  }}
                >
                  <Text style={[styles.safetyBtnText, { color: '#FFFFFF', fontWeight: '700' }]}>実行する</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      )}

      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
      <ChatHeader />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
        <View style={styles.chatArea}>
          <ChatMessageList
            messages={messages}
            fontSize={settings.fontSize ?? 14}
            onSampleTap={(text) => commandInputRef.current?.setText(text)}
          />
        </View>

        <CommandInput
          ref={commandInputRef}
          onSend={handleSend}
          onHistoryUp={handleHistoryUp}
          onHistoryDown={handleHistoryDown}
          onCtrlC={handleCancel}
          isRunning={messages.some(m => m.isStreaming)}
          isBridgeConnected={isBridgeConnected}
        />
      </KeyboardAvoidingView>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  chatArea: {
    flex: 1,
  },
  safetyOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  safetyDialog: {
    width: '100%',
    borderRadius: 12,
    padding: 20,
    borderWidth: 1,
    borderColor: '#333',
  },
  safetyHeader: {
    borderLeftWidth: 4,
    paddingLeft: 12,
    marginBottom: 12,
  },
  safetyLevel: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'monospace',
    letterSpacing: 1,
  },
  safetyTitle: {
    fontSize: 17,
    fontWeight: '600',
    marginTop: 2,
  },
  safetyMessage: {
    fontSize: 13,
    lineHeight: 20,
    marginBottom: 12,
  },
  intentBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#A78BFA15',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#A78BFA30',
    padding: 10,
    marginBottom: 12,
  },
  intentText: {
    color: '#C4B5FD',
    fontSize: 13,
    lineHeight: 19,
    flex: 1,
    fontFamily: 'monospace',
  },
  commandBox: {
    flexDirection: 'row',
    backgroundColor: '#0D0D0D',
    borderRadius: 6,
    padding: 10,
    marginBottom: 16,
    borderWidth: 1,
  },
  commandPrompt: {
    color: '#00D4AA',
    fontFamily: 'monospace',
    fontSize: 13,
  },
  commandText: {
    fontFamily: 'monospace',
    fontSize: 13,
    flex: 1,
    flexWrap: 'wrap',
  },
  safetyButtons: {
    flexDirection: 'row',
    gap: 10,
  },
  safetyBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  safetyBtnText: {
    fontSize: 15,
    fontWeight: '600',
  },
});
