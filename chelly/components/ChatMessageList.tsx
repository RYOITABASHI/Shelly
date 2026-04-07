/**
 * components/chat/ChatMessageList.tsx
 *
 * FlatList of chat messages (GPT/Claude style).
 * Auto-scrolls to bottom on new messages.
 */

import React, { useRef, useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, View, Text, ScrollView, StyleSheet, TouchableOpacity, Pressable, useWindowDimensions, type NativeSyntheticEvent, type NativeScrollEvent } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { ChatBubble } from './ChatBubble';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { useTranslation } from '@/lib/i18n';
import type { ChatMessage, ActionsWizardData } from '@/store/chat-store';

type Props = {
  messages: ChatMessage[];
  fontSize?: number;
  onSampleTap?: (text: string) => void;
  onRegenerate?: (messageId: string) => void;
  onEdit?: (messageId: string, content: string) => void;
  onDelete?: (messageId: string) => void;
  onStopGenerating?: () => void;
  isStreaming?: boolean;
  projectDir?: string;
  runCommand?: (cmd: string) => Promise<{ stdout: string; exitCode: number }>;
  sendToTerminal?: (text: string) => void;
  runCommandInBackground?: (command: string) => Promise<{ stdout: string; exitCode: number | null }>;
  onWizardUpdate?: (messageId: string, data: ActionsWizardData) => void;
  onWizardComplete?: (messageId: string, data: ActionsWizardData) => void;
  onAutoCheckEnable?: (messageId: string) => void;
  onAutoCheckDismiss?: (messageId: string) => void;
};

export function ChatMessageList({ messages, fontSize, onSampleTap, onRegenerate, onEdit, onDelete, onStopGenerating, isStreaming, projectDir, runCommand, sendToTerminal, runCommandInBackground, onWizardUpdate, onWizardComplete, onAutoCheckEnable, onAutoCheckDismiss }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  const SAMPLE_PROMPTS = [
    { label: 'ls -la', desc: t('chat.sample_list_files') },
    { label: '@claude Explain this project', desc: t('chat.sample_ask_claude') },
    { label: '@gemini Summarize README', desc: t('chat.sample_ask_gemini') },
    { label: 'git status', desc: t('chat.sample_git_status') },
  ];
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  // Force re-mount when screen dimensions change significantly (fold/unfold)
  const layoutKey = `${Math.round(screenWidth / 40)}-${Math.round(screenHeight / 40)}`;
  const listRef = useRef<FlatList>(null);
  const prevCount = useRef(messages.length);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const distFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
    setShowScrollBtn(distFromBottom > 200);
  }, []);

  const handleScrollToBottom = useCallback(() => {
    listRef.current?.scrollToEnd({ animated: true });
  }, []);

  // Deduplicate error summary bubbles: same errorText within 10s → keep first only
  const dedupedMessages = useMemo(() => {
    const recentErrors: { ts: number; text: string }[] = [];
    return messages.filter((m) => {
      if (!m.errorSummaryData) return true;
      const isDupe = recentErrors.some(
        (e) => m.timestamp - e.ts < 10_000 && e.text === m.errorSummaryData!.errorText
      );
      if (isDupe) return false;
      recentErrors.push({ ts: m.timestamp, text: m.errorSummaryData.errorText });
      return true;
    });
  }, [messages]);

  // Auto-scroll on new message
  useEffect(() => {
    if (dedupedMessages.length > prevCount.current) {
      setTimeout(() => {
        listRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
    prevCount.current = dedupedMessages.length;
  }, [dedupedMessages.length]);

  const renderItem = useCallback(({ item }: { item: ChatMessage }) => (
    <ChatBubble
      message={item}
      fontSize={fontSize}
      onRegenerate={onRegenerate}
      onEdit={onEdit}
      onDelete={onDelete}
      projectDir={projectDir}
      runCommand={runCommand}
      sendToTerminal={sendToTerminal}
      runCommandInBackground={runCommandInBackground}
      onWizardUpdate={onWizardUpdate}
      onWizardComplete={onWizardComplete}
      onAutoCheckEnable={onAutoCheckEnable}
      onAutoCheckDismiss={onAutoCheckDismiss}
    />
  ), [fontSize, onRegenerate, onEdit, onDelete, projectDir, runCommand, sendToTerminal, runCommandInBackground, onWizardUpdate, onWizardComplete, onAutoCheckEnable, onAutoCheckDismiss]);

  const keyExtractor = useCallback((item: ChatMessage) => item.id, []);

  const listFooter = useMemo(() => {
    if (!isStreaming || !onStopGenerating) return null;
    return (
      <View style={styles.stopRow}>
        <TouchableOpacity
          style={[styles.stopBtn, { borderColor: colors.border, backgroundColor: colors.surfaceHigh }]}
          onPress={onStopGenerating}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={t('chat.stop_generating')}
        >
          <View style={[styles.stopIcon, { backgroundColor: colors.inactive }]} />
          <Text style={[styles.stopText, { color: colors.foreground }]}>{t('chat.stop_generating')}</Text>
        </TouchableOpacity>
      </View>
    );
  }, [isStreaming, onStopGenerating, colors]);

  if (dedupedMessages.length === 0) {
    return (
      <ScrollView contentContainerStyle={styles.emptyContainer} keyboardShouldPersistTaps="handled">
        <Text style={[styles.emptyTitle, { color: colors.foreground }]}>{t('chat.empty_title')}</Text>
        <Text style={[styles.emptySubtitle, { color: colors.muted }]}>
          {t('chat.empty_subtitle')}
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
      </ScrollView>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        key={`chat-list-${layoutKey}`}
        ref={listRef}
        data={dedupedMessages}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        ListFooterComponent={listFooter ?? undefined}
        onScroll={handleScroll}
        scrollEventThrottle={100}
      />
      {showScrollBtn && (
        <Pressable
          onPress={handleScrollToBottom}
          style={[styles.scrollToBottomFab, { backgroundColor: colors.surfaceHigh, borderColor: colors.border }]}
          accessibilityRole="button"
          accessibilityLabel="Scroll to bottom"
        >
          <MaterialIcons name="keyboard-arrow-down" size={22} color={colors.accent} />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  listContent: {
    paddingVertical: 12,
  },
  emptyContainer: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingTop: 24,
    paddingBottom: 24,
    gap: 8,
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
  stopRow: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  stopBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: 1,
  },
  stopIcon: {
    width: 10,
    height: 10,
    borderRadius: 2,
  },
  stopText: {
    fontSize: 13,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  scrollToBottomFab: {
    position: 'absolute',
    right: 12,
    bottom: 12,
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
  },
});
