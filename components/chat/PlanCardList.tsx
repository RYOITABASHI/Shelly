/**
 * components/chat/PlanCardList.tsx — Plan Mode ステップカード表示
 *
 * AIが生成した計画を構造化カードとして表示。
 * 各ステップに[実行]/[スキップ]ボタン。非エンジニアが事前確認可能。
 */

import React, { memo, useCallback } from 'react';
import { colors as C } from '@/theme.config';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useTranslation } from '@/lib/i18n';
import Animated, { FadeInDown } from 'react-native-reanimated';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import type { PlanMessage, PlanStep, PlanStepStatus } from '@/lib/parse-plan';

// ─── Status config ──────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<PlanStepStatus, { icon: keyof typeof MaterialIcons.glyphMap; color: string }> = {
  pending:  { icon: 'radio-button-unchecked', color: '#6B7280' },
  running:  { icon: 'play-circle-outline',    color: C.accent },
  done:     { icon: 'check-circle',           color: '#22C55E' },
  error:    { icon: 'error',                  color: '#EF4444' },
  skipped:  { icon: 'remove-circle-outline',  color: '#9CA3AF' },
};

// ─── Props ──────────────────────────────────────────────────────────────────

type Props = {
  plan: PlanMessage;
  onExecuteStep: (step: PlanStep) => void;
  onSkipStep: (step: PlanStep) => void;
  isWide: boolean;
};

// ─── Step Card ──────────────────────────────────────────────────────────────

const StepCard = memo(function StepCard({
  step,
  onExecute,
  onSkip,
}: {
  step: PlanStep;
  onExecute: (step: PlanStep) => void;
  onSkip: (step: PlanStep) => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const config = STATUS_CONFIG[step.status];
  const isActionable = step.status === 'pending';
  const isSkipped = step.status === 'skipped';

  const handleExecute = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onExecute(step);
  }, [step, onExecute]);

  const handleSkip = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSkip(step);
  }, [step, onSkip]);

  return (
    <View style={[
      styles.card,
      { backgroundColor: colors.surfaceHigh, borderLeftColor: config.color },
      isSkipped && styles.cardSkipped,
    ]}>
      {/* Header: status icon + step number + title */}
      <View style={styles.cardHeader}>
        {step.status === 'running' ? (
          <ActivityIndicator size={16} color={config.color} />
        ) : (
          <MaterialIcons name={config.icon} size={16} color={config.color} />
        )}
        <Text style={[styles.stepNumber, { color: config.color }]}>
          {step.number}.
        </Text>
        <Text
          style={[
            styles.stepTitle,
            { color: isSkipped ? colors.muted : colors.foreground },
            isSkipped && styles.textSkipped,
          ]}
          numberOfLines={2}
        >
          {step.title}
        </Text>
      </View>

      {/* Substeps */}
      {step.substeps.length > 0 && (
        <View style={styles.substepList}>
          {step.substeps.map((sub, idx) => (
            <Text key={idx} style={[styles.substepText, { color: colors.muted }]}>
              {'\u2022'} {sub}
            </Text>
          ))}
        </View>
      )}

      {/* Command preview */}
      {step.command && (
        <View style={[styles.commandBlock, { backgroundColor: withAlpha(colors.foreground, 0.05) }]}>
          <Text style={[styles.commandText, { color: colors.foregroundDim }]} numberOfLines={3}>
            $ {step.command}
          </Text>
        </View>
      )}

      {/* Output (collapsed) */}
      {step.output && (
        <View style={[styles.outputBlock, {
          backgroundColor: step.status === 'error'
            ? withAlpha('#EF4444', 0.08)
            : withAlpha('#22C55E', 0.08),
        }]}>
          <Text
            style={[styles.outputText, {
              color: step.status === 'error' ? '#EF4444' : colors.foregroundDim,
            }]}
            numberOfLines={5}
          >
            {step.output}
          </Text>
        </View>
      )}

      {/* Action buttons */}
      {isActionable && (
        <View style={styles.buttonRow}>
          <TouchableOpacity
            style={[styles.button, { backgroundColor: withAlpha(C.accent, 0.15) }]}
            onPress={handleExecute}
            activeOpacity={0.7}
          >
            <MaterialIcons name="play-arrow" size={14} color="#00D4AA" />
            <Text style={[styles.buttonText, { color: C.accent }]}>
              {step.command ? t('plan.execute') : t('plan.next')}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.button, { backgroundColor: withAlpha(colors.foreground, 0.08) }]}
            onPress={handleSkip}
            activeOpacity={0.7}
          >
            <MaterialIcons name="skip-next" size={14} color={colors.muted} />
            <Text style={[styles.buttonText, { color: colors.muted }]}>{t('plan.skip')}</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
});

// ─── PlanCardList ───────────────────────────────────────────────────────────

export const PlanCardList = memo(function PlanCardList({ plan, onExecuteStep, onSkipStep }: Props) {
  const { colors } = useTheme();
  const completedCount = plan.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const allDone = completedCount === plan.steps.length;

  return (
    <Animated.View entering={FadeInDown.duration(250).springify().damping(16)}>
      {/* Plan header + progress */}
      <View style={styles.planHeader}>
        <MaterialIcons name="assignment" size={16} color={colors.accent} />
        <Text style={[styles.planTitle, { color: colors.foreground }]}>
          {plan.title}
        </Text>
        <Text style={[styles.progress, { color: colors.muted }]}>
          {completedCount}/{plan.steps.length}
        </Text>
      </View>

      {/* Progress bar */}
      <View style={[styles.progressBar, { backgroundColor: withAlpha(colors.foreground, 0.08) }]}>
        <View
          style={[
            styles.progressFill,
            {
              backgroundColor: allDone ? '#22C55E' : colors.accent,
              width: `${(completedCount / plan.steps.length) * 100}%`,
            },
          ]}
        />
      </View>

      {/* Step cards */}
      {plan.steps.map((step) => (
        <StepCard
          key={step.id}
          step={step}
          onExecute={onExecuteStep}
          onSkip={onSkipStep}
        />
      ))}

      {/* Completion banner */}
      {allDone && (
        <View style={[styles.completionBanner, { backgroundColor: withAlpha('#22C55E', 0.1) }]}>
          <Text style={styles.completionText}>
            Plan complete!
          </Text>
        </View>
      )}
    </Animated.View>
  );
});

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  planHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  planTitle: {
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
  progress: {
    fontSize: 11,
  },
  progressBar: {
    height: 3,
    borderRadius: 2,
    marginBottom: 8,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
  },
  card: {
    borderLeftWidth: 3,
    borderRadius: 8,
    padding: 10,
    marginBottom: 6,
    gap: 6,
  },
  cardSkipped: {
    opacity: 0.5,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  stepNumber: {
    fontSize: 12,
    fontWeight: '700',
  },
  stepTitle: {
    fontSize: 13,
    flex: 1,
    lineHeight: 18,
  },
  textSkipped: {
    textDecorationLine: 'line-through',
  },
  substepList: {
    paddingLeft: 28,
    gap: 2,
  },
  substepText: {
    fontSize: 11,
    lineHeight: 16,
  },
  commandBlock: {
    marginLeft: 28,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  commandText: {
    fontSize: 11,
    lineHeight: 16,
  },
  outputBlock: {
    marginLeft: 28,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  outputText: {
    fontSize: 11,
    lineHeight: 16,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 8,
    marginLeft: 28,
    marginTop: 2,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
  },
  buttonText: {
    fontSize: 11,
    fontWeight: '600',
  },
  completionBanner: {
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: 8,
    marginTop: 4,
  },
  completionText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#22C55E',
  },
});
