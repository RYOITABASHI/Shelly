/**
 * app/(tabs)/index.tsx
 *
 * Chat-first UI — GPT/Claude style.
 * User messages on right, AI responses on left.
 * Shell commands also routed through chat bubbles.
 */

import React, { useEffect, useCallback, useState, useRef, useMemo } from 'react';
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
  Alert,
  Keyboard,
  Linking,
  useWindowDimensions,
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
import { VoiceChat } from '@/components/VoiceChat';
import { useDeviceLayout } from '@/hooks/use-device-layout';
import { TranslateOverlay } from '@/components/chat/TranslateOverlay';

import { generateId } from '@/lib/id';
import { useTranslation } from '@/lib/i18n';
import { useExecutionLogStore } from '@/store/execution-log-store';
import { ChatOnboarding } from '@/components/ChatOnboarding';
import { type OnboardingStep, getOnboardingStep, setOnboardingStep, isOnboardingDone } from '@/lib/chat-onboarding';
import { checkAndSave, initGitIfNeeded, isFileChangingCommand } from '@/lib/auto-savepoint';
import { useSavepointStore } from '@/store/savepoint-store';

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function ChatScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  // Force full re-mount of layout tree when screen dimensions change significantly (fold/unfold)
  const layoutKey = `${Math.round(screenWidth / 40)}-${Math.round(screenHeight / 40)}`;

  // ── Terminal store (settings, bridge config) ──
  const {
    runCommand,
    navigateHistory,
    loadSettings,
    connectionMode,
    pendingCommand,
    settings,
    setLastInputMode,
    activeCliSession,
    setActiveCliSession,
  } = useTerminalStore();
  const activeSession = useActiveSession();

  // ── Chat store ──
  const {
    load: loadChat,
    isLoaded: chatLoaded,
    createSession: createChatSession,
    addMessage,
    updateMessage,
    deleteMessage,
    deleteMessagesFrom,
  } = useChatStore();
  // Reactive selector for active session (re-renders when session/messages change)
  const chatSession = useChatStore((s) =>
    s.sessions.find((sess) => sess.id === s.activeSessionId) ?? null
  );

  // ── Onboarding ──
  const [onboardingStep, setOnboardingStepState] = useState<OnboardingStep>('complete');
  const onboardingChecked = useRef(false);

  // Load chat store on mount
  useEffect(() => {
    loadChat();
  }, []);

  // Get current chat session messages
  const messages = chatSession?.messages ?? [];
  const chatSessionId = chatSession?.id ?? '';

  // Ensure there's always an active chat session
  useEffect(() => {
    if (!chatLoaded) return;
    if (!chatSession) {
      createChatSession('New Chat');
    }
  }, [chatLoaded, chatSession]);

  // Check onboarding status after chat loads
  useEffect(() => {
    if (!chatLoaded || onboardingChecked.current) return;
    onboardingChecked.current = true;
    getOnboardingStep().then((step) => {
      setOnboardingStepState(step);
      // Auto-add welcome message if onboarding just starting
      if (step === 'welcome' && chatSessionId && messages.length === 0) {
        addMessage(chatSessionId, {
          id: generateId(),
          role: 'assistant',
          content: t('onboarding.welcome'),
          timestamp: Date.now(),
        });
      }
    });
  }, [chatLoaded, chatSessionId]);
  // Keep messages in ref to avoid handleSend re-creation on every message
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const isAnyStreaming = useMemo(() => messages.some(m => m.isStreaming), [messages]);

  // ── Bridge ──
  const { sendCommand, sendStdin, cancelCurrent, isConnected: isBridgeConnected, runCommand: bridgeRunCommand, hasActiveCommand } = useTermuxBridge();

  // ── AI dispatch (extracted from handleSend) ──
  const { dispatch: aiDispatch, cancelStreaming } = useAIDispatch();

  // ── Device layout (for cross-pane intelligence) ──
  const { isWide } = useDeviceLayout();

  const execForContext = useCallback(
    async (cmd: string): Promise<string> => {
      const result = await bridgeRunCommand(cmd);
      return result.stdout;
    },
    [bridgeRunCommand],
  );

  // ── Savepoint helpers ──
  const savepointExec = useCallback(
    async (cmd: string) => {
      const result = await bridgeRunCommand(cmd);
      return { stdout: result.stdout ?? '', exitCode: result.exitCode ?? 1 };
    },
    [bridgeRunCommand],
  );

  // ── ActionBlock background execution ──
  const runCommandInBackground = useCallback(async (command: string) => {
    const result = await bridgeRunCommand(command, {});
    return { stdout: result.stdout ?? '', exitCode: result.exitCode ?? null };
  }, [bridgeRunCommand]);

  const currentDir = activeSession?.currentDir ?? '';
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetIdleTimer = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    if (!currentDir || !isBridgeConnected) return;
    idleTimerRef.current = setTimeout(async () => {
      if (!useSavepointStore.getState().isEnabled) return;
      await initGitIfNeeded(currentDir, savepointExec);
      const result = await checkAndSave(currentDir, savepointExec);
      if (result) {
        useSavepointStore.getState().flashBadge();
      }
    }, 30000);
  }, [currentDir, isBridgeConnected, savepointExec]);

  // Cleanup idle timer
  useEffect(() => {
    return () => { if (idleTimerRef.current) clearTimeout(idleTimerRef.current); };
  }, []);

  // ── Auto-savepoint: trigger after AI response completes ──
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = isAnyStreaming;

    // Streaming just ended → AI response completed
    if (wasStreaming && !isAnyStreaming && currentDir && isBridgeConnected) {
      resetIdleTimer();
      const doSave = async () => {
        if (!useSavepointStore.getState().isEnabled) return;
        await initGitIfNeeded(currentDir, savepointExec);
        const result = await checkAndSave(currentDir, savepointExec);
        if (result) {
          // Find the last assistant message to attach savepoint
          const lastMsg = messages.filter(m => m.role === 'assistant').pop();
          if (lastMsg) {
            useSavepointStore.getState().recordSavepoint(lastMsg.id, result);
          }
          useSavepointStore.getState().flashBadge();
        }
      };
      doSave();
    }
  }, [isAnyStreaming, currentDir, isBridgeConnected, savepointExec, resetIdleTimer, messages]);

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

  // ── Sync cwd when chat session has a projectPath ──
  useEffect(() => {
    if (!isBridgeConnected || !chatSession?.projectPath) return;
    // Send cd to bridge server to sync working directory (escape path for shell)
    const escapedPath = chatSession.projectPath.replace(/'/g, "'\\''");
    bridgeRunCommand(`cd '${escapedPath}'`).catch(() => {});
  }, [chatSessionId, chatSession?.projectPath, isBridgeConnected]);

  // ── Project context ──
  useEffect(() => {
    if (!isBridgeConnected || !settings.localLlmEnabled) return;
    const cwd = activeSession.currentDir;
    let cancelled = false;
    loadProjectContext(cwd, execForContext).then(async (ctx) => {
      if (cancelled) return;
      if (ctx) {
        projectContextRef.current = ctx;
      } else {
        const hasProject = await execForContext(
          `test -f "${cwd}/package.json" -o -f "${cwd}/Cargo.toml" -o -f "${cwd}/go.mod" -o -f "${cwd}/pyproject.toml" -o -f "${cwd}/Makefile" && echo "yes" || echo "no"`,
        );
        if (cancelled) return;
        if (hasProject.trim() === 'yes') {
          const generated = await generateProjectContext(cwd, execForContext);
          if (cancelled) return;
          projectContextRef.current = generated;
          const projName = cwd.split('/').pop() ?? cwd;
          learnFromProject(cwd, projName).catch(() => {});
        }
      }
    });
    return () => { cancelled = true; };
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
  const [showVoiceChat, setShowVoiceChat] = useState(false);

  useEffect(() => {
    if (!safetyDialog?.visible) {
      setIntentExplanation('');
      setIsExplainingIntent(false);
      return;
    }
    const effectiveMode = settings.experienceMode ?? 'learning';
    if (effectiveMode === 'fast') return;
    if (!settings.localLlmEnabled) return;
    if (!settings.llmInterpreterEnabled) return;

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
    if (messagesRef.current.length === 0 && chatSession?.title === 'New Chat') {
      const title = text.length > 40 ? text.slice(0, 40) + '...' : text;
      useChatStore.setState((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === chatSessionId ? { ...s, title } : s
        ),
      }));
    }

    return msg.id;
  }, [chatSessionId, addMessage, chatSession?.title]);

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
    Keyboard.dismiss();
    let parsed: ReturnType<typeof parseInput>;
    try {
      parsed = parseInput(input);
    } catch (err) {
      console.error('[handleSend] parseInput error:', err);
      return;
    }

    try {

    // ── CLI session control ──
    // Exit session: "ログアウト", "/exit", "@exit"
    const exitPatterns = /^(ログアウト|\/exit|@exit|exit session|セッション終了)$/i;
    if (exitPatterns.test(input.trim()) && activeCliSession) {
      const prev = activeCliSession;
      setActiveCliSession(null);
      addMessage(chatSessionId, {
        id: generateId(), role: 'assistant', content: `${prev === 'claude' ? 'Claude Code' : prev === 'codex' ? 'Codex' : 'Gemini CLI'} セッションを終了しました。`, timestamp: Date.now(),
      });
      return;
    }

    // @mention for CLI → start session
    if (parsed.layer === 'mention' && ['claude', 'codex', 'gemini'].includes(parsed.target)) {
      setActiveCliSession(parsed.target as 'claude' | 'codex' | 'gemini');
    }

    // Active CLI session: override natural language routing
    if (parsed.layer === 'natural' && activeCliSession) {
      parsed = { ...parsed, layer: 'mention' as any, target: activeCliSession };
    }

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
    if (!isBridgeConnected && !hasAnyApi) {
      // Determine agent for demo AI mocks
      const demoAgent: ChatAgent | undefined = parsed.layer === 'mention'
        ? (parsed.target === 'claude' ? 'claude' : parsed.target === 'gemini' ? 'gemini' : parsed.target === 'perplexity' ? 'perplexity' : parsed.target === 'local' ? 'local' : undefined)
        : undefined;
      addUserMessage(input);
      const msgId = addAssistantMessage(demoAgent, undefined);

      const demoResponses: Record<string, string> = {
        'ls': `\`\`\`\nDocuments/  Downloads/  Pictures/  Music/\npackage.json  README.md  .gitignore\n\`\`\`\n\n${t('chat.demo_suffix')}`,
        'git status': `\`\`\`\nOn branch main\nYour branch is up to date with 'origin/main'.\n\nnothing to commit, working tree clean\n\`\`\`\n\n${t('chat.demo_suffix_short')}`,
        'pwd': `\`\`\`\n/home/user/projects\n\`\`\`\n\n${t('chat.demo_suffix_short')}`,
      };
      const aiDemoResponses: Record<string, string> = {
        claude: t('chat.demo_claude'),
        gemini: t('chat.demo_gemini'),
        perplexity: t('chat.demo_perplexity'),
        local: t('chat.demo_local'),
      };
      const demoText = (demoAgent && aiDemoResponses[demoAgent])
        ? aiDemoResponses[demoAgent]
        : demoResponses[parsed.prompt.trim()]
          ?? t('chat.demo_welcome');

      // Simulate streaming for demo feel (with cleanup ref)
      // Clear any existing demo timer to prevent stacking
      if (demoTimerRef.current) { clearTimeout(demoTimerRef.current); demoTimerRef.current = null; }
      let i = 0;
      const streamDemo = () => {
        if (i < demoText.length) {
          const chunk = demoText.slice(0, Math.min(i + 8, demoText.length));
          updateMessage(chatSessionId, msgId, { streamingText: chunk, isStreaming: true });
          i += 8;
          demoTimerRef.current = setTimeout(streamDemo, 50);
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
      await aiDispatch({ target: 'gemini', prompt: parsed.prompt, chatSessionId, messages: messagesRef.current, images, files, isWide });
      return;
    }

    // ── shelly context ──
    if (parsed.layer === 'command' && /^shelly\s+context/i.test(parsed.prompt.trim())) {
      addUserMessage(input);
      const msgId = addAssistantMessage('local');
      updateMessage(chatSessionId, msgId, { isStreaming: true, streamingText: t('chat.context_analyzing') });
      try {
        const cwd = activeSession.currentDir;
        const ctx = await generateProjectContext(cwd, execForContext);
        projectContextRef.current = ctx;
        updateMessage(chatSessionId, msgId, {
          content: `.shelly/context.md generated (${ctx.length} chars)\n\n${ctx.slice(0, 1500)}${ctx.length > 1500 ? '\n...(truncated)' : ''}`,
          isStreaming: false,
        });
      } catch (err) {
        updateMessage(chatSessionId, msgId, {
          content: '',
          error: t('chat.context_gen_failed', { error: err instanceof Error ? err.message : String(err) }),
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
      updateMessage(chatSessionId, msgId, { isStreaming: true, streamingText: t('chat.cmd_running') });

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
          // Advance onboarding after first successful command
          if (onboardingStep === 'welcome' && result.exitCode === 0) {
            setOnboardingStep('after_first_cmd');
            setOnboardingStepState('after_first_cmd');
            // Add onboarding message
            addMessage(chatSessionId, {
              id: generateId(),
              role: 'assistant',
              content: t('onboarding.after_cmd'),
              timestamp: Date.now(),
            });
          }
          // Log to shared execution log (visible in Terminal tab)
          useExecutionLogStore.getState().addEntry({
            source: 'chat',
            command: parsed.prompt,
            output: (output + stderr).slice(0, 500),
            exitCode: result.exitCode,
          });
        } catch (err) {
          updateMessage(chatSessionId, msgId, {
            content: '',
            error: `Error: ${err instanceof Error ? err.message : String(err)}`,
            isStreaming: false,
          });
        }
      } else {
        updateMessage(chatSessionId, msgId, {
          content: t('chat.connect_termux'),
          isStreaming: false,
          error: t('chat.not_connected'),
        });
      }
      return;
    }

    // ── AI routing → dispatch to useAIDispatch hook ──
    addUserMessage(input);

    let target: string = parsed.target;

    // Natural language → route by priority: Cerebras > Groq > Local LLM > default CLI agent
    // Cerebras Qwen3-235B: fastest frontier model, 1M tokens/day free
    // Groq: fast fallback (also handles Whisper STT separately)
    // Local LLM: offline fallback
    // CLI agents: code-related tasks only
    if (parsed.layer === 'natural') {
      if (settings.cerebrasApiKey) {
        // Cerebras: fastest, Qwen3-235B, best for conversational chat
        target = 'cerebras';
      } else if (settings.groqApiKey) {
        // Groq: fast fallback
        target = 'groq';
      } else if (settings.localLlmEnabled) {
        // Local LLM: offline fallback for chat
        target = 'local';
      } else {
        // CLI fallback: route to user's default CLI agent
        const defaultCli = settings.defaultAgent || 'gemini-cli';
        const cliTargetMap: Record<string, string> = {
          'claude-code': 'claude',
          'gemini-cli': 'gemini',
          'codex': 'codex',
        };
        const cliTarget = cliTargetMap[defaultCli];
        if (cliTarget) {
          target = cliTarget;
        } else {
          const msgId = addAssistantMessage(undefined);
          updateMessage(chatSessionId, msgId, {
            content: t('chat.no_ai_configured'),
            isStreaming: false,
          });
          return;
        }
      }
    }

    // nl_with_tool: パーサーがツール名を検出済み → そのtargetを使う
    // (parseInputが既にtargetを設定してるのでここでは何もしない)

    // Browser target — open in system browser
    if (target === 'browser') {
      const url = parsed.prompt.trim();
      const msgId = addAssistantMessage(undefined);
      updateMessage(chatSessionId, msgId, { content: t('chat.opening_browser', { url }), isStreaming: false });
      Linking.openURL(url).catch(() => {});
      return;
    }

    // Dispatch to AI agent (with conversation context + file attachments)
    const result = await aiDispatch({ target, prompt: parsed.prompt, chatSessionId, messages: messagesRef.current, files, isWide });
    if (!result.handled) {
      const msgId = addAssistantMessage(undefined);
      updateMessage(chatSessionId, msgId, {
        content: t('chat.unsupported_agent', { target }),
        isStreaming: false,
      });
    }
    } catch (err) {
      console.error('[handleSend] Uncaught error:', err);
      // Show error in chat instead of crashing
      try {
        const msgId = addAssistantMessage(undefined);
        updateMessage(chatSessionId, msgId, {
          content: '',
          error: `Error: ${err instanceof Error ? err.message : String(err)}`,
          isStreaming: false,
        });
      } catch (innerErr) {
        console.error('[handleSend] Failed to display error:', innerErr);
      }
    }
  }, [chatSessionId, connectionMode, sendCommand, activeSession.id, activeSession.currentDir, settings, addMessage, updateMessage, setLastInputMode, router, addUserMessage, addAssistantMessage, bridgeRunCommand, execForContext, aiDispatch, isBridgeConnected]);

  // ── Regenerate: re-send the user message that preceded an assistant message ──
  const handleRegenerate = useCallback((assistantMsgId: string) => {
    if (!chatSessionId) return;
    const msgs = messagesRef.current;
    const idx = msgs.findIndex((m) => m.id === assistantMsgId);
    if (idx === -1) return;
    // Find the preceding user message
    let userMsg: ChatMessage | undefined;
    for (let i = idx - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') { userMsg = msgs[i]; break; }
    }
    if (!userMsg) return;
    // Strip "$ " prefix from shell commands so parseInput routes correctly
    const originalInput = userMsg.content.startsWith('$ ')
      ? userMsg.content.slice(2)
      : userMsg.content;
    // Delete from the user message onward
    deleteMessagesFrom(chatSessionId, userMsg.id);
    // Delay re-send to next tick so messagesRef picks up the deletion
    queueMicrotask(() => handleSend(originalInput));
  }, [chatSessionId, deleteMessagesFrom, handleSend]);

  // ── Edit: remove from edited message onward, put text back in input ──
  const handleEdit = useCallback((messageId: string, content: string) => {
    if (!chatSessionId) return;
    deleteMessagesFrom(chatSessionId, messageId);
    // Strip "$ " prefix from shell commands so parseInput routes correctly
    const text = content.startsWith('$ ') ? content.slice(2) : content;
    commandInputRef.current?.setText(text);
  }, [chatSessionId, deleteMessagesFrom]);

  // ── Delete: remove a single message (with confirmation) ──
  const handleDelete = useCallback((messageId: string) => {
    if (!chatSessionId) return;
    Alert.alert(t('chat.delete_title'), t('chat.delete_confirm'), [
      { text: t('chat.cancel'), style: 'cancel' },
      {
        text: t('chat.delete'), style: 'destructive', onPress: () => {
          const msg = messagesRef.current.find(m => m.id === messageId);
          if (msg?.isStreaming) cancelStreaming();
          deleteMessage(chatSessionId, messageId);
        },
      },
    ]);
  }, [chatSessionId, deleteMessage, cancelStreaming]);

  const handleCancel = useCallback(() => {
    cancelCurrent();
    cancelStreaming();
    if (demoTimerRef.current) {
      clearTimeout(demoTimerRef.current);
      demoTimerRef.current = null;
    }
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
                  {t('chat.safety_risk', { level: safetyDialog.level })}
                </Text>
                <Text style={[styles.safetyTitle, { color: colors.foreground }]}>
                  {t('chat.safety_confirm')}
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
                    {intentExplanation || t('chat.context_analyzing')}
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
                  <Text style={[styles.safetyBtnText, { color: colors.muted }]}>{t('chat.safety_cancel')}</Text>
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
                    // Execute and show result in chat (not terminal-store)
                    if (chatSessionId && connectionMode === 'termux') {
                      const msgId = addAssistantMessage(undefined);
                      updateMessage(chatSessionId, msgId, { isStreaming: true, streamingText: t('chat.cmd_running') });
                      bridgeRunCommand(cmd).then((result) => {
                        const output = result.stdout || '';
                        const stderr = result.stderr ? `\n--- stderr ---\n${result.stderr}` : '';
                        updateMessage(chatSessionId, msgId, {
                          content: output + stderr,
                          isStreaming: false,
                          executions: [{
                            command: cmd,
                            output: output + stderr,
                            exitCode: result.exitCode,
                            isCollapsed: (output + stderr).split('\n').length > 10,
                          }],
                        });
                      }).catch((err) => {
                        updateMessage(chatSessionId, msgId, {
                          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
                          isStreaming: false,
                        });
                      });
                    } else {
                      executeCommandSafely(cmd);
                    }
                  }}
                >
                  <Text style={[styles.safetyBtnText, { color: '#FFFFFF', fontWeight: '700' }]}>{t('chat.safety_run')}</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      )}

      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
      <ChatHeader onVoiceChat={() => setShowVoiceChat(true)} />
      <ChatOnboarding step={onboardingStep} onStepChange={setOnboardingStepState} />

      <KeyboardAvoidingView
        key={`kav-${layoutKey}`}
        style={styles.flex}
        behavior="padding"
        keyboardVerticalOffset={Platform.OS === 'android' ? 56 : 0}
      >
        <View style={styles.chatArea}>
          <TranslateOverlay />
          <ChatMessageList
            messages={messages}
            fontSize={settings.fontSize ?? 14}
            onSampleTap={(text) => commandInputRef.current?.setText(text)}
            onRegenerate={handleRegenerate}
            onEdit={handleEdit}
            onDelete={handleDelete}
            onStopGenerating={handleCancel}
            isStreaming={isAnyStreaming}
            projectDir={currentDir || undefined}
            runCommand={isBridgeConnected ? savepointExec : undefined}
            sendToTerminal={isBridgeConnected ? sendCommand : undefined}
            runCommandInBackground={isBridgeConnected ? runCommandInBackground : undefined}
          />
        </View>

        {/* Suggestion chips when chat is empty */}
        {messages.length === 0 && !isAnyStreaming && onboardingStep === 'complete' && (
          <View style={styles.suggestRow}>
            {[
              { label: '📂 ファイル一覧', cmd: 'ファイル一覧' },
              { label: '💬 こんにちは', cmd: 'こんにちは' },
              { label: '🚀 アプリ作って', cmd: 'アプリ作って' },
              { label: '@claude', cmd: '@claude ' },
            ].map((s) => (
              <Pressable key={s.cmd} style={styles.suggestChip} onPress={() => handleSend(s.cmd)}>
                <Text style={styles.suggestText}>{s.label}</Text>
              </Pressable>
            ))}
          </View>
        )}

        <CommandInput
          ref={commandInputRef}
          onSend={handleSend}
          onHistoryUp={handleHistoryUp}
          onHistoryDown={handleHistoryDown}
          onCtrlC={handleCancel}
          onStdin={hasActiveCommand ? sendStdin : undefined}
          isRunning={isAnyStreaming || hasActiveCommand}
          isBridgeConnected={isBridgeConnected}
          showShortcutBar={settings.externalKeyboardShortcuts ?? false}
        />
      </KeyboardAvoidingView>

      <VoiceChat visible={showVoiceChat} onClose={() => setShowVoiceChat(false)} />
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
  suggestRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  suggestChip: {
    backgroundColor: '#1A1A1A',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  suggestText: {
    color: '#9CA3AF',
    fontSize: 12,
    fontFamily: 'monospace',
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
