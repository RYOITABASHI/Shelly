/**
 * components/terminal/ExecutionLogPanel.tsx
 *
 * ターミナルタブに表示するコマンド実行ログパネル。
 * チャットタブでBridge経由で実行されたコマンドと結果をリアルタイム表示。
 * 初学者が「裏で何が起きているか」を学べる教育的UI。
 */

import React, { useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
} from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useExecutionLogStore, type ExecutionLogEntry } from '@/store/execution-log-store';

interface Props {
  colors: any;
}

export function ExecutionLogPanel({ colors: c }: Props) {
  const { entries, isLogPanelOpen, toggleLogPanel, clearEntries, resetUnread } = useExecutionLogStore();
  const scrollRef = useRef<ScrollView>(null);

  // Auto-scroll to bottom on new entries
  useEffect(() => {
    if (isLogPanelOpen && entries.length > 0) {
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [entries.length, isLogPanelOpen]);

  // Reset unread when panel is visible
  useEffect(() => {
    if (isLogPanelOpen) resetUnread();
  }, [isLogPanelOpen]);

  if (entries.length === 0) return null;

  return (
    <View style={[styles.container, { backgroundColor: c.backgroundDeep || '#0A0A0A', borderTopColor: c.border }]}>
      {/* Header */}
      <Pressable style={styles.header} onPress={toggleLogPanel}>
        <View style={styles.headerLeft}>
          <MaterialIcons
            name={isLogPanelOpen ? 'expand-more' : 'expand-less'}
            size={18}
            color={c.accent}
          />
          <View style={styles.headerDot} />
          <Text style={[styles.headerTitle, { color: c.accent }]}>
            Activity Log
          </Text>
          <Text style={[styles.headerCount, { color: c.muted }]}>
            {entries.length}
          </Text>
        </View>
        {isLogPanelOpen && (
          <Pressable onPress={clearEntries} hitSlop={8}>
            <MaterialIcons name="delete-outline" size={16} color={c.muted} />
          </Pressable>
        )}
      </Pressable>

      {/* Log entries */}
      {isLogPanelOpen && (
        <ScrollView
          ref={scrollRef}
          style={styles.scrollArea}
          showsVerticalScrollIndicator={false}
        >
          {entries.map((entry) => (
            <LogEntry key={entry.id} entry={entry} colors={c} />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function LogEntry({ entry, colors: c }: { entry: ExecutionLogEntry; colors: any }) {
  const time = new Date(entry.timestamp).toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const isCommand = !!entry.command;
  const isError = entry.exitCode != null && entry.exitCode !== 0;
  const statusColor = entry.isStreaming ? '#FBBF24' : isError ? '#F87171' : '#4ADE80';

  return (
    <View style={[styles.entry, { borderLeftColor: statusColor }]}>
      {/* Source + time */}
      <View style={styles.entryHeader}>
        <View style={[styles.sourceBadge, { backgroundColor: statusColor + '20' }]}>
          <Text style={[styles.sourceText, { color: statusColor }]}>
            {entry.source === 'chat' ? 'Chat' : entry.agent || 'AI'}
          </Text>
        </View>
        <Text style={[styles.timeText, { color: c.muted }]}>{time}</Text>
      </View>

      {/* User input (if AI) */}
      {entry.userInput && (
        <Text style={[styles.userInput, { color: c.muted }]} numberOfLines={1}>
          &gt; {entry.userInput}
        </Text>
      )}

      {/* Command */}
      {entry.command && (
        <View style={[styles.commandLine, { backgroundColor: '#1A1A2E' }]}>
          <Text style={[styles.prompt, { color: c.accent }]}>$</Text>
          <Text style={[styles.commandText, { color: '#E8E8E8' }]} numberOfLines={2}>
            {entry.command}
          </Text>
        </View>
      )}

      {/* Output (truncated) */}
      {entry.output && (
        <Text
          style={[styles.outputText, { color: isError ? '#F87171' : '#9CA3AF' }]}
          numberOfLines={4}
        >
          {entry.output.slice(0, 300)}
        </Text>
      )}

      {/* AI response (truncated) */}
      {entry.aiResponse && (
        <Text style={[styles.aiText, { color: '#A78BFA' }]} numberOfLines={2}>
          {entry.aiResponse.slice(0, 200)}
        </Text>
      )}

      {/* Streaming indicator */}
      {entry.isStreaming && (
        <Text style={[styles.streamingText, { color: '#FBBF24' }]}>...</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    maxHeight: 200,
    borderTopWidth: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  headerDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#4ADE80',
  },
  headerTitle: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  headerCount: {
    fontSize: 10,
    fontFamily: 'monospace',
  },
  scrollArea: {
    paddingHorizontal: 8,
    paddingBottom: 4,
  },
  entry: {
    borderLeftWidth: 2,
    paddingLeft: 8,
    paddingVertical: 4,
    marginBottom: 6,
  },
  entryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  sourceBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
  },
  sourceText: {
    fontSize: 9,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  timeText: {
    fontSize: 9,
    fontFamily: 'monospace',
  },
  userInput: {
    fontSize: 10,
    fontFamily: 'monospace',
    fontStyle: 'italic',
    marginBottom: 2,
  },
  commandLine: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 3,
    marginBottom: 2,
  },
  prompt: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  commandText: {
    fontSize: 11,
    fontFamily: 'monospace',
    flex: 1,
  },
  outputText: {
    fontSize: 10,
    fontFamily: 'monospace',
    lineHeight: 14,
  },
  aiText: {
    fontSize: 10,
    fontFamily: 'monospace',
    lineHeight: 14,
  },
  streamingText: {
    fontSize: 10,
    fontFamily: 'monospace',
  },
});
