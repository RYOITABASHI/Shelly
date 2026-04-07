/**
 * components/chat/ActionsWizardBubble.tsx — GitHub Actions 3-step wizard UI.
 *
 * Step 1: Select actions (build/test/deploy/release)
 * Step 2: Select trigger (push/daily/manual)
 * Step 3: Confirm → generate workflow → git add + commit + push
 */

import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { useTranslation } from '@/lib/i18n';
import type { ActionsWizardData } from '@/store/chat-store';

// ─── Types ───────────────────────────────────────────────────────────────────

type ActionKind = 'build' | 'test' | 'deploy' | 'release';
type TriggerKind = 'push' | 'daily' | 'manual';

interface Props {
  wizardData: ActionsWizardData;
  onUpdate: (data: ActionsWizardData) => void;
  onComplete: (data: ActionsWizardData) => void;
}

const ACTION_OPTIONS: Array<{ key: ActionKind; icon: string }> = [
  { key: 'build', icon: 'build' },
  { key: 'test', icon: 'science' },
  { key: 'deploy', icon: 'cloud-upload' },
  { key: 'release', icon: 'new-releases' },
];

const TRIGGER_OPTIONS: Array<{ key: TriggerKind; icon: string }> = [
  { key: 'push', icon: 'publish' },
  { key: 'daily', icon: 'schedule' },
  { key: 'manual', icon: 'touch-app' },
];

// ─── Component ───────────────────────────────────────────────────────────────

export function ActionsWizardBubble({ wizardData, onUpdate, onComplete }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [selectedActions, setSelectedActions] = useState<ActionKind[]>(wizardData.actions || ['build', 'test']);
  const [selectedTrigger, setSelectedTrigger] = useState<TriggerKind>(wizardData.trigger || 'push');
  const [step, setStep] = useState<'what' | 'when' | 'confirm'>(
    wizardData.step === 'done' ? 'confirm' : wizardData.step,
  );
  const isDone = wizardData.step === 'done';

  const accentColor = '#F97316'; // Orange — GitHub Actions brand

  const toggleAction = useCallback((action: ActionKind) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedActions((prev) =>
      prev.includes(action) ? prev.filter((a) => a !== action) : [...prev, action],
    );
  }, []);

  const selectTrigger = useCallback((trigger: TriggerKind) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedTrigger(trigger);
  }, []);

  const handleNext = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (step === 'what') {
      if (selectedActions.length === 0) return;
      setStep('when');
      onUpdate({ ...wizardData, step: 'when', actions: selectedActions });
    } else if (step === 'when') {
      setStep('confirm');
      onUpdate({ ...wizardData, step: 'confirm', actions: selectedActions, trigger: selectedTrigger });
    }
  }, [step, selectedActions, selectedTrigger, wizardData, onUpdate]);

  const handleBack = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (step === 'when') {
      setStep('what');
      onUpdate({ ...wizardData, step: 'what' });
    } else if (step === 'confirm') {
      setStep('when');
      onUpdate({ ...wizardData, step: 'when' });
    }
  }, [step, wizardData, onUpdate]);

  const handleConfirm = useCallback(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const finalData: ActionsWizardData = {
      ...wizardData,
      step: 'done',
      actions: selectedActions,
      trigger: selectedTrigger,
    };
    onComplete(finalData);
  }, [selectedActions, selectedTrigger, wizardData, onComplete]);

  const handleRedo = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setStep('what');
    setSelectedActions(['build', 'test']);
    setSelectedTrigger('push');
    onUpdate({ ...wizardData, step: 'what', actions: ['build', 'test'], trigger: null });
  }, [wizardData, onUpdate]);

  const actionLabel = (key: ActionKind) => t(`wizard.action_${key}`);
  const triggerLabel = (key: TriggerKind) => t(`wizard.trigger_${key}`);

  // ── Done state ──
  if (isDone) {
    const triggerKey = wizardData.trigger || 'push';
    const doneTrigger = t(`wizard.done_${triggerKey}`);
    return (
      <View style={[styles.container, { backgroundColor: colors.surfaceHigh, borderColor: withAlpha(accentColor, 0.2) }]}>
        <View style={[styles.header, { borderBottomColor: withAlpha(accentColor, 0.1) }]}>
          <MaterialIcons name="check-circle" size={16} color="#4ADE80" />
          <Text style={[styles.headerTitle, { color: '#4ADE80' }]}>{t('wizard.actions_title')}</Text>
        </View>
        <Text style={[styles.doneText, { color: colors.foregroundDim }]}>
          {t('wizard.done', { trigger: doneTrigger })}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.surfaceHigh, borderColor: withAlpha(accentColor, 0.2) }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: withAlpha(accentColor, 0.1) }]}>
        <MaterialIcons name="settings" size={16} color={accentColor} />
        <Text style={[styles.headerTitle, { color: accentColor }]}>{t('wizard.actions_title')}</Text>
        <View style={styles.stepIndicator}>
          {['what', 'when', 'confirm'].map((s, i) => (
            <View
              key={s}
              style={[
                styles.stepDot,
                {
                  backgroundColor: s === step ? accentColor : withAlpha(colors.inactive, 0.3),
                },
              ]}
            />
          ))}
        </View>
      </View>

      {/* Step 1: What */}
      {step === 'what' && (
        <View style={styles.stepContent}>
          <Text style={[styles.stepTitle, { color: colors.foreground }]}>{t('wizard.step1_title')}</Text>
          <Text style={[styles.stepDesc, { color: colors.inactive }]}>{t('wizard.step1_desc')}</Text>
          <View style={styles.optionGrid}>
            {ACTION_OPTIONS.map(({ key, icon }) => {
              const isSelected = selectedActions.includes(key);
              return (
                <TouchableOpacity
                  key={key}
                  style={[
                    styles.optionChip,
                    {
                      backgroundColor: isSelected ? withAlpha(accentColor, 0.15) : withAlpha(colors.inactive, 0.08),
                      borderColor: isSelected ? accentColor : withAlpha(colors.inactive, 0.2),
                    },
                  ]}
                  onPress={() => toggleAction(key)}
                  activeOpacity={0.7}
                >
                  <MaterialIcons
                    name={icon as any}
                    size={14}
                    color={isSelected ? accentColor : colors.inactive}
                  />
                  <Text
                    style={[
                      styles.optionText,
                      { color: isSelected ? accentColor : colors.foregroundDim },
                    ]}
                  >
                    {actionLabel(key)}
                  </Text>
                  {isSelected && (
                    <MaterialIcons name="check" size={12} color={accentColor} />
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
          <View style={styles.btnRow}>
            <TouchableOpacity
              style={[styles.nextBtn, { backgroundColor: selectedActions.length > 0 ? accentColor : withAlpha(colors.inactive, 0.3) }]}
              onPress={handleNext}
              disabled={selectedActions.length === 0}
              activeOpacity={0.7}
            >
              <Text style={styles.nextBtnText}>{t('wizard.btn_next')}</Text>
              <MaterialIcons name="arrow-forward" size={14} color="#FFF" />
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Step 2: When */}
      {step === 'when' && (
        <View style={styles.stepContent}>
          <Text style={[styles.stepTitle, { color: colors.foreground }]}>{t('wizard.step2_title')}</Text>
          <View style={styles.optionGrid}>
            {TRIGGER_OPTIONS.map(({ key, icon }) => {
              const isSelected = selectedTrigger === key;
              return (
                <TouchableOpacity
                  key={key}
                  style={[
                    styles.optionChip,
                    {
                      backgroundColor: isSelected ? withAlpha(accentColor, 0.15) : withAlpha(colors.inactive, 0.08),
                      borderColor: isSelected ? accentColor : withAlpha(colors.inactive, 0.2),
                    },
                  ]}
                  onPress={() => selectTrigger(key)}
                  activeOpacity={0.7}
                >
                  <MaterialIcons
                    name={icon as any}
                    size={14}
                    color={isSelected ? accentColor : colors.inactive}
                  />
                  <Text
                    style={[
                      styles.optionText,
                      { color: isSelected ? accentColor : colors.foregroundDim },
                    ]}
                  >
                    {triggerLabel(key)}
                  </Text>
                  {isSelected && (
                    <View style={[styles.radioDot, { borderColor: accentColor }]}>
                      <View style={[styles.radioInner, { backgroundColor: accentColor }]} />
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
          <View style={styles.btnRow}>
            <TouchableOpacity style={[styles.backBtn, { borderColor: withAlpha(colors.inactive, 0.3) }]} onPress={handleBack} activeOpacity={0.7}>
              <MaterialIcons name="arrow-back" size={14} color={colors.inactive} />
              <Text style={[styles.backBtnText, { color: colors.inactive }]}>{t('wizard.btn_back')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.nextBtn, { backgroundColor: accentColor }]}
              onPress={handleNext}
              activeOpacity={0.7}
            >
              <Text style={styles.nextBtnText}>{t('wizard.btn_next')}</Text>
              <MaterialIcons name="arrow-forward" size={14} color="#FFF" />
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Step 3: Confirm */}
      {step === 'confirm' && (
        <View style={styles.stepContent}>
          <Text style={[styles.stepTitle, { color: colors.foreground }]}>{t('wizard.step3_title')}</Text>
          <View style={[styles.confirmBox, { backgroundColor: withAlpha(accentColor, 0.05), borderColor: withAlpha(accentColor, 0.15) }]}>
            <View style={styles.confirmRow}>
              <MaterialIcons name="check-box" size={14} color={accentColor} />
              <Text style={[styles.confirmText, { color: colors.foregroundDim }]}>
                {t('wizard.confirm_actions', { actions: selectedActions.map(actionLabel).join(', ') })}
              </Text>
            </View>
            <View style={styles.confirmRow}>
              <MaterialIcons name="schedule" size={14} color={accentColor} />
              <Text style={[styles.confirmText, { color: colors.foregroundDim }]}>
                {t('wizard.confirm_trigger', { trigger: triggerLabel(selectedTrigger) })}
              </Text>
            </View>
            <View style={styles.confirmRow}>
              <MaterialIcons name="notifications-active" size={14} color={accentColor} />
              <Text style={[styles.confirmText, { color: colors.foregroundDim }]}>
                {t('wizard.confirm_notify')}
              </Text>
            </View>
          </View>
          <View style={styles.btnRow}>
            <TouchableOpacity style={[styles.backBtn, { borderColor: withAlpha(colors.inactive, 0.3) }]} onPress={handleRedo} activeOpacity={0.7}>
              <MaterialIcons name="refresh" size={14} color={colors.inactive} />
              <Text style={[styles.backBtnText, { color: colors.inactive }]}>{t('wizard.btn_redo')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.nextBtn, { backgroundColor: '#4ADE80' }]}
              onPress={handleConfirm}
              activeOpacity={0.7}
            >
              <MaterialIcons name="rocket-launch" size={14} color="#FFF" />
              <Text style={styles.nextBtnText}>{t('wizard.btn_setup')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
    marginVertical: 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  headerTitle: {
    fontSize: 12,
    fontFamily: 'monospace',
    fontWeight: '700',
    flex: 1,
  },
  stepIndicator: {
    flexDirection: 'row',
    gap: 4,
  },
  stepDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  stepContent: {
    padding: 12,
    gap: 8,
  },
  stepTitle: {
    fontSize: 13,
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  stepDesc: {
    fontSize: 11,
    fontFamily: 'monospace',
  },
  optionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 4,
  },
  optionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
  },
  optionText: {
    fontSize: 12,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  radioDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioInner: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  btnRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 4,
  },
  nextBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
  },
  nextBtnText: {
    color: '#FFF',
    fontSize: 12,
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
  },
  backBtnText: {
    fontSize: 12,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  confirmBox: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 10,
    gap: 6,
  },
  confirmRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  confirmText: {
    fontSize: 12,
    fontFamily: 'monospace',
    flex: 1,
  },
  doneText: {
    fontSize: 12,
    fontFamily: 'monospace',
    padding: 12,
  },
});
