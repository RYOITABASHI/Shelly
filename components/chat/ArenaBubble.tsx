/**
 * components/chat/ArenaBubble.tsx — Arena Mode 対決UI
 *
 * 2つのAI応答を匿名で並べて表示。投票後にエージェント名を明かす。
 * Wide: 左右並列、Compact: スワイプ切り替え。
 */

import React, { memo, useState, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator, Dimensions } from 'react-native';
import Animated, { FadeInDown, FadeIn } from 'react-native-reanimated';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Haptics from 'expo-haptics';
import Markdown from 'react-native-markdown-display';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { useArenaStore, type ArenaEntry } from '@/store/arena-store';

// ─── Props ──────────────────────────────────────────────────────────────────

type Props = {
  arenaId: string;
  isWide: boolean;
};

// ─── Component ──────────────────────────────────────────────────────────────

export const ArenaBubble = memo(function ArenaBubble({ arenaId, isWide }: Props) {
  const { colors } = useTheme();
  const arena = useArenaStore((s) =>
    s.activeArena?.id === arenaId ? s.activeArena : s.arenaHistory.find((e) => e.id === arenaId),
  );
  const vote = useArenaStore((s) => s.vote);
  const getWinRate = useArenaStore((s) => s.getWinRate);
  const [compactIndex, setCompactIndex] = useState(0);

  const handleVote = useCallback((candidateId: string) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    vote(arenaId, candidateId);
  }, [arenaId, vote]);

  if (!arena) return null;

  const isRevealed = arena.winnerId !== null;
  const [a, b] = arena.candidates;
  const winner = isRevealed ? arena.candidates.find((c) => c.id === arena.winnerId) : null;
  const winRate = winner ? getWinRate(winner.agent) : 0;

  const markdownStyles = {
    body: { color: colors.foregroundDim, fontSize: 13, fontFamily: 'Silkscreen', lineHeight: 18 },
    code_inline: { backgroundColor: withAlpha(colors.foreground, 0.08), color: colors.accent, fontFamily: 'Silkscreen', fontSize: 12 },
    code_block: { backgroundColor: '#0D0D0D', color: '#E8E8E8', fontFamily: 'Silkscreen', fontSize: 12, padding: 8, borderRadius: 6 },
    fence: { backgroundColor: '#0D0D0D', color: '#E8E8E8', fontFamily: 'Silkscreen', fontSize: 12, padding: 8, borderRadius: 6 },
  };

  const renderCandidate = (candidate: typeof a, label: string, idx: number) => {
    const isWinner = isRevealed && candidate.id === arena.winnerId;
    return (
      <View
        key={candidate.id}
        style={[
          styles.candidateCard,
          { backgroundColor: colors.surfaceHigh, borderColor: isWinner ? '#22C55E' : withAlpha(colors.foreground, 0.1) },
          isWide && { flex: 1 },
        ]}
      >
        {/* Candidate header */}
        <View style={styles.candidateHeader}>
          <View style={[styles.labelBadge, { backgroundColor: withAlpha(idx === 0 ? '#3B82F6' : '#F59E0B', 0.15) }]}>
            <Text style={[styles.labelText, { color: idx === 0 ? '#3B82F6' : '#F59E0B' }]}>{label}</Text>
          </View>
          {isRevealed && (
            <Animated.View entering={FadeIn.duration(300)} style={styles.revealRow}>
              <Text style={[styles.agentName, { color: colors.foreground }]}>
                {candidate.agent.charAt(0).toUpperCase() + candidate.agent.slice(1)}
              </Text>
              {isWinner && (
                <MaterialIcons name="emoji-events" size={14} color="#F59E0B" />
              )}
            </Animated.View>
          )}
        </View>

        {/* Response */}
        <ScrollView style={styles.responseScroll} nestedScrollEnabled>
          {candidate.isStreaming ? (
            <View style={styles.streamingRow}>
              <ActivityIndicator size="small" color={colors.accent} />
              <Text style={[styles.streamingText, { color: colors.muted }]}>
                {candidate.response ? '...' : 'thinking...'}
              </Text>
            </View>
          ) : candidate.error ? (
            <Text style={[styles.errorText, { color: '#EF4444' }]}>{candidate.error}</Text>
          ) : null}
          {candidate.response ? (
            <Markdown style={markdownStyles}>{candidate.response}</Markdown>
          ) : null}
        </ScrollView>

        {/* Vote button (pre-reveal) */}
        {!isRevealed && !candidate.isStreaming && candidate.response && (
          <TouchableOpacity
            style={[styles.voteButton, { backgroundColor: withAlpha(colors.accent, 0.15) }]}
            onPress={() => handleVote(candidate.id)}
            activeOpacity={0.7}
          >
            <MaterialIcons name="thumb-up" size={14} color={colors.accent} />
            <Text style={[styles.voteText, { color: colors.accent }]}>This one</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  return (
    <Animated.View entering={FadeInDown.duration(250).springify().damping(16)}>
      <View style={[styles.container, { borderColor: withAlpha(colors.foreground, 0.1) }]}>
        {/* Arena header */}
        <View style={styles.arenaHeader}>
          <Text style={[styles.arenaTitle, { color: colors.foreground }]}>
            Arena Mode
          </Text>
          {isRevealed && (
            <Text style={[styles.resultLabel, { color: '#22C55E' }]}>Result</Text>
          )}
        </View>

        {/* Prompt */}
        <Text style={[styles.prompt, { color: colors.muted }]} numberOfLines={2}>
          {arena.prompt}
        </Text>

        {/* Candidates */}
        {isWide ? (
          <View style={styles.wideRow}>
            {renderCandidate(a, 'A', 0)}
            {renderCandidate(b, 'B', 1)}
          </View>
        ) : (
          <View>
            {/* Compact: show one at a time with switch */}
            {renderCandidate(compactIndex === 0 ? a : b, compactIndex === 0 ? 'A' : 'B', compactIndex)}
            <View style={styles.switchRow}>
              <TouchableOpacity
                style={[styles.switchDot, compactIndex === 0 && { backgroundColor: colors.accent }]}
                onPress={() => setCompactIndex(0)}
              />
              <TouchableOpacity
                style={[styles.switchDot, compactIndex === 1 && { backgroundColor: colors.accent }]}
                onPress={() => setCompactIndex(1)}
              />
            </View>
          </View>
        )}

        {/* Result footer */}
        {isRevealed && winner && (
          <Animated.View entering={FadeIn.duration(300)} style={[styles.resultFooter, { backgroundColor: withAlpha('#22C55E', 0.08) }]}>
            <Text style={[styles.resultText, { color: colors.foreground }]}>
              {winner.agent.charAt(0).toUpperCase() + winner.agent.slice(1)} selected
              {winRate > 0 ? ` (${winRate}% win rate)` : ''}
            </Text>
          </Animated.View>
        )}

        {/* Pre-reveal hint */}
        {!isRevealed && (
          <Text style={[styles.hint, { color: colors.muted }]}>
            Vote to reveal which AI wrote each response
          </Text>
        )}
      </View>
    </Animated.View>
  );
});

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    borderWidth: 1,
    borderRadius: 10,
    overflow: 'hidden',
  },
  arenaHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 4,
  },
  arenaTitle: {
    fontSize: 14,
    fontWeight: '700',
  },
  resultLabel: {
    fontSize: 11,
    fontWeight: '600',
  },
  prompt: {
    fontSize: 12,
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  wideRow: {
    flexDirection: 'row',
    gap: 1,
  },
  candidateCard: {
    borderWidth: 1,
    borderRadius: 8,
    margin: 6,
    padding: 10,
    gap: 6,
    maxHeight: 300,
  },
  candidateHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  labelBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  labelText: {
    fontSize: 12,
    fontWeight: '700',
  },
  revealRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  agentName: {
    fontSize: 12,
    fontWeight: '600',
  },
  responseScroll: {
    maxHeight: 200,
  },
  streamingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
  },
  streamingText: {
    fontSize: 11,
  },
  errorText: {
    fontSize: 12,
  },
  voteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    borderRadius: 6,
    marginTop: 4,
  },
  voteText: {
    fontSize: 12,
    fontWeight: '600',
  },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 8,
  },
  switchDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#444',
  },
  resultFooter: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignItems: 'center',
  },
  resultText: {
    fontSize: 12,
    fontWeight: '600',
  },
  hint: {
    fontSize: 10,
    textAlign: 'center',
    paddingVertical: 6,
  },
});
