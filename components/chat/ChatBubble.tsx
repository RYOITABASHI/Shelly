/**
 * components/chat/ChatBubble.tsx
 *
 * Chat message bubble — GPT/Claude style.
 * Right-aligned for user, left-aligned for assistant.
 */

import React, { memo, useState, useCallback, useRef, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Share } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import Markdown from 'react-native-markdown-display';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import type { ChatMessage, ChatAgent } from '@/store/chat-store';
import type { ThemeColorPalette } from '@/lib/theme';

// ─── Agent Colors ────────────────────────────────────────────────────────────

const AGENT_COLORS: Record<ChatAgent | 'default', string> = {
  claude: '#F59E0B',
  gemini: '#3B82F6',
  local: '#8B5CF6',
  perplexity: '#14B8A6',
  team: '#EC4899',
  git: '#F97316',
  codex: '#6366F1',
  default: '#00D4AA',
};

function getAgentColor(agent?: ChatAgent): string {
  return agent ? AGENT_COLORS[agent] : AGENT_COLORS.default;
}

function getAgentLabel(agent?: ChatAgent): string {
  if (!agent) return 'AI';
  const labels: Record<ChatAgent, string> = {
    claude: 'Claude',
    gemini: 'Gemini',
    local: 'Local',
    perplexity: 'Search',
    team: 'Team',
    git: 'Git',
    codex: 'Codex',
  };
  return labels[agent];
}

// ─── Props ───────────────────────────────────────────────────────────────────

type Props = {
  message: ChatMessage;
  fontSize?: number;
  onRegenerate?: (messageId: string) => void;
  onEdit?: (messageId: string, content: string) => void;
  onDelete?: (messageId: string) => void;
};

// ─── Component ───────────────────────────────────────────────────────────────

export const ChatBubble = memo(function ChatBubble({ message, fontSize = 14, onRegenerate, onEdit, onDelete }: Props) {
  const { colors } = useTheme();
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isUser = message.role === 'user';
  const agentColor = getAgentColor(message.agent);

  useEffect(() => {
    return () => { if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current); };
  }, []);

  const handleCopy = useCallback(async () => {
    const text = message.content || message.streamingText || '';
    if (!text) return;
    await Clipboard.setStringAsync(text);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
  }, [message.content, message.streamingText]);

  const handleShare = useCallback(async () => {
    const text = message.content || message.streamingText || '';
    if (!text) return;
    const agentLabel = message.agent ? getAgentLabel(message.agent) : 'AI';
    try {
      await Share.share({ message: `${text}\n\n— via Shelly (${agentLabel})` });
    } catch { /* cancelled */ }
  }, [message.content, message.streamingText, message.agent]);

  const displayText = message.isStreaming ? (message.streamingText || '') : message.content;

  // ── User Bubble (right-aligned) ──────────────────────────────────────────
  if (isUser) {
    return (
      <Animated.View
        entering={FadeInDown.duration(200).springify().damping(18)}
        style={styles.userRow}
      >
        <View style={[styles.userBubble, { backgroundColor: withAlpha(colors.accent, 0.12), borderColor: withAlpha(colors.accent, 0.2) }]}>
          <Text style={[styles.messageText, { color: colors.foreground, fontSize }]} selectable>
            {message.content}
          </Text>
          <View style={styles.bottomRow}>
            <View style={styles.actionGroup}>
              {onEdit && (
                <TouchableOpacity onPress={() => onEdit(message.id, message.content)} activeOpacity={0.7} style={styles.copyBtn} accessibilityRole="button" accessibilityLabel="Edit message">
                  <MaterialIcons name="edit" size={12} color={colors.inactive} />
                </TouchableOpacity>
              )}
              {onDelete && (
                <TouchableOpacity onPress={() => onDelete(message.id)} activeOpacity={0.7} style={styles.copyBtn} accessibilityRole="button" accessibilityLabel="Delete message">
                  <MaterialIcons name="delete-outline" size={12} color={colors.inactive} />
                </TouchableOpacity>
              )}
            </View>
            <Text style={[styles.timestamp, { color: colors.inactive }]}>
              {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </Text>
          </View>
        </View>
      </Animated.View>
    );
  }

  // ── Assistant Bubble (left-aligned) ──────────────────────────────────────
  return (
    <Animated.View
      entering={FadeInDown.duration(250).springify().damping(16)}
      style={styles.assistantRow}
    >
      {/* Avatar */}
      <View style={[styles.avatar, { backgroundColor: withAlpha(agentColor, 0.15), borderColor: withAlpha(agentColor, 0.3) }]}>
        <Text style={[styles.avatarText, { color: agentColor }]}>
          {getAgentLabel(message.agent).slice(0, 2)}
        </Text>
      </View>

      <View style={[styles.assistantBubble, { backgroundColor: colors.surfaceHigh, borderColor: withAlpha(agentColor, 0.15) }]}>
        {/* Accent bar */}
        <View style={[styles.accentBar, { backgroundColor: agentColor }]} />

        {/* Agent label + LLM model name */}
        {message.agent && (
          <View style={styles.agentRow}>
            <View style={[styles.agentDot, { backgroundColor: agentColor }]} />
            <Text style={[styles.agentLabel, { color: agentColor }]}>
              {getAgentLabel(message.agent)}
            </Text>
            {message.agent === 'local' && message.llmModelLabel && (
              <Text style={[styles.llmModelLabel, { color: withAlpha(agentColor, 0.6) }]}>
                {message.llmModelLabel}
              </Text>
            )}
            {message.isStreaming && (
              <ActivityIndicator size="small" color={agentColor} style={{ marginLeft: 4 }} />
            )}
          </View>
        )}

        {/* Message text (Markdown) */}
        {displayText ? (
          <View style={styles.markdownWrap}>
            <Markdown
              style={{
                body: { color: colors.foregroundDim, fontSize, fontFamily: 'monospace', lineHeight: 21 },
                code_inline: { backgroundColor: withAlpha(colors.foreground, 0.08), color: colors.accent, fontFamily: 'monospace', fontSize: fontSize - 1, paddingHorizontal: 4, borderRadius: 3 },
                code_block: { backgroundColor: '#0D0D0D', color: '#E8E8E8', fontFamily: 'monospace', fontSize: fontSize - 1, padding: 10, borderRadius: 6, lineHeight: 18 },
                fence: { backgroundColor: '#0D0D0D', color: '#E8E8E8', fontFamily: 'monospace', fontSize: fontSize - 1, padding: 10, borderRadius: 6, lineHeight: 18 },
                heading1: { color: colors.foreground, fontSize: fontSize + 4, fontWeight: '700', fontFamily: 'monospace', marginVertical: 6 },
                heading2: { color: colors.foreground, fontSize: fontSize + 2, fontWeight: '700', fontFamily: 'monospace', marginVertical: 4 },
                heading3: { color: colors.foreground, fontSize: fontSize + 1, fontWeight: '600', fontFamily: 'monospace', marginVertical: 3 },
                link: { color: colors.link ?? colors.accent },
                blockquote: { borderLeftColor: agentColor, borderLeftWidth: 3, paddingLeft: 10, opacity: 0.85 },
                bullet_list_icon: { color: colors.foregroundDim },
                ordered_list_icon: { color: colors.foregroundDim },
              }}
            >
              {displayText}
            </Markdown>
            {message.isStreaming && (
              <Text style={{ color: agentColor, fontSize: 14, fontFamily: 'monospace' }}>{'\u258B'}</Text>
            )}
          </View>
        ) : message.isStreaming ? (
          <View style={[styles.markdownWrap, { flexDirection: 'row', alignItems: 'center', gap: 6 }]}>
            <ActivityIndicator size="small" color={agentColor} />
            <Text style={{ color: agentColor, fontSize: 12, fontFamily: 'monospace', opacity: 0.7 }}>考え中...</Text>
          </View>
        ) : null}

        {/* Command executions */}
        {message.executions && message.executions.length > 0 && (
          <View style={styles.execContainer}>
            {message.executions.map((exec, i) => (
              <CommandExecView key={i} exec={exec} colors={colors} />
            ))}
          </View>
        )}

        {/* Citations */}
        {message.citations && message.citations.length > 0 && (
          <View style={[styles.citationsBox, { borderTopColor: colors.surface }]}>
            <Text style={[styles.citationsTitle, { color: colors.inactive }]}>Sources:</Text>
            {message.citations.map((c, i) => (
              <Text key={i} style={[styles.citationItem, { color: colors.link }]} numberOfLines={1}>
                {i + 1}. {c.title || c.url}
              </Text>
            ))}
          </View>
        )}

        {/* Error */}
        {message.error && (
          <View style={styles.errorRow}>
            <MaterialIcons name="error-outline" size={14} color="#F87171" />
            <Text style={styles.errorText} numberOfLines={3}>{message.error}</Text>
          </View>
        )}

        {/* Actions + Timestamp */}
        <View style={styles.bottomRow}>
          {!message.isStreaming && displayText ? (
            <View style={styles.actionGroup}>
              <TouchableOpacity onPress={handleCopy} activeOpacity={0.7} style={styles.copyBtn} accessibilityRole="button" accessibilityLabel="Copy message">
                <MaterialIcons
                  name={copied ? 'check' : 'content-copy'}
                  size={12}
                  color={copied ? colors.accent : colors.inactive}
                />
              </TouchableOpacity>
              <TouchableOpacity onPress={handleShare} activeOpacity={0.7} style={styles.copyBtn} accessibilityRole="button" accessibilityLabel="Share message">
                <MaterialIcons name="share" size={12} color={colors.inactive} />
              </TouchableOpacity>
              {onRegenerate && message.role === 'assistant' && (
                <TouchableOpacity onPress={() => onRegenerate(message.id)} activeOpacity={0.7} style={styles.copyBtn} accessibilityRole="button" accessibilityLabel="Regenerate response">
                  <MaterialIcons name="refresh" size={12} color={colors.inactive} />
                </TouchableOpacity>
              )}
              {onDelete && (
                <TouchableOpacity onPress={() => onDelete(message.id)} activeOpacity={0.7} style={styles.copyBtn} accessibilityRole="button" accessibilityLabel="Delete message">
                  <MaterialIcons name="delete-outline" size={12} color={colors.inactive} />
                </TouchableOpacity>
              )}
            </View>
          ) : <View />}
          <Text style={[styles.timestamp, { color: colors.inactive }]}>
            {message.tokenCount ? `${message.tokenCount} tok · ` : ''}
            {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
        </View>
      </View>
    </Animated.View>
  );
});

// ─── Command Execution Sub-component ─────────────────────────────────────────

function CommandExecView({ exec, colors }: { exec: { command: string; output: string; exitCode: number | null; isCollapsed: boolean }; colors: ThemeColorPalette }) {
  const [collapsed, setCollapsed] = useState(exec.isCollapsed);
  const isError = exec.exitCode !== null && exec.exitCode !== 0;
  const outputLines = exec.output.split('\n');
  const shouldCollapse = outputLines.length > 5;

  return (
    <View style={[styles.execBlock, { borderColor: isError ? '#F8717133' : '#2D2D2D' }]}>
      <TouchableOpacity
        style={styles.execHeader}
        onPress={() => shouldCollapse && setCollapsed(!collapsed)}
        activeOpacity={shouldCollapse ? 0.7 : 1}
      >
        <Text style={styles.execPrompt}>$</Text>
        <Text style={styles.execCommand} numberOfLines={1}>{exec.command}</Text>
        {exec.exitCode !== null && (
          <View style={[styles.exitBadge, { backgroundColor: isError ? '#F8717120' : '#4ADE8020' }]}>
            <Text style={[styles.exitText, { color: isError ? '#F87171' : '#4ADE80' }]}>
              {isError ? `exit ${exec.exitCode}` : 'ok'}
            </Text>
          </View>
        )}
        {shouldCollapse && (
          <MaterialIcons name={collapsed ? 'expand-more' : 'expand-less'} size={14} color="#6B7280" />
        )}
      </TouchableOpacity>
      {!collapsed && exec.output && (
        <Text style={styles.execOutput} selectable>
          {exec.output}
        </Text>
      )}
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // User bubble (right-aligned)
  userRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingLeft: 48,
    paddingRight: 12,
    marginVertical: 3,
  },
  userBubble: {
    borderRadius: 16,
    borderTopRightRadius: 4,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    maxWidth: '85%',
  },

  // Assistant bubble (left-aligned)
  assistantRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingLeft: 8,
    paddingRight: 48,
    marginVertical: 3,
    gap: 8,
  },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  avatarText: {
    fontSize: 9,
    fontWeight: '800',
    fontFamily: 'monospace',
  },
  assistantBubble: {
    flex: 1,
    maxWidth: '88%',
    borderRadius: 16,
    borderTopLeftRadius: 4,
    borderWidth: 1,
    overflow: 'hidden',
  },
  accentBar: {
    height: 2,
    width: '100%',
  },
  agentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 8,
    gap: 5,
  },
  agentDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  agentLabel: {
    fontSize: 11,
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  llmModelLabel: {
    fontSize: 10,
    fontFamily: 'monospace',
    fontWeight: '400',
    marginLeft: 6,
  },

  // Markdown wrapper
  markdownWrap: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  // Shared
  messageText: {
    fontFamily: 'monospace',
    lineHeight: 21,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  timestamp: {
    fontSize: 9,
    fontFamily: 'monospace',
    textAlign: 'right',
  },
  bottomRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 6,
  },
  actionGroup: {
    flexDirection: 'row',
    gap: 2,
  },
  copyBtn: {
    padding: 8,
    minWidth: 36,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Command execution
  execContainer: {
    paddingHorizontal: 10,
    paddingBottom: 6,
    gap: 4,
  },
  execBlock: {
    backgroundColor: '#0D0D0D',
    borderRadius: 8,
    borderWidth: 1,
    overflow: 'hidden',
  },
  execHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 6,
  },
  execPrompt: {
    color: '#00D4AA',
    fontSize: 12,
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  execCommand: {
    color: '#E8E8E8',
    fontSize: 12,
    fontFamily: 'monospace',
    flex: 1,
  },
  exitBadge: {
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  exitText: {
    fontSize: 9,
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  execOutput: {
    color: '#9CA3AF',
    fontSize: 11,
    fontFamily: 'monospace',
    lineHeight: 16,
    paddingHorizontal: 10,
    paddingBottom: 8,
    borderTopWidth: 1,
    borderTopColor: '#1A1A1A',
    paddingTop: 6,
  },

  // Citations
  citationsBox: {
    paddingHorizontal: 12,
    paddingBottom: 6,
    borderTopWidth: 1,
    paddingTop: 6,
  },
  citationsTitle: {
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: '600',
    marginBottom: 2,
  },
  citationItem: {
    fontFamily: 'monospace',
    fontSize: 10,
    marginBottom: 1,
  },

  // Error
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  errorText: {
    fontFamily: 'monospace',
    fontSize: 11,
    color: '#F87171',
    flex: 1,
  },
});
