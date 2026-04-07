/**
 * components/chat/TranslateOverlay.tsx — リアルタイム翻訳オーバーレイ
 *
 * Chat画面上部に半透明で表示。チャット履歴を汚さない。
 * 新しい翻訳が来たら前の翻訳を上書き（常に最新1ブロック）。
 */

import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { useExecutionLogStore } from '@/store/execution-log-store';
import { useTerminalStore } from '@/store/terminal-store';
import { translateTerminalOutput, type TranslateResult } from '@/lib/realtime-translate';

export function TranslateOverlay() {
  const { colors } = useTheme();
  const enabled = useTerminalStore((s) => s.settings.realtimeTranslateEnabled);
  const terminalOutput = useExecutionLogStore((s) => s.terminalOutput);
  const [translation, setTranslation] = useState<TranslateResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastLineCountRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled || terminalOutput.length === 0) return;
    if (terminalOutput.length === lastLineCountRef.current) return;
    lastLineCountRef.current = terminalOutput.length;

    // Debounce: wait 1s after last output line before translating
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      // Cancel previous translation
      abortRef.current?.abort();
      abortRef.current = new AbortController();

      const recentLines = terminalOutput.slice(-10);
      const currentLine = recentLines[recentLines.length - 1];
      const contextLines = recentLines.slice(0, -1);

      const result = await translateTerminalOutput(
        currentLine,
        contextLines,
        abortRef.current.signal,
      );
      if (result) {
        setTranslation(result);
        // Auto-hide after 10 seconds
        if (hideRef.current) clearTimeout(hideRef.current);
        hideRef.current = setTimeout(() => setTranslation(null), 10000);
      }
    }, 1000);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    };
  }, [enabled, terminalOutput]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (hideRef.current) clearTimeout(hideRef.current);
      abortRef.current?.abort();
    };
  }, []);

  if (!enabled || !translation) return null;

  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(200)}
      style={[styles.container, {
        backgroundColor: withAlpha(colors.surface ?? '#111', 0.92),
        borderBottomColor: translation.isApprovalAlert ? '#F59E0B' : colors.border,
      }]}
    >
      <View style={styles.header}>
        <MaterialIcons
          name={translation.isApprovalAlert ? 'warning' : 'translate'}
          size={14}
          color={translation.isApprovalAlert ? '#F59E0B' : colors.accent}
        />
        <Text style={[styles.providerLabel, { color: colors.muted }]}>
          {translation.provider}
        </Text>
      </View>
      <Text style={[styles.text, { color: colors.foreground }]} numberOfLines={3}>
        {translation.translated}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  providerLabel: {
    fontSize: 10,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  text: {
    fontSize: 13,
    fontFamily: 'monospace',
    lineHeight: 19,
  },
});
