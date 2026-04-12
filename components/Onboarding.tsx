/**
 * Onboarding.tsx — First-launch interactive walkthrough
 *
 * 3-4 step tutorial that introduces:
 * 1. Terminal basics
 * 2. AI assistants (@mention)
 * 3. Git beginner guide
 * 4. Customization (themes, keybindings, plugins)
 */
import React, { useState, useCallback } from 'react';
import { colors as C } from '@/theme.config';
import {
  View,
  Text,
  Pressable,
  Modal,
  StyleSheet,
  Dimensions,
} from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTranslation } from '@/lib/i18n';

const ONBOARDING_KEY = '@shelly/onboarding_complete';

const { width: SCREEN_W } = Dimensions.get('window');

interface Step {
  icon: string;
  titleKey: string;
  descKey: string;
  color: string;
}

const STEPS: Step[] = [
  {
    icon: 'waving-hand',
    titleKey: 'onboard.welcome',
    descKey: 'onboard.welcome_desc',
    color: '#FBBF24',
  },
  {
    icon: 'terminal',
    titleKey: 'onboard.terminal_title',
    descKey: 'onboard.terminal_desc',
    color: C.accent,
  },
  {
    icon: 'smart-toy',
    titleKey: 'onboard.ai_title',
    descKey: 'onboard.ai_desc',
    color: '#8B5CF6',
  },
  {
    icon: 'merge-type',
    titleKey: 'onboard.git_title',
    descKey: 'onboard.git_desc',
    color: '#F97316',
  },
  {
    icon: 'palette',
    titleKey: 'onboard.customize_title',
    descKey: 'onboard.customize_desc',
    color: '#EC4899',
  },
];

type Props = {
  visible: boolean;
  onComplete: () => void;
};

export function Onboarding({ visible, onComplete }: Props) {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const current = STEPS[step];

  const handleNext = useCallback(() => {
    if (step < STEPS.length - 1) {
      setStep((s) => s + 1);
    } else {
      handleDone();
    }
  }, [step]);

  const handleBack = useCallback(() => {
    if (step > 0) setStep((s) => s - 1);
  }, [step]);

  const handleDone = useCallback(async () => {
    await AsyncStorage.setItem(ONBOARDING_KEY, 'true');
    onComplete();
  }, [onComplete]);

  const handleSkip = useCallback(async () => {
    await AsyncStorage.setItem(ONBOARDING_KEY, 'true');
    onComplete();
  }, [onComplete]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          {/* Progress dots */}
          <View style={styles.dotsRow}>
            {STEPS.map((_, i) => (
              <View
                key={i}
                style={[
                  styles.dot,
                  i === step && { backgroundColor: current.color, width: 20 },
                ]}
              />
            ))}
          </View>

          {/* Icon */}
          <View style={[styles.iconCircle, { backgroundColor: current.color + '20' }]}>
            <MaterialIcons
              name={current.icon as any}
              size={48}
              color={current.color}
            />
          </View>

          {/* Title */}
          <Text style={[styles.title, { color: current.color }]}>
            {t(current.titleKey)}
          </Text>

          {/* Description */}
          <Text style={styles.description}>
            {t(current.descKey)}
          </Text>

          {/* Navigation */}
          <View style={styles.navRow}>
            {step > 0 ? (
              <Pressable style={styles.navBtnSecondary} onPress={handleBack}>
                <MaterialIcons name="arrow-back" size={16} color="#6B7280" />
                <Text style={styles.navBtnTextSecondary}>{t('onboard.back')}</Text>
              </Pressable>
            ) : (
              <Pressable style={styles.navBtnSecondary} onPress={handleSkip}>
                <Text style={styles.navBtnTextSecondary}>{t('onboard.skip')}</Text>
              </Pressable>
            )}

            <Pressable
              style={[styles.navBtnPrimary, { backgroundColor: current.color }]}
              onPress={handleNext}
            >
              <Text style={styles.navBtnTextPrimary}>
                {step < STEPS.length - 1 ? t('onboard.next') : t('onboard.done')}
              </Text>
              {step < STEPS.length - 1 && (
                <MaterialIcons name="arrow-forward" size={16} color="#000" />
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

/**
 * Check if onboarding has been completed.
 */
export async function isOnboardingComplete(): Promise<boolean> {
  const val = await AsyncStorage.getItem(ONBOARDING_KEY);
  return val === 'true';
}

/**
 * Reset onboarding (for testing or Settings).
 */
export async function resetOnboarding(): Promise<void> {
  await AsyncStorage.removeItem(ONBOARDING_KEY);
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#141414',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    paddingHorizontal: 28,
    paddingVertical: 32,
    alignItems: 'center',
  },
  dotsRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 28,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#333',
  },
  iconCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    fontFamily: 'monospace',
    marginBottom: 12,
    textAlign: 'center',
  },
  description: {
    color: '#9CA3AF',
    fontSize: 14,
    fontFamily: 'monospace',
    lineHeight: 22,
    textAlign: 'center',
    marginBottom: 32,
  },
  navRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    gap: 12,
  },
  navBtnSecondary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#1E1E1E',
    borderWidth: 1,
    borderColor: '#333',
  },
  navBtnTextSecondary: {
    color: '#6B7280',
    fontSize: 13,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  navBtnPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
    flex: 1,
    justifyContent: 'center',
  },
  navBtnTextPrimary: {
    color: '#000',
    fontSize: 14,
    fontFamily: 'monospace',
    fontWeight: '800',
  },
});
