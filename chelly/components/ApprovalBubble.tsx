/**
 * components/chat/ApprovalBubble.tsx
 *
 * 承認プロキシUI — ターミナルの [Y/n] プロンプトをChat側のネイティブボタンに変換。
 * Wide時のみChatバブルとして表示（Single時はTranslateOverlayのまま）。
 */

import React, { memo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { t } from '@/lib/i18n';
import Animated, { FadeInDown } from 'react-native-reanimated';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { dangerLevelColor, type DangerLevel } from '@/lib/command-safety';
import TerminalEmulator from '@/modules/terminal-emulator';

export type ApprovalBubbleData = {
  sessionId: string;
  command: string;
  translation: string;
  dangerLevel: DangerLevel;
};

type Props = {
  data: ApprovalBubbleData;
  onAskTeam?: (context: string) => void;
};

export const ApprovalBubble = memo(function ApprovalBubble({ data, onAskTeam }: Props) {
  const { colors } = useTheme();
  const [responded, setResponded] = useState<'approved' | 'denied' | null>(null);
  const borderColor = dangerLevelColor(data.dangerLevel);

  const handleApprove = async () => {
    setResponded('approved');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await TerminalEmulator.writeToSession(data.sessionId, 'Y\n');
    } catch {}
  };

  const handleDeny = async () => {
    setResponded('denied');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      await TerminalEmulator.writeToSession(data.sessionId, 'n\n');
    } catch {}
  };

  const handleAskTeam = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onAskTeam?.(t('approval.ask_team_prompt', { command: data.command, translation: data.translation }));
  };

  return (
    <Animated.View entering={FadeInDown.duration(200).springify().damping(18)}>
      <View style={[styles.container, { backgroundColor: colors.surfaceHigh, borderColor: withAlpha(borderColor, 0.4) }]}>
        {/* Header */}
        <View style={styles.header}>
          <MaterialIcons name="warning" size={16} color={borderColor} />
          <Text style={[styles.headerText, { color: colors.foreground }]}>
            {t('approval.header')}
          </Text>
        </View>

        {/* Translation / explanation */}
        <Text style={[styles.translation, { color: colors.foregroundDim }]}>
          {data.translation || data.command}
        </Text>

        {/* Command preview */}
        {data.translation && data.command && (
          <Text style={[styles.command, { color: colors.muted, backgroundColor: withAlpha(colors.foreground, 0.05) }]} numberOfLines={2}>
            $ {data.command}
          </Text>
        )}

        {/* Action buttons */}
        {responded ? (
          <View style={styles.respondedRow}>
            <MaterialIcons
              name={responded === 'approved' ? 'check-circle' : 'cancel'}
              size={16}
              color={responded === 'approved' ? '#22C55E' : '#EF4444'}
            />
            <Text style={[styles.respondedText, { color: colors.muted }]}>
              {responded === 'approved' ? t('approval.approved') : t('approval.denied')}
            </Text>
          </View>
        ) : (
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[styles.button, styles.approveBtn, { backgroundColor: withAlpha('#22C55E', 0.15) }]}
              onPress={handleApprove}
              activeOpacity={0.7}
            >
              <MaterialIcons name="check" size={14} color="#22C55E" />
              <Text style={[styles.buttonText, { color: '#22C55E' }]}>{t('approval.allow')}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.button, styles.denyBtn, { backgroundColor: withAlpha('#EF4444', 0.15) }]}
              onPress={handleDeny}
              activeOpacity={0.7}
            >
              <MaterialIcons name="close" size={14} color="#EF4444" />
              <Text style={[styles.buttonText, { color: '#EF4444' }]}>{t('approval.deny')}</Text>
            </TouchableOpacity>

            {onAskTeam && (
              <TouchableOpacity
                style={[styles.button, { backgroundColor: withAlpha('#EC4899', 0.15) }]}
                onPress={handleAskTeam}
                activeOpacity={0.7}
              >
                <MaterialIcons name="group" size={14} color="#EC4899" />
                <Text style={[styles.buttonText, { color: '#EC4899' }]}>{t('approval.ask_team')}</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
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
  },
  translation: {
    fontSize: 13,
    fontFamily: 'monospace',
    lineHeight: 19,
  },
  command: {
    fontSize: 11,
    fontFamily: 'monospace',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    overflow: 'hidden',
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
  approveBtn: {},
  denyBtn: {},
  buttonText: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
  respondedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  respondedText: {
    fontSize: 12,
    fontFamily: 'monospace',
  },
});
