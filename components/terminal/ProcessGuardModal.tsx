/**
 * ProcessGuardModal — Step-by-step wizard for Android phantom process killer
 *
 * Shown when SIGKILL (signal 9) is detected 2+ times.
 * Provides device-specific fix instructions with action buttons.
 */

import React, { memo, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, Pressable,
  ScrollView, Linking,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { getDeviceProfile, type KillFixStep } from '@/lib/process-guard';
import { useTranslation } from '@/lib/i18n';
import { colors as C, fonts as F, sizes as S } from '@/theme.config';

type Props = {
  visible: boolean;
  onClose: () => void;
};

export const ProcessGuardModal = memo(function ProcessGuardModal({ visible, onClose }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [currentStep, setCurrentStep] = useState(0);
  const [copiedCmd, setCopiedCmd] = useState(false);

  const profile = getDeviceProfile();
  const steps = profile.fixSteps;
  const step = steps[currentStep];
  const isLast = currentStep >= steps.length - 1;

  const handleOpenSettings = useCallback((intentUri?: string) => {
    if (!intentUri) return;
    Linking.openURL(`intent://#Intent;action=${intentUri};end`).catch(() => {
      // Fallback: open Android settings main
      Linking.openURL('android.settings.SETTINGS').catch(() => {});
    });
  }, []);

  const handleCopyAdb = useCallback(async (cmd?: string) => {
    if (!cmd) return;
    await Clipboard.setStringAsync(cmd);
    setCopiedCmd(true);
    setTimeout(() => setCopiedCmd(false), 2000);
  }, []);

  const handleNext = useCallback(() => {
    if (isLast) {
      onClose();
      setCurrentStep(0);
    } else {
      setCurrentStep((s) => s + 1);
    }
  }, [isLast, onClose]);

  if (!step) return null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.overlay, { backgroundColor: 'rgba(0,0,0,0.85)' }]}>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          {/* Header */}
          <View style={styles.header}>
            <MaterialIcons name="shield" size={24} color="#FF6B6B" />
            <Text style={[styles.title, { color: colors.foreground }]}>
              {t('guard.title')}
            </Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <MaterialIcons name="close" size={20} color={colors.muted} />
            </Pressable>
          </View>

          {/* Problem explanation */}
          {currentStep === 0 && (
            <View style={[styles.alertBox, { backgroundColor: withAlpha('#FF6B6B', 0.1) }]}>
              <Text style={[styles.alertText, { color: '#FF8A8A' }]}>
                {t('guard.problem')}
              </Text>
            </View>
          )}

          {/* Step indicator */}
          <View style={styles.stepIndicator}>
            {steps.map((_, i) => (
              <View
                key={i}
                style={[
                  styles.stepDot,
                  { backgroundColor: i === currentStep ? colors.accent : withAlpha(colors.foreground, 0.2) },
                ]}
              />
            ))}
            <Text style={[styles.stepCount, { color: colors.muted }]}>
              {t('guard.step_counter', { current: currentStep + 1, total: steps.length })}
            </Text>
          </View>

          <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
            {/* Step title */}
            <Text style={[styles.stepTitle, { color: colors.foreground }]}>
              {step.title}
            </Text>

            {/* Step description */}
            <Text style={[styles.stepDesc, { color: colors.foregroundDim }]}>
              {step.description}
            </Text>

            {/* ADB command (if applicable) */}
            {step.adbCommand && (
              <View style={[styles.codeBox, { backgroundColor: C.bgSidebar, borderColor: colors.border }]}>
                <Text style={styles.codeText} selectable>{step.adbCommand}</Text>
                <TouchableOpacity
                  style={[styles.copyBtn, { backgroundColor: withAlpha(colors.accent, 0.15) }]}
                  onPress={() => handleCopyAdb(step.adbCommand)}
                  activeOpacity={0.7}
                >
                  <MaterialIcons
                    name={copiedCmd ? 'check' : 'content-copy'}
                    size={14}
                    color={colors.accent}
                  />
                  <Text style={[styles.copyText, { color: colors.accent }]}>
                    {copiedCmd ? t('guard.copied') : t('guard.copy')}
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Settings jump button (if applicable) */}
            {step.intentUri && (
              <TouchableOpacity
                style={[styles.settingsBtn, { backgroundColor: withAlpha(colors.accent, 0.12) }]}
                onPress={() => handleOpenSettings(step.intentUri)}
                activeOpacity={0.7}
              >
                <MaterialIcons name="settings" size={16} color={colors.accent} />
                <Text style={[styles.settingsBtnText, { color: colors.accent }]}>
                  {t('guard.open_settings')}
                </Text>
              </TouchableOpacity>
            )}
          </ScrollView>

          {/* Navigation */}
          <View style={styles.footer}>
            {currentStep > 0 && (
              <TouchableOpacity onPress={() => setCurrentStep((s) => s - 1)} activeOpacity={0.7}>
                <Text style={[styles.navText, { color: colors.muted }]}>{t('guard.back')}</Text>
              </TouchableOpacity>
            )}
            <View style={{ flex: 1 }} />
            <TouchableOpacity
              style={[styles.nextBtn, { backgroundColor: colors.accent }]}
              onPress={handleNext}
              activeOpacity={0.7}
            >
              <Text style={[styles.nextText, { color: colors.background }]}>
                {isLast ? t('guard.done') : t('guard.next')}
              </Text>
              {!isLast && <MaterialIcons name="arrow-forward" size={16} color={colors.background} />}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
});

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  card: { width: '100%', maxWidth: 420, borderRadius: 16, borderWidth: 1, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 16, borderBottomWidth: 1, borderBottomColor: '#222' },
  title: { flex: 1, fontFamily: 'Silkscreen', fontSize: 16, fontWeight: '700' },
  alertBox: { marginHorizontal: 16, marginTop: 12, padding: 12, borderRadius: 8 },
  alertText: { fontFamily: 'Silkscreen', fontSize: 12, lineHeight: 18 },
  stepIndicator: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingTop: 12 },
  stepDot: { width: 8, height: 8, borderRadius: 4 },
  stepCount: { fontFamily: 'Silkscreen', fontSize: 10, marginLeft: 'auto' },
  content: { maxHeight: 300 },
  contentInner: { padding: 16, gap: 12 },
  stepTitle: { fontFamily: 'Silkscreen', fontSize: 15, fontWeight: '700' },
  stepDesc: { fontFamily: 'Silkscreen', fontSize: 13, lineHeight: 20 },
  codeBox: { padding: 12, borderRadius: 8, borderWidth: 1 },
  codeText: { fontFamily: 'Silkscreen', fontSize: 11, color: '#E8E8E8', lineHeight: 16 },
  copyBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-end', marginTop: 8, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6 },
  copyText: { fontFamily: 'Silkscreen', fontSize: 11, fontWeight: '600' },
  settingsBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, alignSelf: 'flex-start' },
  settingsBtnText: { fontFamily: 'Silkscreen', fontSize: 13, fontWeight: '600' },
  footer: { flexDirection: 'row', alignItems: 'center', padding: 16, borderTopWidth: 1, borderTopColor: '#222' },
  navText: { fontFamily: 'Silkscreen', fontSize: 13 },
  nextBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 },
  nextText: { fontFamily: 'Silkscreen', fontSize: 13, fontWeight: '700' },
});
