/**
 * SetupWizard.tsx — v2.1: Fully automated Termux setup + Auth
 *
 * 4-step wizard:
 * 1. Install apps (Termux + Termux:Tasker + Termux:Boot)
 * 2. Auto-setup (animated progress + feature slideshow)
 * 3. Complete (summary + auth prompt)
 * 4. Auth (optional — AuthWizard modal for API keys)
 *
 * Design philosophy: Non-engineers should complete setup
 * by tapping "Next" a few times. No copy-paste. No Termux interaction.
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  Pressable,
  Modal,
  StyleSheet,
  Linking,
  ActivityIndicator,
} from 'react-native';
import Animated, {
  FadeInDown,
  FadeIn,
  FadeInRight,
  FadeOutLeft,
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  withSpring,
  Easing,
  interpolateColor,
  runOnJS,
} from 'react-native-reanimated';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTranslation } from '@/lib/i18n';
import { runAutoSetup, type SetupStep, type SetupProgress } from '@/lib/auto-setup';
import { getStoreUrl, checkTermuxPackages } from '@/lib/termux-intent';
import { AuthWizard } from '@/components/AuthWizard';

const SETUP_WIZARD_KEY = '@shelly/setup_wizard_complete';

// ── Slide configuration ────────────────────────────────────────────────────────

interface Slide {
  titleKey: string;
  descKey: string;
  exampleKey?: string;
  icon: string;
  color: string;
}

const SLIDES: Slide[] = [
  { titleKey: 'setup2.slide1_title', descKey: 'setup2.slide1_desc', exampleKey: 'setup2.slide1_example', icon: 'chat-bubble-outline', color: '#00D4AA' },
  { titleKey: 'setup2.slide2_title', descKey: 'setup2.slide2_desc', icon: 'auto-awesome', color: '#60A5FA' },
  { titleKey: 'setup2.slide3_title', descKey: 'setup2.slide3_desc', icon: 'folder-open', color: '#FBBF24' },
  { titleKey: 'setup2.slide4_title', descKey: 'setup2.slide4_desc', icon: 'mic', color: '#F472B6' },
  { titleKey: 'setup2.slide5_title', descKey: 'setup2.slide5_desc', icon: 'rocket-launch', color: '#A78BFA' },
  { titleKey: 'setup2.slide6_title', descKey: 'setup2.slide6_desc', icon: 'shield', color: '#4ADE80' },
];

const SLIDE_INTERVAL = 6000; // 6s per slide

// ── Step status mapping ────────────────────────────────────────────────────────

const STEP_LABEL_KEYS: Record<string, string> = {
  installing_packages: 'setup2.step_packages',
  writing_bridge: 'setup2.step_bridge',
  writing_boot_script: 'setup2.step_boot',
  starting_ttyd: 'setup2.step_ttyd',
  starting_bridge: 'setup2.step_bridge_start',
  connecting_bridge: 'setup2.step_connect_bridge',
  connecting_tty: 'setup2.step_connect_tty',
  detecting_llm: 'setup2.step_detect_llm',
  complete: 'setup2.step_done',
  error: 'setup2.step_error',
};

const STEP_ORDER: SetupStep[] = [
  'installing_packages',
  'writing_bridge',
  'writing_boot_script',
  'starting_ttyd',
  'starting_bridge',
  'connecting_bridge',
  'connecting_tty',
  'detecting_llm',
];

// ── Props ──────────────────────────────────────────────────────────────────────

type Props = {
  visible: boolean;
  onComplete: () => void;
  /** 設定画面から再セットアップとして開く場合true */
  isResetup?: boolean;
};

// ── Main Component ─────────────────────────────────────────────────────────────

export function SetupWizard({ visible, onComplete, isResetup = false }: Props) {
  const { t } = useTranslation();
  const [wizardStep, setWizardStep] = useState<'welcome' | 'install' | 'progress' | 'complete' | 'error'>(
    isResetup ? 'progress' : 'welcome'
  );
  const [slideIndex, setSlideIndex] = useState(0);
  const [progress, setProgress] = useState<SetupProgress>({ step: 'installing_packages', percent: 0 });
  const [completedSteps, setCompletedSteps] = useState<Set<SetupStep>>(new Set());
  const [setupResult, setSetupResult] = useState<{ llmDetected: boolean; ttyConnected: boolean } | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [showAuthWizard, setShowAuthWizard] = useState(false);
  const slideTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Detect installed apps via native module
  const [installedApps, setInstalledApps] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!visible || wizardStep !== 'install') return;
    checkTermuxPackages().then((result) => {
      setInstalledApps({
        termux: result.termuxInstalled,
        tasker: result.taskerInstalled,
        boot: result.bootInstalled,
      });
    }).catch((e) => {
      console.warn('[SetupWizard] checkTermuxPackages failed:', e);
    });
  }, [visible, wizardStep]);

  // ── Animations ─────────────────────────────────────────────────────────────

  // Progress bar animation
  const progressAnim = useSharedValue(0);
  const progressStyle = useAnimatedStyle(() => ({
    width: `${progressAnim.value}%` as any,
  }));

  // Pulse for active step indicator
  const pulse = useSharedValue(0.4);
  useEffect(() => {
    if (wizardStep !== 'progress') return;
    pulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 800, easing: Easing.inOut(Easing.ease) }),
        withTiming(0.4, { duration: 800, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
      false,
    );
    return () => { pulse.value = 0.4; };
  }, [wizardStep]);

  const pulseStyle = useAnimatedStyle(() => ({
    opacity: pulse.value,
  }));

  // ── Slideshow ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (wizardStep !== 'progress') {
      if (slideTimerRef.current) clearInterval(slideTimerRef.current);
      return;
    }
    slideTimerRef.current = setInterval(() => {
      setSlideIndex((i) => (i + 1) % SLIDES.length);
    }, SLIDE_INTERVAL);
    return () => {
      if (slideTimerRef.current) clearInterval(slideTimerRef.current);
    };
  }, [wizardStep]);

  // ── Update progress ────────────────────────────────────────────────────────

  const handleProgress = useCallback((p: SetupProgress) => {
    setProgress(p);
    progressAnim.value = withTiming(p.percent, { duration: 500 });

    // Track completed steps
    const idx = STEP_ORDER.indexOf(p.step);
    if (idx > 0) {
      setCompletedSteps((prev) => {
        const next = new Set(prev);
        for (let i = 0; i < idx; i++) next.add(STEP_ORDER[i]);
        return next;
      });
    }
  }, []);

  // ── Run setup ──────────────────────────────────────────────────────────────

  const startSetup = useCallback(async () => {
    setWizardStep('progress');
    setCompletedSteps(new Set());
    setProgress({ step: 'installing_packages', percent: 0 });
    progressAnim.value = 0;

    const result = await runAutoSetup(handleProgress);

    if (result.success) {
      setSetupResult({ llmDetected: result.llmDetected, ttyConnected: result.ttyConnected });
      setWizardStep('complete');
      progressAnim.value = withTiming(100, { duration: 300 });
    } else {
      // Map error to user-friendly message
      let errKey = 'setup2.error_generic';
      if (result.error === 'PERMISSION_DENIED') errKey = 'setup2.error_permission';
      else if (result.error === 'TASKER_NOT_INSTALLED') errKey = 'setup2.error_not_installed';
      else if (result.error === 'BRIDGE_CONNECTION_FAILED') errKey = 'setup2.error_bridge';
      setErrorMessage(t(errKey));
      setWizardStep('error');
    }
  }, [handleProgress, t]);

  // Auto-start if isResetup
  useEffect(() => {
    if (isResetup && visible) {
      startSetup();
    }
  }, [isResetup, visible]);

  // ── Done ───────────────────────────────────────────────────────────────────

  const handleDone = useCallback(async () => {
    if (!isResetup) {
      await AsyncStorage.setItem(SETUP_WIZARD_KEY, 'true');
    }
    onComplete();
  }, [onComplete, isResetup]);

  // ── Skip ───────────────────────────────────────────────────────────────────

  const handleSkip = useCallback(async () => {
    await AsyncStorage.setItem(SETUP_WIZARD_KEY, 'true').catch(() => {});
    onComplete();
  }, [onComplete]);

  // ── Render: Welcome ────────────────────────────────────────────────────────

  const renderWelcomeStep = () => (
    <Animated.View entering={FadeInDown.duration(400)} style={styles.stepContainer}>
      <View style={[styles.iconCircle, { backgroundColor: '#FBBF2420' }]}>
        <MaterialIcons name="waving-hand" size={48} color="#FBBF24" />
      </View>

      <Text style={[styles.title, { color: '#FBBF24' }]}>{t('setup2.hero_title')}</Text>
      <Text style={styles.description}>{t('setup2.hero_desc')}</Text>

      {/* Feature highlights */}
      <View style={styles.featureList}>
        <FeatureRow icon="chat-bubble-outline" color="#00D4AA" labelKey="setup2.hero_feat1" />
        <FeatureRow icon="auto-awesome" color="#60A5FA" labelKey="setup2.hero_feat2" />
        <FeatureRow icon="mic" color="#F472B6" labelKey="setup2.hero_feat3" />
        <FeatureRow icon="shield" color="#4ADE80" labelKey="setup2.hero_feat4" />
      </View>

      <Pressable
        style={[styles.primaryBtn, { backgroundColor: '#FBBF24' }]}
        onPress={() => setWizardStep('install')}
      >
        <Text style={styles.primaryBtnText}>{t('setup2.hero_next')}</Text>
        <MaterialIcons name="arrow-forward" size={18} color="#000" />
      </Pressable>
    </Animated.View>
  );

  // ── Render: Step 1 — Install apps ──────────────────────────────────────────

  const renderInstallStep = () => {
    const apps = [
      { key: 'termux' as const, nameKey: 'setup2.install_termux', descKey: 'setup2.install_termux_desc', icon: 'terminal', required: true },
      { key: 'tasker' as const, nameKey: 'setup2.install_tasker', descKey: 'setup2.install_tasker_desc', icon: 'extension', required: true },
      { key: 'boot' as const, nameKey: 'setup2.install_boot', descKey: 'setup2.install_boot_desc', icon: 'power-settings-new', required: false },
    ];

    return (
      <Animated.View entering={FadeInDown.duration(400)} style={styles.stepContainer}>
        <View style={styles.iconCircle}>
          <MaterialIcons name="download" size={48} color="#00D4AA" />
        </View>

        <Text style={styles.title}>{t('setup2.welcome_title')}</Text>
        <Text style={styles.description}>{t('setup2.welcome_desc')}</Text>

        {/* App install cards */}
        {apps.map((app) => {
          const urls = getStoreUrl(app.key);
          const isInstalled = installedApps[app.key] === true;
          return (
            <View key={app.key} style={[styles.installCard, isInstalled && { borderColor: '#00D4AA33' }]}>
              <View style={styles.installCardLeft}>
                <MaterialIcons
                  name={isInstalled ? 'check-circle' : (app.icon as any)}
                  size={24}
                  color={isInstalled ? '#00D4AA' : app.required ? '#00D4AA' : '#6B7280'}
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.installName}>
                    {t(app.nameKey)}
                    {!app.required && <Text style={styles.installOptional}> (optional)</Text>}
                  </Text>
                  <Text style={styles.installDesc}>
                    {isInstalled ? t('setup2.installed') : t(app.descKey)}
                  </Text>
                </View>
              </View>
              {!isInstalled && (
                <View style={styles.installButtons}>
                  <Pressable
                    style={styles.installBtn}
                    onPress={() => Linking.openURL(urls.fdroid)}
                  >
                    <Text style={styles.installBtnText}>F-Droid</Text>
                  </Pressable>
                  {urls.playStore != null && (
                    <Pressable
                      style={[styles.installBtn, { borderColor: '#333' }]}
                      onPress={() => Linking.openURL(urls.playStore!)}
                    >
                      <Text style={[styles.installBtnText, { color: '#6B7280' }]}>Play</Text>
                    </Pressable>
                  )}
                </View>
              )}
            </View>
          );
        })}

        {/* Start button */}
        <Pressable
          style={[styles.primaryBtn, { backgroundColor: '#00D4AA' }]}
          onPress={startSetup}
        >
          <MaterialIcons name="play-arrow" size={20} color="#000" />
          <Text style={styles.primaryBtnText}>{t('setup2.start_setup')}</Text>
        </Pressable>

        {/* Skip */}
        <Pressable style={styles.skipBtn} onPress={handleSkip}>
          <Text style={styles.skipBtnText}>{t('setup.skip')}</Text>
        </Pressable>
      </Animated.View>
    );
  };

  // ── Render: Step 2 — Progress + Slideshow ──────────────────────────────────

  const currentSlide = SLIDES[slideIndex];

  const renderProgressStep = () => (
    <Animated.View entering={FadeInDown.duration(400)} style={styles.stepContainer}>
      {/* Feature slideshow (top half) */}
      <Animated.View
        key={`slide-${slideIndex}`}
        entering={FadeInRight.duration(500)}
        exiting={FadeOutLeft.duration(300)}
        style={styles.slideContainer}
      >
        <View style={[styles.slideIconCircle, { backgroundColor: currentSlide.color + '20' }]}>
          <MaterialIcons name={currentSlide.icon as any} size={36} color={currentSlide.color} />
        </View>
        <Text style={[styles.slideTitle, { color: currentSlide.color }]}>
          {t(currentSlide.titleKey)}
        </Text>
        <Text style={styles.slideDesc}>{t(currentSlide.descKey)}</Text>
        {currentSlide.exampleKey && (
          <View style={styles.slideExample}>
            <Text style={styles.slideExampleText}>{t(currentSlide.exampleKey)}</Text>
          </View>
        )}
      </Animated.View>

      {/* Slide dots */}
      <View style={styles.slideDots}>
        {SLIDES.map((_, i) => (
          <View
            key={i}
            style={[
              styles.slideDot,
              i === slideIndex && { backgroundColor: currentSlide.color, width: 16 },
            ]}
          />
        ))}
      </View>

      {/* Progress bar */}
      <View style={styles.progressBarContainer}>
        <View style={styles.progressBarBg}>
          <Animated.View style={[styles.progressBarFill, progressStyle]} />
        </View>
        <Text style={styles.progressPercent}>{Math.round(progress.percent)}%</Text>
      </View>

      {/* Step status list */}
      <View style={styles.stepList}>
        {STEP_ORDER.map((step) => {
          const isActive = progress.step === step;
          const isDone = completedSteps.has(step);
          const labelKey = STEP_LABEL_KEYS[step] || step;

          return (
            <View key={step} style={styles.stepRow}>
              {isDone ? (
                <MaterialIcons name="check-circle" size={16} color="#4ADE80" />
              ) : isActive ? (
                <Animated.View style={pulseStyle}>
                  <ActivityIndicator size="small" color="#60A5FA" style={{ transform: [{ scale: 0.7 }] }} />
                </Animated.View>
              ) : (
                <MaterialIcons name="radio-button-unchecked" size={16} color="#333" />
              )}
              <Text
                style={[
                  styles.stepLabel,
                  isDone && { color: '#4ADE80' },
                  isActive && { color: '#60A5FA' },
                ]}
              >
                {t(labelKey)}
              </Text>
            </View>
          );
        })}
      </View>

      <Text style={styles.hint}>{t('setup2.progress_wait')}</Text>
    </Animated.View>
  );

  // ── Render: Step 3 — Complete ──────────────────────────────────────────────

  const renderCompleteStep = () => (
    <Animated.View entering={FadeInDown.duration(400)} style={styles.stepContainer}>
      <Animated.View
        entering={FadeIn.duration(600)}
        style={[styles.iconCircle, { backgroundColor: '#4ADE8020' }]}
      >
        <MaterialIcons name="check-circle" size={48} color="#4ADE80" />
      </Animated.View>

      <Text style={[styles.title, { color: '#4ADE80' }]}>{t('setup2.complete_title')}</Text>
      <Text style={styles.description}>{t('setup2.complete_desc')}</Text>

      {/* Results summary */}
      <View style={styles.resultCard}>
        <ResultRow
          icon="cable"
          label={t('setup2.result_bridge')}
          value={t('setup2.result_connected')}
          color="#4ADE80"
        />
        <ResultRow
          icon="terminal"
          label={t('setup2.result_tty')}
          value={setupResult?.ttyConnected ? t('setup2.result_connected') : t('setup2.result_not_found')}
          color={setupResult?.ttyConnected ? '#4ADE80' : '#FBBF24'}
        />
        <ResultRow
          icon="smart-toy"
          label={t('setup2.result_llm')}
          value={setupResult?.llmDetected ? t('setup2.result_connected') : t('setup2.result_not_found')}
          color={setupResult?.llmDetected ? '#4ADE80' : '#6B7280'}
        />
        <ResultRow
          icon="power-settings-new"
          label={t('setup2.result_boot')}
          value={t('setup2.result_boot_ok')}
          color="#4ADE80"
        />
      </View>

      {/* Gemini recommendation card for beginners */}
      <View style={[styles.resultCard, { borderColor: '#3B82F620', marginTop: 12 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <MaterialIcons name="auto-awesome" size={18} color="#3B82F6" />
          <Text style={{ color: '#3B82F6', fontSize: 13, fontWeight: '700', fontFamily: 'monospace' }}>
            {t('setup2.gemini_recommend_title')}
          </Text>
          <View style={{ backgroundColor: '#4ADE8030', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4 }}>
            <Text style={{ color: '#4ADE80', fontSize: 9, fontWeight: '700', fontFamily: 'monospace' }}>
              {t('setup2.free_badge')}
            </Text>
          </View>
        </View>
        <Text style={{ color: '#9CA3AF', fontSize: 11, fontFamily: 'monospace', lineHeight: 16 }}>
          {t('setup2.gemini_recommend_desc')}
        </Text>
      </View>

      {/* Auth setup button */}
      <Pressable
        style={[styles.primaryBtn, { backgroundColor: '#3B82F6', marginTop: 12 }]}
        onPress={() => setShowAuthWizard(true)}
      >
        <MaterialIcons name="login" size={18} color="#FFF" />
        <Text style={[styles.primaryBtnText, { color: '#FFF' }]}>{t('setup2.setup_ai_auth')}</Text>
      </Pressable>

      <Pressable
        style={[styles.primaryBtn, { backgroundColor: '#4ADE80', marginTop: 8 }]}
        onPress={handleDone}
      >
        <Text style={styles.primaryBtnText}>{t('setup2.get_started')}</Text>
        <MaterialIcons name="arrow-forward" size={18} color="#000" />
      </Pressable>
    </Animated.View>
  );

  // ── Render: Error ──────────────────────────────────────────────────────────

  const renderErrorStep = () => (
    <Animated.View entering={FadeInDown.duration(400)} style={styles.stepContainer}>
      <View style={[styles.iconCircle, { backgroundColor: '#F8717120' }]}>
        <MaterialIcons name="error-outline" size={48} color="#F87171" />
      </View>

      <Text style={[styles.title, { color: '#F87171' }]}>{t('setup2.error_title')}</Text>
      <Text style={styles.errorMessage}>{errorMessage}</Text>

      <Pressable
        style={[styles.primaryBtn, { backgroundColor: '#F87171' }]}
        onPress={startSetup}
      >
        <MaterialIcons name="refresh" size={18} color="#000" />
        <Text style={styles.primaryBtnText}>{t('setup2.retry')}</Text>
      </Pressable>

      <Pressable style={styles.skipBtn} onPress={handleSkip}>
        <Text style={styles.skipBtnText}>{t('setup.skip')}</Text>
      </Pressable>
    </Animated.View>
  );

  // ── Main render ────────────────────────────────────────────────────────────

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          {wizardStep === 'welcome' && renderWelcomeStep()}
          {wizardStep === 'install' && renderInstallStep()}
          {wizardStep === 'progress' && renderProgressStep()}
          {wizardStep === 'complete' && renderCompleteStep()}
          {wizardStep === 'error' && renderErrorStep()}
        </View>
      </View>
      {/* Auth Wizard (launched from complete step) */}
      <AuthWizard
        visible={showAuthWizard}
        onComplete={() => setShowAuthWizard(false)}
      />
    </Modal>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function FeatureRow({ icon, color, labelKey }: { icon: string; color: string; labelKey: string }) {
  const { t } = useTranslation();
  return (
    <View style={styles.featureRow}>
      <View style={[styles.featureIcon, { backgroundColor: color + '18' }]}>
        <MaterialIcons name={icon as any} size={18} color={color} />
      </View>
      <Text style={styles.featureLabel}>{t(labelKey)}</Text>
    </View>
  );
}

function ResultRow({ icon, label, value, color }: { icon: string; label: string; value: string; color: string }) {
  return (
    <View style={styles.resultRow}>
      <MaterialIcons name={icon as any} size={18} color={color} />
      <Text style={styles.resultLabel}>{label}</Text>
      <Text style={[styles.resultValue, { color }]}>{value}</Text>
    </View>
  );
}

// ── Utility exports ────────────────────────────────────────────────────────────

export async function isSetupWizardComplete(): Promise<boolean> {
  const val = await AsyncStorage.getItem(SETUP_WIZARD_KEY);
  return val === 'true';
}

export async function resetSetupWizard(): Promise<void> {
  await AsyncStorage.removeItem(SETUP_WIZARD_KEY);
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#141414',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    paddingHorizontal: 24,
    paddingVertical: 28,
    maxHeight: '85%',
  },
  stepContainer: {
    alignItems: 'center',
  },
  iconCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: '#00D4AA20',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    fontFamily: 'monospace',
    color: '#00D4AA',
    textAlign: 'center',
    marginBottom: 8,
  },
  description: {
    color: '#9CA3AF',
    fontSize: 13,
    fontFamily: 'monospace',
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: 20,
  },

  // ── Feature list (welcome) ───────────────────────────────────────────
  featureList: {
    width: '100%',
    gap: 10,
    marginBottom: 8,
  },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  featureIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  featureLabel: {
    color: '#D1D5DB',
    fontSize: 13,
    fontFamily: 'monospace',
    flex: 1,
  },

  // ── Install cards ────────────────────────────────────────────────────
  installCard: {
    width: '100%',
    backgroundColor: '#1A1A1A',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    padding: 12,
    marginBottom: 8,
  },
  installCardLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  installName: {
    color: '#E8E8E8',
    fontSize: 14,
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  installOptional: {
    color: '#6B7280',
    fontSize: 11,
    fontWeight: '400',
  },
  installDesc: {
    color: '#6B7280',
    fontSize: 11,
    fontFamily: 'monospace',
  },
  installButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  installBtn: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#00D4AA44',
    alignItems: 'center',
  },
  installBtnText: {
    color: '#00D4AA',
    fontSize: 12,
    fontFamily: 'monospace',
    fontWeight: '600',
  },

  // ── Primary button ───────────────────────────────────────────────────
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 12,
    width: '100%',
    marginTop: 16,
  },
  primaryBtnText: {
    color: '#000',
    fontSize: 15,
    fontFamily: 'monospace',
    fontWeight: '800',
  },
  skipBtn: {
    paddingVertical: 10,
    marginTop: 8,
  },
  skipBtnText: {
    color: '#6B7280',
    fontSize: 12,
    fontFamily: 'monospace',
  },

  // ── Slideshow ────────────────────────────────────────────────────────
  slideContainer: {
    alignItems: 'center',
    minHeight: 160,
    marginBottom: 12,
  },
  slideIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  slideTitle: {
    fontSize: 18,
    fontWeight: '800',
    fontFamily: 'monospace',
    textAlign: 'center',
    marginBottom: 6,
  },
  slideDesc: {
    color: '#9CA3AF',
    fontSize: 13,
    fontFamily: 'monospace',
    lineHeight: 20,
    textAlign: 'center',
  },
  slideExample: {
    backgroundColor: '#0D0D0D',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginTop: 8,
  },
  slideExampleText: {
    color: '#00D4AA',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  slideDots: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 16,
    justifyContent: 'center',
  },
  slideDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#333',
  },

  // ── Progress bar ─────────────────────────────────────────────────────
  progressBarContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    marginBottom: 14,
  },
  progressBarBg: {
    flex: 1,
    height: 6,
    backgroundColor: '#1E1E1E',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#00D4AA',
    borderRadius: 3,
  },
  progressPercent: {
    color: '#6B7280',
    fontSize: 12,
    fontFamily: 'monospace',
    fontWeight: '600',
    minWidth: 36,
    textAlign: 'right',
  },

  // ── Step list ────────────────────────────────────────────────────────
  stepList: {
    width: '100%',
    gap: 6,
    marginBottom: 8,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 22,
  },
  stepLabel: {
    color: '#4B5563',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  hint: {
    color: '#6B7280',
    fontSize: 11,
    fontFamily: 'monospace',
    textAlign: 'center',
    marginTop: 4,
  },

  // ── Results ──────────────────────────────────────────────────────────
  resultCard: {
    width: '100%',
    backgroundColor: '#1A1A1A',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    padding: 14,
    gap: 10,
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  resultLabel: {
    color: '#9CA3AF',
    fontSize: 13,
    fontFamily: 'monospace',
    flex: 1,
  },
  resultValue: {
    fontSize: 12,
    fontFamily: 'monospace',
    fontWeight: '700',
  },

  // ── Error ────────────────────────────────────────────────────────────
  errorMessage: {
    color: '#F87171',
    fontSize: 13,
    fontFamily: 'monospace',
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: 12,
  },
});
