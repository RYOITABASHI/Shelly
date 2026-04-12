import React, { memo, useState, useCallback, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withSequence,
  withRepeat,
  withTiming,
  FadeInDown,
} from 'react-native-reanimated';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { AiBlock as AiBlockType } from '@/store/types';
import { colors as C } from '@/theme.config';
import { getTargetColor } from '@/lib/input-router';
import { speakText, stopSpeaking } from '@/lib/tts';
import { GitGuideBlock } from './GitGuideBlock';
import type { GitGuide } from '@/lib/git-assistant';
import { useTranslation } from '@/lib/i18n';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { SPRING_CONFIGS } from '@/hooks/use-motion';
import { playSound } from '@/lib/sounds';

type Props = {
  block: AiBlockType;
  onSelectTool?: (mentionExample: string) => void;
  onRunCommand?: (command: string) => void;
  onRetry?: (input: string) => void;
  onAskOther?: (input: string) => void;
  fontSize?: number;
};

// ─── Streaming Cursor ─────────────────────────────────────────────────────────

function StreamingCursor({ color }: { color: string }) {
  const opacity = useSharedValue(0.4);

  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 400 }),
        withTiming(0.4, { duration: 400 }),
      ),
      -1,
      false,
    );
  }, []);

  const animStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.Text style={[{ color, fontSize: 14, fontFamily: 'Silkscreen' }, animStyle]}>
      {'\u258B'}
    </Animated.Text>
  );
}

export const AiBlock = memo(function AiBlock({ block, onSelectTool, onRunCommand, onRetry, onAskOther, fontSize = 14 }: Props) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const targetColor = getTargetColor(block.target);
  const { t } = useTranslation();

  const toggleExpand = useCallback(() => setExpanded((v) => !v), []);

  const [copied, setCopied] = useState(false);

  // Copy button animation
  const copyScale = useSharedValue(1);
  const copyAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: copyScale.value }],
  }));

  // Sound on streaming start/complete
  const prevStreaming = React.useRef(block.isStreaming);
  useEffect(() => {
    if (block.isStreaming && !prevStreaming.current) {
      playSound('ai_start');
    }
    if (!block.isStreaming && prevStreaming.current) {
      playSound('ai_complete');
    }
    prevStreaming.current = block.isStreaming;
  }, [block.isStreaming]);

  const handleCopy = useCallback(async () => {
    const text = block.response || block.streamingText || '';
    if (!text) return;
    await Clipboard.setStringAsync(text);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    playSound('copy');
    setCopied(true);
    copyScale.value = withSequence(
      withSpring(0.7, SPRING_CONFIGS.quick),
      withSpring(1.2, SPRING_CONFIGS.bouncy),
      withSpring(1, SPRING_CONFIGS.snappy),
    );
    setTimeout(() => setCopied(false), 1500);
  }, [block.response, block.streamingText, copyScale]);

  const handleSpeak = useCallback(async () => {
    if (isSpeaking) {
      stopSpeaking();
      setIsSpeaking(false);
      return;
    }
    const text = block.response || block.streamingText || '';
    if (!text) return;
    setIsSpeaking(true);
    await speakText(text);
    setIsSpeaking(false);
  }, [isSpeaking, block.response, block.streamingText]);

  const displayText = block.isStreaming ? block.streamingText : block.response;
  const isComplete = !block.isStreaming && !!block.response;

  const elapsed = block.streamingStartTime
    ? ((block.isStreaming ? Date.now() : block.timestamp) - block.streamingStartTime) / 1000
    : 0;
  const tps = elapsed > 0 && block.tokenCount ? (block.tokenCount / elapsed).toFixed(1) : null;

  return (
    <Animated.View
      entering={FadeInDown.duration(250).springify().damping(16)}
      style={styles.bubbleRow}
    >
      {/* Avatar */}
      <View style={[styles.avatar, { backgroundColor: withAlpha(targetColor, 0.15), borderColor: withAlpha(targetColor, 0.3) }]}>
        <Text style={[styles.avatarText, { color: targetColor }]}>AI</Text>
      </View>

      <View style={[styles.container, { backgroundColor: colors.surfaceHigh, borderColor: withAlpha(targetColor, 0.15) }]}>
        {/* Accent bar */}
        <View style={[styles.accentBar, { backgroundColor: targetColor }]} />

        {/* Log summary line */}
        <TouchableOpacity onPress={toggleExpand} activeOpacity={0.7} style={styles.summaryRow}>
          <View style={[styles.targetDot, { backgroundColor: targetColor }]} />
          <Text style={[styles.summaryText, { color: colors.muted, fontSize: fontSize - 2 }]} numberOfLines={1}>
            {block.logSummary}
          </Text>
          {block.isStreaming && (
            <ActivityIndicator size="small" color={targetColor} style={styles.spinner} />
          )}
          <MaterialIcons
            name={expanded ? 'expand-less' : 'expand-more'}
            size={16}
            color={colors.muted}
          />
        </TouchableOpacity>

        {/* Routing detail */}
        {expanded && block.routingDetail && (
          <View style={[styles.detailBox, { borderTopColor: colors.surface }]}>
            <Text style={[styles.detailText, { color: colors.inactive, fontSize: fontSize - 2 }]}>
              {block.routingDetail}
            </Text>
          </View>
        )}

        {/* Mention hint */}
        {block.showHint && block.mentionHint && (
          <View style={[styles.hintBox, { backgroundColor: withAlpha(colors.accent, 0.04) }]}>
            <Text style={[styles.hintText, { color: colors.muted }]}>
              {block.mentionHint.text}
            </Text>
            <Text style={[styles.hintExample, { color: colors.accent }]}>{block.mentionHint.example}</Text>
          </View>
        )}

        {/* Tool suggestion cards */}
        {block.toolSuggestions && block.toolSuggestions.length > 0 && !block.response && !block.isStreaming && (
          <View style={styles.suggestionsContainer}>
            {block.toolSuggestions.map((s) => {
              const sColor = getTargetColor(s.target);
              return (
                <TouchableOpacity
                  key={s.target}
                  style={[styles.suggestionCard, { borderColor: sColor, backgroundColor: colors.background }]}
                  onPress={() => onSelectTool?.(s.mentionExample)}
                  activeOpacity={0.7}
                >
                  <View style={styles.suggestionHeader}>
                    <View style={[styles.targetDot, { backgroundColor: sColor }]} />
                    <Text style={[styles.suggestionLabel, { color: sColor }]}>{s.label}</Text>
                    <Text style={[styles.suggestionConf, { color: colors.inactive }]}>{Math.round(s.confidence * 100)}%</Text>
                  </View>
                  <Text style={[styles.suggestionReason, { color: colors.muted }]}>{s.reason}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {/* Git Guide */}
        {block.target === 'git' && block.response && (() => {
          try {
            const guide: GitGuide = JSON.parse(block.response);
            return (
              <GitGuideBlock
                guide={guide}
                onRunCommand={onRunCommand ?? (() => {})}
              />
            );
          } catch {
            return null;
          }
        })()}

        {/* AI response text / streaming */}
        {block.target !== 'git' && displayText ? (
          <View style={[styles.responseBox, { borderTopColor: colors.surface }]}>
            <Text style={[styles.responseText, { color: colors.foregroundDim, fontSize }]} selectable>
              {displayText}
              {block.isStreaming && <StreamingCursor color={targetColor} />}
            </Text>
            {block.isStreaming && tps && (
              <Text style={[styles.statsText, { color: colors.hint }]}>
                {block.tokenCount} tokens | {tps} tok/s
              </Text>
            )}
          </View>
        ) : null}

        {/* Citations */}
        {block.citations && block.citations.length > 0 && (
          <View style={[styles.citationsBox, { borderTopColor: colors.surface }]}>
            <Text style={[styles.citationsTitle, { color: colors.inactive }]}>Sources:</Text>
            {block.citations.map((c, i) => (
              <Text key={i} style={[styles.citationItem, { color: colors.link }]} numberOfLines={1}>
                {i + 1}. {c.title || c.url}
              </Text>
            ))}
          </View>
        )}

        {/* Action buttons */}
        {(isComplete || displayText) && (
          <View style={styles.actionRow}>
            <Animated.View style={copyAnimStyle}>
              <TouchableOpacity
                style={[
                  styles.actionBtn,
                  { backgroundColor: colors.surface, borderColor: colors.border },
                  copied && { borderColor: colors.accent, backgroundColor: withAlpha(colors.accent, 0.04) },
                ]}
                onPress={handleCopy}
                activeOpacity={0.7}
              >
                <MaterialIcons
                  name={copied ? 'check' : 'content-copy'}
                  size={14}
                  color={copied ? colors.accent : colors.muted}
                />
                <Text style={[styles.actionBtnText, { color: colors.muted }, copied && { color: colors.accent }]}>
                  {copied ? t('ai.copied') : t('ai.copy')}
                </Text>
              </TouchableOpacity>
            </Animated.View>

            {isComplete && (
              <TouchableOpacity
                style={[
                  styles.actionBtn,
                  { backgroundColor: colors.surface, borderColor: colors.border },
                  isSpeaking && { borderColor: '#FF6B6B', backgroundColor: withAlpha(colors.error, 0.1) },
                ]}
                onPress={handleSpeak}
                activeOpacity={0.7}
              >
                <MaterialIcons
                  name={isSpeaking ? 'stop' : 'volume-up'}
                  size={14}
                  color={isSpeaking ? '#FF6B6B' : colors.muted}
                />
                <Text style={[styles.actionBtnText, { color: colors.muted }, isSpeaking && { color: '#FF6B6B' }]}>
                  {isSpeaking ? t('ai.stop') : t('ai.speak')}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* Error action buttons */}
        {block.error && !block.isStreaming && (
          <View style={[styles.errorBox, { borderTopColor: colors.surface }]}>
            <View style={styles.errorRow}>
              <MaterialIcons name="error-outline" size={14} color="#F87171" />
              <Text style={styles.errorText} numberOfLines={2}>{block.error}</Text>
            </View>
            <View style={styles.errorActions}>
              {onRetry && (
                <TouchableOpacity
                  style={[styles.errorBtn, { borderColor: '#FBBF2440' }]}
                  onPress={() => onRetry(block.input)}
                  activeOpacity={0.7}
                >
                  <MaterialIcons name="refresh" size={14} color="#FBBF24" />
                  <Text style={[styles.errorBtnText, { color: C.warning }]}>{t('ai.retry') || 'Retry'}</Text>
                </TouchableOpacity>
              )}
              {onAskOther && (
                <TouchableOpacity
                  style={[styles.errorBtn, { borderColor: '#60A5FA40' }]}
                  onPress={() => onAskOther(block.input)}
                  activeOpacity={0.7}
                >
                  <MaterialIcons name="swap-horiz" size={14} color="#60A5FA" />
                  <Text style={[styles.errorBtnText, { color: '#60A5FA' }]}>{t('ai.ask_other') || 'Ask another AI'}</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}

        {/* Timestamp */}
        <Text style={[styles.bubbleTime, { color: colors.hint }]}>
          {new Date(block.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </Text>
      </View>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  bubbleRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingLeft: 8,
    paddingRight: 48,
    marginVertical: 4,
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
    fontSize: 10,
    fontWeight: '800',
  },
  container: {
    flex: 1,
    borderRadius: 16,
    borderTopLeftRadius: 4,
    borderWidth: 1,
    overflow: 'hidden',
  },
  accentBar: {
    height: 2,
    width: '100%',
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
  },
  targetDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  summaryText: {
    flex: 1,
  },
  spinner: {
    marginHorizontal: 4,
  },
  detailBox: {
    paddingHorizontal: 12,
    paddingBottom: 8,
    borderTopWidth: 1,
    paddingTop: 6,
  },
  detailText: {
    lineHeight: 18,
  },
  hintBox: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 4,
    gap: 6,
  },
  hintText: {
    fontSize: 11,
  },
  hintExample: {
    fontSize: 11,
    fontWeight: '600',
  },
  suggestionsContainer: {
    paddingHorizontal: 10,
    paddingBottom: 8,
    gap: 6,
  },
  suggestionCard: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  suggestionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 3,
  },
  suggestionLabel: {
    fontSize: 12,
    fontWeight: '700',
    flex: 1,
  },
  suggestionConf: {
    fontSize: 11,
  },
  suggestionReason: {
    fontSize: 11,
    marginLeft: 14,
  },
  responseBox: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
  },
  responseText: {
    lineHeight: 21,
  },
  statsText: {
    fontSize: 10,
    marginTop: 4,
    textAlign: 'right',
  },
  citationsBox: {
    paddingHorizontal: 12,
    paddingBottom: 8,
    borderTopWidth: 1,
    paddingTop: 6,
  },
  citationsTitle: {
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 2,
  },
  citationItem: {
    fontSize: 10,
    marginBottom: 1,
  },
  actionRow: {
    flexDirection: 'row',
    paddingHorizontal: 10,
    paddingBottom: 8,
    gap: 8,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    borderWidth: 1,
  },
  actionBtnText: {
    fontSize: 11,
  },
  errorBox: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderTopWidth: 1,
  },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  errorText: {
    fontSize: 11,
    color: '#F87171',
    flex: 1,
  },
  errorActions: {
    flexDirection: 'row',
    gap: 8,
  },
  errorBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    borderWidth: 1,
  },
  errorBtnText: {
    fontSize: 11,
  },
  bubbleTime: {
    fontSize: 9,
    textAlign: 'right',
    paddingHorizontal: 12,
    paddingBottom: 6,
    paddingTop: 2,
  },
});
