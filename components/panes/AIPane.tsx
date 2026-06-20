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
  type ListRenderItemInfo,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { PaneIdContext, MultiPaneContext } from '@/components/multi-pane/PaneSlot';
import { useAIPaneStore } from '@/store/ai-pane-store';
import { usePaneStore } from '@/store/pane-store';
import { formatContextBadge } from '@/lib/ai-pane-context';
import type { ChatMessage } from '@/store/chat-store';
import PaneInputBar from '@/components/panes/PaneInputBar';
import InlineDiff, { hasDiffContent } from '@/components/panes/InlineDiff';
import AgentConfirmCard, { type ConfirmedAgentDraft } from '@/components/panes/AgentConfirmCard';
import { CodeBlockWithAction, splitFencedCode } from '@/components/panes/CodeBlockWithAction';
import { useAIPaneDispatch } from '@/hooks/use-ai-pane-dispatch';
import VoiceWaveform from '@/components/panes/VoiceWaveform';
import { usePaneVoice } from '@/hooks/use-pane-voice';
import { useSettingsStore } from '@/store/settings-store';
import { VoiceChat } from '@/components/VoiceChat';
import { colors as C, fonts as F } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';
import { usePaneContentBackground, usePanelBackground } from '@/hooks/use-panel-background';
import { logError } from '@/lib/debug-logger';
import {
  getAiPaneAgentMeta,
  isAiPaneAgent,
  pickDefaultAiPaneAgent,
  resolveAiPaneAgent,
} from '@/lib/ai-pane-agents';
import { kickLocalLlmAutoStart } from '@/lib/local-llm-autostart';

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
};

const MessageBubble = React.memo(function MessageBubble({
  message,
  isStreaming,
  maxWidth,
  onConfirmAgentDraft,
  onCancelAgentDraft,
}: BubbleProps) {
  const containerMaxWidth = maxWidth && maxWidth > 0 ? { maxWidth } : null;
  const isUser = message.role === 'user';
  const isLastStreaming = isStreaming && message.isStreaming;
  const displayText = message.streamingText ?? message.content;

  // NL-self-registration confirm card (Phase 0 §2.1). While pending, the card
  // replaces the bubble text; once confirmed/cancelled it falls through to the
  // normal assistant text render (which now holds the result line).
  if (message.agentDraft && message.agentCardState === 'pending') {
    return (
      <View style={[bubbleStyles.messageContainer, containerMaxWidth]}>
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
      <View style={[bubbleStyles.systemRow, containerMaxWidth]}>
        <Text style={bubbleStyles.systemText}>{displayText}</Text>
      </View>
    );
  }

  if (isUser) {
    return (
      <View style={[bubbleStyles.messageContainer, containerMaxWidth]}>
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
  const agentKey = resolveAiPaneAgent(message.agent, 'local');
  const agentMeta = getAiPaneAgentMeta(agentKey);
  const agentLabel = agentMeta.label.toUpperCase();

  return (
    <View style={[bubbleStyles.messageContainer, containerMaxWidth]}>
      <Text style={[bubbleStyles.roleLabelAgent, { color: C.text2 }]}>
        {agentLabel}
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

  const handleSubmit = useCallback(
    (text: string) => {
      void dispatch(text).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        try {
          logError('AIPane', 'dispatch rejected', err);
        } catch {}
        try {
          const store = useAIPaneStore.getState();
          store.setStreaming(paneId, false);
          store.addMessage(paneId, {
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
    return s.conversations[paneId] ?? null;
  });

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

  const prevAgentRef = useRef<string | null>(boundAgent);
  useEffect(() => {
    const prev = prevAgentRef.current;
    prevAgentRef.current = boundAgent;
    if (prev === boundAgent) return;
    const agentName = boundAgent
      ? boundAgent.charAt(0).toUpperCase() + boundAgent.slice(1)
      : 'Unbound';
    const systemMsg: ChatMessage = {
      id: `system-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      role: 'system',
      content: `Switched to ${agentName}`,
      timestamp: Date.now(),
    };
    useAIPaneStore.getState().addMessage(paneId, systemMsg);
  }, [boundAgent, paneId]);

  const messages = conversation?.messages ?? [];
  const isStreaming = conversation?.isStreaming ?? false;
  const terminalContext = conversation?.terminalContext ?? null;
  const contextBadge = formatContextBadge(terminalContext);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<ChatMessage>) => (
      <MessageBubble
        message={item}
        isStreaming={isStreaming}
        maxWidth={bubbleMaxWidth}
        onConfirmAgentDraft={confirmAgentDraft}
        onCancelAgentDraft={cancelAgentDraft}
      />
    ),
    [isStreaming, bubbleMaxWidth, confirmAgentDraft, cancelAgentDraft],
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
            Ask anything. I can see your terminal output.
          </Text>
        </View>
      ) : (
        <FlatList
          data={messages}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          inverted={false}
          contentContainerStyle={paneStyles.listContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          removeClippedSubviews
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
      />

      <VoiceChat
        visible={voiceChatVisible}
        onClose={() => setVoiceChatVisible(false)}
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
