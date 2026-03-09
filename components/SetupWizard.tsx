/**
 * SetupWizard.tsx — Termux setup wizard (post-onboarding)
 *
 * 4-step guided setup:
 * 1. Prepare Termux (install check)
 * 2. Install the bridge (copy command → paste in Termux)
 * 3. Start & connect (AppState auto-detect + testConnection)
 * 4. All set! (completion)
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  Pressable,
  Modal,
  StyleSheet,
  ScrollView,
  AppState,
  AppStateStatus,
  ActivityIndicator,
  Linking,
} from 'react-native';
import Animated, {
  FadeInDown,
  FadeIn,
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  withSpring,
  Easing,
} from 'react-native-reanimated';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Clipboard from 'expo-clipboard';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTranslation } from '@/lib/i18n';
import { BRIDGE_SERVER_JS } from '@/lib/bridge-bundle';
import { useTerminalStore } from '@/store/terminal-store';

const SETUP_WIZARD_KEY = '@shelly/setup_wizard_complete';

// ── Step configuration ───────────────────────────────────────────────────────

type StepConfig = {
  icon: string;
  color: string;
};

const STEPS: StepConfig[] = [
  { icon: 'terminal',      color: '#00D4AA' },
  { icon: 'cable',         color: '#FBBF24' },
  { icon: 'wifi',          color: '#60A5FA' },
  { icon: 'smart-toy',     color: '#8B5CF6' },
  { icon: 'check-circle',  color: '#4ADE80' },
];

// ── Install command ──────────────────────────────────────────────────────────

function buildInstallCommand(): string {
  // Single command: install nodejs-lts + create bridge directory + write server.js
  const serverContent = BRIDGE_SERVER_JS;

  if (serverContent.length < 200) {
    return `pkg install -y nodejs-lts && mkdir -p ~/shelly-bridge && echo "nodejs installed & bridge directory ready"`;
  }

  // Full embedded: write server.js via heredoc
  return `pkg install -y nodejs-lts && mkdir -p ~/shelly-bridge && cat << 'SHELLY_EOF' > ~/shelly-bridge/server.js\n${serverContent}\nSHELLY_EOF`;
}

/**
 * 1コマンドでインストール+起動まで完了する。
 * コピペ1回で済むので5分以内にセットアップ完了できる。
 */
function buildOneStepCommand(): string {
  const serverContent = BRIDGE_SERVER_JS;

  if (serverContent.length < 200) {
    return `pkg install -y nodejs-lts && mkdir -p ~/shelly-bridge && echo "bridge ready" && node ~/shelly-bridge/server.js`;
  }

  return `pkg install -y nodejs-lts && mkdir -p ~/shelly-bridge && cat << 'SHELLY_EOF' > ~/shelly-bridge/server.js\n${serverContent}\nSHELLY_EOF\nnode ~/shelly-bridge/server.js`;
}

const START_COMMAND = 'node ~/shelly-bridge/server.js';

// ── Standalone testConnection (no hook needed) ───────────────────────────────

function testConnectionStandalone(): Promise<boolean> {
  return new Promise((resolve) => {
    const { wsUrl, timeoutSeconds } = useTerminalStore.getState().termuxSettings;
    let resolved = false;
    const done = (result: boolean) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { testWs.close(); } catch (_) {}
      resolve(result);
    };

    let testWs: WebSocket;
    try {
      testWs = new WebSocket(wsUrl);
    } catch {
      resolve(false);
      return;
    }

    const timer = setTimeout(() => done(false), Math.min(timeoutSeconds * 1000, 5000));

    testWs.onopen = () => {
      testWs.send(JSON.stringify({ type: 'ping' }));
    };

    testWs.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type === 'pong' || msg.type === 'ready') {
          done(true);
        }
      } catch (_) {}
    };

    testWs.onerror = () => done(false);
    testWs.onclose = () => done(false);
  });
}

// ── Props ────────────────────────────────────────────────────────────────────

type Props = {
  visible: boolean;
  onComplete: () => void;
};

// ── Main Component ───────────────────────────────────────────────────────────

export function SetupWizard({ visible, onComplete }: Props) {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const [quickMode, setQuickMode] = useState(false);
  const [showModeSelect, setShowModeSelect] = useState(true);
  const [copied, setCopied] = useState(false);
  const [copiedStart, setCopiedStart] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'checking' | 'success' | 'fail'>('idle');
  const appStateRef = useRef<AppStateStatus>('active');
  const current = STEPS[step];

  // Pulse animation for icon
  const iconScale = useSharedValue(1);
  const checkScale = useSharedValue(0);

  useEffect(() => {
    if (!visible) return;
    // Pulse the icon
    iconScale.value = withRepeat(
      withSequence(
        withTiming(1.1, { duration: 600, easing: Easing.inOut(Easing.ease) }),
        withTiming(1.0, { duration: 600, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
      false,
    );
    return () => {
      iconScale.value = 1;
    };
  }, [visible, step]);

  // Shimmer animation for active progress segment
  const shimmer = useSharedValue(0.4);
  useEffect(() => {
    if (!visible) return;
    shimmer.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.ease) }),
        withTiming(0.4, { duration: 1200, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
      false,
    );
    return () => { shimmer.value = 0.4; };
  }, [visible, step]);

  const shimmerStyle = useAnimatedStyle(() => ({
    opacity: shimmer.value,
  }));

  // Waiting dots animation for hint text
  const dotOpacity = useSharedValue(0);
  useEffect(() => {
    if (!visible) return;
    dotOpacity.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 800, easing: Easing.inOut(Easing.ease) }),
        withTiming(0.2, { duration: 800, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
      false,
    );
    return () => { dotOpacity.value = 0; };
  }, [visible]);

  const waitingDotStyle = useAnimatedStyle(() => ({
    opacity: dotOpacity.value,
  }));

  const iconAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: iconScale.value }],
  }));

  const checkAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: checkScale.value }],
    opacity: checkScale.value,
  }));

  // ── Connection test ──────────────────────────────────────────────────────

  const runConnectionTest = useCallback(async () => {
    setConnectionStatus('checking');
    const ok = await testConnectionStandalone();
    if (ok) {
      setConnectionStatus('success');
      // Enable termux mode
      useTerminalStore.getState().setConnectionMode('termux');
      // Bounce-in check animation
      checkScale.value = withSpring(1, { damping: 8, stiffness: 150 });
      // Auto-advance after delay
      setTimeout(() => {
        setStep(3);
        setConnectionStatus('idle');
      }, 1200);
    } else {
      setConnectionStatus('fail');
    }
  }, []);

  // AppState listener for Step 3 auto-check
  useEffect(() => {
    if (step !== 2 || !visible) return;

    // Auto-check immediately when entering this step (bridge may already be running)
    const initialCheck = setTimeout(() => runConnectionTest(), 500);

    const subscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      const prev = appStateRef.current;
      appStateRef.current = nextState;

      if (nextState === 'active' && prev !== 'active') {
        runConnectionTest();
      }
    });

    return () => {
      clearTimeout(initialCheck);
      subscription.remove();
    };
  }, [step, visible, runConnectionTest]);

  // ── Copy to clipboard ────────────────────────────────────────────────────

  const handleCopyInstall = useCallback(async () => {
    // quickMode: 1コマンドでインストール+起動まで完了
    await Clipboard.setStringAsync(quickMode ? buildOneStepCommand() : buildInstallCommand());
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  }, [quickMode]);

  const handleCopyStart = useCallback(async () => {
    await Clipboard.setStringAsync(START_COMMAND);
    setCopiedStart(true);
    setTimeout(() => setCopiedStart(false), 3000);
  }, []);

  // ── Open Termux ──────────────────────────────────────────────────────────

  const openTermux = useCallback(async () => {
    try {
      await Linking.openURL('com.termux://');
    } catch {
      // Termux custom scheme not available — try Play Store
      try {
        await Linking.openURL('market://details?id=com.termux');
      } catch {
        // Play Store app not available — use web link
        Linking.openURL('https://play.google.com/store/apps/details?id=com.termux').catch(() => {});
      }
    }
  }, []);

  // ── Navigation ───────────────────────────────────────────────────────────

  const handleDone = useCallback(async () => {
    await AsyncStorage.setItem(SETUP_WIZARD_KEY, 'true');
    onComplete();
  }, [onComplete]);

  const handleNext = useCallback(() => {
    if (step < STEPS.length - 1) {
      setCopied(false);
      setCopiedStart(false);
      setConnectionStatus('idle');
      // quickModeの場合、Step4（AIツール選択）をスキップ
      if (quickMode && step === 2) {
        setStep(4); // 直接Step5（完了）へ
      } else {
        setStep((s) => s + 1);
      }
    } else {
      handleDone();
    }
  }, [step, handleDone, quickMode]);

  const handleBack = useCallback(() => {
    if (step > 0) {
      setCopied(false);
      setCopiedStart(false);
      setConnectionStatus('idle');
      setStep((s) => s - 1);
    }
  }, [step]);

  // ── Quick start (skip to minimal setup) ─────────────────────────────────

  const handleQuickStart = useCallback(async () => {
    // おすすめ構成: Gemini CLIをデフォルトに設定して即完了
    useTerminalStore.getState().updateSettings({ defaultAgent: 'gemini-cli' });
    // Step 1（Termux確認）へジャンプ、AIツール選択はスキップ
    setStep(0);
    setQuickMode(true);
  }, []);

  const renderModeSelect = () => (
    <Animated.View entering={FadeInDown.duration(400)} key="mode-select">
      <Text style={styles.description}>
        {'Shellyのセットアップを始めましょう。\nどちらのモードで進めますか？'}
      </Text>

      <Pressable
        style={[styles.actionBtn, { backgroundColor: '#00D4AA', marginBottom: 12 }]}
        onPress={() => {
          handleQuickStart();
          setShowModeSelect(false);
        }}
      >
        <MaterialIcons name="rocket-launch" size={18} color="#000" />
        <Text style={styles.actionBtnText}>おすすめ構成で始める</Text>
      </Pressable>
      <Text style={[styles.hint, { marginBottom: 16 }]}>
        {'Gemini CLI（無料）で最速セットアップ。\n後から設定で変更できます。'}
      </Text>

      <Pressable
        style={styles.secondaryBtn}
        onPress={() => {
          setShowModeSelect(false);
          setQuickMode(false);
        }}
      >
        <MaterialIcons name="tune" size={16} color="#9CA3AF" />
        <Text style={styles.secondaryBtnText}>カスタム構成</Text>
      </Pressable>
      <Text style={styles.hint}>
        {'AIツール選択・詳細設定を自分で選びたい方向け'}
      </Text>
    </Animated.View>
  );

  // ── Step content renderers ───────────────────────────────────────────────

  const renderStep1 = () => (
    <Animated.View entering={FadeInDown.duration(400)} key="step1">
      <Text style={styles.description}>{t('setup.step1_desc')}</Text>

      <Pressable
        style={[styles.actionBtn, { backgroundColor: '#00D4AA' }]}
        onPress={() => Linking.openURL('https://play.google.com/store/apps/details?id=com.termux')}
      >
        <MaterialIcons name="shop" size={18} color="#000" />
        <Text style={styles.actionBtnText}>{t('setup.step1_get_playstore')}</Text>
      </Pressable>

      <Pressable
        style={styles.linkBtn}
        onPress={() => Linking.openURL('https://f-droid.org/packages/com.termux/')}
      >
        <Text style={styles.linkBtnText}>{t('setup.step1_get_fdroid')}</Text>
      </Pressable>
    </Animated.View>
  );

  const renderStep2 = () => (
    <Animated.View entering={FadeInDown.duration(400)} key="step2">
      <Text style={styles.description}>
        {quickMode
          ? 'コマンドをコピーしてTermuxに貼り付けるだけ。\nインストールからブリッジ起動まで自動で完了します。'
          : t('setup.step2_desc')}
      </Text>

      {/* Command preview */}
      <View style={styles.codeBlock}>
        <Text style={styles.codeText} numberOfLines={3}>
          {quickMode
            ? 'pkg install ... && node ~/shelly-bridge/server.js'
            : 'pkg install -y nodejs-lts && mkdir -p ~/shelly-bridge ...'}
        </Text>
      </View>

      {/* Copy button */}
      <Pressable
        style={[styles.actionBtn, { backgroundColor: copied ? '#4ADE80' : '#FBBF24' }]}
        onPress={handleCopyInstall}
      >
        <MaterialIcons name={copied ? 'check' : 'content-copy'} size={18} color="#000" />
        <Text style={styles.actionBtnText}>
          {copied ? t('setup.step2_copied') : t('setup.step2_copy')}
        </Text>
      </Pressable>

      {/* Open Termux */}
      <Pressable style={styles.secondaryBtn} onPress={openTermux}>
        <MaterialIcons name="launch" size={16} color="#9CA3AF" />
        <Text style={styles.secondaryBtnText}>{t('setup.step2_open_termux')}</Text>
      </Pressable>

      <Text style={styles.hint}>
        {quickMode
          ? 'Termuxに貼り付けて実行 → Shellyに戻ると自動接続します'
          : t('setup.step2_paste_hint')}
      </Text>
    </Animated.View>
  );

  const renderStep3 = () => (
    <Animated.View entering={FadeInDown.duration(400)} key="step3">
      <Text style={styles.description}>
        {quickMode
          ? 'Termuxでコマンド実行後、Shellyに戻ると自動で接続を確認します。'
          : t('setup.step3_desc')}
      </Text>

      {/* Start command (hide in quickMode — already included in one-step) */}
      {!quickMode && (
        <>
          <View style={styles.codeBlock}>
            <Text style={styles.codeText}>{START_COMMAND}</Text>
          </View>

          <Pressable
            style={[styles.actionBtn, { backgroundColor: copiedStart ? '#4ADE80' : '#60A5FA' }]}
            onPress={handleCopyStart}
          >
            <MaterialIcons name={copiedStart ? 'check' : 'content-copy'} size={18} color="#000" />
            <Text style={styles.actionBtnText}>
              {copiedStart ? t('setup.step2_copied') : t('setup.step3_copy_start')}
            </Text>
          </Pressable>

          <Pressable style={styles.secondaryBtn} onPress={openTermux}>
            <MaterialIcons name="launch" size={16} color="#9CA3AF" />
            <Text style={styles.secondaryBtnText}>{t('setup.step3_open_termux')}</Text>
          </Pressable>
        </>
      )}

      {/* Manual retry button for quickMode */}
      {quickMode && connectionStatus !== 'checking' && connectionStatus !== 'success' && (
        <Pressable
          style={[styles.actionBtn, { backgroundColor: '#60A5FA' }]}
          onPress={runConnectionTest}
        >
          <MaterialIcons name="wifi-find" size={18} color="#000" />
          <Text style={styles.actionBtnText}>接続を確認</Text>
        </Pressable>
      )}

      {/* Connection status */}
      <View style={styles.statusContainer}>
        {connectionStatus === 'idle' && (
          <Text style={styles.hint}>{t('setup.step3_auto_check')}</Text>
        )}
        {connectionStatus === 'checking' && (
          <Animated.View entering={FadeIn.duration(200)} style={styles.statusRow}>
            <ActivityIndicator size="small" color="#60A5FA" />
            <Text style={[styles.statusText, { color: '#60A5FA' }]}>
              {t('setup.step3_checking')}
            </Text>
          </Animated.View>
        )}
        {connectionStatus === 'success' && (
          <Animated.View entering={FadeIn.duration(200)} style={styles.statusRow}>
            <Animated.View style={checkAnimStyle}>
              <MaterialIcons name="check-circle" size={24} color="#4ADE80" />
            </Animated.View>
            <Text style={[styles.statusText, { color: '#4ADE80' }]}>
              {t('setup.step3_success')}
            </Text>
          </Animated.View>
        )}
        {connectionStatus === 'fail' && (
          <Animated.View entering={FadeIn.duration(200)}>
            <View style={styles.statusRow}>
              <MaterialIcons name="error" size={24} color="#F87171" />
              <Text style={[styles.statusText, { color: '#F87171' }]}>
                {t('setup.step3_fail')}
              </Text>
            </View>
            <Text style={styles.hintError}>{t('setup.step3_hint_not_running')}</Text>
            <Pressable
              style={[styles.secondaryBtn, { borderColor: '#F87171' }]}
              onPress={runConnectionTest}
            >
              <MaterialIcons name="refresh" size={16} color="#F87171" />
              <Text style={[styles.secondaryBtnText, { color: '#F87171' }]}>
                {t('setup.step3_retry')}
              </Text>
            </Pressable>
          </Animated.View>
        )}
      </View>
    </Animated.View>
  );

  // ── AI Tool Selection (Step 4) ──────────────────────────────────────────

  const AI_TOOLS = [
    { id: 'gemini-cli' as const, label: 'Gemini CLI', desc: 'Google AI. \u7121\u6599\u679A\u3042\u308A\u3001\u521D\u5FC3\u8005\u5411\u3051', color: '#60A5FA', icon: 'auto-awesome' as const },
    { id: 'claude-code' as const, label: 'Claude Code', desc: '\u6700\u3082\u8ce2\u3044AI\u30B3\u30FC\u30C9\u30A8\u30FC\u30B8\u30A7\u30F3\u30C8', color: '#00D4AA', icon: 'code' as const },
    { id: 'codex' as const, label: 'Codex CLI', desc: '\u8EFD\u91CF\u30FB\u9AD8\u901F\u306A\u30B3\u30FC\u30C9\u4FEE\u6B63', color: '#FBBF24', icon: 'bolt' as const },
  ] as const;

  const [selectedAgent, setSelectedAgent] = useState<'gemini-cli' | 'claude-code' | 'codex'>(
    useTerminalStore.getState().settings.defaultAgent
  );

  const handleSelectAgent = useCallback((id: 'gemini-cli' | 'claude-code' | 'codex') => {
    setSelectedAgent(id);
    useTerminalStore.getState().updateSettings({ defaultAgent: id });
  }, []);

  const renderStep4 = () => (
    <Animated.View entering={FadeInDown.duration(400)} key="step4">
      <Text style={styles.description}>
        {'\u4F7F\u3044\u305F\u3044AI\u30C4\u30FC\u30EB\u3092\u9078\u3093\u3067\u304F\u3060\u3055\u3044\u3002\u5F8C\u304B\u3089\u8A2D\u5B9A\u3067\u5909\u66F4\u3067\u304D\u307E\u3059\u3002'}
      </Text>

      {AI_TOOLS.map((tool) => (
        <Pressable
          key={tool.id}
          style={[
            styles.aiToolCard,
            selectedAgent === tool.id && { borderColor: tool.color, backgroundColor: tool.color + '12' },
          ]}
          onPress={() => handleSelectAgent(tool.id)}
        >
          <View style={styles.aiToolRow}>
            <MaterialIcons name={tool.icon} size={22} color={selectedAgent === tool.id ? tool.color : '#6B7280'} />
            <View style={styles.aiToolInfo}>
              <Text style={[styles.aiToolLabel, selectedAgent === tool.id && { color: tool.color }]}>{tool.label}</Text>
              <Text style={styles.aiToolDesc}>{tool.desc}</Text>
            </View>
            {selectedAgent === tool.id && (
              <MaterialIcons name="check-circle" size={20} color={tool.color} />
            )}
          </View>
        </Pressable>
      ))}

      <Text style={styles.hint}>
        {'\u203B \u30ED\u30FC\u30AB\u30EBLLM\u3092\u8A2D\u5B9A\u3059\u308B\u3068\u3001AI\u304C\u81EA\u52D5\u3067\u6700\u9069\u306A\u30C4\u30FC\u30EB\u3092\u9078\u3073\u307E\u3059'}
      </Text>
    </Animated.View>
  );

  const renderStep5 = () => (
    <Animated.View entering={FadeInDown.duration(400)} key="step5">
      <Text style={styles.description}>{t('setup.step5_desc')}</Text>

      <Text style={styles.tryLabel}>{t('setup.step4_try_commands')}</Text>
      <View style={styles.codeBlock}>
        <Text style={styles.codeText}>ls{'\n'}pwd{'\n'}whoami</Text>
      </View>

      <Text style={styles.tryLabel}>{t('setup.step4_try_ai')}</Text>
      <View style={styles.codeBlock}>
        <Text style={styles.codeText}>@local {'\u3053\u3093\u306B\u3061\u306F'}</Text>
      </View>
    </Animated.View>
  );

  const renderCurrentStep = () => {
    if (showModeSelect) return renderModeSelect();
    switch (step) {
      case 0: return renderStep1();
      case 1: return renderStep2();
      case 2: return renderStep3();
      case 3: return renderStep4();
      case 4: return renderStep5();
      default: return null;
    }
  };

  // ── Skip wizard (Web or advanced users) ──────────────────────────────────
  const handleSkip = useCallback(async () => {
    await AsyncStorage.setItem(SETUP_WIZARD_KEY, 'true').catch(() => {});
    onComplete();
  }, [onComplete]);

  // Can advance? Step 3 requires successful connection (but skip is always available)
  const canAdvance = (): boolean => {
    if (step === 2) return connectionStatus === 'success';
    return true;
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          {/* Progress bar (hide during mode select) */}
          {!showModeSelect && (() => {
            // quickMode: 4 steps (Termux, Install+Start, Connect, Done) — skip AI tool step
            const displaySteps = quickMode
              ? STEPS.filter((_, i) => i !== 3)
              : STEPS;
            const displayIndex = quickMode && step >= 3 ? step - 1 : step;
            return (
              <View style={styles.progressRow}>
                {displaySteps.map((s, i) => (
                  i === displayIndex ? (
                    <Animated.View
                      key={i}
                      style={[
                        styles.progressSegment,
                        { backgroundColor: current.color, flex: 1 },
                        shimmerStyle,
                      ]}
                    />
                  ) : (
                    <View
                      key={i}
                      style={[
                        styles.progressSegment,
                        {
                          backgroundColor: i < displayIndex ? current.color : '#333',
                          flex: 1,
                        },
                      ]}
                    />
                  )
                ))}
              </View>
            );
          })()}

          {/* Step indicator */}
          {!showModeSelect && (
            <Text style={styles.stepIndicator}>
              {quickMode ? (step >= 3 ? step : step + 1) : step + 1} / {quickMode ? STEPS.length - 1 : STEPS.length}
            </Text>
          )}

          {/* Icon */}
          <Animated.View
            style={[
              styles.iconCircle,
              { backgroundColor: showModeSelect ? '#00D4AA20' : current.color + '20' },
              iconAnimStyle,
            ]}
          >
            <MaterialIcons
              name={showModeSelect ? 'waving-hand' as any : current.icon as any}
              size={48}
              color={showModeSelect ? '#00D4AA' : current.color}
            />
          </Animated.View>

          {/* Title */}
          <Text style={[styles.title, { color: showModeSelect ? '#00D4AA' : current.color }]}>
            {showModeSelect ? 'Shellyへようこそ' : t(`setup.step${step + 1}_title`)}
          </Text>

          {/* Step content */}
          <ScrollView style={styles.contentArea} contentContainerStyle={styles.contentAreaInner} showsVerticalScrollIndicator={false}>
            {renderCurrentStep()}
          </ScrollView>

          {/* Skip link */}
          <Pressable style={{ alignSelf: 'flex-end', paddingHorizontal: 16, paddingBottom: 4 }} onPress={handleSkip}>
            <Text style={{ color: '#6B7280', fontSize: 12 }}>{t('setup.skip') ?? 'スキップ'}</Text>
          </Pressable>

          {/* Navigation (hide during mode select) */}
          {!showModeSelect && <View style={styles.navRow}>
            {step > 0 ? (
              <Pressable style={styles.navBtnSecondary} onPress={handleBack}>
                <MaterialIcons name="arrow-back" size={16} color="#6B7280" />
                <Text style={styles.navBtnTextSecondary}>{t('setup.back')}</Text>
              </Pressable>
            ) : (
              <View style={{ width: 80 }} />
            )}

            <Pressable
              style={[
                styles.navBtnPrimary,
                { backgroundColor: canAdvance() ? current.color : '#333' },
              ]}
              onPress={step === STEPS.length - 1 ? handleDone : handleNext}
              disabled={!canAdvance()}
            >
              <Text style={[styles.navBtnTextPrimary, { color: canAdvance() ? '#000' : '#666' }]}>
                {step === 0
                  ? t('setup.step1_have_it')
                  : step === STEPS.length - 1
                    ? t('setup.step4_start')
                    : t('setup.next')}
              </Text>
              {step < STEPS.length - 1 && step !== 0 && (
                <MaterialIcons
                  name="arrow-forward"
                  size={16}
                  color={canAdvance() ? '#000' : '#666'}
                />
              )}
            </Pressable>
          </View>}
        </View>
      </View>
    </Modal>
  );
}

// ── Utility functions ────────────────────────────────────────────────────────

export async function isSetupWizardComplete(): Promise<boolean> {
  const val = await AsyncStorage.getItem(SETUP_WIZARD_KEY);
  return val === 'true';
}

export async function resetSetupWizard(): Promise<void> {
  await AsyncStorage.removeItem(SETUP_WIZARD_KEY);
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.9)',
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
    alignItems: 'center',
  },
  progressRow: {
    flexDirection: 'row',
    gap: 4,
    width: '100%',
    marginBottom: 12,
  },
  progressSegment: {
    height: 3,
    borderRadius: 2,
  },
  stepIndicator: {
    color: '#555',
    fontSize: 11,
    fontFamily: 'monospace',
    marginBottom: 16,
  },
  iconCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 20,
    fontWeight: '800',
    fontFamily: 'monospace',
    marginBottom: 8,
    textAlign: 'center',
  },
  contentArea: {
    width: '100%',
    maxHeight: 320,
    marginBottom: 20,
  },
  contentAreaInner: {
    flexGrow: 1,
  },
  description: {
    color: '#9CA3AF',
    fontSize: 13,
    fontFamily: 'monospace',
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: 16,
  },
  codeBlock: {
    backgroundColor: '#0D0D0D',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    paddingHorizontal: 14,
    paddingVertical: 10,
    width: '100%',
    marginBottom: 12,
  },
  codeText: {
    color: '#00D4AA',
    fontSize: 12,
    fontFamily: 'monospace',
    lineHeight: 18,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 10,
    width: '100%',
    marginBottom: 10,
  },
  actionBtnText: {
    color: '#000',
    fontSize: 14,
    fontFamily: 'monospace',
    fontWeight: '800',
  },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#333',
    backgroundColor: '#1E1E1E',
    width: '100%',
    marginBottom: 10,
  },
  secondaryBtnText: {
    color: '#9CA3AF',
    fontSize: 13,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  linkBtn: {
    paddingVertical: 8,
    marginBottom: 4,
  },
  linkBtnText: {
    color: '#6B7280',
    fontSize: 12,
    fontFamily: 'monospace',
    textDecorationLine: 'underline',
    textAlign: 'center',
  },
  hint: {
    color: '#6B7280',
    fontSize: 11,
    fontFamily: 'monospace',
    textAlign: 'center',
    lineHeight: 16,
    marginTop: 4,
  },
  hintError: {
    color: '#F87171',
    fontSize: 11,
    fontFamily: 'monospace',
    textAlign: 'center',
    lineHeight: 16,
    marginTop: 4,
    marginBottom: 8,
  },
  statusContainer: {
    marginTop: 8,
    alignItems: 'center',
    minHeight: 60,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusText: {
    fontSize: 14,
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  tryLabel: {
    color: '#9CA3AF',
    fontSize: 12,
    fontFamily: 'monospace',
    marginBottom: 6,
    marginTop: 8,
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
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
    flex: 1,
  },
  navBtnTextPrimary: {
    fontSize: 14,
    fontFamily: 'monospace',
    fontWeight: '800',
  },
  aiToolCard: {
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
    backgroundColor: '#1A1A1A',
  },
  aiToolRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  aiToolInfo: {
    flex: 1,
  },
  aiToolLabel: {
    color: '#E8E8E8',
    fontSize: 14,
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  aiToolDesc: {
    color: '#6B7280',
    fontSize: 11,
    fontFamily: 'monospace',
    marginTop: 2,
  },
});
