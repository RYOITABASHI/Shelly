/**
 * WelcomeWizard.tsx — Native PTY Setup Wizard
 *
 * First-launch wizard flow:
 * 1. Welcome — Shelly intro + 3 feature highlights
 * 2. CLI Selection — Pick Claude Code / Gemini CLI / Codex CLI (multi-select, all skippable)
 * 3. Auth Loop — Configure each selected CLI (API key or web auth), skip individually
 * 4. Done — Summary of configured CLIs + "Get Started"
 *
 * No Termux dependency. Stores completion flag in AsyncStorage.
 */
import React, { useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  Pressable,
  Modal,
  StyleSheet,
  ScrollView,
  Dimensions,
} from 'react-native';
import Animated, {
  FadeInDown,
  FadeInRight,
  FadeOutLeft,
} from 'react-native-reanimated';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTranslation } from '@/lib/i18n';
import { ActivityIndicator } from 'react-native';
import { AuthWizard } from '@/components/AuthWizard';
import type { AuthToolId } from '@/lib/cli-auth';
import { logInfo, logError, logLifecycle } from '@/lib/debug-logger';
import { execCommand } from '@/hooks/use-native-exec';

// Map wizard CLI IDs to npm packages
const CLI_INSTALL_MAP: Record<AuthToolId, { npm: string; bin: string }> = {
  'claude-code': { npm: '@anthropic-ai/claude-code', bin: 'claude' },
  'gemini-cli': { npm: '@google/gemini-cli', bin: 'gemini' },
  'codex': { npm: '@openai/codex', bin: 'codex' },
};

// ── Constants ────────────────────────────────────────────────────────────────

const WIZARD_KEY = '@shelly/setup_wizard_complete';
const ACCENT = '#00D4AA';

// ── Types ────────────────────────────────────────────────────────────────────

type WizardStep = 'welcome' | 'cli-select' | 'cli-install' | 'cli-auth' | 'done';

type CliOption = {
  id: AuthToolId;
  name: string;
  descKey: string;
  icon: string;
  color: string;
  free?: boolean;
};

const CLI_OPTIONS: CliOption[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    descKey: 'wizard2.cli_claude_desc',
    icon: 'psychology',
    color: '#D4A574',
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    descKey: 'wizard2.cli_gemini_desc',
    icon: 'auto-awesome',
    color: '#4285F4',
    free: true,
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    descKey: 'wizard2.cli_codex_desc',
    icon: 'code',
    color: '#10A37F',
  },
];

type FeatureItem = {
  icon: string;
  titleKey: string;
  descKey: string;
  color: string;
};

const FEATURES: FeatureItem[] = [
  {
    icon: 'terminal',
    titleKey: 'wizard2.feat_terminal',
    descKey: 'wizard2.feat_terminal_desc',
    color: ACCENT,
  },
  {
    icon: 'smart-toy',
    titleKey: 'wizard2.feat_ai',
    descKey: 'wizard2.feat_ai_desc',
    color: '#8B5CF6',
  },
  {
    icon: 'bolt',
    titleKey: 'wizard2.feat_native',
    descKey: 'wizard2.feat_native_desc',
    color: '#FBBF24',
  },
];

// ── Props ────────────────────────────────────────────────────────────────────

type Props = {
  visible: boolean;
  onComplete: () => void;
};

// ── Main Component ───────────────────────────────────────────────────────────

export function WelcomeWizard({ visible, onComplete }: Props) {
  const { t } = useTranslation();
  const [step, setStep] = useState<WizardStep>('welcome');
  const [selectedClis, setSelectedClis] = useState<Set<AuthToolId>>(new Set());
  const [configuredClis, setConfiguredClis] = useState<Set<AuthToolId>>(new Set());
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [installProgress, setInstallProgress] = useState<Record<string, 'pending' | 'installing' | 'done' | 'error'>>({});
  const [installError, setInstallError] = useState<string | null>(null);

  React.useEffect(() => {
    logLifecycle('WelcomeWizard', 'mounted');
  }, []);

  React.useEffect(() => {
    logInfo('WelcomeWizard', 'Step: ' + step);
  }, [step]);

  // ── Handlers ─────────────────────────────────────────────────────────────

  const toggleCli = useCallback((id: AuthToolId) => {
    setSelectedClis((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      logInfo('WelcomeWizard', 'Selected CLIs: ' + Array.from(next).join(', '));
      return next;
    });
  }, []);

  const handleFinish = useCallback(async () => {
    logInfo('WelcomeWizard', 'Wizard complete');
    await AsyncStorage.setItem(WIZARD_KEY, 'true');
    onComplete();
  }, [onComplete]);

  const handleCliSelectNext = useCallback(() => {
    logInfo('WelcomeWizard', 'CLI select next, count=' + selectedClis.size);
    if (selectedClis.size === 0) {
      setStep('done');
    } else {
      // Go to install step first
      setStep('cli-install');
      setInstallError(null);
      const initial: Record<string, 'pending' | 'installing' | 'done' | 'error'> = {};
      selectedClis.forEach((id) => { initial[id] = 'pending'; });
      setInstallProgress(initial);
      // Start installation
      installSelectedClis(Array.from(selectedClis));
    }
  }, [selectedClis]);

  const installSelectedClis = useCallback(async (cliIds: AuthToolId[]) => {
    for (const id of cliIds) {
      const info = CLI_INSTALL_MAP[id];
      if (!info) continue;
      setInstallProgress((prev) => ({ ...prev, [id]: 'installing' }));
      logInfo('WelcomeWizard', 'Installing ' + id + ' via npm install -g ' + info.npm);
      try {
        // Check if already installed
        const check = await execCommand(`which ${info.bin} 2>/dev/null`);
        if (check.exitCode === 0 && check.stdout.trim()) {
          logInfo('WelcomeWizard', id + ' already installed: ' + check.stdout.trim());
          setInstallProgress((prev) => ({ ...prev, [id]: 'done' }));
          continue;
        }
        // Install via npm
        const result = await execCommand(`npm install -g ${info.npm} 2>&1`, 300000);
        if (result.exitCode === 0) {
          logInfo('WelcomeWizard', id + ' installed successfully');
          setInstallProgress((prev) => ({ ...prev, [id]: 'done' }));
        } else {
          logError('WelcomeWizard', id + ' install failed: ' + result.stderr);
          setInstallProgress((prev) => ({ ...prev, [id]: 'error' }));
          setInstallError(result.stderr || 'Install failed');
        }
      } catch (e: any) {
        logError('WelcomeWizard', id + ' install exception', e);
        setInstallProgress((prev) => ({ ...prev, [id]: 'error' }));
        setInstallError(e.message || 'Install failed');
      }
    }
    // All done — proceed to auth
    logInfo('WelcomeWizard', 'All installations complete, moving to auth');
    setStep('cli-auth');
    setShowAuthModal(true);
  }, []);

  const handleAuthComplete = useCallback(() => {
    setShowAuthModal(false);
    // Mark all selected as "configured" (user went through the flow)
    setConfiguredClis(new Set(selectedClis));
    setStep('done');
  }, [selectedClis]);

  // ── Step indicator ───────────────────────────────────────────────────────

  const stepIndex = step === 'welcome' ? 0 : step === 'cli-select' ? 1 : step === 'cli-install' ? 2 : step === 'cli-auth' ? 3 : 4;
  const totalSteps = selectedClis.size > 0 ? 5 : 3;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <ScrollView
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.scrollContent}
          >
            {/* Step dots */}
            <View style={styles.dotsRow}>
              {Array.from({ length: totalSteps }).map((_, i) => (
                <View
                  key={i}
                  style={[
                    styles.dot,
                    i === stepIndex && styles.dotActive,
                    i < stepIndex && styles.dotDone,
                  ]}
                />
              ))}
            </View>

            {step === 'welcome' && (
              <WelcomeStep
                t={t}
                onNext={() => setStep('cli-select')}
                onSkip={handleFinish}
              />
            )}

            {step === 'cli-select' && (
              <CliSelectStep
                t={t}
                selectedClis={selectedClis}
                onToggle={toggleCli}
                onNext={handleCliSelectNext}
                onBack={() => setStep('welcome')}
              />
            )}

            {step === 'cli-install' && (
              <Animated.View entering={FadeInRight.duration(300)} style={styles.stepContent}>
                <View style={[styles.iconCircle, { backgroundColor: '#FBBF2420' }]}>
                  <MaterialIcons name="download" size={36} color="#FBBF24" />
                </View>
                <Text style={styles.stepTitle}>{t('wizard2.installing_title') || 'インストール中'}</Text>
                <Text style={styles.stepDesc}>{t('wizard2.installing_desc') || 'AIツールをセットアップしています...'}</Text>

                <View style={{ width: '100%', gap: 12, marginTop: 16 }}>
                  {Array.from(selectedClis).map((id) => {
                    const opt = CLI_OPTIONS.find((o) => o.id === id);
                    const status = installProgress[id] || 'pending';
                    return (
                      <View key={id} style={[styles.cliCard, { borderColor: status === 'error' ? '#F8717140' : '#2A2A2A' }]}>
                        <View style={[styles.cliIcon, { backgroundColor: (opt?.color ?? '#666') + '18' }]}>
                          {status === 'installing' ? (
                            <ActivityIndicator size={20} color={opt?.color ?? ACCENT} />
                          ) : (
                            <MaterialIcons
                              name={status === 'done' ? 'check-circle' : status === 'error' ? 'error' : (opt?.icon as any) ?? 'code'}
                              size={20}
                              color={status === 'done' ? ACCENT : status === 'error' ? '#F87171' : opt?.color ?? '#666'}
                            />
                          )}
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.cliName, { color: opt?.color ?? '#ccc' }]}>{opt?.name ?? id}</Text>
                          <Text style={styles.cliDesc}>
                            {status === 'pending' ? '待機中...'
                              : status === 'installing' ? 'npm install -g ...'
                              : status === 'done' ? 'インストール完了'
                              : 'エラー'}
                          </Text>
                        </View>
                      </View>
                    );
                  })}
                </View>

                {installError && (
                  <Text style={{ color: '#F87171', fontSize: 11, fontFamily: 'monospace', marginTop: 8, textAlign: 'center' }}>
                    {installError}
                  </Text>
                )}
              </Animated.View>
            )}

            {step === 'cli-auth' && (
              <View style={styles.authStepContainer}>
                <Text style={styles.authStepHint}>
                  {t('wizard2.auth_hint')}
                </Text>
              </View>
            )}

            {step === 'done' && (
              <DoneStep
                t={t}
                configuredClis={configuredClis}
                selectedClis={selectedClis}
                onFinish={handleFinish}
              />
            )}
          </ScrollView>
        </View>
      </View>

      {/* AuthWizard modal (reuse existing component) */}
      <AuthWizard
        visible={showAuthModal}
        onComplete={handleAuthComplete}
        toolFilter={Array.from(selectedClis)}
        title={t('wizard2.auth_title')}
      />
    </Modal>
  );
}

// ── Step 1: Welcome ──────────────────────────────────────────────────────────

function WelcomeStep({
  t,
  onNext,
  onSkip,
}: {
  t: (k: string) => string;
  onNext: () => void;
  onSkip: () => void;
}) {
  return (
    <Animated.View entering={FadeInDown.duration(400)} style={styles.stepContent}>
      <View style={[styles.iconCircle, { backgroundColor: ACCENT + '20' }]}>
        <MaterialIcons name="terminal" size={38} color={ACCENT} />
      </View>

      <Text style={[styles.title, { color: ACCENT }]}>
        {t('wizard2.welcome_title')}
      </Text>
      <Text style={styles.subtitle}>
        {t('wizard2.welcome_subtitle')}
      </Text>

      {/* Feature cards */}
      <View style={styles.featureList}>
        {FEATURES.map((feat, i) => (
          <Animated.View
            key={feat.titleKey}
            entering={FadeInRight.delay(200 + i * 100).duration(300)}
            style={styles.featureCard}
          >
            <View style={[styles.featureIcon, { backgroundColor: feat.color + '18' }]}>
              <MaterialIcons name={feat.icon as any} size={20} color={feat.color} />
            </View>
            <View style={styles.featureText}>
              <Text style={[styles.featureName, { color: feat.color }]}>
                {t(feat.titleKey)}
              </Text>
              <Text style={styles.featureDesc}>
                {t(feat.descKey)}
              </Text>
            </View>
          </Animated.View>
        ))}
      </View>

      {/* Nav */}
      <View style={styles.navRow}>
        <Pressable style={styles.skipBtn} onPress={onSkip}>
          <Text style={styles.skipText}>{t('wizard2.skip_all')}</Text>
        </Pressable>
        <Pressable style={[styles.primaryBtn, { backgroundColor: ACCENT }]} onPress={onNext}>
          <Text style={styles.primaryBtnText}>{t('wizard2.next')}</Text>
          <MaterialIcons name="arrow-forward" size={16} color="#000" />
        </Pressable>
      </View>
    </Animated.View>
  );
}

// ── Step 2: CLI Selection ────────────────────────────────────────────────────

function CliSelectStep({
  t,
  selectedClis,
  onToggle,
  onNext,
  onBack,
}: {
  t: (k: string) => string;
  selectedClis: Set<AuthToolId>;
  onToggle: (id: AuthToolId) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  return (
    <Animated.View entering={FadeInDown.duration(400)} style={styles.stepContent}>
      <View style={[styles.iconCircle, { backgroundColor: '#8B5CF620' }]}>
        <MaterialIcons name="smart-toy" size={40} color="#8B5CF6" />
      </View>

      <Text style={[styles.title, { color: '#8B5CF6' }]}>
        {t('wizard2.cli_title')}
      </Text>
      <Text style={styles.subtitle}>
        {t('wizard2.cli_subtitle')}
      </Text>

      {/* CLI option cards */}
      <View style={styles.cliList}>
        {CLI_OPTIONS.map((cli) => {
          const selected = selectedClis.has(cli.id);
          return (
            <Pressable
              key={cli.id}
              style={[
                styles.cliCard,
                selected && { borderColor: cli.color + '66', backgroundColor: cli.color + '08' },
              ]}
              onPress={() => onToggle(cli.id)}
            >
              <View style={[styles.cliIcon, { backgroundColor: cli.color + '18' }]}>
                <MaterialIcons name={cli.icon as any} size={22} color={cli.color} />
              </View>
              <View style={styles.cliInfo}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={[styles.cliName, { color: cli.color }]}>{cli.name}</Text>
                  {cli.free && (
                    <View style={styles.freeBadge}>
                      <Text style={styles.freeBadgeText}>FREE</Text>
                    </View>
                  )}
                </View>
                <Text style={styles.cliDesc}>{t(cli.descKey)}</Text>
              </View>
              <View style={[styles.checkbox, selected && { borderColor: cli.color, backgroundColor: cli.color }]}>
                {selected && <MaterialIcons name="check" size={14} color="#000" />}
              </View>
            </Pressable>
          );
        })}
      </View>

      <Text style={styles.hint}>
        {t('wizard2.cli_hint')}
      </Text>

      {/* Nav */}
      <View style={styles.navRow}>
        <Pressable style={styles.backBtn} onPress={onBack}>
          <MaterialIcons name="arrow-back" size={16} color="#6B7280" />
          <Text style={styles.backText}>{t('wizard2.back')}</Text>
        </Pressable>
        <Pressable style={[styles.primaryBtn, { backgroundColor: selectedClis.size > 0 ? '#60A5FA' : '#4B5563' }]} onPress={onNext}>
          <Text style={styles.primaryBtnText}>
            {selectedClis.size > 0 ? t('wizard2.setup_selected') : t('wizard2.skip_setup')}
          </Text>
          <MaterialIcons name="arrow-forward" size={16} color="#000" />
        </Pressable>
      </View>
    </Animated.View>
  );
}

// ── Step 4: Done ─────────────────────────────────────────────────────────────

function DoneStep({
  t,
  configuredClis,
  selectedClis,
  onFinish,
}: {
  t: (k: string) => string;
  configuredClis: Set<AuthToolId>;
  selectedClis: Set<AuthToolId>;
  onFinish: () => void;
}) {
  const configuredNames = CLI_OPTIONS
    .filter((c) => configuredClis.has(c.id))
    .map((c) => c.name);

  return (
    <Animated.View entering={FadeInDown.duration(400)} style={styles.stepContent}>
      <View style={[styles.iconCircle, { backgroundColor: '#4ADE8020' }]}>
        <MaterialIcons name="check-circle" size={48} color="#4ADE80" />
      </View>

      <Text style={[styles.title, { color: '#4ADE80' }]}>
        {t('wizard2.done_title')}
      </Text>

      {configuredNames.length > 0 ? (
        <View style={styles.summaryBox}>
          <Text style={styles.summaryLabel}>{t('wizard2.configured_label')}</Text>
          {configuredNames.map((name) => (
            <View key={name} style={styles.summaryItem}>
              <MaterialIcons name="check" size={14} color="#4ADE80" />
              <Text style={styles.summaryName}>{name}</Text>
            </View>
          ))}
        </View>
      ) : (
        <Text style={styles.subtitle}>
          {t('wizard2.done_no_cli')}
        </Text>
      )}

      <Text style={styles.hint}>
        {t('wizard2.done_hint')}
      </Text>

      <Pressable style={[styles.primaryBtn, { backgroundColor: ACCENT, width: '100%' }]} onPress={onFinish}>
        <Text style={styles.primaryBtnText}>{t('wizard2.get_started')}</Text>
        <MaterialIcons name="rocket-launch" size={16} color="#000" />
      </Pressable>
    </Animated.View>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export async function isWizardComplete(): Promise<boolean> {
  const val = await AsyncStorage.getItem(WIZARD_KEY);
  return val === 'true';
}

export async function resetWizard(): Promise<void> {
  await AsyncStorage.removeItem(WIZARD_KEY);
}

// ── Styles ───────────────────────────────────────────────────────────────────

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
    maxWidth: 440,
    backgroundColor: '#111111',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    maxHeight: '92%',
    overflow: 'hidden',
  },
  scrollContent: {
    paddingHorizontal: 24,
    paddingVertical: 28,
  },
  // ── Dots ──────────────────────────────────────────────────────────
  dotsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
    marginBottom: 24,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#333',
  },
  dotActive: {
    backgroundColor: ACCENT,
    width: 20,
  },
  dotDone: {
    backgroundColor: '#4ADE80',
  },
  // ── Step content ──────────────────────────────────────────────────
  stepContent: {
    alignItems: 'center',
  },
  iconCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    fontFamily: 'monospace',
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    color: '#9CA3AF',
    fontSize: 14,
    fontFamily: 'monospace',
    lineHeight: 22,
    textAlign: 'center',
    marginBottom: 24,
  },
  // ── Features (Welcome) ────────────────────────────────────────────
  featureList: {
    width: '100%',
    gap: 10,
    marginBottom: 24,
  },
  featureCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#1A1A1A',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  featureIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  featureText: {
    flex: 1,
  },
  featureName: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'monospace',
    marginBottom: 2,
  },
  featureDesc: {
    color: '#6B7280',
    fontSize: 11,
    fontFamily: 'monospace',
  },
  // ── CLI Select ────────────────────────────────────────────────────
  cliList: {
    width: '100%',
    gap: 10,
    marginBottom: 12,
  },
  cliCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#1A1A1A',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  cliIcon: {
    width: 42,
    height: 42,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cliInfo: {
    flex: 1,
    gap: 2,
  },
  cliName: {
    fontSize: 14,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  cliDesc: {
    color: '#6B7280',
    fontSize: 11,
    fontFamily: 'monospace',
    lineHeight: 16,
  },
  freeBadge: {
    backgroundColor: '#4ADE8030',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
  },
  freeBadgeText: {
    color: '#4ADE80',
    fontSize: 8,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#4B5563',
    alignItems: 'center',
    justifyContent: 'center',
  },
  hint: {
    color: '#6B7280',
    fontSize: 11,
    fontFamily: 'monospace',
    textAlign: 'center',
    marginBottom: 20,
  },
  // ── Done ──────────────────────────────────────────────────────────
  summaryBox: {
    width: '100%',
    backgroundColor: '#1A1A1A',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    marginBottom: 16,
    gap: 8,
  },
  summaryLabel: {
    color: '#9CA3AF',
    fontSize: 11,
    fontFamily: 'monospace',
    fontWeight: '600',
    marginBottom: 4,
  },
  summaryItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  summaryName: {
    color: '#E5E7EB',
    fontSize: 13,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  // ── Auth step placeholder ─────────────────────────────────────────
  authStepContainer: {
    alignItems: 'center',
    paddingVertical: 20,
  },
  authStepHint: {
    color: '#6B7280',
    fontSize: 12,
    fontFamily: 'monospace',
    textAlign: 'center',
  },
  // ── Nav ────────────────────────────────────────────────────────────
  navRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    gap: 12,
  },
  skipBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#1E1E1E',
    borderWidth: 1,
    borderColor: '#333',
  },
  skipText: {
    color: '#6B7280',
    fontSize: 13,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  backBtn: {
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
  backText: {
    color: '#6B7280',
    fontSize: 13,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 12,
    flex: 1,
  },
  primaryBtnText: {
    color: '#000',
    fontSize: 14,
    fontFamily: 'monospace',
    fontWeight: '800',
  },
});
