/**
 * components/chat/TemplateGallery.tsx — テンプレートギャラリー + ウィザード
 *
 * 空のChat画面で表示。テンプレート選択 → 対話ウィザード → Creator Engine連携。
 */

import React, { memo, useState, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ScrollView } from 'react-native';
import Animated, { FadeInDown, FadeIn } from 'react-native-reanimated';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { TEMPLATE_GALLERY, type TemplateWithWizard, type WizardStep } from '@/lib/project-templates';
import { t } from '@/lib/i18n';

// ─── Props ──────────────────────────────────────────────────────────────────

type Props = {
  onSelectTemplate: (template: TemplateWithWizard, answers: Record<string, string>) => void;
  onFreeInput: (text: string) => void;
};

// ─── Component ──────────────────────────────────────────────────────────────

export const TemplateGallery = memo(function TemplateGallery({ onSelectTemplate, onFreeInput }: Props) {
  const { colors } = useTheme();
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateWithWizard | null>(null);
  const [wizardStep, setWizardStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [freeText, setFreeText] = useState('');

  const handleTemplateSelect = useCallback((template: TemplateWithWizard) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedTemplate(template);
    setWizardStep(0);
    setAnswers({});
  }, []);

  const handleBack = useCallback(() => {
    if (wizardStep > 0) {
      setWizardStep(wizardStep - 1);
    } else {
      setSelectedTemplate(null);
    }
  }, [wizardStep]);

  const handleNext = useCallback(() => {
    if (!selectedTemplate) return;
    const currentStep = selectedTemplate.wizardSteps[wizardStep];
    if (currentStep.required && !answers[currentStep.key]?.trim()) return;

    if (wizardStep < selectedTemplate.wizardSteps.length - 1) {
      setWizardStep(wizardStep + 1);
    } else {
      // Wizard complete
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onSelectTemplate(selectedTemplate, answers);
    }
  }, [selectedTemplate, wizardStep, answers, onSelectTemplate]);

  const handleFreeSubmit = useCallback(() => {
    if (!freeText.trim()) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onFreeInput(freeText.trim());
    setFreeText('');
  }, [freeText, onFreeInput]);

  const updateAnswer = useCallback((key: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [key]: value }));
  }, []);

  // ── Wizard View ─────────────────────────────────────────────────────────
  if (selectedTemplate) {
    const step = selectedTemplate.wizardSteps[wizardStep];
    const isLast = wizardStep === selectedTemplate.wizardSteps.length - 1;
    const canProceed = !step.required || !!answers[step.key]?.trim();

    return (
      <Animated.View entering={FadeIn.duration(200)} style={styles.container}>
        {/* Wizard header */}
        <View style={styles.wizardHeader}>
          <MaterialIcons name={selectedTemplate.icon as any} size={18} color={colors.accent} />
          <Text style={[styles.wizardTitle, { color: colors.foreground }]}>
            {selectedTemplate.label} — Step {wizardStep + 1}/{selectedTemplate.wizardSteps.length}
          </Text>
        </View>

        {/* Question */}
        <Text style={[styles.question, { color: colors.foreground }]}>
          {step.question}
        </Text>

        {/* Input */}
        {step.inputType === 'text' ? (
          <TextInput
            style={[styles.textInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: withAlpha(colors.foreground, 0.05) }]}
            placeholder="..."
            placeholderTextColor={colors.muted}
            value={answers[step.key] || ''}
            onChangeText={(v) => updateAnswer(step.key, v)}
            onSubmitEditing={handleNext}
            returnKeyType={isLast ? 'done' : 'next'}
            autoFocus
          />
        ) : (
          <View style={styles.optionGrid}>
            {step.options?.map((opt) => (
              <TouchableOpacity
                key={opt.value}
                style={[
                  styles.optionButton,
                  {
                    backgroundColor: answers[step.key] === opt.value
                      ? withAlpha(colors.accent, 0.2)
                      : withAlpha(colors.foreground, 0.06),
                    borderColor: answers[step.key] === opt.value ? colors.accent : 'transparent',
                  },
                ]}
                onPress={() => {
                  updateAnswer(step.key, opt.value);
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                }}
                activeOpacity={0.7}
              >
                <Text style={[styles.optionText, {
                  color: answers[step.key] === opt.value ? colors.accent : colors.foregroundDim,
                }]}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Navigation */}
        <View style={styles.navRow}>
          <TouchableOpacity style={styles.navButton} onPress={handleBack} activeOpacity={0.7}>
            <MaterialIcons name="arrow-back" size={16} color={colors.muted} />
            <Text style={[styles.navText, { color: colors.muted }]}>
              {wizardStep === 0 ? 'Back' : 'Prev'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.navButton, styles.nextButton, {
              backgroundColor: canProceed ? withAlpha(colors.accent, 0.15) : withAlpha(colors.foreground, 0.05),
            }]}
            onPress={handleNext}
            activeOpacity={0.7}
            disabled={!canProceed}
          >
            <Text style={[styles.navText, { color: canProceed ? colors.accent : colors.muted }]}>
              {isLast ? 'Create' : 'Next'}
            </Text>
            <MaterialIcons
              name={isLast ? 'rocket-launch' : 'arrow-forward'}
              size={16}
              color={canProceed ? colors.accent : colors.muted}
            />
          </TouchableOpacity>
        </View>
      </Animated.View>
    );
  }

  // ── Gallery View ────────────────────────────────────────────────────────
  return (
    <Animated.View entering={FadeInDown.duration(300).springify().damping(16)} style={styles.container}>
      <Text style={[styles.title, { color: colors.foreground }]}>
        What do you want to build?
      </Text>

      {/* Template grid */}
      <View style={styles.grid}>
        {TEMPLATE_GALLERY.map((template) => (
          <TouchableOpacity
            key={template.type}
            style={[styles.templateCard, { backgroundColor: withAlpha(colors.foreground, 0.06) }]}
            onPress={() => handleTemplateSelect(template)}
            activeOpacity={0.7}
          >
            <MaterialIcons name={template.icon as any} size={22} color={colors.accent} />
            <Text style={[styles.templateLabel, { color: colors.foreground }]} numberOfLines={1}>
              {t(`template.${template.type}`) || template.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Free input */}
      <Text style={[styles.orText, { color: colors.muted }]}>or describe freely...</Text>
      <View style={styles.freeInputRow}>
        <TextInput
          style={[styles.freeInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: withAlpha(colors.foreground, 0.05) }]}
          placeholder="Portfolio site with..."
          placeholderTextColor={colors.muted}
          value={freeText}
          onChangeText={setFreeText}
          onSubmitEditing={handleFreeSubmit}
          returnKeyType="send"
        />
        <TouchableOpacity
          style={[styles.sendButton, { backgroundColor: freeText.trim() ? colors.accent : withAlpha(colors.accent, 0.3) }]}
          onPress={handleFreeSubmit}
          activeOpacity={0.7}
          disabled={!freeText.trim()}
        >
          <MaterialIcons name="send" size={16} color="#000" />
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
});

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  templateCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
  },
  templateLabel: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
  orText: {
    fontSize: 12,
    fontFamily: 'monospace',
    textAlign: 'center',
  },
  freeInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  freeInput: {
    flex: 1,
    fontSize: 13,
    fontFamily: 'monospace',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Wizard styles
  wizardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  wizardTitle: {
    fontSize: 14,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
  question: {
    fontSize: 15,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
  textInput: {
    fontSize: 14,
    fontFamily: 'monospace',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  optionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  optionButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  optionText: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
  navRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  navButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
  },
  nextButton: {
    // background set dynamically
  },
  navText: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
});
