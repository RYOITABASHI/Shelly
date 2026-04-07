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
  type ListRenderItemInfo,
} from 'react-native';
import { PaneIdContext } from '@/components/multi-pane/PaneSlot';
import { useAIPaneStore } from '@/store/ai-pane-store';
import { formatContextBadge } from '@/lib/ai-pane-context';
import { useThemeStore } from '@/lib/theme-engine';
import type { ChatMessage } from '@/store/chat-store';
import PaneInputBar from '@/components/panes/PaneInputBar';
import InlineDiff, { hasDiffContent } from '@/components/panes/InlineDiff';

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
});

// ─── AIPane ──────────────────────────────────────────────────────────────────

export default function AIPane() {
  const paneId = useContext(PaneIdContext);
  const theme = useThemeStore((s) => s.activeTheme);
  const colors = theme.colors;
  const addMessage = useAIPaneStore((s) => s.addMessage);

  const handleSubmit = useCallback(
    (text: string) => {
      const msg: ChatMessage = {
        id: `user-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        role: 'user',
        content: text,
        timestamp: Date.now(),
      };
      addMessage(paneId, msg);
    },
    [paneId, addMessage],
  );

  const handleAttach = useCallback(() => {
    console.log('[AIPane] attach pressed — not yet implemented');
  }, []);

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

      {/* Input bar */}
      <PaneInputBar
        placeholder="Ask anything..."
        onSubmit={handleSubmit}
        onAttach={handleAttach}
      />
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
});
