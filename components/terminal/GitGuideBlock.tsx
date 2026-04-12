/**
 * GitGuideBlock — @git の結果を初心者向けに見やすく表示するUI。
 *
 * 各ステップをカード形式で表示し、コマンドはワンタップで実行可能。
 * 「そもそもこれは何？」レベルの初心者でも理解できる言葉遣い。
 */
import React, { memo, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import type { GitGuide, GitGuideStep } from '@/lib/git-assistant';
import { useTranslation } from '@/lib/i18n';
import { colors as C, fonts as F, sizes as S } from '@/theme.config';


type Props = {
  guide: GitGuide;
  /** コマンドをターミナルで実行する */
  onRunCommand: (command: string) => void;
  /** prereqCommandの結果（自動実行された場合） */
  prereqOutput?: string;
};

const STEP_ICONS: Record<GitGuideStep['type'], { icon: string; color: string; bg: string }> = {
  info:    { icon: 'info-outline',    color: '#60A5FA', bg: '#60A5FA10' },
  command: { icon: 'terminal',        color: C.accent,    bg: '#00D4AA10' },
  warning: { icon: 'warning-amber',   color: C.warning, bg: '#FBBF2410' },
  tip:     { icon: 'lightbulb-outline', color: '#A78BFA', bg: '#A78BFA10' },
};

function GitGuideBlockInner({ guide, onRunCommand, prereqOutput }: Props) {
  const { t } = useTranslation();
  const handleRun = useCallback((cmd: string) => {
    onRunCommand(cmd);
  }, [onRunCommand]);

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <MaterialIcons name="assistant" size={18} color={C.accent} />
        <Text style={styles.headerTitle}>{guide.title}</Text>
        <View style={styles.gitBadge}>
          <Text style={styles.gitBadgeText}>@git</Text>
        </View>
      </View>

      {/* Overview — 最重要。何も知らない人が読む最初の文 */}
      <View style={styles.overviewBox}>
        <Text style={styles.overviewText}>{guide.overview}</Text>
      </View>

      {/* Steps */}
      <ScrollView style={styles.stepsArea} nestedScrollEnabled>
        {guide.steps.map((step, i) => {
          const visual = STEP_ICONS[step.type];
          return (
            <View key={i} style={[styles.stepCard, { backgroundColor: visual.bg }]}>
              {/* Step header */}
              <View style={styles.stepHeader}>
                <MaterialIcons name={visual.icon as any} size={16} color={visual.color} />
                <Text style={[styles.stepNumber, { color: visual.color }]}>
                  {step.type === 'tip' ? 'TIP' : step.type === 'warning' ? '注意' : `Step ${i + 1}`}
                </Text>
              </View>

              {/* Explanation */}
              <Text style={styles.stepExplanation} selectable>
                {step.explanation}
              </Text>

              {/* Command (if any) — tap to execute */}
              {step.command && (
                <Pressable
                  style={styles.commandBox}
                  onPress={() => handleRun(step.command!)}
                >
                  <View style={styles.commandRow}>
                    <Text style={styles.commandPrompt}>$ </Text>
                    <Text style={styles.commandText} numberOfLines={2}>
                      {step.command}
                    </Text>
                  </View>
                  <View style={styles.runBtn}>
                    <MaterialIcons name="play-arrow" size={16} color="#FFF" />
                    <Text style={styles.runBtnText}>{t('git.run')}</Text>
                  </View>
                </Pressable>
              )}
            </View>
          );
        })}
      </ScrollView>

      {/* Footer hint */}
      <View style={styles.footer}>
        <MaterialIcons name="help-outline" size={12} color="#4B5563" />
        <Text style={styles.footerText}>
          {t('git.guide_footer')}
        </Text>
      </View>
    </View>
  );
}

export const GitGuideBlock = memo(GitGuideBlockInner);

const styles = StyleSheet.create({
  container: {
    marginHorizontal: 8,
    marginVertical: 3,
    borderRadius: 10,
    backgroundColor: '#0F1210',
    borderWidth: 1,
    borderColor: '#00D4AA30',
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
    backgroundColor: '#00D4AA08',
    borderBottomWidth: 1,
    borderBottomColor: '#00D4AA15',
  },
  headerTitle: {
    color: '#ECEDEE',
    fontSize: 15,
    fontFamily: 'monospace',
    fontWeight: '700',
    flex: 1,
  },
  gitBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: '#00D4AA20',
    borderWidth: 1,
    borderColor: '#00D4AA40',
  },
  gitBadgeText: {
    color: C.accent,
    fontSize: 10,
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  overviewBox: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  overviewText: {
    color: '#C8D0D8',
    fontSize: 13,
    fontFamily: 'monospace',
    lineHeight: 20,
  },
  stepsArea: {
    maxHeight: 450,
  },
  stepCard: {
    marginHorizontal: 10,
    marginVertical: 5,
    borderRadius: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: '#1E1E1E',
  },
  stepHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  stepNumber: {
    fontSize: 10,
    fontFamily: 'monospace',
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  stepExplanation: {
    color: '#B0B8C0',
    fontSize: 12,
    fontFamily: 'monospace',
    lineHeight: 18,
    marginBottom: 4,
  },
  commandBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.bgDeep,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#00D4AA30',
    marginTop: 6,
    overflow: 'hidden',
  },
  commandRow: {
    flex: 1,
    flexDirection: 'row',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  commandPrompt: {
    color: C.accent,
    fontSize: 12,
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  commandText: {
    color: '#ECEDEE',
    fontSize: 12,
    fontFamily: 'monospace',
    flex: 1,
  },
  runBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: C.accent,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  runBtnText: {
    color: '#FFF',
    fontSize: 11,
    fontWeight: '700',
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
  footerText: {
    color: C.text3,
    fontSize: 10,
    fontFamily: 'monospace',
  },
});
