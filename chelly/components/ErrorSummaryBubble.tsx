/**
 * components/chat/ErrorSummaryBubble.tsx
 *
 * エラー要約バブル — TranslateOverlay（10秒で消える）をWide時にChat永続バブルに昇格。
 * [修正を提案] → AI dispatch、[@teamに聞く] → @team dispatch。
 */

import React, { memo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { t } from '@/lib/i18n';
import Animated, { FadeInDown } from 'react-native-reanimated';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';

export type ErrorSummaryData = {
  errorText: string;
  translation: string;
  provider: string;
};

type Props = {
  data: ErrorSummaryData;
  onSuggestFix?: (context: string) => void;
  onAskTeam?: (context: string) => void;
  onExecuteFix?: (command: string) => void;
};

export const ErrorSummaryBubble = memo(function ErrorSummaryBubble({ data, onSuggestFix, onAskTeam, onExecuteFix }: Props) {
  const { colors } = useTheme();

  // Try to extract a quick-fix command from common error patterns
  const quickFix = React.useMemo(() => {
    const err = data.errorText;
    if (err.includes('Module not found') || err.includes('Cannot find module')) {
      const match = err.match(/Cannot find module '([^']+)'/);
      if (match) return `npm install ${match[1].replace(/^@/, '').split('/')[0]}`;
    }
    if (err.includes('ENOENT') && err.includes('package.json')) return 'npm init -y';
    if (err.includes('permission denied')) return 'chmod +x ' + (err.match(/permission denied,.*'([^']+)'/)?.[1] ?? '');
    if (err.includes('EADDRINUSE')) {
      const port = err.match(/port (\d+)/i)?.[1] ?? err.match(/:(\d{4,5})/)?.[1];
      return port ? `kill $(lsof -ti:${port})` : null;
    }
    if (err.includes('command not found')) {
      const cmd = err.match(/(\w+): command not found/)?.[1];
      return cmd ? `pkg install ${cmd}` : null;
    }
    return null;
  }, [data.errorText]);

  const handleExecuteFix = () => {
    if (!quickFix) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onExecuteFix?.(quickFix);
  };

  const handleSuggestFix = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSuggestFix?.(t('error_summary.suggest_fix_prompt', { errorText: data.errorText, translation: data.translation }));
  };

  const handleAskTeam = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onAskTeam?.(t('error_summary.ask_team_prompt', { errorText: data.errorText, translation: data.translation }));
  };

  return (
    <Animated.View entering={FadeInDown.duration(200).springify().damping(18)}>
      <View style={[styles.container, { backgroundColor: colors.surfaceHigh, borderColor: withAlpha('#EF4444', 0.3) }]}>
        {/* Header */}
        <View style={styles.header}>
          <MaterialIcons name="error-outline" size={16} color="#EF4444" />
          <Text style={[styles.headerText, { color: colors.foreground }]}>
            {t('error_summary.header')}
          </Text>
          <Text style={[styles.providerLabel, { color: colors.muted }]}>
            {data.provider}
          </Text>
        </View>

        {/* Translation */}
        <Text style={[styles.translation, { color: colors.foregroundDim }]}>
          {data.translation}
        </Text>

        {/* Original error (collapsed) */}
        <Text
          style={[styles.errorText, { color: colors.muted, backgroundColor: withAlpha(colors.foreground, 0.05) }]}
          numberOfLines={3}
        >
          {data.errorText}
        </Text>

        {/* Quick fix command (if detected) */}
        {quickFix && onExecuteFix && (
          <TouchableOpacity
            style={[styles.fixBanner, { backgroundColor: withAlpha('#10B981', 0.12) }]}
            onPress={handleExecuteFix}
            activeOpacity={0.7}
          >
            <MaterialIcons name="play-arrow" size={14} color="#10B981" />
            <Text style={[styles.fixCommand, { color: '#10B981' }]}>$ {quickFix}</Text>
            <Text style={[styles.fixLabel, { color: '#10B981' }]}>Run</Text>
          </TouchableOpacity>
        )}

        {/* Action buttons */}
        <View style={styles.buttonRow}>
          {onSuggestFix && (
            <TouchableOpacity
              style={[styles.button, { backgroundColor: withAlpha(colors.accent, 0.15) }]}
              onPress={handleSuggestFix}
              activeOpacity={0.7}
            >
              <MaterialIcons name="auto-fix-high" size={14} color={colors.accent} />
              <Text style={[styles.buttonText, { color: colors.accent }]}>{t('error_summary.suggest_fix')}</Text>
            </TouchableOpacity>
          )}

          {onAskTeam && (
            <TouchableOpacity
              style={[styles.button, { backgroundColor: withAlpha('#EC4899', 0.15) }]}
              onPress={handleAskTeam}
              activeOpacity={0.7}
            >
              <MaterialIcons name="group" size={14} color="#EC4899" />
              <Text style={[styles.buttonText, { color: '#EC4899' }]}>{t('error_summary.ask_team')}</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  container: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  headerText: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'monospace',
    flex: 1,
  },
  providerLabel: {
    fontSize: 10,
    fontFamily: 'monospace',
  },
  translation: {
    fontSize: 13,
    fontFamily: 'monospace',
    lineHeight: 19,
  },
  errorText: {
    fontSize: 11,
    fontFamily: 'monospace',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    overflow: 'hidden',
    lineHeight: 16,
  },
  fixBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  fixCommand: {
    flex: 1,
    fontSize: 11,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  fixLabel: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  buttonText: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
});
