/**
 * StatusIndicator — 接続状況 + 稼働モデルの表示バー
 *
 * Chat/Terminal両タブのヘッダー下に表示。
 * - Bridge接続状態（接続済み / 切断 / 接続中）
 * - 稼働中のチャットAI（Cerebras / Groq / Local LLM / CLI名）
 * - 稼働中のローカルLLM（モデル名 + ポート）
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTerminalStore } from '@/store/terminal-store';
import { useTermuxBridge } from '@/hooks/use-termux-bridge';
import { getActiveLlmLabel } from '@/hooks/use-tool-discovery';

function getActiveChat(settings: {
  cerebrasApiKey?: string;
  groqApiKey?: string;
  localLlmEnabled?: boolean;
  defaultAgent?: string;
}): { label: string; color: string } {
  if (settings.cerebrasApiKey) return { label: 'Cerebras', color: '#A78BFA' };
  if (settings.groqApiKey) return { label: 'Groq', color: '#F97316' };
  if (settings.localLlmEnabled) return { label: 'Local LLM', color: '#60A5FA' };
  const cli = settings.defaultAgent || 'gemini-cli';
  const map: Record<string, { label: string; color: string }> = {
    'claude-code': { label: 'Claude', color: '#D4A574' },
    'codex': { label: 'Codex', color: '#4ADE80' },
    'gemini-cli': { label: 'Gemini', color: '#60A5FA' },
  };
  return map[cli] ?? { label: 'CLI', color: '#6B7280' };
}

export function StatusIndicator() {
  const { bridgeStatus, settings } = useTerminalStore();
  const { isConnected } = useTermuxBridge();

  const bridgeColor = isConnected ? '#4ADE80' : bridgeStatus === 'connecting' ? '#FBBF24' : '#6B7280';
  const bridgeLabel = isConnected ? 'Bridge' : bridgeStatus === 'connecting' ? 'Connecting' : 'Offline';
  const chat = getActiveChat(settings);
  const llmLabel = getActiveLlmLabel();

  return (
    <View style={styles.container}>
      {/* Bridge status */}
      <View style={styles.item}>
        <View style={[styles.dot, { backgroundColor: bridgeColor }]} />
        <Text style={[styles.label, { color: bridgeColor }]}>{bridgeLabel}</Text>
      </View>

      <Text style={styles.separator}>·</Text>

      {/* Chat AI */}
      <View style={styles.item}>
        <MaterialIcons name="chat-bubble-outline" size={10} color={chat.color} />
        <Text style={[styles.label, { color: chat.color }]}>{chat.label}</Text>
      </View>

      {/* Local LLM (if running) */}
      {llmLabel && (
        <>
          <Text style={styles.separator}>·</Text>
          <View style={styles.item}>
            <MaterialIcons name="memory" size={10} color="#60A5FA" />
            <Text style={[styles.label, { color: '#60A5FA' }]} numberOfLines={1}>{llmLabel}</Text>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 4,
    backgroundColor: '#0A0A0A',
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
    gap: 6,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  label: {
    fontSize: 10,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  separator: {
    color: '#333',
    fontSize: 10,
  },
});
