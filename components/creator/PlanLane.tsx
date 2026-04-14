/**
 * components/creator/PlanLane.tsx
 *
 * The "Plan" lane — shows the AI-generated plan before execution.
 * Displays a natural language summary and step list.
 * User can confirm or cancel.
 */

import React from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { CreatorPlan, CreatorSessionStatus } from '@/store/types';
import { useTranslation } from '@/lib/i18n';

// ─── Props ────────────────────────────────────────────────────────────────────

type Props = {
  status: CreatorSessionStatus;
  plan: CreatorPlan | null;
  onConfirm: () => void;
  onCancel: () => void;
};

// ─── Component ────────────────────────────────────────────────────────────────

export function PlanLane({ status, plan, onConfirm, onCancel }: Props) {
  const { t } = useTranslation();
  const isPlanning = status === 'planning';
  const isConfirming = status === 'confirming';
  const isBuilding = status === 'building' || status === 'done' || status === 'error';

  return (
    <View style={styles.container}>
      {/* Lane header */}
      <View style={styles.laneHeader}>
        <Text style={styles.laneLabel}>PLAN</Text>
        {isPlanning && (
          <ActivityIndicator size="small" color="#00D4AA" style={styles.spinner} />
        )}
        {isBuilding && plan && (
          <View style={[styles.dot, styles.dotDone]} />
        )}
        {isConfirming && (
          <View style={[styles.dot, styles.dotActive]} />
        )}
      </View>

      {/* Idle state */}
      {status === 'idle' && (
        <Text style={styles.placeholder}>
          {t('creator.plan_placeholder')}
        </Text>
      )}

      {/* Planning state */}
      {isPlanning && (
        <Text style={styles.thinking}>{t('creator.plan_thinking')}</Text>
      )}

      {/* Plan content */}
      {plan && (isConfirming || isBuilding) && (
        <View style={styles.planContent}>
          {/* Summary */}
          <Text style={styles.summary}>{plan.summary}</Text>

          {/* Steps */}
          <View style={styles.steps}>
            {plan.steps.map((step, i) => (
              <View key={i} style={styles.stepRow}>
                <Text style={styles.stepNum}>{i + 1}.</Text>
                <Text style={styles.stepText}>{step}</Text>
              </View>
            ))}
          </View>

          {/* Meta */}
          <View style={styles.meta}>
            <Text style={styles.metaText}>
              {t('creator.plan_files', { n: plan.estimatedFiles })} · {planTypeLabel(plan.projectType, t)}
            </Text>
          </View>

          {/* Action buttons (only in confirming state) */}
          {isConfirming && (
            <View style={styles.actions}>
              <Pressable
                onPress={onCancel}
                style={({ pressed }) => [
                  styles.cancelBtn,
                  pressed && styles.btnPressed,
                ]}
              >
                <Text style={styles.cancelBtnText}>{t('creator.plan_cancel')}</Text>
              </Pressable>
              <Pressable
                onPress={onConfirm}
                style={({ pressed }) => [
                  styles.confirmBtn,
                  pressed && styles.btnPressed,
                ]}
              >
                <Text style={styles.confirmBtnText}>{t('creator.plan_confirm')}</Text>
              </Pressable>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

function planTypeLabel(
  type: string,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const labels: Record<string, string> = {
    web: t('creator.type_web'),
    script: t('creator.type_script'),
    document: t('creator.type_document'),
    unknown: t('creator.type_unknown'),
  };
  return labels[type] ?? type;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#0D0D0D',
    borderBottomWidth: 1,
    borderBottomColor: '#1E1E1E',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
  },
  laneHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
  },
  laneLabel: {
    fontSize: 9,
    color: '#4B5563',
    letterSpacing: 1.5,
  },
  spinner: {
    marginLeft: 2,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  dotActive: {
    backgroundColor: '#FBBF24',
  },
  dotDone: {
    backgroundColor: '#4ADE80',
  },
  placeholder: {
    fontSize: 12,
    color: '#374151',
    fontStyle: 'italic',
  },
  thinking: {
    fontSize: 12,
    color: '#6B7280',
  },
  planContent: {
    gap: 10,
  },
  summary: {
    fontSize: 13,
    color: '#ECEDEE',
    lineHeight: 20,
  },
  steps: {
    gap: 4,
    paddingLeft: 4,
  },
  stepRow: {
    flexDirection: 'row',
    gap: 6,
  },
  stepNum: {
    fontSize: 11,
    color: '#00D4AA',
    width: 16,
  },
  stepText: {
    fontSize: 11,
    color: '#9BA1A6',
    flex: 1,
  },
  meta: {
    borderTopWidth: 1,
    borderTopColor: '#1E1E1E',
    paddingTop: 6,
  },
  metaText: {
    fontSize: 10,
    color: '#4B5563',
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'flex-end',
    marginTop: 4,
  },
  cancelBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#374151',
  },
  cancelBtnText: {
    fontSize: 12,
    color: '#6B7280',
  },
  confirmBtn: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: 'rgba(0, 212, 170, 0.12)',
    borderWidth: 1,
    borderColor: '#00D4AA',
  },
  confirmBtnText: {
    fontSize: 12,
    color: '#00D4AA',
    fontWeight: '600',
  },
  btnPressed: {
    opacity: 0.7,
  },
});
