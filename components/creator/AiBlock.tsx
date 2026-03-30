import React, { useState, useCallback, useEffect, useRef } from 'react';
import { View, Text, Pressable, StyleSheet, Animated } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import type { AiBlock as AiBlockType } from '@/store/types';
import { getTargetColor, getTargetLabel } from '@/lib/input-router';

type Props = {
  block: AiBlockType;
  /** Called when user taps a tool suggestion card */
  onSelectTool?: (mentionExample: string) => void;
  fontSize?: number;
};

/**
 * AI応答ブロック — ギーク向けストリーミング表示
 *
 * ストリーミング中:
 * - 文字がリアルタイムで流れる（streamingText）
 * - ▋カーソルが点滅
 * - トークン/秒・経過時間をリアルタイム表示
 * - ステータスバー: [■■■■□□□□] 進捗インジケーター
 *
 * 完了後:
 * - 通常のレスポンス表示
 * - 最終トークン/秒・合計時間を表示
 */
export const AiBlock = React.memo(function AiBlock({
  block,
  onSelectTool,
  fontSize = 14,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const targetColor = getTargetColor(block.target);
  const smallFont = Math.max(11, fontSize - 2);
  const tinyFont = Math.max(10, fontSize - 3);

  // カーソル点滅アニメーション
  const cursorOpacity = useRef(new Animated.Value(1)).current;
  const cursorAnim = useRef<Animated.CompositeAnimation | null>(null);

  // 経過時間カウンター
  const [elapsedMs, setElapsedMs] = useState(0);
  const elapsedTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // ストリーミング開始時にカーソル点滅と経過時間カウンターを起動
  useEffect(() => {
    if (block.isStreaming) {
      // カーソル点滅: 500ms周期
      cursorAnim.current = Animated.loop(
        Animated.sequence([
          Animated.timing(cursorOpacity, { toValue: 0, duration: 500, useNativeDriver: true }),
          Animated.timing(cursorOpacity, { toValue: 1, duration: 500, useNativeDriver: true }),
        ])
      );
      cursorAnim.current.start();

      // 経過時間カウンター: 1秒更新（省バッテリー: 100ms→1000ms）
      const startTime = block.streamingStartTime ?? Date.now();
      elapsedTimer.current = setInterval(() => {
        setElapsedMs(Date.now() - startTime);
      }, 1000);
    } else {
      // 停止
      cursorAnim.current?.stop();
      cursorOpacity.setValue(0);
      if (elapsedTimer.current) {
        clearInterval(elapsedTimer.current);
        elapsedTimer.current = null;
      }
    }

    return () => {
      cursorAnim.current?.stop();
      if (elapsedTimer.current) clearInterval(elapsedTimer.current);
    };
  }, [block.isStreaming, block.streamingStartTime, cursorOpacity]);

  const toggleExpand = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const handleSuggestionTap = useCallback(
    (mentionExample: string) => {
      onSelectTool?.(mentionExample);
    },
    [onSelectTool],
  );

  // ── トークン/秒を計算 ──────────────────────────────────────────────────
  const tokensPerSec = (() => {
    const tokens = block.tokenCount ?? 0;
    const startTime = block.streamingStartTime;
    if (!startTime || tokens === 0) return null;
    const elapsed = block.isStreaming ? elapsedMs : (Date.now() - startTime);
    if (elapsed < 100) return null;
    return (tokens / (elapsed / 1000)).toFixed(1);
  })();

  // ── 合計時間（完了後） ────────────────────────────────────────────────
  const totalTimeStr = (() => {
    if (block.isStreaming || !block.streamingStartTime || !block.response) return null;
    // We don't store end time, so we can't show exact total time after completion
    // Show token count instead
    return block.tokenCount ? `${block.tokenCount} tok` : null;
  })();

  // ── ストリーミング中のテキスト ─────────────────────────────────────────
  const displayText = block.isStreaming ? (block.streamingText ?? '') : (block.response ?? '');
  const hasContent = displayText.length > 0;

  // ── ツール提案カード ───────────────────────────────────────────────────
  const hasSuggestions =
    block.layer === 'natural' && block.toolSuggestions && block.toolSuggestions.length > 0;

  return (
    <View style={styles.container}>
      {/* ── 1行サマリー（常時表示） ─────────────────────────────────────── */}
      <Pressable
        onPress={toggleExpand}
        style={({ pressed }) => [
          styles.summaryRow,
          pressed && { opacity: 0.7 },
        ]}
      >
        <View style={[styles.targetBadge, { backgroundColor: targetColor + '22' }]}>
          <Text style={[styles.targetBadgeText, { color: targetColor, fontSize: smallFont - 1 }]}>
            {block.target === 'suggest' ? 'AI' : getTargetLabel(block.target)}
          </Text>
        </View>
        <Text
          style={[styles.summaryText, { fontSize: smallFont }]}
          numberOfLines={1}
        >
          {block.logSummary}
        </Text>
        {/* ストリーミング中: tok/s表示 */}
        {block.isStreaming && tokensPerSec && (
          <Text style={[styles.tokensPerSec, { fontSize: tinyFont }]}>
            {tokensPerSec} tok/s
          </Text>
        )}
        {/* 完了後: トークン数表示 */}
        {!block.isStreaming && totalTimeStr && (
          <Text style={[styles.tokensTotal, { fontSize: tinyFont }]}>
            {totalTimeStr}
          </Text>
        )}
        <MaterialIcons
          name={expanded ? 'expand-less' : 'expand-more'}
          size={16}
          color="#4B5563"
        />
      </Pressable>

      {/* ── 展開時: ルーティング詳細 ──────────────────────────────────── */}
      {expanded && block.routingDetail && (
        <View style={styles.detailBox}>
          {block.routingDetail.split('\n').map((line, i) => (
            <Text key={i} style={[styles.detailText, { fontSize: smallFont }]}>
              {line}
            </Text>
          ))}
        </View>
      )}

      {/* ── AI応答テキスト（ストリーミング中 or 完了後） ─────────────── */}
      {(hasContent || block.isStreaming) && (
        <View style={[styles.responseBox, block.isStreaming && styles.responseBoxStreaming]}>
          {/* ストリーミング中: ステータスヘッダー */}
          {block.isStreaming && (
            <View style={styles.streamingHeader}>
              <Text style={[styles.streamingLabel, { fontSize: tinyFont }]}>
                {'▶ GENERATING'}
              </Text>
              <Text style={[styles.elapsedTime, { fontSize: tinyFont }]}>
                {(elapsedMs / 1000).toFixed(1)}s
              </Text>
            </View>
          )}

          {/* テキスト本体 */}
          <Text style={[styles.responseText, { fontSize }]}>
            {displayText}
            {block.isStreaming && (
              <Animated.Text style={[styles.cursor, { opacity: cursorOpacity }]}>
                {'▋'}
              </Animated.Text>
            )}
          </Text>

          {/* ストリーミング中: フッター（tok/s + elapsed） */}
          {block.isStreaming && (
            <View style={styles.streamingFooter}>
              <Text style={[styles.streamingMeta, { fontSize: tinyFont }]}>
                {`${block.tokenCount ?? 0} tokens`}
              </Text>
              {tokensPerSec && (
                <Text style={[styles.streamingMetaHighlight, { fontSize: tinyFont }]}>
                  {`${tokensPerSec} tok/s`}
                </Text>
              )}
            </View>
          )}
        </View>
      )}

      {/* ── Perplexity 引用リスト ─────────────────────────────────────── */}
      {block.citations && block.citations.length > 0 && !block.isStreaming && (
        <View style={styles.citationsContainer}>
          <Text style={[styles.citationsHeader, { fontSize: tinyFont }]}>
            {'[ SOURCES ]'}
          </Text>
          {block.citations.map((c, i) => (
            <Text
              key={i}
              style={[styles.citationItem, { fontSize: tinyFont }]}
              numberOfLines={1}
            >
              {`[${i + 1}] ${c.url}`}
            </Text>
          ))}
        </View>
      )}

      {/* ── ツール提案カード ──────────────────────────────────────────── */}
      {hasSuggestions && (
        <View style={styles.suggestionsContainer}>
          <Text style={[styles.suggestLabel, { fontSize: smallFont }]}>
            どのツールを使いますか？
          </Text>
          {block.toolSuggestions!.map((s, i) => (
            <Pressable
              key={i}
              onPress={() => handleSuggestionTap(s.mentionExample)}
              style={({ pressed }) => [
                styles.suggestionCard,
                { borderLeftColor: getTargetColor(s.target) },
                pressed && { opacity: 0.7, transform: [{ scale: 0.98 }] },
              ]}
            >
              <View style={styles.suggestionHeader}>
                <View style={[styles.suggestionBadge, { backgroundColor: getTargetColor(s.target) + '22' }]}>
                  <Text style={[styles.suggestionBadgeText, { color: getTargetColor(s.target), fontSize: smallFont - 1 }]}>
                    {s.label}
                  </Text>
                </View>
                <Text style={[styles.confidenceText, { fontSize: smallFont - 1 }]}>
                  {Math.round(s.confidence * 100)}%
                </Text>
              </View>
              <Text style={[styles.suggestionReason, { fontSize: smallFont }]}>
                {s.reason}
              </Text>
              <Text style={[styles.suggestionExample, { fontSize: smallFont - 1 }]}>
                {s.mentionExample}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {/* ── @mention学習ヒント（showHint=trueの場合のみ） ─────────────── */}
      {block.showHint && block.mentionHint && (
        <View style={styles.hintBox}>
          <MaterialIcons name="lightbulb-outline" size={14} color="#6B7280" />
          <View style={styles.hintTextContainer}>
            <Text style={[styles.hintText, { fontSize: smallFont - 1 }]}>
              {block.mentionHint.text}
            </Text>
            <Text style={[styles.hintExample, { fontSize: smallFont - 1 }]}>
              例: {block.mentionHint.example}
            </Text>
          </View>
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    marginHorizontal: 8,
    marginVertical: 2,
  },
  // ── サマリー行 ────────────────────────────────────────────────────────────
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    paddingHorizontal: 6,
    gap: 6,
  },
  targetBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
  },
  targetBadgeText: {
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  summaryText: {
    flex: 1,
    color: '#6B7280',
    fontFamily: 'monospace',
  },
  tokensPerSec: {
    color: '#00D4AA',
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  tokensTotal: {
    color: '#4B5563',
    fontFamily: 'monospace',
  },
  // ── 詳細展開 ──────────────────────────────────────────────────────────────
  detailBox: {
    backgroundColor: '#111111',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginTop: 2,
    marginHorizontal: 6,
    borderLeftWidth: 2,
    borderLeftColor: '#2D2D2D',
  },
  detailText: {
    color: '#6B7280',
    fontFamily: 'monospace',
    lineHeight: 18,
  },
  // ── AI応答 ────────────────────────────────────────────────────────────────
  responseBox: {
    backgroundColor: '#0A0A0A',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginTop: 4,
    marginHorizontal: 6,
    borderWidth: 1,
    borderColor: '#1E1E1E',
  },
  responseBoxStreaming: {
    borderColor: '#00D4AA33',
    borderWidth: 1,
  },
  // ── ストリーミングヘッダー ─────────────────────────────────────────────
  streamingHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
  },
  streamingLabel: {
    color: '#00D4AA',
    fontFamily: 'monospace',
    fontWeight: '700',
    letterSpacing: 1,
  },
  elapsedTime: {
    color: '#4B5563',
    fontFamily: 'monospace',
  },
  // ── テキスト本体 ──────────────────────────────────────────────────────────
  responseText: {
    color: '#D1D5DB',
    fontFamily: 'monospace',
    lineHeight: 20,
  },
  cursor: {
    color: '#00D4AA',
    fontWeight: '700',
  },
  // ── ストリーミングフッター ─────────────────────────────────────────────
  streamingFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: '#1A1A1A',
  },
  streamingMeta: {
    color: '#374151',
    fontFamily: 'monospace',
  },
  streamingMetaHighlight: {
    color: '#00D4AA',
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  // ── ツール提案 ────────────────────────────────────────────────────────────
  suggestionsContainer: {
    marginTop: 6,
    marginHorizontal: 6,
    gap: 4,
  },
  suggestLabel: {
    color: '#6B7280',
    fontFamily: 'monospace',
    marginBottom: 2,
  },
  suggestionCard: {
    backgroundColor: '#111111',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderLeftWidth: 3,
  },
  suggestionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 2,
  },
  suggestionBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
  },
  suggestionBadgeText: {
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  confidenceText: {
    color: '#6B7280',
    fontFamily: 'monospace',
    marginLeft: 'auto',
  },
  suggestionReason: {
    color: '#9CA3AF',
    fontFamily: 'monospace',
    lineHeight: 18,
  },
  suggestionExample: {
    color: '#4B5563',
    fontFamily: 'monospace',
    marginTop: 2,
  },
  // ── ヒント ────────────────────────────────────────────────────────────────
  hintBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginTop: 4,
    marginHorizontal: 6,
    backgroundColor: '#111111',
    borderRadius: 6,
    borderLeftWidth: 2,
    borderLeftColor: '#374151',
  },
  hintTextContainer: {
    flex: 1,
  },
  hintText: {
    color: '#6B7280',
    fontFamily: 'monospace',
    lineHeight: 16,
  },
  hintExample: {
    color: '#4B5563',
    fontFamily: 'monospace',
    marginTop: 2,
  },
  // ── Perplexity 引用 ────────────────────────────────────────────────────────
  citationsContainer: {
    marginTop: 6,
    marginHorizontal: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: '#0A1A1A',
    borderRadius: 4,
    borderLeftWidth: 2,
    borderLeftColor: '#20B2AA',
    gap: 2,
  },
  citationsHeader: {
    color: '#20B2AA',
    fontFamily: 'monospace',
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 4,
  },
  citationItem: {
    color: '#4B8B8B',
    fontFamily: 'monospace',
    lineHeight: 16,
  },
});
