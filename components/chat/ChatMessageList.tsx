/**
 * components/chat/ChatMessageList.tsx
 *
 * FlatList of chat messages (GPT/Claude style).
 * Auto-scrolls to bottom on new messages.
 */

import React, { useRef, useCallback, useEffect } from 'react';
import { FlatList, View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { ChatBubble } from './ChatBubble';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import type { ChatMessage } from '@/store/chat-store';

const SAMPLE_PROMPTS = [
  { label: 'ls -la', desc: 'List files' },
  { label: '@claude Explain this project', desc: 'Ask Claude' },
  { label: '@gemini Summarize README', desc: 'Ask Gemini' },
  { label: 'git status', desc: 'Git status' },
];

type Props = {
  messages: ChatMessage[];
  fontSize?: number;
  onSampleTap?: (text: string) => void;
};

export function ChatMessageList({ messages, fontSize, onSampleTap }: Props) {
  const { colors } = useTheme();
  const listRef = useRef<FlatList>(null);
  const prevCount = useRef(messages.length);

  // Auto-scroll on new message
  useEffect(() => {
    if (messages.length > prevCount.current) {
      setTimeout(() => {
        listRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
    prevCount.current = messages.length;
  }, [messages.length]);

  const renderItem = useCallback(({ item }: { item: ChatMessage }) => (
    <ChatBubble message={item} fontSize={fontSize} />
  ), [fontSize]);

  const keyExtractor = useCallback((item: ChatMessage) => item.id, []);

  if (messages.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={[styles.emptyIcon]}>🐚</Text>
        <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Shelly</Text>
        <Text style={[styles.emptySubtitle, { color: colors.muted }]}>
          何でも聞いてください{'\n'}
          @claude @gemini @local でAIを指定できます
        </Text>
        <View style={styles.sampleGrid}>
          {SAMPLE_PROMPTS.map((s) => (
            <TouchableOpacity
              key={s.label}
              style={[styles.sampleCard, { backgroundColor: withAlpha(colors.accent, 0.08), borderColor: withAlpha(colors.accent, 0.15) }]}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={s.desc}
              onPress={() => onSampleTap?.(s.label)}
            >
              <Text style={[styles.sampleLabel, { color: colors.accent }]} numberOfLines={1}>{s.label}</Text>
              <Text style={[styles.sampleDesc, { color: colors.muted }]}>{s.desc}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
    );
  }

  return (
    <FlatList
      ref={listRef}
      data={messages}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      contentContainerStyle={styles.listContent}
      showsVerticalScrollIndicator={false}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
    />
  );
}

const styles = StyleSheet.create({
  listContent: {
    paddingVertical: 12,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 8,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 8,
  },
  emptyTitle: {
    fontSize: 24,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  emptySubtitle: {
    fontSize: 13,
    fontFamily: 'monospace',
    textAlign: 'center',
    lineHeight: 20,
  },
  sampleGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
    marginTop: 16,
    paddingHorizontal: 8,
  },
  sampleCard: {
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minWidth: 140,
    maxWidth: 170,
  },
  sampleLabel: {
    fontSize: 12,
    fontFamily: 'monospace',
    fontWeight: '600',
    marginBottom: 2,
  },
  sampleDesc: {
    fontSize: 10,
    fontFamily: 'monospace',
  },
});
