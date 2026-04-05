/**
 * SetupWizard.tsx — v3.0: 2-phase setup with reliable bridge connection
 *
 * 5-step wizard:
 * 1. Welcome — feature intro
 * 2. Install apps — Termux + Termux:Boot (Tasker removed)
 * 3. Init — RUN_COMMAND sends && chain, polls WebSocket until connected
 * 4. Auto — bridge-based setup (boot script, socat+tmux, CLI/LLM detection)
 * 5. Complete — summary + auth prompt
 *
 * Design philosophy: Non-engineers should complete setup
 * by tapping buttons. No copy-paste unless Phase 1 times out.
 * Engineers can skip or dismiss anything.
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
} from 'react-native-reanimated';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import { useTranslation } from '@/lib/i18n';
import {
  runPhase1Setup,
  runPhase2Setup,
  buildSetupCommand,
  type Phase1Progress,
  type Phase2Progress,
  type Phase2Results,
  type BridgeExecutor,
  type BridgeFileWriter,
} from '@/lib/auto-setup';
import { getStoreUrl, checkTermuxPackages, runTermuxCommand } from '@/lib/termux-intent';
import { useTermuxBridge } from '@/hooks/use-termux-bridge';
import { AuthWizard } from '@/components/AuthWizard';
import { getDeviceProfile, type KillFixStep } from '@/lib/process-guard';

const SETUP_WIZARD_KEY = '@shelly/setup_wizard_complete';

// ── Slide configuration (feature showcase during init wait) ────────────────

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

const SLIDE_INTERVAL = 6000;

// ── Phase 2 step display config ───────────────────────────────────────────

const PHASE2_STEPS = [
  { key: 'boot_script', labelKey: 'setup2.auto_step_boot' },
  { key: 'terminal', labelKey: 'setup2.auto_step_terminal' },
  { key: 'cli_detect', labelKey: 'setup2.auto_step_cli' },
  { key: 'llm_detect', labelKey: 'setup2.auto_step_llm' },
] as const;

// ── Props ──────────────────────────────────────────────────────────────────

type Props = {
  visible: boolean;
  onComplete: () => void;
  isResetup?: boolean;
};

type CliDetectionResult = {
  claudeCode: boolean;
  geminiCli: boolean;
  codex: boolean;
};

// ── Main Component ─────────────────────────────────────────────────────────

export function SetupWizard({ visible, onComplete, isResetup = false }: Props) {
  const { t } = useTranslation();
  const { runRawCommand, writeFile } = useTermuxBridge();

  type WizardStep = 'welcome' | 'install' | 'init' | 'auto' | 'protect' | 'complete' | 'error';
  const [wizardStep, setWizardStep] = useState<WizardStep>(
    isResetup ? 'init' : 'welcome',
  );

  // Install step
  const [installedApps, setInstalledApps] = useState<Record<string, boolean>>({});

  // Init step (Phase 1)
  const [phase1Progress, setPhase1Progress] = useState<Phase1Progress | null>(null);
  const [showManualFallback, setShowManualFallback] = useState(false);
  const [initCopied, setInitCopied] = useState(false);

  // Auto step (Phase 2)
  const [phase2Progress, setPhase2Progress] = useState<Phase2Progress | null>(null);

  // Complete step
  const [setupResult, setSetupResult] = useState<{ llmDetected: boolean; terminalReady: boolean } | null>(null);
  const [cliDetected, setCliDetected] = useState<CliDetectionResult>({ claudeCode: false, geminiCli: false, codex: false });
  const [geminiInstalling, setGeminiInstalling] = useState(false);
  const [geminiInstalled, setGeminiInstalled] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [showAuthWizard, setShowAuthWizard] = useState(false);

  // Slideshow (during init wait)
  const [slideIndex, setSlideIndex] = useState(0);
  const slideTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Detect installed apps ────────────────────────────────────────────────

  useEffect(() => {
    if (!visible || wizardStep !== 'install') return;
    checkTermuxPackages().then((result) => {
      setInstalledApps({
        termux: result.termuxInstalled,
        boot: result.bootInstalled,
      });
    }).catch(() => {});
  }, [visible, wizardStep]);

  // ── Slideshow during init ────────────────────────────────────────────────

  useEffect(() => {
    if (wizardStep !== 'init') {
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

  // ── Phase 1: Auto-execute via Native Module, fallback to manual ────

  const handleCopyAndOpenTermux = useCallback(async () => {
    // Already attempted auto — this is the manual fallback button
    await Clipboard.setStringAsync(buildSetupCommand());
    setInitCopied(true);
    setTimeout(() => setInitCopied(false), 3000);
    try { await Linking.openURL('com.termux://'); } catch {}
  }, []);

  // Start polling when entering init step — try auto-execute first
  useEffect(() => {
    if (wizardStep !== 'init') return;

    let cancelled = false;

    const startSetup = async () => {
      // Try Native Module auto-execution first (no user interaction needed)
      const setupCmd = buildSetupCommand();
      const autoResult = await runTermuxCommand({ command: setupCmd, background: false });

      if (!autoResult.success) {
        // Auto-execution failed (likely allow-external-apps not set)
        // Show manual fallback after a short delay
        if (!cancelled) setShowManualFallback(true);
      }

      // Poll for bridge connection regardless (works for both auto and manual paths)
      const result = await runPhase1Setup((p) => {
        if (!cancelled) setPhase1Progress(p);
      });
      if (!cancelled && result.success) {
        setWizardStep('auto');
      }
    };
    startSetup();

    return () => { cancelled = true; };
  }, [wizardStep]);

  // ── Phase 2: Bridge-based setup ──────────────────────────────────────────

  const startPhase2 = useCallback(async () => {
    const exec: BridgeExecutor = (cmd, opts) =>
      runRawCommand(cmd, { timeoutMs: opts?.timeoutMs, reason: 'auto-setup' });
    const writer: BridgeFileWriter = (path, content) =>
      writeFile(path, content);

    try {
      const results = await runPhase2Setup(exec, writer, (p) => {
        setPhase2Progress(p);
      });

      setSetupResult({
        llmDetected: results.llm ?? false,
        terminalReady: results.terminal ?? false,
      });
      setCliDetected(results.cli ?? { claudeCode: false, geminiCli: false, codex: false });
      setWizardStep('protect');
    } catch (err) {
      // Phase 2 failure is non-fatal — still show protect with partial results
      setSetupResult({ llmDetected: false, terminalReady: false });
      setWizardStep('protect');
    }
  }, [runRawCommand, writeFile]);

  useEffect(() => {
    if (wizardStep === 'auto') {
      startPhase2();
    }
  }, [wizardStep, startPhase2]);

  // Auto-start if isResetup
  useEffect(() => {
    if (isResetup && visible) {
      setWizardStep('init');
    }
  }, [isResetup, visible]);

  // ── Done / Skip ──────────────────────────────────────────────────────────

  const handleDone = useCallback(async () => {
    if (!isResetup) {
      await AsyncStorage.setItem(SETUP_WIZARD_KEY, 'true');
    }
    onComplete();
  }, [onComplete, isResetup]);

  const handleSkip = useCallback(async () => {
    await AsyncStorage.setItem(SETUP_WIZARD_KEY, 'true').catch(() => {});
    onComplete();
  }, [onComplete]);

  // ── Render: Welcome ────────────────────────────────────────────────────

  const renderWelcomeStep = () => (
    <Animated.View entering={FadeInDown.duration(400)} style={styles.stepContainer}>
      <View style={[styles.iconCircle, { backgroundColor: '#FBBF2420' }]}>
        <MaterialIcons name="waving-hand" size={48} color="#FBBF24" />
      </View>

      <Text style={[styles.title, { color: '#FBBF24' }]}>{t('setup2.hero_title')}</Text>
      <Text style={styles.description}>{t('setup2.hero_desc')}</Text>

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

  // ── Render: Step 2 — Install apps ──────────────────────────────────────

  const renderInstallStep = () => {
    const apps = [
      { key: 'termux' as const, nameKey: 'setup2.install_termux', descKey: 'setup2.install_termux_desc', icon: 'terminal', required: true },
      { key: 'boot' as const, nameKey: 'setup2.install_boot', descKey: 'setup2.install_boot_desc', icon: 'power-settings-new', required: false },
    ];

    return (
      <Animated.View entering={FadeInDown.duration(400)} style={styles.stepContainer}>
        <View style={styles.iconCircle}>
          <MaterialIcons name="download" size={48} color="#00D4AA" />
        </View>

        <Text style={styles.title}>{t('setup2.welcome_title')}</Text>
        <Text style={styles.description}>{t('setup2.welcome_desc')}</Text>

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
                    onPress={() => Linking.openURL(urls.fdroid).catch(() => {})}
                  >
                    <Text style={styles.installBtnText}>F-Droid</Text>
                  </Pressable>
                  {urls.playStore != null && (
                    <Pressable
                      style={[styles.installBtn, { borderColor: '#333' }]}
                      onPress={() => Linking.openURL(urls.playStore!).catch(() => {})}
                    >
                      <Text style={[styles.installBtnText, { color: '#6B7280' }]}>Play</Text>
                    </Pressable>
                  )}
                </View>
              )}
            </View>
          );
        })}

        {/* Bootstrap hint */}
        <Text style={styles.bootstrapHint}>{t('setup2.install_termux_bootstrap')}</Text>

        {/* Gemini CLI teaser */}
        <View style={styles.geminiTeaserCard}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <MaterialIcons name="auto-awesome" size={14} color="#60A5FA" />
            <Text style={styles.geminiTeaserTitle}>{t('setup2.gemini_teaser_title')}</Text>
          </View>
          <Text style={styles.geminiTeaserDesc}>{t('setup2.gemini_teaser_desc')}</Text>
        </View>

        <Pressable
          style={[styles.primaryBtn, { backgroundColor: '#00D4AA' }]}
          onPress={() => setWizardStep('init')}
        >
          <MaterialIcons name="play-arrow" size={20} color="#000" />
          <Text style={styles.primaryBtnText}>{t('setup2.start_setup')}</Text>
        </Pressable>

        <Pressable style={styles.skipBtn} onPress={handleSkip}>
          <Text style={styles.skipBtnText}>{t('setup.skip')}</Text>
        </Pressable>
      </Animated.View>
    );
  };

  // ── Render: Step 3 — Init (Phase 1: copy command + open Termux + poll) ──

  const currentSlide = SLIDES[slideIndex];

  const renderInitStep = () => (
    <Animated.View entering={FadeInDown.duration(400)} style={styles.stepContainer}>
      <View style={[styles.iconCircle, { backgroundColor: '#60A5FA20' }]}>
        <MaterialIcons name="terminal" size={48} color="#60A5FA" />
      </View>

      <Text style={[styles.title, { color: '#60A5FA' }]}>{t('setup2.init_title')}</Text>
      <Text style={styles.description}>
        {showManualFallback ? t('setup2.init_desc') : t('setup2.init_auto_desc') || 'Termuxを自動セットアップ中...'}
      </Text>

      {/* Manual fallback: only shown when auto-execute fails */}
      {showManualFallback && (
        <>
          <Pressable
            style={[styles.primaryBtn, { backgroundColor: '#00D4AA' }]}
            onPress={handleCopyAndOpenTermux}
          >
            <MaterialIcons name="content-paste-go" size={20} color="#000" />
            <Text style={styles.primaryBtnText}>
              {initCopied ? t('setup2.init_copied') : t('setup2.init_start')}
            </Text>
          </Pressable>
          <Text style={styles.hint}>{t('setup2.init_paste_hint')}</Text>
        </>
      )}

      {/* Polling indicator */}
      <View style={[styles.waitingContainer, { marginTop: 16 }]}>
        <ActivityIndicator size="small" color="#60A5FA" />
        <Text style={styles.waitingText}>
          {showManualFallback
            ? t('setup2.init_waiting')
            : t('setup2.init_auto_waiting') || 'Termuxをセットアップ中...'}
          {phase1Progress?.elapsedSeconds != null && phase1Progress.elapsedSeconds > 0
            ? ` (${phase1Progress.elapsedSeconds}s)`
            : ''}
        </Text>
      </View>

      {/* Feature slideshow while waiting */}
      <Animated.View
        key={`slide-${slideIndex}`}
        entering={FadeInRight.duration(500)}
        exiting={FadeOutLeft.duration(300)}
        style={[styles.slideContainer, { marginTop: 12 }]}
      >
        <Text style={[styles.slideTitle, { color: currentSlide.color, fontSize: 14 }]}>
          {t(currentSlide.titleKey)}
        </Text>
        <Text style={[styles.slideDesc, { fontSize: 11 }]}>{t(currentSlide.descKey)}</Text>
      </Animated.View>

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

      <Pressable style={styles.skipBtn} onPress={handleSkip}>
        <Text style={styles.skipBtnText}>{t('setup.skip')}</Text>
      </Pressable>
    </Animated.View>
  );

  // ── Render: Step 4 — Auto (Phase 2) ──────────────────────────────────

  const renderAutoStep = () => (
    <Animated.View entering={FadeInDown.duration(400)} style={styles.stepContainer}>
      <View style={[styles.iconCircle, { backgroundColor: '#4ADE8020' }]}>
        <ActivityIndicator size="large" color="#4ADE80" />
      </View>

      <Text style={[styles.title, { color: '#4ADE80' }]}>{t('setup2.auto_title')}</Text>
      <Text style={styles.description}>{t('setup2.auto_desc')}</Text>

      <View style={styles.stepList}>
        {PHASE2_STEPS.map(({ key, labelKey }) => {
          const currentIdx = PHASE2_STEPS.findIndex(s => s.key === phase2Progress?.step);
          const thisIdx = PHASE2_STEPS.findIndex(s => s.key === key);
          const isDone = thisIdx < currentIdx || phase2Progress?.step === 'complete';
          const isActive = key === phase2Progress?.step;

          return (
            <View key={key} style={styles.stepRow}>
              {isDone ? (
                <MaterialIcons name="check-circle" size={16} color="#4ADE80" />
              ) : isActive ? (
                <ActivityIndicator size="small" color="#60A5FA" style={{ transform: [{ scale: 0.7 }] }} />
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
    </Animated.View>
  );

  // ── Render: Step 4.5 — Background Protection (ProcessGuard) ───────────

  const renderProtectStep = () => {
    const profile = getDeviceProfile();
    return (
      <Animated.View entering={FadeInDown.duration(400)} style={styles.stepContainer}>
        <View style={[styles.iconCircle, { backgroundColor: '#FF6B6B20' }]}>
          <MaterialIcons name="shield" size={48} color="#FF6B6B" />
        </View>

        <Text style={[styles.title, { color: '#FF6B6B' }]}>{t('setup2.protect_title')}</Text>
        <Text style={styles.description}>
          {t('setup2.protect_desc')}
        </Text>

        <View style={styles.stepList}>
          {profile.fixSteps.map((step, i) => (
            <View key={i} style={[styles.resultCard, { marginTop: i > 0 ? 8 : 0 }]}>
              <Text style={{ color: '#E8E8E8', fontSize: 13, fontWeight: '700', fontFamily: 'monospace', marginBottom: 4 }}>
                {i + 1}. {step.title}
              </Text>
              <Text style={{ color: '#9CA3AF', fontSize: 11, fontFamily: 'monospace', lineHeight: 16 }}>
                {step.description}
              </Text>
              {step.intentUri && (
                <Pressable
                  style={[styles.primaryBtn, { backgroundColor: '#FF6B6B', marginTop: 8, paddingVertical: 8 }]}
                  onPress={() => Linking.openURL(`intent://#Intent;action=${step.intentUri};end`).catch(() => {})}
                >
                  <MaterialIcons name="settings" size={16} color="#000" />
                  <Text style={[styles.primaryBtnText, { fontSize: 12 }]}>{t('guard.open_settings')}</Text>
                </Pressable>
              )}
              {step.adbCommand && (
                <View style={{ marginTop: 8, backgroundColor: '#0D0D0D', padding: 8, borderRadius: 6 }}>
                  <Text style={{ fontFamily: 'monospace', fontSize: 10, color: '#E8E8E8' }} selectable>
                    {step.adbCommand}
                  </Text>
                  <Pressable
                    style={{ alignSelf: 'flex-end', marginTop: 4, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, backgroundColor: '#FF6B6B20' }}
                    onPress={() => { Clipboard.setStringAsync(step.adbCommand!); }}
                  >
                    <Text style={{ fontFamily: 'monospace', fontSize: 10, color: '#FF6B6B' }}>{t('guard.copy')}</Text>
                  </Pressable>
                </View>
              )}
            </View>
          ))}
        </View>

        <Pressable
          style={[styles.primaryBtn, { backgroundColor: '#4ADE80', marginTop: 16 }]}
          onPress={() => setWizardStep('complete')}
        >
          <Text style={styles.primaryBtnText}>{t('setup2.protect_continue')}</Text>
          <MaterialIcons name="arrow-forward" size={18} color="#000" />
        </Pressable>

        <Pressable style={styles.skipBtn} onPress={() => setWizardStep('complete')}>
          <Text style={styles.skipBtnText}>{t('setup2.protect_skip')}</Text>
        </Pressable>
      </Animated.View>
    );
  };

  // ── Render: Step 5 — Complete ──────────────────────────────────────────

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
          value={setupResult?.terminalReady ? t('setup2.result_connected') : t('setup2.result_not_found')}
          color={setupResult?.terminalReady ? '#4ADE80' : '#FBBF24'}
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

      {/* CLI detection & Gemini install */}
      {(() => {
        const hasCli = cliDetected?.claudeCode || cliDetected?.geminiCli || cliDetected?.codex || geminiInstalled;
        return hasCli ? (
          <>
            <View style={[styles.resultCard, { borderColor: '#4ADE8020', marginTop: 12 }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <MaterialIcons name="check-circle" size={18} color="#4ADE80" />
                <Text style={{ color: '#4ADE80', fontSize: 13, fontWeight: '700', fontFamily: 'monospace' }}>
                  AI CLI Ready
                </Text>
              </View>
              <Text style={{ color: '#9CA3AF', fontSize: 11, fontFamily: 'monospace', lineHeight: 16 }}>
                {[
                  cliDetected?.claudeCode && 'Claude Code',
                  (cliDetected?.geminiCli || geminiInstalled) && 'Gemini CLI',
                  cliDetected?.codex && 'Codex',
                ].filter(Boolean).join(' / ')} detected.
              </Text>
            </View>
            <Pressable
              style={[styles.primaryBtn, { backgroundColor: '#3B82F6', marginTop: 12 }]}
              onPress={() => setShowAuthWizard(true)}
            >
              <MaterialIcons name="login" size={18} color="#FFF" />
              <Text style={[styles.primaryBtnText, { color: '#FFF' }]}>{t('setup2.setup_ai_auth')}</Text>
            </Pressable>
          </>
        ) : (
          <>
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
              {geminiInstalling && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
                  <ActivityIndicator size="small" color="#3B82F6" />
                  <Text style={{ color: '#3B82F6', fontSize: 11, fontFamily: 'monospace' }}>
                    Installing Gemini CLI...
                  </Text>
                </View>
              )}
            </View>
            <Pressable
              style={[styles.primaryBtn, { backgroundColor: '#3B82F6', marginTop: 12, opacity: geminiInstalling ? 0.5 : 1 }]}
              disabled={geminiInstalling}
              onPress={async () => {
                setGeminiInstalling(true);
                try {
                  const result = await runRawCommand(
                    'npm install -g @google/gemini-cli 2>&1',
                    { timeoutMs: 120_000, reason: 'gemini-cli-install' },
                  );
                  if (result.exitCode === 0) {
                    setGeminiInstalled(true);
                    setShowAuthWizard(true);
                  }
                } catch {} finally {
                  setGeminiInstalling(false);
                }
              }}
            >
              <MaterialIcons name="download" size={18} color="#FFF" />
              <Text style={[styles.primaryBtnText, { color: '#FFF' }]}>
                Install Gemini CLI (Free)
              </Text>
            </Pressable>
          </>
        );
      })()}

      <Pressable
        style={[styles.primaryBtn, { backgroundColor: '#4ADE80', marginTop: 8 }]}
        onPress={handleDone}
      >
        <Text style={styles.primaryBtnText}>{t('setup2.get_started')}</Text>
        <MaterialIcons name="arrow-forward" size={18} color="#000" />
      </Pressable>
    </Animated.View>
  );

  // ── Render: Error ──────────────────────────────────────────────────────

  const renderErrorStep = () => (
    <Animated.View entering={FadeInDown.duration(400)} style={styles.stepContainer}>
      <View style={[styles.iconCircle, { backgroundColor: '#F8717120' }]}>
        <MaterialIcons name="error-outline" size={48} color="#F87171" />
      </View>

      <Text style={[styles.title, { color: '#F87171' }]}>{t('setup2.error_title')}</Text>
      <Text style={styles.errorMessage}>{errorMessage}</Text>

      <Pressable
        style={[styles.primaryBtn, { backgroundColor: '#F87171' }]}
        onPress={() => setWizardStep('init')}
      >
        <MaterialIcons name="refresh" size={18} color="#000" />
        <Text style={styles.primaryBtnText}>{t('setup2.retry')}</Text>
      </Pressable>

      <Pressable style={styles.skipBtn} onPress={handleSkip}>
        <Text style={styles.skipBtnText}>{t('setup.skip')}</Text>
      </Pressable>
    </Animated.View>
  );

  // ── Main render ────────────────────────────────────────────────────────

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          {wizardStep === 'welcome' && renderWelcomeStep()}
          {wizardStep === 'install' && renderInstallStep()}
          {wizardStep === 'init' && renderInitStep()}
          {wizardStep === 'auto' && renderAutoStep()}
          {wizardStep === 'protect' && renderProtectStep()}
          {wizardStep === 'complete' && renderCompleteStep()}
          {wizardStep === 'error' && renderErrorStep()}
        </View>
      </View>
      <AuthWizard
        visible={showAuthWizard}
        onComplete={() => setShowAuthWizard(false)}
      />
    </Modal>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

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

// ── Utility exports ────────────────────────────────────────────────────────

export async function isSetupWizardComplete(): Promise<boolean> {
  const val = await AsyncStorage.getItem(SETUP_WIZARD_KEY);
  return val === 'true';
}

export async function resetSetupWizard(): Promise<void> {
  await AsyncStorage.removeItem(SETUP_WIZARD_KEY);
}

// ── Styles ─────────────────────────────────────────────────────────────────

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
  stepContainer: { alignItems: 'center' },
  iconCircle: {
    width: 88, height: 88, borderRadius: 44,
    backgroundColor: '#00D4AA20',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 22, fontWeight: '800', fontFamily: 'monospace',
    color: '#00D4AA', textAlign: 'center', marginBottom: 8,
  },
  description: {
    color: '#9CA3AF', fontSize: 13, fontFamily: 'monospace',
    lineHeight: 20, textAlign: 'center', marginBottom: 20,
  },

  // Feature list
  featureList: { width: '100%', gap: 10, marginBottom: 8 },
  featureRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  featureIcon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  featureLabel: { color: '#D1D5DB', fontSize: 13, fontFamily: 'monospace', flex: 1 },

  // Install cards
  installCard: {
    width: '100%', backgroundColor: '#1A1A1A', borderRadius: 12,
    borderWidth: 1, borderColor: '#2A2A2A', padding: 12, marginBottom: 8,
  },
  installCardLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  installName: { color: '#E8E8E8', fontSize: 14, fontFamily: 'monospace', fontWeight: '700' },
  installOptional: { color: '#6B7280', fontSize: 11, fontWeight: '400' },
  installDesc: { color: '#6B7280', fontSize: 11, fontFamily: 'monospace' },
  installButtons: { flexDirection: 'row', gap: 8 },
  installBtn: {
    flex: 1, paddingVertical: 6, borderRadius: 8,
    borderWidth: 1, borderColor: '#00D4AA44', alignItems: 'center',
  },
  installBtnText: { color: '#00D4AA', fontSize: 12, fontFamily: 'monospace', fontWeight: '600' },

  // Bootstrap hint
  bootstrapHint: {
    color: '#FBBF24', fontSize: 11, fontFamily: 'monospace',
    textAlign: 'center', marginBottom: 8, lineHeight: 18,
  },

  // Gemini teaser card (install step)
  geminiTeaserCard: {
    backgroundColor: '#60A5FA12',
    borderWidth: 1,
    borderColor: '#60A5FA30',
    borderRadius: 10,
    padding: 12,
    width: '100%',
  },
  geminiTeaserTitle: {
    color: '#60A5FA',
    fontSize: 12,
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  geminiTeaserDesc: {
    color: '#9CA3AF',
    fontSize: 11,
    fontFamily: 'monospace',
    lineHeight: 17,
  },

  // Primary button
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingHorizontal: 24, paddingVertical: 14,
    borderRadius: 12, width: '100%', marginTop: 16,
  },
  primaryBtnText: { color: '#000', fontSize: 15, fontFamily: 'monospace', fontWeight: '800' },
  skipBtn: { paddingVertical: 10, marginTop: 8 },
  skipBtnText: { color: '#6B7280', fontSize: 12, fontFamily: 'monospace' },

  // Slideshow
  slideContainer: { alignItems: 'center', minHeight: 160, marginBottom: 12 },
  slideIconCircle: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  slideTitle: { fontSize: 18, fontWeight: '800', fontFamily: 'monospace', textAlign: 'center', marginBottom: 6 },
  slideDesc: { color: '#9CA3AF', fontSize: 13, fontFamily: 'monospace', lineHeight: 20, textAlign: 'center' },
  slideExample: { backgroundColor: '#0D0D0D', borderRadius: 8, borderWidth: 1, borderColor: '#2A2A2A', paddingHorizontal: 12, paddingVertical: 6, marginTop: 8 },
  slideExampleText: { color: '#00D4AA', fontSize: 12, fontFamily: 'monospace' },
  slideDots: { flexDirection: 'row', gap: 6, marginBottom: 16, justifyContent: 'center' },
  slideDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#333' },

  // Waiting
  waitingContainer: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 8 },
  waitingText: { color: '#60A5FA', fontSize: 13, fontFamily: 'monospace' },
  hint: { color: '#6B7280', fontSize: 11, fontFamily: 'monospace', textAlign: 'center', marginTop: 4, lineHeight: 18 },

  // Command box (manual fallback)
  commandBox: {
    width: '100%', backgroundColor: '#0D0D0D', borderRadius: 8,
    borderWidth: 1, borderColor: '#2A2A2A', padding: 12, marginVertical: 12,
  },
  commandText: { color: '#00D4AA', fontSize: 11, fontFamily: 'monospace', lineHeight: 18 },

  // Step list (Phase 2)
  stepList: { width: '100%', gap: 6, marginBottom: 8 },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 22 },
  stepLabel: { color: '#4B5563', fontSize: 12, fontFamily: 'monospace' },

  // Results
  resultCard: {
    width: '100%', backgroundColor: '#1A1A1A', borderRadius: 12,
    borderWidth: 1, borderColor: '#2A2A2A', padding: 14, gap: 10,
  },
  resultRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  resultLabel: { color: '#9CA3AF', fontSize: 13, fontFamily: 'monospace', flex: 1 },
  resultValue: { fontSize: 12, fontFamily: 'monospace', fontWeight: '700' },

  // Error
  errorMessage: {
    color: '#F87171', fontSize: 13, fontFamily: 'monospace',
    lineHeight: 20, textAlign: 'center', marginBottom: 12,
  },
});
