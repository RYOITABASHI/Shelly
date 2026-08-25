/**
 * components/panes/AIPane.tsx
 *
 * AI Pane — per-pane chat interface for the Superset UI.
 * Redesigned to match mock: provider labels, inline diff, READING TERMINAL badge.
 */

import React, { useContext, useCallback, useRef, useEffect, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  Animated,
  Easing,
  TouchableOpacity,
  Alert,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { PaneIdContext, MultiPaneContext } from '@/components/multi-pane/PaneSlot';
import {
  addAiPaneThreadSwitchNotice,
  resolveAiPaneStoreKey,
  useAIPaneStore,
} from '@/store/ai-pane-store';
import { digestConversationForJournal } from '@/lib/companion-journal';
import { execCommand } from '@/hooks/use-native-exec';
import { usePaneStore } from '@/store/pane-store';
import { useInboundStore } from '@/store/inbound-store';
import { parseAgentNL } from '@/lib/agent-nl-parser';
import { formatContextBadge } from '@/lib/ai-pane-context';
import type { ChatMessage } from '@/store/types';
import PaneInputBar from '@/components/panes/PaneInputBar';
import InlineDiff, { hasDiffContent } from '@/components/panes/InlineDiff';
import AgentConfirmCard, { type ConfirmedAgentDraft } from '@/components/panes/AgentConfirmCard';
import AgentScheduleReadinessCard from '@/components/panes/AgentScheduleReadinessCard';
import AgentChatConfirm from '@/components/panes/AgentChatConfirm';
import { CodeBlockWithAction, splitFencedCode } from '@/components/panes/CodeBlockWithAction';
import { useAIPaneDispatch, type AIPaneDispatchOptions } from '@/hooks/use-ai-pane-dispatch';
import VoiceWaveform from '@/components/panes/VoiceWaveform';
import { usePaneVoice } from '@/hooks/use-pane-voice';
import { useSettingsStore } from '@/store/settings-store';
import { VoiceChat } from '@/components/VoiceChat';
import { colors as C, fonts as F } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';
import { usePaneContentBackground, usePanelBackground } from '@/hooks/use-panel-background';
import { logError } from '@/lib/debug-logger';
import {
  isAiPaneAgent,
  pickDefaultAiPaneAgent,
} from '@/lib/ai-pane-agents';
import { kickLocalLlmAutoStart } from '@/lib/local-llm-autostart';
import { useTranslation } from '@/lib/i18n';
import { AgentUndoButton } from '@/components/panes/AgentUndoButton';

const AUTO_FOLLOW_THRESHOLD_PX = 100;

// Adapter matching lib/companion-journal.ts's `(cmd) => Promise<string>`
// runCommand shape — same small pattern used by
// hooks/use-ai-pane-dispatch.ts's and AgentRunsPane.tsx's own
// runAgentShellCommand.
async function runCompanionJournalCommand(cmd: string): Promise<string> {
  const result = await execCommand(cmd, 30_000);
  if (result.exitCode !== 0) throw new Error(result.stderr || `exit ${result.exitCode}`);
  return result.stdout;
}

// ─── Streaming Indicator ─────────────────────────────────────────────────────

const StreamingDots = React.memo(function StreamingDots({ color }: { color: string }) {
  const opacity = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.3,
          duration: 600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [opacity]);

  return (
    <Animated.Text style={[dotStyles.text, { color, opacity }]}>
      {'...'}
    </Animated.Text>
  );
});

const dotStyles = StyleSheet.create({
  text: {
    fontFamily: F.family,
    fontSize: 16,
    letterSpacing: 2,
    marginTop: 2,
  },
});

// ─── Message Bubble (Redesigned) ────────────────────────────────────────────

type BubbleProps = {
  message: ChatMessage;
  isStreaming: boolean;
  maxWidth?: number;
  onConfirmAgentDraft?: (messageId: string, confirmed: ConfirmedAgentDraft) => void;
  onCancelAgentDraft?: (messageId: string) => void;
  onDismissScheduleReadiness?: (messageId: string) => void;
};

const MessageBubble = React.memo(function MessageBubble({
  message,
  isStreaming,
  maxWidth,
  onConfirmAgentDraft,
  onCancelAgentDraft,
  onDismissScheduleReadiness,
}: BubbleProps) {
  const { t } = useTranslation();
  const containerMaxWidth = maxWidth && maxWidth > 0 ? { maxWidth } : null;
  const isUser = message.role === 'user';
  const isLastStreaming = isStreaming && message.isStreaming;
  const displayText = message.streamingText ?? message.content;
  const accessibilityLabel = `${isUser ? 'You' : 'Shelly'}: ${displayText}`;

  // P1 scheduling-reliability audit (2026-07-15): one-time, dismissible
  // checklist appended after a device's first scheduled agent registration —
  // see hooks/use-ai-pane-dispatch.ts's confirmAgentDraft. Never a
  // registration gate: the agent it follows already exists.
  if (message.scheduleReadinessCard) {
    return (
      <View accessible accessibilityLabel={accessibilityLabel} style={[bubbleStyles.messageContainer, containerMaxWidth]}>
        <AgentScheduleReadinessCard onDismiss={() => onDismissScheduleReadiness?.(message.id)} />
      </View>
    );
  }

  // NL-self-registration confirm card (Phase 0 §2.1). While pending, the card
  // replaces the bubble text; once confirmed/cancelled it falls through to the
  // normal assistant text render (which now holds the result line).
  if (message.agentDraft && message.agentCardState === 'pending') {
    // Phase 7: app-act / tool-pinned-orchestration drafts render chat-native —
    // the plan is plain assistant text (message.content, set by
    // summarizeAgentDraftAsText at creation) with a trailing inline
    // Confirm/Cancel row, NOT a card. Everything else keeps AgentConfirmCard.
    if (message.agentChatConfirm) {
      return (
        <View accessible accessibilityLabel={accessibilityLabel} style={[bubbleStyles.messageContainer, containerMaxWidth]}>
          <Text style={[bubbleStyles.roleLabelAgent, { color: C.text2 }]}>
            {t('chat.companion_label')}
          </Text>
          <View style={bubbleStyles.assistantContent}>
            <Text style={bubbleStyles.assistantText} selectable>{message.content}</Text>
          </View>
          <AgentChatConfirm
            draft={message.agentDraft}
            onConfirm={(c) => onConfirmAgentDraft?.(message.id, c)}
            onCancel={() => onCancelAgentDraft?.(message.id)}
          />
        </View>
      );
    }
    return (
      <View accessible accessibilityLabel={accessibilityLabel} style={[bubbleStyles.messageContainer, containerMaxWidth]}>
        <AgentConfirmCard
          draft={message.agentDraft}
          onConfirm={(c) => onConfirmAgentDraft?.(message.id, c)}
          onCancel={() => onCancelAgentDraft?.(message.id)}
        />
      </View>
    );
  }

  if (message.role === 'system') {
    return (
      <View accessible accessibilityLabel={`System: ${displayText}`} style={[bubbleStyles.systemRow, containerMaxWidth]}>
        <Text style={bubbleStyles.systemText}>{displayText}</Text>
      </View>
    );
  }

  if (isUser) {
    return (
      <View accessible accessibilityLabel={accessibilityLabel} style={[bubbleStyles.messageContainer, containerMaxWidth]}>
        <Text
          style={[
            bubbleStyles.roleLabel,
            { color: C.accent, textShadowColor: withAlpha(C.accent, 0.6) },
          ]}
        >
          YOU
        </Text>
        <Text style={bubbleStyles.userText} selectable>{displayText}</Text>
      </View>
    );
  }

  // Assistant message
  const containsDiff = !isLastStreaming && hasDiffContent(displayText);

  return (
    <View accessible accessibilityLabel={accessibilityLabel} style={[bubbleStyles.messageContainer, containerMaxWidth]}>
      <Text style={[bubbleStyles.roleLabelAgent, { color: C.text2 }]}>
        {t('chat.companion_label')}
      </Text>
      <View style={bubbleStyles.assistantContent}>
        {containsDiff ? (
          <InlineDiff content={displayText} />
        ) : (
          // Render fenced code blocks as CodeBlockWithAction so users get
          // COPY + INSERT-to-terminal actions per block. Prose outside the
          // fences renders as plain selectable text. While the response is
          // still streaming we skip the parse and show raw text — fenced
          // regex would fire on an unclosed ``` and hide content.
          isLastStreaming ? (
            <Text style={bubbleStyles.assistantText} selectable>{displayText}</Text>
          ) : (
            splitFencedCode(displayText).map((seg, i) =>
              seg.kind === 'code' ? (
                <CodeBlockWithAction key={i} lang={seg.lang} code={seg.content} />
              ) : (
                <Text key={i} style={bubbleStyles.assistantText} selectable>
                  {seg.content}
                </Text>
              ),
            )
          )
        )}
        {isLastStreaming && <StreamingDots color="#6B7280" />}
      </View>
      {!isLastStreaming && message.agentRollbackOffer && (
        <AgentUndoButton agentId={message.agentRollbackOffer.agentId} />
      )}
    </View>
  );
});

const bubbleStyles = StyleSheet.create({
  messageContainer: {
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  roleLabel: {
    fontSize: 7,
    fontFamily: F.family,
    fontWeight: '800',
    letterSpacing: 0.8,
    color: C.text2,
    marginBottom: 2,
    textTransform: 'uppercase',
    textShadowColor: 'transparent',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 6,
  },
  roleLabelAgent: {
    fontSize: 7,
    fontFamily: F.family,
    fontWeight: '800',
    letterSpacing: 0.8,
    color: C.text2,
    marginBottom: 2,
    textTransform: 'uppercase',
  },
  userText: {
    fontSize: 8,
    fontFamily: F.family,
    lineHeight: 14,
    color: C.text1,
  },
  assistantContent: {
    backgroundColor: C.bgSurface,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  assistantText: {
    fontSize: 8,
    fontFamily: F.family,
    lineHeight: 14,
    color: C.text1,
  },
  systemRow: {
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  systemText: {
    fontSize: 7,
    fontFamily: F.family,
    color: C.text2,
    fontStyle: 'italic',
  },
});

// ─── AIPane ──────────────────────────────────────────────────────────────────

export default function AIPane() {
  const { t } = useTranslation();
  const paneId = useContext(PaneIdContext);
  const paneBg = usePaneContentBackground(C.bgDeep);
  // Bug #56 — narrow grid layouts (2×2 or 1+2) drop pane width below
  // ~360dp. Shrink horizontal padding so bubble content does not get
  // clipped by the pane chrome.
  const mp = useContext(MultiPaneContext);
  const pw = mp?.paneWidth ?? 0;
  const ph = mp?.paneHeight ?? 0;
  const isCompactPane = pw > 0 && pw < 360;
  const compactOverlay = isCompactPane
    ? { paddingHorizontal: 6 }
    : null;
  // Wave F — cap chat bubble width at 85% of the pane so long responses
  // do not run into the right-edge chrome in 2×2 grid layouts. Fall back
  // to 0 (unconstrained) when paneWidth is not yet measured.
  const bubbleMaxWidth = pw > 0 ? Math.max(Math.floor(pw * 0.85), 180) : 0;
  // ph is captured for future height-aware tweaks (e.g. clamping the
  // input-row footprint in short panes). Referenced to satisfy the
  // noUnusedLocals compiler option.
  void ph;

  const { dispatch, cancelStreaming, isStreaming: dispatchStreaming, confirmAgentDraft, cancelAgentDraft } =
    useAIPaneDispatch(paneId);
  const isNearBottomRef = useRef(true);

  const handleSubmit = useCallback(
    (text: string, dispatchOpts?: AIPaneDispatchOptions) => {
      isNearBottomRef.current = true;
      void dispatch(text, dispatchOpts).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        try {
          logError('AIPane', 'dispatch rejected', err);
        } catch {}
        try {
          const store = useAIPaneStore.getState();
          const conversationKey = resolveAiPaneStoreKey(paneId);
          store.setStreaming(conversationKey, false);
          store.addMessage(conversationKey, {
            id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            role: 'assistant',
            content: `Error: ${message}`,
            timestamp: Date.now(),
            error: message,
          });
        } catch (recoveryErr) {
          try {
            logError('AIPane', 'failed to surface dispatch rejection', recoveryErr);
          } catch {}
        }
      });
    },
    [dispatch, paneId],
  );

  // Widget ASK → `@agent …` handoff (2026-07-29): a prompt queued from
  // outside any AI Pane (app/_layout.tsx's `shelly:///ai?widgetAgentCommand=1`
  // deep-link branch) is claimed here and fed through the SAME handleSubmit →
  // dispatch() path a typed submission uses, so the widget-seeded `@agent`
  // command lands in the identical NL-parse/slot-fill/confirm-card flow.
  // takePendingExternalPrompt() is claim-and-clear (synchronous), so with
  // multiple mounted AI Panes exactly one dispatches it. The claimed entry's
  // `source` tag ('widget-ask') is threaded through so dispatch() can apply
  // the widget-scoped registration-confirm policy — see
  // lib/widget-agent-registration.ts (OFF-by-default opt-in; with it off this
  // is byte-identical to a typed submission).
  const pendingExternalPrompt = useAIPaneStore((s) => s.pendingExternalPrompt);
  useEffect(() => {
    if (!pendingExternalPrompt) return;
    const taken = useAIPaneStore.getState().takePendingExternalPrompt();
    if (taken?.text) {
      handleSubmit(taken.text, taken.source ? { source: taken.source } : undefined);
    }
  }, [pendingExternalPrompt, handleSubmit]);

  const { startRecording, stopRecording, isRecording, isTranscribing } =
    usePaneVoice(handleSubmit);

  const handleMicPress = useCallback(() => {
    if (isRecording) stopRecording();
    else startRecording();
  }, [isRecording, startRecording, stopRecording]);

  // Keyboard height tracking lifted to MultiPaneContainer so split
  // layouts don't stack paddingBottom per-pane.

  const [voiceChatVisible, setVoiceChatVisible] = useState(false);
  const handleMicLongPress = useCallback(() => {
    setVoiceChatVisible(true);
  }, []);

  const handleAttach = useCallback(() => {
    if (dispatchStreaming) {
      cancelStreaming();
    }
  }, [dispatchStreaming, cancelStreaming]);

  const conversation = useAIPaneStore((s) => {
    return s.conversations[resolveAiPaneStoreKey(paneId)] ?? null;
  });
  const paneTerminalContext = useAIPaneStore(
    (s) => s.conversations[paneId]?.terminalContext ?? null,
  );

  const initialised = useRef(false);
  if (!initialised.current) {
    useAIPaneStore.getState().getOrCreate(paneId);
    const currentAgent = usePaneStore.getState().paneAgents[paneId];
    if (!isAiPaneAgent(currentAgent)) {
      // AI Pane/background uses API providers only. Codex remains a
      // foreground Terminal CLI with its own official auth flow.
      const s = useSettingsStore.getState().settings;
      usePaneStore.getState().bindAgent(paneId, pickDefaultAiPaneAgent(s));
    }
    initialised.current = true;
  }

  const boundAgent = usePaneStore((s) => s.paneAgents[paneId] ?? null);
  useEffect(() => {
    if (boundAgent === 'local') {
      kickLocalLlmAutoStart('ai-pane-open');
    }
  }, [boundAgent]);

  // Keep the chat pinned to the latest message as content streams in, mirroring
  // the terminal's auto-scroll. A single scrollToEnd is fragile with variable row
  // heights + removeClippedSubviews (the content size is estimated, so one call
  // lands short), so we fire it three times — immediately, next frame, and after a
  // short settle — exactly like AgentChatPane which already tail-follows reliably.
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const scrollToLatest = useCallback(() => {
    listRef.current?.scrollToEnd({ animated: false });
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
    setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 80);
  }, []);
  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
    isNearBottomRef.current = distanceFromBottom <= AUTO_FOLLOW_THRESHOLD_PX;
  }, []);
  const handleContentSizeChange = useCallback(() => {
    if (isNearBottomRef.current) scrollToLatest();
  }, [scrollToLatest]);

  // 2026-08-24 (Fable5 design consult, "一人の相棒" Phase 3): this used to
  // be two separate effects — one posting a hardcoded, non-i18n'd
  // "Switched to Gemini" system message on every boundAgent change, the
  // other calling addAiPaneThreadSwitchNotice on every resolved-key
  // change. Since binding to any explicit provider always changes BOTH at
  // once, switching produced two stacked system lines every time. Only
  // the conversation-key-based notice remains — see its own i18n key
  // comments (chat.switched_to_companion_thread/chat.switched_to_pane_thread
  // in lib/i18n/locales) for why the provider name itself was dropped
  // from the wording (shown in the pane header instead).
  const resolvedConversationKey = resolveAiPaneStoreKey(paneId);
  const prevConversationKeyRef = useRef(resolvedConversationKey);
  useEffect(() => {
    const prev = prevConversationKeyRef.current;
    prevConversationKeyRef.current = resolvedConversationKey;
    addAiPaneThreadSwitchNotice(prev, resolvedConversationKey, t);
    // Companion journal (G1-P2's sibling, "一人の相棒" Gap②): distill the
    // thread being LEFT into a note before it's forgotten. Same trigger
    // point as carry-forward (this is the sole switch-notice caller,
    // trigger-source-agnostic — covers the pane-header "SWITCH AGENT" menu
    // AND an `@mention` switch alike), but deliberately NOT awaited: it
    // only feeds a FUTURE conversation, never the one in progress.
    if (prev !== resolvedConversationKey) {
      const settings = useSettingsStore.getState().settings;
      const sourceMessages = useAIPaneStore.getState().conversations[prev]?.messages ?? [];
      void digestConversationForJournal(
        prev,
        sourceMessages,
        { baseUrl: settings.localLlmUrl, model: settings.localLlmModel ?? 'default', enabled: true },
        runCompanionJournalCommand,
      );
    }
  }, [resolvedConversationKey, t]);

  // Phase 3 inbound gateway: drain authorized Telegram utterances into the SAME
  // @agent confirm-card pipeline a local utterance uses. consume() pops atomically
  // so with multiple AI panes only one card is created per message; the human
  // still taps Confirm and the usual secret-guard / approval checks apply — inbound
  // carries no extra privilege.
  const pendingInboundCount = useInboundStore((s) => s.pending.length);
  useEffect(() => {
    if (pendingInboundCount === 0) return;
    const item = useInboundStore.getState().consume();
    if (!item) return;
    const draft = parseAgentNL(item.text, useSettingsStore.getState().socialConnectors ?? []);
    useAIPaneStore.getState().addMessage(resolveAiPaneStoreKey(paneId), {
      id: `inb-card-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      agentDraft: draft,
      agentCardState: 'pending',
    });
  }, [pendingInboundCount, paneId]);

  const messages = conversation?.messages ?? [];
  const isStreaming = conversation?.isStreaming ?? false;
  const contextBadge = formatContextBadge(paneTerminalContext);

  // Tail-follow signal: changes on every new message AND on each streamed token,
  // since the store mutates the last message's streamingText in place (the array
  // ref may not change, so onContentSizeChange alone can miss growth). Re-running
  // scrollToLatest on this signal keeps the latest line pinned during streaming.
  const last = messages[messages.length - 1];
  const tailSignal = `${messages.length}:${(last?.streamingText ?? last?.content ?? '').length}:${isStreaming ? 1 : 0}`;
  useEffect(() => {
    if (messages.length > 0 && isNearBottomRef.current) scrollToLatest();
  }, [tailSignal, scrollToLatest]); // eslint-disable-line react-hooks/exhaustive-deps

  // P1 scheduling-reliability audit (2026-07-15): dismissing the checklist
  // just collapses this one message back to a short acknowledgement line —
  // the settings flag that prevents it from ever reappearing is already set
  // at append time (confirmAgentDraft), not here, so leaving the card
  // undismissed can't cause it to resurface on a later scheduled agent.
  const dismissScheduleReadiness = useCallback((messageId: string) => {
    useAIPaneStore.getState().updateMessage(resolveAiPaneStoreKey(paneId), messageId, {
      scheduleReadinessCard: false,
      content: `✓ ${t('schedulereadiness.title')}`,
    });
  }, [paneId]);

  const confirmDeleteMessage = useCallback((messageId: string) => {
    Alert.alert(
      t('chat.delete_message_title'),
      t('chat.delete_message_body'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => useAIPaneStore.getState().deleteMessage(
            resolveAiPaneStoreKey(paneId),
            messageId,
          ),
        },
      ],
    );
  }, [paneId, t]);

  const confirmClearConversation = useCallback(() => {
    Alert.alert(
      t('chat.clear_conversation_title'),
      t('chat.clear_conversation_body'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => useAIPaneStore.getState().clearConversation(
            resolveAiPaneStoreKey(paneId),
          ),
        },
      ],
    );
  }, [paneId, t]);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<ChatMessage>) => (
      <TouchableOpacity
        activeOpacity={1}
        onLongPress={() => confirmDeleteMessage(item.id)}
        delayLongPress={350}
      >
        <MessageBubble
          message={item}
          isStreaming={isStreaming}
          maxWidth={bubbleMaxWidth}
          onConfirmAgentDraft={confirmAgentDraft}
          onCancelAgentDraft={cancelAgentDraft}
          onDismissScheduleReadiness={dismissScheduleReadiness}
        />
      </TouchableOpacity>
    ),
    [isStreaming, bubbleMaxWidth, confirmAgentDraft, cancelAgentDraft, dismissScheduleReadiness, confirmDeleteMessage],
  );

  const keyExtractor = useCallback((item: ChatMessage) => item.id, []);
  const voiceBarBg = usePanelBackground(C.bgSurface);

  return (
    // Keyboard avoidance moved to MultiPaneContainer — in a split
    // layout every pane-level KAV stacked its own paddingBottom,
    // which collapsed the terminal content to 0px. Container now
    // shrinks the whole grid by keyboardHeight once, panes render
    // at their natural size.
    <View style={[paneStyles.container, { backgroundColor: paneBg }, compactOverlay]}>
      {messages.length > 0 && (
        <TouchableOpacity
          style={paneStyles.clearConversationButton}
          onPress={confirmClearConversation}
          accessibilityRole="button"
          accessibilityLabel={t('chat.clear_conversation_button')}
          hitSlop={6}
        >
          <MaterialIcons name="delete-sweep" size={15} color={C.text2} />
        </TouchableOpacity>
      )}

      {/* Context badge — READING TERMINAL 1 */}
      {contextBadge && (
        <View style={paneStyles.contextBadge}>
          <MaterialIcons name="visibility" size={9} color={C.accent} />
          <Text style={paneStyles.contextBadgeText}>{contextBadge}</Text>
        </View>
      )}

      {/* Message list */}
      {messages.length === 0 ? (
        <View style={paneStyles.emptyState}>
          <Text style={paneStyles.emptyText}>
            {t('chat.empty_subtitle')}
          </Text>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          inverted={false}
          contentContainerStyle={paneStyles.listContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          onScroll={handleScroll}
          scrollEventThrottle={16}
          onContentSizeChange={handleContentSizeChange}
        />
      )}

      {/* Voice mode indicator */}
      {(isRecording || isTranscribing) && (
        <View style={[paneStyles.voiceBar, { backgroundColor: voiceBarBg }]}>
          <VoiceWaveform active={isRecording} />
          <Text style={paneStyles.voiceLabel}>
            {isTranscribing ? 'Transcribing...' : 'Listening...'}
          </Text>
          {isRecording && (
            <TouchableOpacity onPress={stopRecording} style={paneStyles.voiceStopButton}>
              <MaterialIcons name="stop" size={16} color={C.accent} />
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Input bar (mic integrated so the attach/mic/send icons live inside
          the same rounded pill rather than as separate large circles). */}
      <PaneInputBar
        placeholder={dispatchStreaming ? 'Responding...' : 'Ask anything...'}
        onSubmit={handleSubmit}
        onAttach={handleAttach}
        showMic
        isRecording={isRecording}
        onMicPress={handleMicPress}
        onMicLongPress={handleMicLongPress}
        paneId={paneId}
      />

      <VoiceChat
        visible={voiceChatVisible}
        onClose={() => setVoiceChatVisible(false)}
        dispatch={dispatch}
        paneId={paneId}
      />
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const paneStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: C.bgDeep,
  },
  contextBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 5,
    marginHorizontal: 10,
    marginTop: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: withAlpha(C.accent, 0.35),
    backgroundColor: withAlpha(C.accent, 0.08),
  },
  clearConversationButton: {
    position: 'absolute',
    top: 4,
    right: 6,
    zIndex: 2,
    width: 28,
    height: 28,
    justifyContent: 'center',
    alignItems: 'center',
  },
  contextDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: C.accent,
  },
  contextBadgeText: {
    fontSize: 7,
    fontFamily: F.family,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    fontWeight: '700',
    color: C.accent,
    textShadowColor: withAlpha(C.accent, 0.9),
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 8,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  emptyText: {
    fontSize: 8,
    fontFamily: F.family,
    textAlign: 'center',
    lineHeight: 14,
    color: C.text2,
  },
  listContent: {
    paddingVertical: 8,
  },
  voiceBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: C.border,
    gap: 8,
  },
  voiceLabel: {
    flex: 1,
    fontSize: 7,
    fontFamily: F.family,
    letterSpacing: 0.5,
    color: C.accent,
  },
  voiceStopButton: {
    width: 28,
    height: 28,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
