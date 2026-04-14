/**
 * components/creator/BuildLane.tsx
 *
 * The "Build" lane — shows real-time build log as steps execute.
 * Each step animates from pending → running → done/error.
 */

import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { BuildStep, CreatorSessionStatus } from '@/store/types';
import { useTranslation } from '@/lib/i18n';

// ─── Props ────────────────────────────────────────────────────────────────────

type Props = {
  status: CreatorSessionStatus;
  steps: BuildStep[];
};

// ─── Component ────────────────────────────────────────────────────────────────

export function BuildLane({ status, steps }: Props) {
  const { t } = useTranslation();
  const scrollRef = useRef<ScrollView>(null);

  // Auto-scroll to bottom when new steps appear
  useEffect(() => {
    if (steps.length > 0) {
      setTimeout(() => {
        scrollRef.current?.scrollToEnd({ animated: true });
      }, 50);
    }
  }, [steps.length]);

  const isActive = status === 'building' || status === 'done' || status === 'error';

  return (
    <View style={styles.container}>
      {/* Lane header */}
      <View style={styles.laneHeader}>
        <Text style={styles.laneLabel}>BUILD</Text>
        {status === 'building' && (
          <ActivityIndicator size="small" color="#FBBF24" style={styles.spinner} />
        )}
        {status === 'done' && <View style={[styles.dot, styles.dotDone]} />}
        {status === 'error' && <View style={[styles.dot, styles.dotError]} />}
      </View>

      {/* Idle / planning / confirming */}
      {!isActive && (
        <Text style={styles.placeholder}>
          {t('creator.build_placeholder')}
        </Text>
      )}

      {/* Build log */}
      {isActive && (
        <ScrollView
          ref={scrollRef}
          style={styles.log}
          contentContainerStyle={styles.logContent}
          showsVerticalScrollIndicator={false}
        >
          {steps.map((step) => (
            <BuildStepRow key={step.id} step={step} />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

// ─── BuildStepRow ─────────────────────────────────────────────────────────────

function BuildStepRow({ step }: { step: BuildStep }) {
  return (
    <View style={stepStyles.row}>
      <StepIcon status={step.status} />
      <Text
        style={[
          stepStyles.message,
          step.status === 'done' && stepStyles.messageDone,
          step.status === 'error' && stepStyles.messageError,
          step.status === 'pending' && stepStyles.messagePending,
        ]}
      >
        {step.message}
      </Text>
    </View>
  );
}

function StepIcon({ status }: { status: BuildStep['status'] }) {
  switch (status) {
    case 'running':
      return <ActivityIndicator size="small" color="#FBBF24" style={stepStyles.icon} />;
    case 'done':
      return <Text style={[stepStyles.icon, stepStyles.iconDone]}>✓</Text>;
    case 'error':
      return <Text style={[stepStyles.icon, stepStyles.iconError]}>✗</Text>;
    default:
      return <Text style={[stepStyles.icon, stepStyles.iconPending]}>·</Text>;
  }
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
    minHeight: 80,
    maxHeight: 160,
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
  dotDone: {
    backgroundColor: '#4ADE80',
  },
  dotError: {
    backgroundColor: '#F87171',
  },
  placeholder: {
    fontSize: 12,
    color: '#374151',
    fontStyle: 'italic',
  },
  log: {
    flex: 1,
  },
  logContent: {
    gap: 3,
  },
});

const stepStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 20,
  },
  icon: {
    width: 16,
    fontSize: 11,
    textAlign: 'center',
  },
  iconDone: {
    color: '#4ADE80',
  },
  iconError: {
    color: '#F87171',
  },
  iconPending: {
    color: '#374151',
  },
  message: {
    fontSize: 11,
    color: '#FBBF24',
    flex: 1,
  },
  messageDone: {
    color: '#4B5563',
  },
  messageError: {
    color: '#F87171',
  },
  messagePending: {
    color: '#374151',
  },
});
