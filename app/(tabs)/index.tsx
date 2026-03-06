import React, { useEffect, useCallback, useState, useContext } from 'react';
import {
  View,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  StatusBar,
  ImageBackground,
  Modal,
  Text,
  Pressable,
  ActivityIndicator,
} from 'react-native';
import { MultiPaneContext } from '@/components/multi-pane/PaneSlot';
import { checkCommandSafety, needsConfirmation, dangerLevelColor } from '@/lib/command-safety';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTerminalStore, useActiveSession } from '@/store/terminal-store';
import { useRef } from 'react';
import { useRouter } from 'expo-router';
import { TerminalHeader } from '@/components/terminal/TerminalHeader';
import { BlockList } from '@/components/terminal/BlockList';
import { CommandInput, type ImageAttachment } from '@/components/input/CommandInput';
import { useDeviceLayout } from '@/hooks/use-device-layout';
import { useTermuxBridge } from '@/hooks/use-termux-bridge';
import { parseInput, buildRoutingDetail } from '@/lib/input-router';
import { orchestrateTask, orchestrateChatStream } from '@/lib/local-llm';
import { shouldShowHint } from '@/lib/hint-tracker';
import { interpretTermuxOutput, explainCommandIntent } from '@/lib/llm-interpreter';
import { loadProjectContext, generateProjectContext, clearProjectContextCache } from '@/lib/project-context';
import { loadUserProfile, learnFromCommand, learnFromAgentUse, learnFromUserInput, learnFromProject, formatProfileForPrompt } from '@/lib/user-profile';
import { requestNotificationPermission } from '@/lib/command-notifier';
import { detectGitIntent, generateGuide } from '@/lib/git-assistant';
import type { AiBlock } from '@/store/types';

export default function TerminalScreen() {
  const {
    runCommand,
    navigateHistory,
    loadSettings,
    connectionMode,
    pendingCommand,
    settings,
    addAiBlock,
    updateAiBlock,
    updateBlockInterpretation,
    setLastInputMode,
  } = useTerminalStore();

  // ガラス背景設定
  const hasWallpaper = !!settings.wallpaperUri;
  const bgOpacity = settings.backgroundOpacity ?? 1.0;
  const blurIntensity = settings.blurIntensity ?? 0;
  const rootBgColor = `rgba(10,10,10,${bgOpacity})`;

  // CommandInput ref for pre-filling pending commands from Snippets (insert-only mode)
  const commandInputRef = useRef<{ setText: (t: string) => void } | null>(null);

  useEffect(() => {
    if (pendingCommand) {
      commandInputRef.current?.setText(pendingCommand);
      useTerminalStore.setState({ pendingCommand: null });
    }
  }, [pendingCommand]);
  const activeSession = useActiveSession();
  const layout = useDeviceLayout();
  const insets = useSafeAreaInsets();
  const paneCtx = useContext(MultiPaneContext);
  const router = useRouter();

  // Termux bridge — always mounted so WS lifecycle follows connectionMode
  const { sendCommand, cancelCurrent, isConnected: isBridgeConnected, runCommand: bridgeRunCommand } = useTermuxBridge();

  // Adapter: bridge runCommand → CommandRunner型 (Promise<string>)
  const execForContext = useCallback(
    async (cmd: string): Promise<string> => {
      const result = await bridgeRunCommand(cmd);
      return result.stdout;
    },
    [bridgeRunCommand],
  );

  // Whether any block in the active session is currently running (for Ctrl+C state)
  const isRunning = activeSession.blocks.some(
    (b) => b.isRunning || b.blockStatus === 'cancelling'
  );

  useEffect(() => {
    loadSettings();
    requestNotificationPermission();
  }, []);

  // ── Auth URL auto-detection: open browser for OAuth/login URLs from CLI tools ──
  const openedAuthUrlsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    // Check running blocks for auth URLs in their output
    for (const block of activeSession.blocks) {
      if (!block.isRunning && !block.output?.length) continue;
      const output = block.output?.map((o) => o.text).join('') ?? '';
      // Match URLs from CLI tool auth flows (Claude Code, Gemini, Codex, GitHub, etc.)
      const urlPattern = /https?:\/\/[^\s"'<>]*(?:auth|login|oauth|consent|accounts\.google|github\.com\/login|anthropic\.com\/|signin|device\/activate|verify|callback|token)[^\s"'<>]*/gi;
      const matches = output.match(urlPattern);
      if (!matches) continue;
      for (const url of matches) {
        if (openedAuthUrlsRef.current.has(url)) continue;
        openedAuthUrlsRef.current.add(url);
        // Open in Shelly's browser tab
        useTerminalStore.setState({ pendingBrowserUrl: url } as any);
        router.push('/(tabs)/browser' as any);
        break; // Only open one at a time
      }
    }
  }, [activeSession.blocks, router]);

  // ── ユーザープロファイル（自動学習）─────────────────────────────────────────
  const userProfileRef = useRef<string>('');

  useEffect(() => {
    loadUserProfile().then((p) => {
      userProfileRef.current = formatProfileForPrompt(p);
    });
  }, []);

  // ── プロジェクトコンテキスト（ローカルLLM強化用）───────────────────────────
  const projectContextRef = useRef<string>('');

  useEffect(() => {
    if (!isBridgeConnected || !settings.localLlmEnabled) return;
    const cwd = activeSession.currentDir;
    loadProjectContext(cwd, execForContext).then(async (ctx) => {
      if (ctx) {
        projectContextRef.current = ctx;
      } else {
        // context.mdがない場合、package.json等があれば自動生成
        const hasProject = await execForContext(
          `test -f "${cwd}/package.json" -o -f "${cwd}/Cargo.toml" -o -f "${cwd}/go.mod" -o -f "${cwd}/pyproject.toml" -o -f "${cwd}/Makefile" && echo "yes" || echo "no"`,
        );
        if (hasProject.trim() === 'yes') {
          const generated = await generateProjectContext(cwd, execForContext);
          projectContextRef.current = generated;
          // プロジェクトアクセスを学習
          const projName = cwd.split('/').pop() ?? cwd;
          learnFromProject(cwd, projName).catch(() => {});
        }
      }
    });
  }, [isBridgeConnected, settings.localLlmEnabled, activeSession.currentDir]);

  // ── LLM通訳: Termuxブロック完了時に自動トリガー ──────────────────────────
  const interpretedBlocksRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!settings.localLlmEnabled) return;

    for (const block of activeSession.blocks) {
      // 完了済み・Termuxブロック・未通訳・キャンセルでない
      if (
        !block.isRunning &&
        block.connectionMode === 'termux' &&
        block.exitCode !== null &&
        block.blockStatus !== 'cancelled' &&
        !block.isInterpreting &&
        !block.llmInterpretation &&
        !interpretedBlocksRef.current.has(block.id)
      ) {
        interpretedBlocksRef.current.add(block.id);

        const config = {
          baseUrl: settings.localLlmUrl,
          model: settings.localLlmModel,
          enabled: settings.localLlmEnabled,
        };

        updateBlockInterpretation(block.id, { isInterpreting: true });

        const verbosity = (settings.experienceMode ?? 'learning') === 'learning' ? 'verbose' : 'minimal';

        interpretTermuxOutput(
          block.command,
          block.output,
          block.exitCode,
          config,
          (chunk) => {
            // ストリーミング中: llmInterpretationStreamingに追記
            const current = useTerminalStore.getState().sessions
              .flatMap((s) => s.blocks)
              .find((b) => b.id === block.id);
            updateBlockInterpretation(block.id, {
              llmInterpretationStreaming: (current?.llmInterpretationStreaming ?? '') + chunk,
            });
          },
          { verbosity, projectContext: projectContextRef.current },
        ).then((result) => {
          if (result.text) {
            updateBlockInterpretation(block.id, {
              isInterpreting: false,
              llmInterpretation: result.text,
              llmInterpretationStreaming: undefined,
              llmSuggestedCommand: result.suggestedCommand,
              interpretType: result.type,
            });
          } else {
            // 通訳結果が空（LLM未起動等）はフィールドをクリア
            updateBlockInterpretation(block.id, {
              isInterpreting: false,
              llmInterpretationStreaming: undefined,
            });
          }
        });
      }
    }
  }, [activeSession.blocks, settings.localLlmEnabled, settings.localLlmUrl, settings.localLlmModel, settings.experienceMode]);

  /**
   * Unified input handler with 4-layer routing:
   *   1. @mention → direct CLI routing
   *   2. Natural language + tool name → detected tool routing + hint
   *   3. Natural language only → AI tool suggestion cards
   *   4. Shell command → Termux direct execution
   */
  // コマンド安全確認ダイアログの状態
  const [safetyDialog, setSafetyDialog] = useState<{
    visible: boolean;
    message: string;
    level: string;
    color: string;
    command: string;
  } | null>(null);
  const [intentExplanation, setIntentExplanation] = useState<string>('');
  const [isExplainingIntent, setIsExplainingIntent] = useState(false);

  // ── ダイアログ表示時にLLMで意図説明をストリーミング取得 ─────────────────────
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

  const handleSend = useCallback(async (input: string, images?: ImageAttachment[]) => {
    const parsed = parseInput(input);

    // ── 自動学習（バックグラウンド、UIブロックしない）──────────────────────
    if (parsed.layer === 'command') {
      learnFromCommand(parsed.prompt).catch(() => {});
    } else {
      learnFromUserInput(parsed.prompt).catch(() => {});
      if (parsed.target !== 'termux' && parsed.target !== 'suggest') {
        learnFromAgentUse(parsed.target).catch(() => {});
      }
    }
    // プロファイルサマリーを非同期更新
    loadUserProfile().then((p) => {
      userProfileRef.current = formatProfileForPrompt(p);
    });

    // Set input mode for UI switching
    setLastInputMode(parsed.layer === 'command' ? 'shell' : 'natural');

    // ── Image-attached input → Gemini multimodal ─────────────────────────────────
    if (images && images.length > 0) {
      const blockId = `ai-${Date.now()}`;
      const aiBlock: AiBlock = {
        id: blockId,
        sessionId: activeSession.id,
        blockType: 'ai',
        input: parsed.raw,
        target: 'gemini',
        layer: 'mention',
        logSummary: `[Gemini] 画像分析 (${images.length}枚)`,
        showHint: false,
        timestamp: Date.now(),
      };
      addAiBlock(aiBlock);

      const apiKey = settings.geminiApiKey ?? '';
      if (!apiKey) {
        updateAiBlock(blockId, {
          response: 'Gemini APIキーが設定されていません。\n画像分析にはGemini APIが必要です。\nhttps://aistudio.google.com/app/apikey で無料取得できます。',
          isStreaming: false,
          logSummary: '[Gemini] APIキー未設定',
        });
        return;
      }

      const geminiStreamStart = Date.now();
      let geminiAccumulated = '';
      let geminiTokenCount = 0;
      updateAiBlock(blockId, {
        isStreaming: true,
        streamingText: '',
        tokenCount: 0,
        streamingStartTime: geminiStreamStart,
      });

      const { geminiMultimodalStream } = await import('@/lib/gemini');
      const geminiResult = await geminiMultimodalStream(
        apiKey,
        input,
        images.map((img) => ({ base64: img.base64, mimeType: img.mimeType })),
        (chunk, done) => {
          if (chunk) {
            geminiAccumulated += chunk;
            geminiTokenCount = Math.round(geminiAccumulated.length / 4);
            updateAiBlock(blockId, {
              streamingText: geminiAccumulated,
              tokenCount: geminiTokenCount,
              isStreaming: !done,
            });
          }
          if (done) {
            updateAiBlock(blockId, {
              response: geminiAccumulated,
              streamingText: undefined,
              isStreaming: false,
              tokenCount: geminiTokenCount,
              logSummary: `[Gemini] 画像分析完了 (${images.length}枚)`,
            });
          }
        },
        settings.geminiModel ?? 'gemini-2.0-flash',
      );
      if (!geminiResult.success && !geminiAccumulated) {
        updateAiBlock(blockId, {
          response: `Geminiエラー: ${geminiResult.error ?? '不明なエラー'}`,
          isStreaming: false,
          logSummary: '[Gemini] エラー',
        });
      }
      return;
    }

    // ── Built-in: shelly context ────────────────────────────────────────────────
    if (parsed.layer === 'command' && /^shelly\s+context/i.test(parsed.prompt.trim())) {
      const cwd = activeSession.currentDir;
      const blockId = `ai-${Date.now()}`;
      const aiBlock: AiBlock = {
        id: blockId,
        sessionId: activeSession.id,
        blockType: 'ai',
        input: parsed.raw,
        target: 'local',
        layer: 'command',
        logSummary: '[Shelly] context.md 自動生成中...',
        showHint: false,
        timestamp: Date.now(),
      };
      addAiBlock(aiBlock);
      updateAiBlock(blockId, { isStreaming: true, streamingText: '解析中...' });

      try {
        const ctx = await generateProjectContext(cwd, execForContext);
        projectContextRef.current = ctx;
        updateAiBlock(blockId, {
          response: `.shelly/context.md を生成しました (${ctx.length}文字)\nLLMが自動でプロジェクト情報を参照します。\n\n---\n${ctx.slice(0, 1500)}${ctx.length > 1500 ? '\n...(省略)' : ''}`,
          isStreaming: false,
          logSummary: '[Shelly] context.md 生成完了',
        });
      } catch (err) {
        updateAiBlock(blockId, {
          response: `context.md の生成に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
          isStreaming: false,
          logSummary: '[Shelly] context生成エラー',
        });
      }
      return;
    }

    // ── Layer 4: Shell command → direct execution ──────────────────────────────────
    if (parsed.layer === 'command') {
      // 安全チェック
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
      executeCommandSafely(parsed.prompt);
      return;
    }    // ── Layer 1-3: AI routing → create AiBlock ────────────────────────
    const blockId = `ai-${Date.now()}`;
    const showHint = parsed.mentionHint
      ? await shouldShowHint(parsed.mentionHint.key)
      : false;

    const aiBlock: AiBlock = {
      id: blockId,
      sessionId: activeSession.id,
      blockType: 'ai',
      input: parsed.raw,
      target: parsed.target,
      layer: parsed.layer,
      logSummary: parsed.logSummary,
      routingDetail: buildRoutingDetail(parsed),
      toolSuggestions: parsed.suggestions?.map((s) => ({
        target: s.target as 'claude' | 'gemini' | 'local' | 'perplexity',
        label: s.label,
        reason: s.reason,
        mentionExample: s.mentionExample,
        confidence: s.confidence,
      })),
      mentionHint: parsed.mentionHint,
      showHint,
      timestamp: Date.now(),
    };

    addAiBlock(aiBlock);

    // ── Layer 3: Natural language → route directly to Local LLM (if enabled) ─
    // No more suggestion cards — just send it straight to the LLM
    let target = parsed.target;
    if (parsed.layer === 'natural') {
      if (settings.localLlmEnabled) {
        target = 'local';
        updateAiBlock(blockId, {
          target: 'local',
          logSummary: `[Local LLM] ${parsed.prompt.slice(0, 60)}${parsed.prompt.length > 60 ? '…' : ''}`,
          routingDetail: undefined,
          toolSuggestions: undefined,
          mentionHint: undefined,
        });
      } else {
        // Local LLM disabled — show brief hint instead of suggestion cards
        updateAiBlock(blockId, {
          response: '@mentionでツールを指定してください。例: @claude, @gemini, @local',
          isStreaming: false,
        });
        return;
      }
    }

    if (target === 'local') {
      // Local LLM — use streaming orchestration
      const config = {
        baseUrl: settings.localLlmUrl,
        model: settings.localLlmModel,
        enabled: settings.localLlmEnabled,
      };

      const streamStartTime = Date.now();
      let accumulatedText = '';
      let tokenCount = 0;

      updateAiBlock(blockId, {
        isStreaming: true,
        streamingText: '',
        tokenCount: 0,
        streamingStartTime: streamStartTime,
      });

      const result = await orchestrateChatStream(
        parsed.prompt,
        config,
        (chunk, done) => {
          if (chunk) {
            accumulatedText += chunk;
            // Rough token count: ~4 chars per token
            tokenCount = Math.round(accumulatedText.length / 4);
            updateAiBlock(blockId, {
              streamingText: accumulatedText,
              tokenCount,
              isStreaming: !done,
            });
          }
          if (done) {
            updateAiBlock(blockId, {
              response: accumulatedText,
              streamingText: undefined,
              isStreaming: false,
              tokenCount,
              logSummary: `[Local LLM] ${parsed.prompt.slice(0, 50)}${parsed.prompt.length > 50 ? '…' : ''}`,
            });
          }
        },
        [],
        projectContextRef.current,
        userProfileRef.current,
      );

      if (result.handledBy !== 'local_llm') {
        // Fallback to CLI (code/research/file_ops or error)
        updateAiBlock(blockId, { isStreaming: false, streamingText: undefined });
        if (result.delegatedCommand) {
          if (connectionMode === 'termux') {
            sendCommand(result.delegatedCommand);
          } else {
            runCommand(result.delegatedCommand);
          }
        } else {
          updateAiBlock(blockId, {
            response: 'Local LLMに接続できませんでした。Settingsで接続を確認してください。',
            isStreaming: false,
          });
        }
      }
    } else if (target === 'perplexity') {
      // Perplexity Sonar API — ストリーミング検索
      const apiKey = settings.perplexityApiKey ?? '';

      if (!apiKey) {
        updateAiBlock(blockId, {
          response: 'Perplexity APIキーが設定されていません。\n設定画面 → Perplexity APIキーで入力してください。\nhttps://www.perplexity.ai/settings/api で取得できます。',
          isStreaming: false,
          logSummary: `[Perplexity] APIキー未設定`,
        });
        return;
      }

      const pxStreamStart = Date.now();
      let pxAccumulated = '';
      let pxTokenCount = 0;
      let pxCitations: Array<{ url: string; title?: string }> = [];

      updateAiBlock(blockId, {
        isStreaming: true,
        streamingText: '',
        tokenCount: 0,
        streamingStartTime: pxStreamStart,
      });

      const { perplexitySearchStream } = await import('@/lib/perplexity');
      await perplexitySearchStream(
        apiKey,
        parsed.prompt,
        (chunk, done, citations) => {
          if (chunk) {
            pxAccumulated += chunk;
            pxTokenCount = Math.round(pxAccumulated.length / 4);
            updateAiBlock(blockId, {
              streamingText: pxAccumulated,
              tokenCount: pxTokenCount,
              isStreaming: !done,
            });
          }
          if (citations && citations.length > 0) {
            pxCitations = citations;
          }
          if (done) {
            updateAiBlock(blockId, {
              response: pxAccumulated,
              streamingText: undefined,
              isStreaming: false,
              tokenCount: pxTokenCount,
              citations: pxCitations,
              logSummary: `[Perplexity] ${parsed.prompt.slice(0, 50)}${parsed.prompt.length > 50 ? '…' : ''}`,
            });
          }
        },
        settings.perplexityModel ?? undefined,
      );
     } else if (target === 'gemini') {
      // Gemini API — 直接ストリーミング呼び出し
      const apiKey = settings.geminiApiKey ?? '';
      if (!apiKey) {
        updateAiBlock(blockId, {
          response: 'Gemini APIキーが設定されていません。\n設定画面 → Gemini API → APIキーで入力してください。\nhttps://aistudio.google.com/app/apikey で無料取得できます。',
          isStreaming: false,
          logSummary: '[Gemini] APIキー未設定',
        });
        return;
      }
      const geminiStreamStart = Date.now();
      let geminiAccumulated = '';
      let geminiTokenCount = 0;
      updateAiBlock(blockId, {
        isStreaming: true,
        streamingText: '',
        tokenCount: 0,
        streamingStartTime: geminiStreamStart,
      });
      const { geminiChatStream } = await import('@/lib/gemini');
      const geminiResult = await geminiChatStream(
        apiKey,
        parsed.prompt,
        (chunk, done) => {
          if (chunk) {
            geminiAccumulated += chunk;
            geminiTokenCount = Math.round(geminiAccumulated.length / 4);
            updateAiBlock(blockId, {
              streamingText: geminiAccumulated,
              tokenCount: geminiTokenCount,
              isStreaming: !done,
            });
          }
          if (done) {
            updateAiBlock(blockId, {
              response: geminiAccumulated,
              streamingText: undefined,
              isStreaming: false,
              tokenCount: geminiTokenCount,
              logSummary: `[Gemini] ${parsed.prompt.slice(0, 50)}${parsed.prompt.length > 50 ? '…' : ''}`,
            });
          }
        },
        settings.geminiModel ?? 'gemini-2.0-flash',
      );
      if (!geminiResult.success && !geminiAccumulated) {
        updateAiBlock(blockId, {
          response: `Geminiエラー: ${geminiResult.error ?? '不明なエラー'}`,
          isStreaming: false,
          logSummary: '[Gemini] エラー',
        });
      }
    } else if (target === 'team') {
      // @team Table — 複数AI並列呼び出し + ファシリサマリー
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
        updateAiBlock(blockId, {
          response: '@team に参加できるエージェントがいません。\n設定画面 → @team メンバー設定でエージェントを有効化してください。',
          isStreaming: false,
          logSummary: '[@team] メンバー未設定',
        });
        return;
      }
      let teamAccumulated = `[@team] ${enabledCount}名のエージェントに質問中...\n\n`;
      updateAiBlock(blockId, {
        isStreaming: true,
        streamingText: teamAccumulated,
        tokenCount: 0,
        streamingStartTime: Date.now(),
        logSummary: `[@team] ${parsed.prompt.slice(0, 50)}${parsed.prompt.length > 50 ? '...' : ''}`,
      });
      try {
        const result = await runTeamRoundtable(
          parsed.prompt,
          teamSettingsObj,
          {
            runCommand: (cmd: string) => new Promise((resolve) => {
              if (connectionMode === 'termux') {
                sendCommand(cmd);
                setTimeout(() => resolve('(CLI実行中 - Termux出力を確認してください)'), 3000);
              } else {
                resolve(`[Disconnected] 実行コマンド: ${cmd}`);
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
              updateAiBlock(blockId, { streamingText: teamAccumulated });
            },
            onFacilitatorChunk: (chunk: string) => {
              teamAccumulated += chunk;
              updateAiBlock(blockId, { streamingText: teamAccumulated });
            },
          },
        );
        const facilitatorLabel = result.facilitator?.label ?? 'ファシリ';
        const finalText = teamAccumulated + `\n\n=== ファシリサマリー (${facilitatorLabel}) ===\n${result.facilitatorSummary}`;
        updateAiBlock(blockId, {
          response: finalText,
          streamingText: undefined,
          isStreaming: false,
          tokenCount: Math.round(finalText.length / 4),
          logSummary: `[@team] Table完了 (${result.members.length}名参加)`,
        });
      } catch (err) {
        updateAiBlock(blockId, {
          response: `@teamエラー: ${err instanceof Error ? err.message : String(err)}`,
          isStreaming: false,
          logSummary: '[@team] エラー',
        });
      }
    } else if (target === 'claude') {
      // Claude CLI — build command and send to Termux
      const config = {
        baseUrl: settings.localLlmUrl,
        model: settings.localLlmModel,
        enabled: settings.localLlmEnabled,
      };
      const result = await orchestrateTask(parsed.prompt, {
        ...config,
        enabled: false, // Force delegation to CLI
      });
      if (result.delegatedCommand) {
        if (connectionMode === 'termux') {
          sendCommand(result.delegatedCommand);
        } else {
          updateAiBlock(blockId, {
            response: `Termuxに接続してください。実行コマンド:\n${result.delegatedCommand}`,
            isStreaming: false,
          });
        }
      }
    } else if (target === 'git') {
      // @git — 自然言語Gitアシスタント
      const intent = detectGitIntent(parsed.prompt);
      const guide = generateGuide(intent, parsed.prompt);

      // prereqCommandがあれば自動実行してから結果を表示
      if (guide.prereqCommand && connectionMode === 'termux') {
        sendCommand(guide.prereqCommand);
      }

      // ガイドをJSON形式でresponseに格納（GitGuideBlockでパース）
      updateAiBlock(blockId, {
        response: JSON.stringify(guide),
        isStreaming: false,
        logSummary: `[Git Guide] ${guide.title}`,
      });
    } else if (target === 'browser') {
      // @open <URL> — BrowserタブでURLを開く
      const url = parsed.prompt.trim();
      useTerminalStore.setState({ pendingCommand: null });
      updateAiBlock(blockId, {
        response: `ブラウザで開きます: ${url}`,
        isStreaming: false,
        logSummary: `[Browser] ${url}`,
      });
      // BrowserタブのURLを設定してタブ遷移
      useTerminalStore.setState({ pendingBrowserUrl: url } as any);
      router.push('/(tabs)/browser' as any);
    }
  }, [connectionMode, sendCommand, runCommand, activeSession.id, settings, addAiBlock, updateAiBlock, setLastInputMode, router]);

  /**
   * Handle tool suggestion card tap — pre-fill input with @mention command
   */
  const handleSelectTool = useCallback((mentionExample: string) => {
    commandInputRef.current?.setText(mentionExample);
  }, []);

  const handleCancel = useCallback((_blockId: string) => {
    // Cancel the currently running Termux command
    cancelCurrent();
  }, [cancelCurrent]);

  // Ctrl+C from ShortcutBar or physical keyboard
  const handleCtrlC = useCallback(() => {
    cancelCurrent();
  }, [cancelCurrent]);

  const handleHistoryUp = useCallback((): string => {
    return navigateHistory('up');
  }, [navigateHistory]);

  const handleHistoryDown = useCallback((): string => {
    return navigateHistory('down');
  }, [navigateHistory]);

  // ── Single-pane layout (all screens) ─────────────────────────────────────
  // Multi-pane is handled by MultiPaneContainer overlay in _layout.tsx
  const portraitContent = (
    <View style={[styles.rootInner, { paddingTop: insets.top, backgroundColor: rootBgColor }]}>
      {/* コマンド安全確認ダイアログ */}
      {safetyDialog && (
        <Modal
          transparent
          animationType="fade"
          visible={safetyDialog.visible}
          onRequestClose={() => setSafetyDialog(null)}
        >
          <View style={styles.safetyOverlay}>
            <View style={styles.safetyDialog}>
              <View style={[styles.safetyHeader, { borderLeftColor: safetyDialog.color }]}>
                <Text style={[styles.safetyLevel, { color: safetyDialog.color }]}>
                  ⚠️ {safetyDialog.level} RISK
                </Text>
                <Text style={styles.safetyTitle}>実行前に確認</Text>
              </View>
              <Text style={styles.safetyMessage}>{safetyDialog.message}</Text>
              {/* LLM意図説明ボックス（学習モード + LLM有効時のみ） */}
              {(settings.experienceMode ?? 'learning') === 'learning' && settings.localLlmEnabled && (intentExplanation || isExplainingIntent) && (
                <View style={styles.intentExplanationBox}>
                  {isExplainingIntent && !intentExplanation && (
                    <ActivityIndicator size="small" color="#A78BFA" style={{ marginRight: 8 }} />
                  )}
                  <Text style={styles.intentExplanationText}>
                    {intentExplanation || '解析中...'}
                  </Text>
                </View>
              )}
              <View style={styles.safetyCommandBox}>
                <Text style={styles.safetyCommandLabel}>$ </Text>
                <Text style={styles.safetyCommand}>{safetyDialog.command}</Text>
              </View>
              <View style={styles.safetyButtons}>
                <Pressable
                  style={[styles.safetyBtn, styles.safetyBtnCancel]}
                  onPress={() => setSafetyDialog(null)}
                >
                  <Text style={styles.safetyBtnCancelText}>キャンセル</Text>
                </Pressable>
                <Pressable
                  style={[styles.safetyBtn, { backgroundColor: safetyDialog.color }]}
                  onPress={() => {
                    const cmd = safetyDialog.command;
                    setSafetyDialog(null);
                    executeCommandSafely(cmd);
                  }}
                >
                  <Text style={styles.safetyBtnExecText}>実行する</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      )}
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
      <TerminalHeader />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
        {/* Terminal output — takes all available space above input */}
        <View style={styles.terminalArea}>
          <BlockList
            blocks={activeSession.blocks}
            entries={activeSession.entries}
            currentDir={activeSession.currentDir}
            onRerun={handleSend}
            onCancel={handleCancel}
            onSelectTool={handleSelectTool}
          />
        </View>

        {/* Input area — pinned to bottom, above keyboard */}
        <CommandInput
          ref={commandInputRef}
          onSend={handleSend}
          onHistoryUp={handleHistoryUp}
          onHistoryDown={handleHistoryDown}
          onCtrlC={handleCtrlC}
          isRunning={isRunning}
          isBridgeConnected={isBridgeConnected}
        />
      </KeyboardAvoidingView>
    </View>
  );
  return hasWallpaper ? (
    <ImageBackground source={{ uri: settings.wallpaperUri! }} style={styles.root} resizeMode="cover">
      {blurIntensity > 0 && <BlurView intensity={blurIntensity} style={StyleSheet.absoluteFill} tint="dark" />}
      {portraitContent}
    </ImageBackground>
  ) : portraitContent;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0A0A0A',
  },
  rootInner: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  // Portrait: terminal area fills all space above input
  terminalArea: {
    flex: 1,
    backgroundColor: '#0A0A0A',
  },
  // コマンド安全確認ダイアログ
  safetyOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  safetyDialog: {
    width: '100%',
    backgroundColor: '#1A1A1A',
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
    color: '#ECEDEE',
    marginTop: 2,
  },
  safetyMessage: {
    fontSize: 13,
    color: '#9BA1A6',
    lineHeight: 20,
    marginBottom: 12,
  },
  safetyCommandBox: {
    flexDirection: 'row',
    backgroundColor: '#0D0D0D',
    borderRadius: 6,
    padding: 10,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  safetyCommandLabel: {
    color: '#00D4AA',
    fontFamily: 'monospace',
    fontSize: 13,
  },
  safetyCommand: {
    color: '#ECEDEE',
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
  safetyBtnCancel: {
    backgroundColor: '#2A2A2A',
  },
  safetyBtnCancelText: {
    color: '#9BA1A6',
    fontSize: 15,
    fontWeight: '600',
  },
  safetyBtnExecText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  intentExplanationBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#A78BFA15',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#A78BFA30',
    padding: 10,
    marginBottom: 12,
  },
  intentExplanationText: {
    color: '#C4B5FD',
    fontSize: 13,
    lineHeight: 19,
    flex: 1,
    fontFamily: 'monospace',
  },
});
