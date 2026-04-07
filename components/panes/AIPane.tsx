/**
 * components/panes/AIPane.tsx
 *
 * AI Pane — per-pane chat interface for the Superset UI.
 * Renders a message list (inverted FlatList) with user/assistant bubbles.
 * Input bar is a separate component (PaneInputBar — P2-T13).
 */

import React, { useContext, useCallback, useRef, useEffect } from 'react';
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
import { PaneIdContext } from '@/components/multi-pane/PaneSlot';
import { useAIPaneStore } from '@/store/ai-pane-store';
import { usePaneStore } from '@/store/pane-store';
import { formatContextBadge } from '@/lib/ai-pane-context';
import { useThemeStore } from '@/lib/theme-engine';
import type { ChatMessage } from '@/store/chat-store';
import PaneInputBar from '@/components/panes/PaneInputBar';
import InlineDiff, { hasDiffContent } from '@/components/panes/InlineDiff';
import { useAIPaneDispatch } from '@/hooks/use-ai-pane-dispatch';
import VoiceWaveform from '@/components/panes/VoiceWaveform';
import { usePaneVoice } from '@/hooks/use-pane-voice';
import { useSettingsStore } from '@/store/settings-store';

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
    fontFamily: 'monospace',
    fontSize: 16,
    letterSpacing: 2,
    marginTop: 2,
  },
});

// ─── Message Bubble ──────────────────────────────────────────────────────────

type BubbleProps = {
  message: ChatMessage;
  isStreaming: boolean;
  accentColor: string;
  surfaceColor: string;
  foregroundColor: string;
  mutedColor: string;
};

const MessageBubble = React.memo(function MessageBubble({
  message,
  isStreaming,
  accentColor,
  surfaceColor,
  foregroundColor,
  mutedColor,
}: BubbleProps) {
  const isUser = message.role === 'user';
  const isLastStreaming = isStreaming && message.isStreaming;
  const displayText = message.streamingText ?? message.content;

  if (isUser) {
    return (
      <View style={bubbleStyles.userRow}>
        <View style={[bubbleStyles.userBubble, { backgroundColor: accentColor }]}>
          <Text style={[bubbleStyles.userText, { color: '#000' }]} selectable>
            {displayText}
          </Text>
        </View>
      </View>
    );
  }

  // System message (e.g., "Switched to Claude")
  if (message.role === 'system') {
    return (
      <View style={bubbleStyles.systemRow}>
        <Text style={[bubbleStyles.systemText, { color: mutedColor }]}>
          {displayText}
        </Text>
      </View>
    );
  }

  // Assistant message
  const containsDiff = !isLastStreaming && hasDiffContent(displayText);

  return (
    <View style={bubbleStyles.assistantRow}>
      {message.agent && (
        <View style={[bubbleStyles.agentBadge, { borderColor: accentColor }]}>
          <Text style={[bubbleStyles.agentBadgeText, { color: accentColor }]}>
            {message.agent}
          </Text>
        </View>
      )}
      <View style={[bubbleStyles.assistantBubble, { backgroundColor: surfaceColor }]}>
        {containsDiff ? (
          <InlineDiff content={displayText} />
        ) : (
          <Text
            style={[bubbleStyles.assistantText, { color: foregroundColor }]}
            selectable
          >
            {displayText}
          </Text>
        )}
        {isLastStreaming && <StreamingDots color={mutedColor} />}
      </View>
    </View>
  );
});

const bubbleStyles = StyleSheet.create({
  userRow: {
    alignItems: 'flex-end',
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  userBubble: {
    maxWidth: '80%',
    borderRadius: 14,
    borderBottomRightRadius: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  userText: {
    fontSize: 13,
    fontFamily: 'monospace',
    lineHeight: 18,
  },
  assistantRow: {
    alignItems: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  agentBadge: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
    marginBottom: 3,
    alignSelf: 'flex-start',
  },
  agentBadgeText: {
    fontSize: 9,
    fontFamily: 'monospace',
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  assistantBubble: {
    maxWidth: '90%',
    borderRadius: 14,
    borderBottomLeftRadius: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  assistantText: {
    fontSize: 13,
    fontFamily: 'monospace',
    lineHeight: 18,
  },
  systemRow: {
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  systemText: {
    fontSize: 10,
    fontFamily: 'monospace',
    opacity: 0.6,
    fontStyle: 'italic',
  },
});

// ─── AIPane ──────────────────────────────────────────────────────────────────

export default function AIPane() {
  const paneId = useContext(PaneIdContext);
  const theme = useThemeStore((s) => s.activeTheme);
  const colors = theme.colors;

  // Dispatch hook — handles message routing, terminal context injection, streaming
  const { dispatch, cancelStreaming, isStreaming: dispatchStreaming } = useAIPaneDispatch(paneId);

  const handleSubmit = useCallback(
    (text: string) => {
      dispatch(text);
    },
    [dispatch],
  );

  // Voice input — transcript is dispatched as a regular message
  const { startRecording, stopRecording, isRecording, isTranscribing } =
    usePaneVoice(handleSubmit);

  const handleMicPress = useCallback(() => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [isRecording, startRecording, stopRecording]);

  const handleMicLongPress = useCallback(() => {
    useSettingsStore.getState().setShowVoiceMode(true);
  }, []);

  // While streaming, the attach button acts as a stop/cancel button
  const handleAttach = useCallback(() => {
    if (dispatchStreaming) {
      cancelStreaming();
    } else {
      console.log('[AIPane] attach pressed — not yet implemented');
    }
  }, [dispatchStreaming, cancelStreaming]);

  // Ensure conversation exists and subscribe to it
  const conversation = useAIPaneStore((s) => {
    // getOrCreate is called outside selector to avoid side-effects in render
    return s.conversations[paneId] ?? null;
  });

  // Initialise conversation lazily on first render
  const initialised = useRef(false);
  if (!initialised.current) {
    useAIPaneStore.getState().getOrCreate(paneId);
    initialised.current = true;
  }

  // Watch for bound agent changes and insert a system message on switch
  const boundAgent = usePaneStore((s) => s.paneAgents[paneId] ?? null);
  const prevAgentRef = useRef<string | null>(boundAgent);
  useEffect(() => {
    const prev = prevAgentRef.current;
    prevAgentRef.current = boundAgent;
    // Skip on first mount (no actual switch happened)
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
        accentColor={colors.accent}
        surfaceColor={colors.surface}
        foregroundColor={colors.foreground}
        mutedColor={colors.muted}
      />
    ),
    [isStreaming, colors],
  );

  const keyExtractor = useCallback((item: ChatMessage) => item.id, []);

  return (
    <View style={[paneStyles.container, { backgroundColor: colors.background }]}>
      {/* Context badge */}
      {contextBadge && (
        <View style={[paneStyles.contextBadge, { borderBottomColor: colors.border }]}>
          <View style={[paneStyles.contextDot, { backgroundColor: colors.accent }]} />
          <Text style={[paneStyles.contextBadgeText, { color: colors.muted }]}>
            {contextBadge}
          </Text>
        </View>
      )}

      {/* Message list */}
      {messages.length === 0 ? (
        <View style={paneStyles.emptyState}>
          <Text style={[paneStyles.emptyText, { color: colors.muted }]}>
            {'Ask anything. I can see your terminal output.'}
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

      {/* Voice mode indicator — shown while recording or transcribing */}
      {(isRecording || isTranscribing) && (
        <View style={[paneStyles.voiceBar, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
          <VoiceWaveform active={isRecording} />
          <Text style={[paneStyles.voiceLabel, { color: colors.accent }]}>
            {isTranscribing ? 'Transcribing...' : 'Listening...'}
          </Text>
          {isRecording && (
            <TouchableOpacity
              onPress={stopRecording}
              style={paneStyles.voiceStopButton}
              accessibilityLabel="Stop recording"
              accessibilityRole="button"
            >
              <MaterialIcons name="stop" size={16} color={colors.accent} />
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Input bar — attach icon doubles as stop button while streaming */}
      <View style={paneStyles.inputRow}>
        <View style={paneStyles.inputBarWrapper}>
          <PaneInputBar
            placeholder={dispatchStreaming ? 'Responding...' : 'Ask anything...'}
            onSubmit={handleSubmit}
            onAttach={handleAttach}
          />
        </View>
        <TouchableOpacity
          onPress={handleMicPress}
          onLongPress={handleMicLongPress}
          delayLongPress={500}
          style={[
            paneStyles.micButton,
            { backgroundColor: isRecording ? colors.accent : colors.surface },
          ]}
          accessibilityLabel={isRecording ? 'Stop recording' : 'Start voice input'}
          accessibilityHint="Long press for full-screen voice mode"
          accessibilityRole="button"
        >
          <MaterialIcons
            name={isRecording ? 'mic' : 'mic-none'}
            size={18}
            color={isRecording ? '#000' : colors.muted}
          />
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const paneStyles = StyleSheet.create({
  container: {
    flex: 1,
  },
  contextBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  contextDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  contextBadgeText: {
    fontSize: 10,
    fontFamily: 'monospace',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  emptyText: {
    fontSize: 12,
    fontFamily: 'monospace',
    textAlign: 'center',
    lineHeight: 18,
    opacity: 0.5,
  },
  listContent: {
    paddingVertical: 8,
  },
  voiceBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  voiceLabel: {
    flex: 1,
    fontSize: 11,
    fontFamily: 'monospace',
    letterSpacing: 0.5,
  },
  voiceStopButton: {
    width: 28,
    height: 28,
    justifyContent: 'center',
    alignItems: 'center',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  inputBarWrapper: {
    flex: 1,
  },
  micButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#1E1E1E',
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: '#1E1E1E',
  },
});
