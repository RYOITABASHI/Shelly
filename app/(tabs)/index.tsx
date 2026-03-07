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
import { CommandInput, type ImageAttachment, type FileAttachment } from '@/components/input/CommandInput';
import { useTermuxBridge } from '@/hooks/use-termux-bridge';
import { useAIDispatch } from '@/hooks/use-ai-dispatch';
import { parseInput } from '@/lib/input-router';
import { explainCommandIntent } from '@/lib/llm-interpreter';
import { loadProjectContext, generateProjectContext } from '@/lib/project-context';
import { loadUserProfile, learnFromCommand, learnFromAgentUse, learnFromUserInput, learnFromProject, formatProfileForPrompt } from '@/lib/user-profile';
import { requestNotificationPermission } from '@/lib/command-notifier';
import { checkCommandSafety, needsConfirmation, dangerLevelColor } from '@/lib/command-safety';
import { useTheme } from '@/hooks/use-theme';

import { generateId } from '@/lib/id';

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

  // ── AI dispatch (extracted from handleSend) ──
  const { dispatch: aiDispatch, cancelStreaming } = useAIDispatch();

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
  const demoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Init ──
  useEffect(() => {
    loadSettings();
    requestNotificationPermission();
    return () => {
      // Clean up demo timer on unmount
      if (demoTimerRef.current) clearTimeout(demoTimerRef.current);
    };
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
  const handleSend = useCallback(async (input: string, images?: ImageAttachment[], files?: FileAttachment[]) => {
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

    // ── Demo mode: mock responses when Termux & AI are unavailable ──
    const hasAnyApi = settings.geminiApiKey || settings.localLlmEnabled || settings.perplexityApiKey;
    const isDemoMention = !isBridgeConnected && !hasAnyApi && parsed.layer === 'mention';
    if (!isBridgeConnected && !hasAnyApi && (parsed.layer !== 'mention' || isDemoMention)) {
      // Determine agent for demo AI mocks
      const demoAgent: ChatAgent | undefined = isDemoMention
        ? (parsed.target === 'claude' ? 'claude' : parsed.target === 'gemini' ? 'gemini' : parsed.target === 'perplexity' ? 'perplexity' : parsed.target === 'local' ? 'local' : undefined)
        : undefined;
      addUserMessage(input);
      const msgId = addAssistantMessage(demoAgent, undefined);

      const demoResponses: Record<string, string> = {
        'ls': '```\nDocuments/  Downloads/  Pictures/  Music/\npackage.json  README.md  .gitignore\n```\n\n*Demo mode* — Termuxに接続するとリアルなコマンドが実行できます',
        'git status': '```\nOn branch main\nYour branch is up to date with \'origin/main\'.\n\nnothing to commit, working tree clean\n```\n\n*Demo mode*',
        'pwd': '```\n/home/user/projects\n```\n\n*Demo mode*',
      };
      const aiDemoResponses: Record<string, string> = {
        claude: `こんにちは！Claude AIです。\n\nこれは**デモモード**の応答です。実際に使用するには:\n- **Termux**をインストールしてClaude Codeをセットアップ\n\n\`@claude コードをレビューして\` のように質問できます。\n\n*Demo mode*`,
        gemini: `こんにちは！Gemini AIです。\n\nこれは**デモモード**の応答です。実際に使用するには:\n- **Settings** → Gemini APIキーを設定\n- https://aistudio.google.com/app/apikey で無料取得\n\n画像添付でマルチモーダル分析もできます。\n\n*Demo mode*`,
        perplexity: `こんにちは！Perplexity AIです。\n\nこれは**デモモード**の応答です。実際に使用するには:\n- **Settings** → Perplexity APIキーを設定\n\nWeb検索ベースの回答と論文引用が特徴です。\n\n*Demo mode*`,
        local: `こんにちは！Local LLMです。\n\nこれは**デモモード**の応答です。実際に使用するには:\n- **Ollama**をセットアップ（\`ollama serve\`）\n- **Settings**でLocal LLMを有効化\n\nプライベートなオフラインAIとして動作します。\n\n*Demo mode*`,
      };
      const demoText = (isDemoMention && demoAgent && aiDemoResponses[demoAgent])
        ? aiDemoResponses[demoAgent]
        : demoResponses[parsed.prompt.trim()]
          ?? `Shellyへようこそ! 🐚\n\n現在 **デモモード** で動作中です。\n\n実際に使うには:\n1. **Termux** をインストール\n2. **Terminal** タブでセットアップ\n3. AIを使うには **Settings** でAPIキーを設定\n\n入力例:\n- \`ls\` — ファイル一覧\n- \`@claude 質問\` — Claude AI\n- \`@gemini 質問\` — Gemini AI`;

      // Simulate streaming for demo feel (with cleanup ref)
      let i = 0;
      const streamDemo = () => {
        if (i < demoText.length) {
          const chunk = demoText.slice(0, Math.min(i + 8, demoText.length));
          updateMessage(chatSessionId, msgId, { streamingText: chunk, isStreaming: true });
          i += 8;
          demoTimerRef.current = setTimeout(streamDemo, 20);
        } else {
          updateMessage(chatSessionId, msgId, { content: demoText, streamingText: undefined, isStreaming: false });
          demoTimerRef.current = null;
        }
      };
      streamDemo();
      return;
    }

    // ── Image-attached → dispatch to Gemini multimodal ──
    if (images && images.length > 0) {
      addUserMessage(input);
      await aiDispatch({ target: 'gemini', prompt: parsed.prompt, chatSessionId, messages, images, files });
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

    // ── AI routing → dispatch to useAIDispatch hook ──
    addUserMessage(input);

    let target = parsed.target;

    // Natural language → default to local LLM or show hint
    if (parsed.layer === 'natural') {
      if (settings.localLlmEnabled) {
        target = 'local';
      } else if (settings.geminiApiKey) {
        target = 'gemini';
      } else {
        const msgId = addAssistantMessage(undefined);
        updateMessage(chatSessionId, msgId, {
          content: 'AIが未設定です。@mentionでツールを指定するか、Settingsでセットアップしてください。\n\n例: `@gemini 質問`, `@local 質問`',
          isStreaming: false,
        });
        return;
      }
    }

    // Browser target — handle locally (not an AI dispatch)
    if (target === 'browser') {
      const url = parsed.prompt.trim();
      const msgId = addAssistantMessage(undefined);
      updateMessage(chatSessionId, msgId, { content: `ブラウザで開きます: ${url}`, isStreaming: false });
      useTerminalStore.setState({ pendingBrowserUrl: url } as any);
      router.push('/(tabs)/browser' as any);
      return;
    }

    // Dispatch to AI agent (with conversation context + file attachments)
    const result = await aiDispatch({ target, prompt: parsed.prompt, chatSessionId, messages, files });
    if (!result.handled) {
      const msgId = addAssistantMessage(undefined);
      updateMessage(chatSessionId, msgId, {
        content: `未対応のエージェントです: @${target}\n\n対応エージェント: @claude, @gemini, @local, @perplexity, @team, @git`,
        isStreaming: false,
      });
    }
  }, [chatSessionId, connectionMode, sendCommand, activeSession.id, activeSession.currentDir, settings, addMessage, updateMessage, setLastInputMode, router, addUserMessage, addAssistantMessage, bridgeRunCommand, execForContext, messages, aiDispatch, isBridgeConnected]);

  const handleCancel = useCallback(() => {
    cancelCurrent();
    cancelStreaming();
  }, [cancelCurrent, cancelStreaming]);

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
