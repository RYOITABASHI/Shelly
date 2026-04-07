import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  Switch,
  StatusBar,
  Share,
  Alert,
  TextInput,
  ActivityIndicator,
  Linking,
  Modal,
} from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTerminalStore } from '@/store/terminal-store';
import { useTermuxBridge } from '@/hooks/use-termux-bridge';
import { BRIDGE_SERVER_JS, BRIDGE_SERVER_VERSION } from '@/lib/bridge-bundle';
import { CursorShape, BridgeStatus } from '@/store/types';
import { LlamaCppSection } from '@/components/settings/LlamaCppSection';
import { LlamaCppModel, MODEL_CATALOG, buildStartAllScript, getRecommendedModel } from '@/lib/llamacpp-setup';
import { useTranslation, t } from '@/lib/i18n';
import { useI18n, AVAILABLE_LOCALES } from '@/lib/i18n';
import { useTheme, useThemeStore, getAllThemes } from '@/lib/theme-engine';
import { TERMINAL_THEMES, TERMINAL_THEME_NAMES, getTerminalTheme, type TerminalTheme } from '@/lib/terminal-theme';
import { useDotfilesStore } from '@/lib/dotfiles-sync';
import { SetupWizard } from '@/components/SetupWizard';
import { PackageManager as PackageManagerModal } from '@/components/PackageManager';
import { saveCustomContext, loadCustomContext, DEFAULT_CUSTOM_CONTEXT } from '@/lib/shelly-system-prompt';
import { AuthWizard } from '@/components/AuthWizard';
import { isPro, SPONSOR_URL } from '@/lib/pro';
import { ActionsWizardBubble } from '@/components/chat/ActionsWizardBubble';
import { generateWorkflowFromWizard, commitAndPushWorkflow, detectProjectTypeFromDir } from '@/lib/github-actions';
import { isGitHubConfigured } from '@/lib/github-auth';
import { hasRemoteOrigin } from '@/lib/github-push';
import type { ActionsWizardData } from '@/store/chat-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useUsageStore } from '@/store/usage-store';


const CURSOR_OPTIONS: { value: CursorShape; label: string; preview: string }[] = [
  { value: 'block',     label: 'Block',       preview: '█' },
  { value: 'underline', label: 'Underline', preview: '_' },
  { value: 'bar',       label: 'Bar',           preview: '|' },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {subtitle && <Text style={styles.sectionSubtitle}>{subtitle}</Text>}
    </View>
  );
}

function UsageAlertToggle() {
  const alertEnabled = useUsageStore((s) => s.alertEnabled);
  return (
    <View style={styles.settingRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.settingLabelText}>Enable usage alerts</Text>
        <Text style={styles.sectionSubtitle}>Notify when daily cost exceeds limit</Text>
      </View>
      <Switch
        value={alertEnabled}
        onValueChange={(v) => useUsageStore.getState().setAlertSettings({ alertEnabled: v })}
        trackColor={{ false: '#333', true: '#00D4AA44' }}
        thumbColor={alertEnabled ? '#00D4AA' : '#666'}
      />
    </View>
  );
}

/** Wraps Pro-only sections: grayed out with lock icon when Free */
function ProGate({ children }: { children: React.ReactNode }) {
  const pro = isPro();
  return (
    <View style={{ opacity: pro ? 1 : 0.35 }} pointerEvents={pro ? 'auto' : 'none'}>
      {!pro && (
        <Pressable
          style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 10,
            justifyContent: 'center', alignItems: 'center',
          }}
          pointerEvents="box-only"
          onPress={() => Alert.alert('Pro Feature', `Sponsor Shelly on GitHub to unlock.\n${SPONSOR_URL}`)}
        />
      )}
      {children}
    </View>
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.settingRow}>
      <View style={styles.settingLabel}>
        <Text style={styles.settingLabelText}>{label}</Text>
        {description && <Text style={styles.settingDesc}>{description}</Text>}
      </View>
      <View style={styles.settingControl}>{children}</View>
    </View>
  );
}

function BridgeStatusBadge({ status }: { status: BridgeStatus }) {
  const config: Record<BridgeStatus, { labelKey: string; color: string; bg: string }> = {
    idle:         { labelKey: 'settings.not_connected',       color: '#4B5563', bg: '#4B556320' },
    connecting:   { labelKey: 'settings.status_connecting',   color: '#FBBF24', bg: '#FBBF2420' },
    connected:    { labelKey: 'settings.status_connected',    color: '#4ADE80', bg: '#4ADE8020' },
    disconnected: { labelKey: 'settings.status_disconnected', color: '#6B7280', bg: '#6B728020' },
    error:        { labelKey: 'settings.error_label',         color: '#F87171', bg: '#F8717120' },
  };
  const c = config[status];
  return (
    <View style={[statusBadgeStyles.badge, { backgroundColor: c.bg }]}>
      {status === 'connecting' && (
        <ActivityIndicator size="small" color={c.color} style={{ transform: [{ scale: 0.6 }], marginRight: 2 }} />
      )}
      <Text style={[statusBadgeStyles.text, { color: c.color }]}>{t(c.labelKey)}</Text>
    </View>
  );
}

const statusBadgeStyles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 5,
  },
  text: {
    fontSize: 12,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
});

// ─── Error Boundary ──────────────────────────────────────────────────────────

class SettingsErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: string }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: '' };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message };
  }
  render() {
    if (this.state.hasError) {
      return (
        <View style={{ flex: 1, backgroundColor: '#0A0A0A', justifyContent: 'center', alignItems: 'center', padding: 24 }}>
          <Text style={{ color: '#F44336', fontSize: 16, fontWeight: 'bold', marginBottom: 8 }}>Settings Error</Text>
          <Text style={{ color: '#999', fontSize: 12, textAlign: 'center' }}>{this.state.error}</Text>
          <Pressable
            onPress={() => this.setState({ hasError: false, error: '' })}
            style={{ marginTop: 16, backgroundColor: '#222', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 }}
          >
            <Text style={{ color: '#00D4AA' }}>Retry</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

// ─── Main screen ──────────────────────────────────────────────────────────────

function SettingsScreenInner() {
  const {
    settings, updateSettings,
    sessions, clearSession,
    termuxSettings, updateTermuxSettings,
    bridgeStatus, connectionMode, setConnectionMode,
  } = useTerminalStore();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();

  // Theme engine
  const _currentTheme = useTheme();
  const { currentThemeId, setTheme: setEngineTheme } = useThemeStore();
  const allThemes = getAllThemes();

  // Language
  const { locale, setLocale } = useI18n();

  // Dotfiles sync
  const dotfiles = useDotfilesStore();
  React.useEffect(() => { dotfiles.loadConfig(); }, []);
  const [patInput, setPatInput] = useState('');
  const [showPkgManager, setShowPkgManager] = useState(false);
  const { testConnection, writeFile, runCommand, runRawCommand } = useTermuxBridge();

  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'fail' | null>(null);
  const [wsUrlInput, setWsUrlInput] = useState(termuxSettings.wsUrl);
  const [isUpdatingBridge, setIsUpdatingBridge] = useState(false);
  const [bridgeUpdateResult, setBridgeUpdateResult] = useState<'success' | 'fail' | null>(null);
  const [isGeneratingScript, setIsGeneratingScript] = useState(false);
  const [showSetupWizard, setShowSetupWizard] = useState(false);
  const [showAuthWizard, setShowAuthWizard] = useState(false);
  const [showAllThemes, setShowAllThemes] = useState(false);
  const [showAutoCheckWizard, setShowAutoCheckWizard] = useState(false);
  const [wizardData, setWizardData] = useState<ActionsWizardData>({
    step: 'what', actions: ['build', 'test'], trigger: null, projectType: 'unknown',
  });
  const [wizardStatus, setWizardStatus] = useState<'idle' | 'working' | 'done' | 'error'>('idle');
  const [wizardError, setWizardError] = useState('');

  // Local LLM state
  const [llmUrlInput, setLlmUrlInput] = useState(settings.localLlmUrl);
  const [llmModelInput, setLlmModelInput] = useState(settings.localLlmModel);
  const [isTestingLlm, setIsTestingLlm] = useState(false);
  const [llmTestResult, setLlmTestResult] = useState<'success' | 'fail' | null>(null);

  // llama.cpp model management state — resolve catalog ID from stored filename
  const [activeModelId, setActiveModelId] = useState<string | null>(() => {
    const stored = settings.localLlmModel;
    if (!stored) return null;
    const match = MODEL_CATALOG.find((m) => m.filename.replace('.gguf', '') === stored || m.id === stored);
    return match?.id ?? null;
  });
  const [installedModelIds, _setInstalledModelIds] = useState<Set<string>>(new Set());

  // Custom context for LLM system prompt
  const [customContextText, setCustomContextText] = useState('');
  const [customContextSaved, setCustomContextSaved] = useState(false);
  React.useEffect(() => {
    loadCustomContext().then((text) => setCustomContextText(text || DEFAULT_CUSTOM_CONTEXT));
  }, []);
  const handleSaveCustomContext = useCallback(async () => {
    await saveCustomContext(customContextText);
    setCustomContextSaved(true);
    setTimeout(() => setCustomContextSaved(false), 2000);
  }, [customContextText]);

  // Auto-approve level for CLI permission proxy
  const autoApproveLevel = settings.autoApproveLevel ?? 'safe';

  // Diagnostics
  const [diagResults, setDiagResults] = useState<{
    bridge: 'checking' | 'ok' | 'fail' | null;
    latency: number | null;
    claudeCli: 'checking' | 'ok' | 'fail' | null;
    geminiCli: 'checking' | 'ok' | 'fail' | null;
    codexCli: 'checking' | 'ok' | 'fail' | null;
    ollama: 'checking' | 'ok' | 'fail' | null;
    storage: 'checking' | 'ok' | 'fail' | null;
  }>({ bridge: null, latency: null, claudeCli: null, geminiCli: null, codexCli: null, ollama: null, storage: null });
  const [isDiagRunning, setIsDiagRunning] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const runDiagnostics = useCallback(async () => {
    setIsDiagRunning(true);
    setDiagResults({ bridge: 'checking', latency: null, claudeCli: 'checking', geminiCli: 'checking', codexCli: 'checking', ollama: 'checking', storage: 'checking' });

    // 1. Bridge connection + latency
    const t0 = Date.now();
    const bridgeOk = await testConnection().catch(() => false);
    const latencyMs = Date.now() - t0;
    setDiagResults(prev => ({ ...prev, bridge: bridgeOk ? 'ok' : 'fail', latency: bridgeOk ? latencyMs : null }));

    // If bridge not connected, mark CLI checks as fail
    if (!bridgeOk) {
      setDiagResults(prev => ({ ...prev, claudeCli: 'fail', geminiCli: 'fail', codexCli: 'fail', storage: 'fail' }));
      // Still check ollama directly
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3000);
        const res = await fetch(`${settings.localLlmUrl}/api/tags`, { signal: ctrl.signal }).catch(() => null);
        clearTimeout(timer);
        setDiagResults(prev => ({ ...prev, ollama: res?.ok ? 'ok' : 'fail' }));
      } catch {
        setDiagResults(prev => ({ ...prev, ollama: 'fail' }));
      }
      setIsDiagRunning(false);
      return;
    }

    // 2. Check CLIs via bridge
    const checkCli = async (cmd: string): Promise<boolean> => {
      try {
        const result = await runRawCommand(`which ${cmd}`, { timeoutMs: 5000 });
        return result.exitCode === 0;
      } catch { return false; }
    };

    const [claude, gemini, codex] = await Promise.all([
      checkCli('claude'),
      checkCli('gemini'),
      checkCli('codex'),
    ]);
    setDiagResults(prev => ({
      ...prev,
      claudeCli: claude ? 'ok' : 'fail',
      geminiCli: gemini ? 'ok' : 'fail',
      codexCli: codex ? 'ok' : 'fail',
    }));

    // 3. Ollama
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(`${settings.localLlmUrl}/api/tags`, { signal: ctrl.signal }).catch(() => null);
      clearTimeout(timer);
      setDiagResults(prev => ({ ...prev, ollama: res?.ok ? 'ok' : 'fail' }));
    } catch {
      setDiagResults(prev => ({ ...prev, ollama: 'fail' }));
    }

    // 4. Storage
    try {
      const result = await runRawCommand('ls ~/storage/shared 2>/dev/null && echo OK', { timeoutMs: 5000 });
      setDiagResults(prev => ({ ...prev, storage: (result.stdout || '').includes('OK') ? 'ok' : 'fail' }));
    } catch {
      setDiagResults(prev => ({ ...prev, storage: 'fail' }));
    }

    setIsDiagRunning(false);
  }, [testConnection, runRawCommand, settings.localLlmUrl]);

  const copyDiagnostics = useCallback(() => {
    const d = diagResults;
    const statusLabel = (s: typeof d.bridge) => s === 'ok' ? 'OK' : s === 'fail' ? 'FAIL' : s === 'checking' ? '...' : '-';
    const report = [
      '## Shelly Diagnostics',
      `Date: ${new Date().toISOString()}`,
      `Bridge: ${statusLabel(d.bridge)}${d.latency ? ` (${d.latency}ms)` : ''}`,
      `Claude CLI: ${statusLabel(d.claudeCli)}`,
      `Gemini CLI: ${statusLabel(d.geminiCli)}`,
      `Codex CLI: ${statusLabel(d.codexCli)}`,
      `Ollama/llama-server: ${statusLabel(d.ollama)}`,
      `Storage: ${statusLabel(d.storage)}`,
      `Connection Mode: ${connectionMode}`,
      `Bridge URL: ${termuxSettings.wsUrl}`,
      `LLM URL: ${settings.localLlmUrl}`,
    ].join('\n');
    Share.share({ message: report, title: 'Shelly Diagnostics' });
  }, [diagResults, connectionMode, termuxSettings.wsUrl, settings.localLlmUrl]);

  const handleSelectModel = (model: LlamaCppModel) => {
    const modelName = model.filename.replace('.gguf', '');
    setActiveModelId(model.id);
    setLlmModelInput(modelName);
    updateSettings({ localLlmModel: modelName });
  };

  const handleRunCommandForSetup = async (
    command: string,
    _label: string,
  ): Promise<{ success: boolean; output?: string }> => {
    // runRawCommandを使用（'run'メッセージ経由でallowlist制限なし）
    // pkg, cmake, wget等のTermuxネイティブコマンドも実行可能
    const result = await runRawCommand(command, { timeoutMs: 1_200_000 });
    return { success: result.exitCode === 0, output: result.stdout || result.stderr };
  };

  const handleUpdateLocalLlmUrl = (url: string) => {
    setLlmUrlInput(url);
    updateSettings({ localLlmUrl: url });
  };

  const handleFontSizeChange = (delta: number) => {
    const newSize = Math.min(24, Math.max(10, settings.fontSize + delta));
    updateSettings({ fontSize: newSize });
  };

  const handleLineHeightChange = (delta: number) => {
    const newLH = Math.min(2.0, Math.max(1.0, Math.round((settings.lineHeight + delta) * 10) / 10));
    updateSettings({ lineHeight: newLH });
  };

  const handleTimeoutChange = (delta: number) => {
    const newVal = Math.min(120, Math.max(5, termuxSettings.timeoutSeconds + delta));
    updateTermuxSettings({ timeoutSeconds: newVal });
  };

  const handleWsUrlSave = () => {
    const trimmed = wsUrlInput.trim();
    if (!trimmed.startsWith('ws://') && !trimmed.startsWith('wss://')) {
      Alert.alert(t('settings.url_error'), t('settings.url_ws_hint'));
      return;
    }
    updateTermuxSettings({ wsUrl: trimmed });
    Alert.alert(t('settings.saved'), t('settings.ws_url_updated', { url: trimmed }));
  };

  const handleOpenTermux = () => {
    Linking.openURL('com.termux://').catch(() => {
      Linking.openURL('https://play.google.com/store/apps/details?id=com.termux').catch(() => {});
    });
  };

  const handleLlmUrlSave = () => {
    const trimmed = llmUrlInput.trim();
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
      Alert.alert(t('settings.url_error'), t('settings.url_http_hint'));
      return;
    }
    updateSettings({ localLlmUrl: trimmed });
    Alert.alert(t('settings.saved'), t('settings.llm_url_updated', { url: trimmed }));
  };

  const handleLlmModelSave = () => {
    const trimmed = llmModelInput.trim();
    if (!trimmed) {
      Alert.alert(t('settings.error_label'), t('settings.model_error'));
      return;
    }
    updateSettings({ localLlmModel: trimmed });
    // Sync activeModelId if the name matches a catalog entry
    const match = MODEL_CATALOG.find((m) => m.filename.replace('.gguf', '') === trimmed || m.id === trimmed);
    if (match) setActiveModelId(match.id);
    Alert.alert(t('settings.saved'), t('settings.model_updated', { model: trimmed }));
  };

  const handleOpenAutoCheckWizard = useCallback(async () => {
    // Pre-checks
    const hasToken = await isGitHubConfigured();
    if (!hasToken) {
      Alert.alert(t('wizard.actions_title'), t('wizard.no_pat'));
      return;
    }
    // Detect project type
    let projectType = 'unknown';
    try {
      const sessions = useTerminalStore.getState().sessions;
      const active = sessions[useTerminalStore.getState().activeSessionId ?? ''];
      const cwd = active?.currentDir || '';
      if (cwd) {
        projectType = await detectProjectTypeFromDir(cwd, async (cmd) => {
          const res = await runCommand(cmd);
          return { stdout: res.stdout, exitCode: res.exitCode };
        });
      }
    } catch { /* ignore */ }
    setWizardData({ step: 'what', actions: ['build', 'test'], trigger: null, projectType });
    setWizardStatus('idle');
    setShowAutoCheckWizard(true);
  }, [t, runCommand]);

  const handleWizardComplete = useCallback(async (data: ActionsWizardData) => {
    setWizardStatus('working');
    try {
      const yaml = generateWorkflowFromWizard(data);
      const sessions = useTerminalStore.getState().sessions;
      const active = sessions[useTerminalStore.getState().activeSessionId ?? ''];
      const cwd = active?.currentDir || '';

      const result = await commitAndPushWorkflow({
        projectDir: cwd,
        yaml,
        runCommand: async (cmd) => {
          const res = await runCommand(cmd);
          return { stdout: res.stdout, exitCode: res.exitCode };
        },
      });

      if (result.success) {
        setWizardStatus('done');
        setWizardData({ ...data, step: 'done' });
        await AsyncStorage.setItem('shelly_autocheck_offered', 'true');
      } else {
        setWizardStatus('error');
        setWizardError(result.error || 'Unknown error');
      }
    } catch (err) {
      setWizardStatus('error');
      setWizardError(err instanceof Error ? err.message : String(err));
    }
  }, [runCommand]);

  const handleTestLlm = useCallback(async () => {
    setIsTestingLlm(true);
    setLlmTestResult(null);
    try {
      const url = `${settings.localLlmUrl}/api/tags`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(url, { signal: controller.signal }).catch(() => null);
      clearTimeout(timer);
      if (res != null && res.ok) {
        const data = await res.json().catch(() => null);
        const _models: string[] = (data?.models ?? []).map((m: { name: string }) => m.name);
        setLlmTestResult('success');
        Alert.alert(
          t('settings.llm_success_title'),
          t('settings.llm_success_msg')
        );
      } else {
        setLlmTestResult('fail');
        Alert.alert(
          t('settings.llm_fail_title'),
          t('settings.llm_fail_msg', { url: settings.localLlmUrl })
        );
      }
    } catch {
      setLlmTestResult('fail');
      Alert.alert(t('settings.llm_fail_title'), t('settings.llm_fail_error'));
    } finally {
      setIsTestingLlm(false);
    }
  }, [settings.localLlmUrl]);

  const handleTestConnection = useCallback(async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const ok = await testConnection();
      setTestResult(ok ? 'success' : 'fail');
      if (ok) {
        Alert.alert(t('settings.bridge_success_title'), t('settings.bridge_success_msg'));
      } else {
        Alert.alert(
          t('settings.bridge_fail_title'),
          t('settings.bridge_fail_msg', { url: termuxSettings.wsUrl })
        );
      }
    } finally {
      setIsTesting(false);
    }
  }, [testConnection, termuxSettings.wsUrl]);

  const handleGenerateStartScript = useCallback(async () => {
    // アクティブなモデルを取得（未選択の場合は推奨モデル）
    const modelId = activeModelId;
    const catalog = (await import('@/lib/llamacpp-setup')).MODEL_CATALOG;
    const model = catalog.find((m) => m.id === modelId) ?? getRecommendedModel();
    const script = buildStartAllScript(model);
    const scriptPath = '~/shelly-bridge/start-shelly.sh';

    if (bridgeStatus !== 'connected') {
      // 未接続時はスクリプトをbase64エンコードして共有（ペーストしてEnterだけでファイルを作成）
      const b64 = Buffer.from(script).toString('base64');
      const installCmd = `echo '${b64}' | base64 -d > ~/shelly-bridge/start-shelly.sh && chmod +x ~/shelly-bridge/start-shelly.sh && echo 'OK: ~/shelly-bridge/start-shelly.sh'`;
      await Share.share({
        message: `# Paste this line into Termux and press Enter:\n${installCmd}\n\n# After saving, just run:\n# ~/shelly-bridge/start-shelly.sh`,
        title: 'Shelly Start Command',
      });
      return;
    }

    setIsGeneratingScript(true);
    try {
      const result = await writeFile(scriptPath, script);
      if (result.ok) {
        // chmod +xも実行
        await runRawCommand('chmod +x ~/shelly-bridge/start-shelly.sh', { timeoutMs: 5000 });
        Alert.alert(
          t('settings.script_saved_title'),
          t('settings.script_saved_msg')
        );
      } else {
        Alert.alert(t('settings.save_failed'), result.error ?? t('settings.unexpected_error'));
      }
    } catch {
      Alert.alert(t('settings.error_label'), t('settings.unexpected_error'));
    } finally {
      setIsGeneratingScript(false);
    }
  }, [bridgeStatus, writeFile, runRawCommand, activeModelId]);

  const handleUpdateBridge = useCallback(async () => {
    if (bridgeStatus !== 'connected') {
      Alert.alert(
        t('settings.termux_not_connected'),
        t('settings.termux_not_connected_msg')
      );
      return;
    }
    setIsUpdatingBridge(true);
    setBridgeUpdateResult(null);
    try {
      const result = await writeFile(
        '~/shelly-bridge/server.js',  // server.js側でチルダ展開済み
        BRIDGE_SERVER_JS
      );
      if (result.ok) {
        setBridgeUpdateResult('success');
        Alert.alert(
          t('settings.bridge_updated_title'),
          t('settings.bridge_updated_msg', { version: BRIDGE_SERVER_VERSION })
        );
      } else {
        setBridgeUpdateResult('fail');
        Alert.alert(t('settings.update_failed'), t('settings.update_failed_msg', { error: result.error ?? '' }));
      }
    } catch (_e) {
      setBridgeUpdateResult('fail');
      Alert.alert(t('settings.update_failed'), t('settings.unexpected_error'));
    } finally {
      setIsUpdatingBridge(false);
    }
  }, [bridgeStatus, writeFile]);


  const handleExportLog = useCallback(async () => {
    const allBlocks = sessions.flatMap((s) =>
      s.blocks.map((b) => {
        const ts = new Date(b.timestamp).toLocaleString('en-US');
        const output = b.output.map((l) => l.text).join('\n');
        const mode = b.connectionMode ? ` [${b.connectionMode}]` : '';
        return `[${ts}]${mode} $ ${b.command}\n${output}`;
      })
    );

    if (allBlocks.length === 0) {
      Alert.alert(t('settings.export'), t('settings.export_no_logs'));
      return;
    }

    const logText = [
      '# Shelly Terminal Log',
      `# Export: ${new Date().toLocaleString('en-US')}`,
      '# ─────────────────────────────────',
      '',
      ...allBlocks,
    ].join('\n');

    try {
      await Share.share({ message: logText, title: 'Shelly Terminal Log' });
    } catch {
      Alert.alert(t('settings.error_label'), t('settings.export_log_error'));
    }
  }, [sessions]);

  const handleClearAll = () => {
    Alert.alert(
      t('settings.clear_all_title'),
      t('settings.clear_all_msg'),
      [
        { text: t('settings.clear_cancel'), style: 'cancel' },
        {
          text: t('settings.clear_delete'),
          style: 'destructive',
          onPress: () => sessions.forEach((s) => clearSession(s.id)),
        },
      ]
    );
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor="#111111" />

      <View style={styles.header}>
        <Text style={styles.headerTitle}>Settings</Text>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">

        {/* ── Display ──────────────────────────────────────────────────────── */}
        <SectionHeader title={t('settings.display_title')} />

        <SettingRow label={t('settings.font_size_label')} description={t('settings.font_size_desc', { size: settings.fontSize })}>
          <View style={styles.stepper}>
            <Pressable onPress={() => handleFontSizeChange(-1)} style={styles.stepBtn}>
              <Text style={styles.stepBtnText}>−</Text>
            </Pressable>
            <Text style={styles.stepValue}>{settings.fontSize}</Text>
            <Pressable onPress={() => handleFontSizeChange(1)} style={styles.stepBtn}>
              <Text style={styles.stepBtnText}>+</Text>
            </Pressable>
          </View>
        </SettingRow>

        <SettingRow label={t('settings.line_height_label')} description={t('settings.line_height_desc', { height: settings.lineHeight.toFixed(1) })}>
          <View style={styles.stepper}>
            <Pressable onPress={() => handleLineHeightChange(-0.1)} style={styles.stepBtn}>
              <Text style={styles.stepBtnText}>−</Text>
            </Pressable>
            <Text style={styles.stepValue}>{settings.lineHeight.toFixed(1)}</Text>
            <Pressable onPress={() => handleLineHeightChange(0.1)} style={styles.stepBtn}>
              <Text style={styles.stepBtnText}>+</Text>
            </Pressable>
          </View>
        </SettingRow>

        {/* ── Cursor ───────────────────────────────────────────────────────── */}
        <SectionHeader title={t('settings.cursor_title')} />
        <View style={styles.cursorOptions}>
          {CURSOR_OPTIONS.map((cursor) => (
            <Pressable
              key={cursor.value}
              onPress={() => updateSettings({ cursorShape: cursor.value })}
              style={[
                styles.cursorOption,
                settings.cursorShape === cursor.value && styles.cursorOptionActive,
              ]}
            >
              <Text style={[
                styles.cursorPreview,
                settings.cursorShape === cursor.value && styles.cursorPreviewActive,
              ]}>
                {cursor.preview}
              </Text>
              <Text style={[
                styles.cursorLabel,
                settings.cursorShape === cursor.value && styles.cursorLabelActive,
              ]}>
                {cursor.label}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* ── Terminal Appearance ──────────────────────────────────────────── */}
        <SectionHeader title={t('settings.terminal_appearance')} subtitle={t('settings.terminal_appearance_desc')} />

        {/* Theme preview cards — horizontal scroll */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 10, gap: 10 }}>
          {TERMINAL_THEME_NAMES.map((key) => {
            const theme = TERMINAL_THEMES[key];
            const isActive = (settings.terminalTheme ?? 'shelly') === key;
            return (
              <Pressable
                key={key}
                onPress={() => updateSettings({ terminalTheme: key })}
                style={{
                  width: 110, borderRadius: 10, padding: 8, borderWidth: 2,
                  borderColor: isActive ? '#00D4AA' : '#2D2D2D',
                  backgroundColor: theme.background,
                }}
              >
                {/* Mini terminal preview */}
                <View style={{ gap: 2, marginBottom: 6 }}>
                  <Text style={{ fontFamily: 'monospace', fontSize: 8, color: theme.green }} numberOfLines={1}>$ ls -la</Text>
                  <Text style={{ fontFamily: 'monospace', fontSize: 8, color: theme.blue }} numberOfLines={1}>drwxr-xr-x node_m</Text>
                  <Text style={{ fontFamily: 'monospace', fontSize: 8, color: theme.foreground }} numberOfLines={1}>-rw-r--r-- index.ts</Text>
                </View>
                <Text style={{ fontFamily: 'monospace', fontSize: 10, fontWeight: '700', color: isActive ? '#00D4AA' : theme.foreground, textAlign: 'center' }}>
                  {theme.label}
                </Text>
                {isActive && (
                  <View style={{ position: 'absolute', top: 4, right: 4 }}>
                    <MaterialIcons name="check-circle" size={14} color="#00D4AA" />
                  </View>
                )}
              </Pressable>
            );
          })}
        </ScrollView>

        {/* ── Behavior ─────────────────────────────────────────────────────── */}
        <SectionHeader title={t('settings.behavior_title')} />

        <SettingRow label={t('settings.haptic_label')} description={t('settings.haptic_desc')}>
          <Switch
            value={settings.hapticFeedback}
            onValueChange={(v) => updateSettings({ hapticFeedback: v })}
            trackColor={{ false: '#2D2D2D', true: '#00D4AA50' }}
            thumbColor={settings.hapticFeedback ? '#00D4AA' : '#6B7280'}
          />
        </SettingRow>

        <SettingRow label={t('settings.auto_scroll_label')} description={t('settings.auto_scroll_desc')}>
          <Switch
            value={settings.autoScroll}
            onValueChange={(v) => updateSettings({ autoScroll: v })}
            trackColor={{ false: '#2D2D2D', true: '#00D4AA50' }}
            thumbColor={settings.autoScroll ? '#00D4AA' : '#6B7280'}
          />
        </SettingRow>

        <SettingRow
          label={t('settings.high_contrast_label')}
          description={settings.highContrastOutput
            ? 'stdout #E8E8E8 / stderr #FF7878 — OLED optimized'
            : 'Theme-dependent colors (may be hard to read on dark screens)'}
        >
          <Switch
            value={settings.highContrastOutput ?? true}
            onValueChange={(v) => updateSettings({ highContrastOutput: v })}
            trackColor={{ false: '#2D2D2D', true: '#FBBF2450' }}
            thumbColor={(settings.highContrastOutput ?? true) ? '#FBBF24' : '#6B7280'}
          />
        </SettingRow>

        <SettingRow
          label="GPU Rendering"
          description="OpenGL ES 3.0 hardware acceleration for the terminal"
        >
          <Switch
            value={settings.gpuRendering ?? false}
            onValueChange={(v) => updateSettings({ gpuRendering: v })}
            trackColor={{ false: '#2D2D2D', true: '#00D4AA50' }}
            thumbColor={(settings.gpuRendering ?? false) ? '#00D4AA' : '#6B7280'}
          />
        </SettingRow>

        <SettingRow
          label={t('settings.experience_label')}
          description={
            (settings.experienceMode ?? 'learning') === 'learning'
              ? 'Learning mode: More safety prompts with AI command explanations'
              : 'Fast mode: Minimal prompts, no explanations (for experienced users)'
          }
        >
          <View style={styles.segmentRow}>
            {(['learning', 'fast'] as const).map((mode) => (
              <Pressable key={mode} style={[styles.segmentBtn,
                (settings.experienceMode ?? 'learning') === mode && styles.segmentBtnActive,
              ]} onPress={() => updateSettings({ experienceMode: mode })}>
                <Text style={[styles.segmentBtnText,
                  (settings.experienceMode ?? 'learning') === mode && styles.segmentBtnTextActive,
                ]}>{mode === 'learning' ? 'Learn' : 'Fast'}</Text>
              </Pressable>
            ))}
          </View>
        </SettingRow>

        <SettingRow label={t('settings.llm_interpreter_label')} description={t('settings.llm_interpreter_desc')}>
          <Switch
            value={settings.llmInterpreterEnabled ?? false}
            onValueChange={(v) => updateSettings({ llmInterpreterEnabled: v })}
            trackColor={{ false: '#2D2D2D', true: '#8B5CF650' }}
            thumbColor={(settings.llmInterpreterEnabled ?? false) ? '#8B5CF6' : '#6B7280'}
          />
        </SettingRow>

        <SettingRow label={t('settings.external_keyboard_label')} description={t('settings.external_keyboard_desc')}>
          <Switch
            value={settings.externalKeyboardShortcuts ?? false}
            onValueChange={(v) => updateSettings({ externalKeyboardShortcuts: v })}
            trackColor={{ false: '#2D2D2D', true: '#00D4AA50' }}
            thumbColor={(settings.externalKeyboardShortcuts ?? false) ? '#00D4AA' : '#6B7280'}
          />
        </SettingRow>

        {/* ── Sound & Effects ─────────────────────────────────────────────── */}
        <SectionHeader title={t('settings.sound_title')} />

        <SettingRow label={t('settings.sound_label')} description={t('settings.sound_desc')}>
          <Switch
            value={settings.soundEffects ?? true}
            onValueChange={(v) => updateSettings({ soundEffects: v })}
            trackColor={{ false: '#2D2D2D', true: '#00D4AA50' }}
            thumbColor={(settings.soundEffects ?? true) ? '#00D4AA' : '#6B7280'}
          />
        </SettingRow>

        <SettingRow label={t('settings.volume_label')} description={`${Math.round((settings.soundVolume ?? 0.6) * 100)}%`}>
          <View style={styles.stepper}>
            <Pressable
              onPress={() => updateSettings({ soundVolume: Math.max(0, (settings.soundVolume ?? 0.6) - 0.1) })}
              style={styles.stepBtn}
            >
              <Text style={styles.stepBtnText}>−</Text>
            </Pressable>
            <Text style={styles.stepValue}>{Math.round((settings.soundVolume ?? 0.6) * 100)}%</Text>
            <Pressable
              onPress={() => updateSettings({ soundVolume: Math.min(1, (settings.soundVolume ?? 0.6) + 0.1) })}
              style={styles.stepBtn}
            >
              <Text style={styles.stepBtnText}>+</Text>
            </Pressable>
          </View>
        </SettingRow>

        {/* ── Advanced Settings Toggle ────────────────────────────────────── */}
        <Pressable
          onPress={() => setShowAdvanced(v => !v)}
          style={[styles.actionButton, { marginTop: 12, borderColor: '#6B728033' }]}
        >
          <MaterialIcons name={showAdvanced ? 'expand-less' : 'expand-more'} size={18} color="#6B7280" />
          <Text style={[styles.actionButtonText, { color: '#9CA3AF' }]}>
            {showAdvanced ? t('settings.advanced_hide') : t('settings.advanced_show')}
          </Text>
          <MaterialIcons name="settings" size={16} color="#6B7280" />
        </Pressable>

        {showAdvanced && (<>
        {/* ── Termux Bridge ─────────────────────────────────────────────────── */}
        <SectionHeader
          title={t('settings.termux_title')}
          subtitle={t('settings.termux_subtitle')}
        />

        {/* Status row */}
        <View style={styles.termuxStatusRow}>
          <Text style={styles.termuxStatusLabel}>Connection status</Text>
          <BridgeStatusBadge status={bridgeStatus} />
        </View>

        {/* Current mode */}
        <View style={styles.termuxStatusRow}>
          <Text style={styles.termuxStatusLabel}>Current mode</Text>
          <View style={styles.modeChips}>
            {(['native', 'termux', 'disconnected'] as const).map((m) => (
              <Pressable
                key={m}
                onPress={() => setConnectionMode(m)}
                style={[
                  styles.modeChip,
                  connectionMode === m && styles.modeChipActive,
                ]}
              >
                <Text style={[
                  styles.modeChipText,
                  connectionMode === m && styles.modeChipTextActive,
                ]}>
                  {m === 'native' ? 'Native' : m === 'termux' ? 'Termux' : 'Off'}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        {/* WebSocket URL */}
        <View style={styles.wsUrlRow}>
          <Text style={styles.wsUrlLabel}>WebSocket URL</Text>
          <View style={styles.wsUrlInputRow}>
            <TextInput
              style={styles.wsUrlInput}
              value={wsUrlInput}
              onChangeText={setWsUrlInput}
              placeholder="ws://127.0.0.1:8765"
              placeholderTextColor="#3D4451"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="done"
              onSubmitEditing={handleWsUrlSave}
            />
            <Pressable onPress={handleWsUrlSave} style={styles.wsUrlSaveBtn}>
              <Text style={styles.wsUrlSaveBtnText}>Save</Text>
            </Pressable>
          </View>
          <Text style={styles.wsUrlHint}>
            Bridge server URL running in Termux.{'\n'}
            Use ws://127.0.0.1:8765 for same device.{'\n'}
            Start command: node ~/shelly-bridge/server.js
          </Text>
        </View>

        {/* Auto-reconnect */}
        <SettingRow label={t('settings.auto_reconnect_label')} description={t('settings.auto_reconnect_desc')}>
          <Switch
            value={termuxSettings.autoReconnect}
            onValueChange={(v) => updateTermuxSettings({ autoReconnect: v })}
            trackColor={{ false: '#2D2D2D', true: '#93C5FD50' }}
            thumbColor={termuxSettings.autoReconnect ? '#93C5FD' : '#6B7280'}
          />
        </SettingRow>

        {/* Timeout */}
        <SettingRow label={t('settings.timeout_label')} description={t('settings.timeout_desc', { seconds: termuxSettings.timeoutSeconds })}>
          <View style={styles.stepper}>
            <Pressable onPress={() => handleTimeoutChange(-5)} style={styles.stepBtn}>
              <Text style={styles.stepBtnText}>−</Text>
            </Pressable>
            <Text style={styles.stepValue}>{termuxSettings.timeoutSeconds}s</Text>
            <Pressable onPress={() => handleTimeoutChange(5)} style={styles.stepBtn}>
              <Text style={styles.stepBtnText}>+</Text>
            </Pressable>
          </View>
        </SettingRow>

        {/* Test connection button */}
        <Pressable
          onPress={handleTestConnection}
          disabled={isTesting}
          style={[styles.actionButton, styles.testButton, isTesting && styles.actionButtonDisabled]}
        >
          {isTesting ? (
            <ActivityIndicator size="small" color="#93C5FD" />
          ) : (
            <MaterialIcons
              name={testResult === 'success' ? 'check-circle' : testResult === 'fail' ? 'error' : 'wifi-tethering'}
              size={18}
              color={testResult === 'success' ? '#4ADE80' : testResult === 'fail' ? '#F87171' : '#93C5FD'}
            />
          )}
          <Text style={[
            styles.actionButtonText,
            testResult === 'success' && { color: '#4ADE80' },
            testResult === 'fail' && { color: '#F87171' },
            !testResult && { color: '#93C5FD' },
          ]}>
            {isTesting ? 'Testing connection...' :
             testResult === 'success' ? 'Connected' :
             testResult === 'fail' ? 'Connection failed' :
             'Test connection'}
          </Text>
          {!isTesting && <MaterialIcons name="chevron-right" size={18} color="#6B7280" />}
        </Pressable>

        {/* Update bridge button */}
        <Pressable
          onPress={handleUpdateBridge}
          disabled={isUpdatingBridge}
          style={[styles.actionButton, styles.updateBridgeButton, isUpdatingBridge && styles.actionButtonDisabled]}
        >
          {isUpdatingBridge ? (
            <ActivityIndicator size="small" color="#FCD34D" />
          ) : (
            <MaterialIcons
              name={bridgeUpdateResult === 'success' ? 'check-circle' : bridgeUpdateResult === 'fail' ? 'error' : 'system-update-alt'}
              size={18}
              color={bridgeUpdateResult === 'success' ? '#4ADE80' : bridgeUpdateResult === 'fail' ? '#F87171' : '#FCD34D'}
            />
          )}
          <Text style={[styles.actionButtonText, { color: bridgeUpdateResult === 'success' ? '#4ADE80' : bridgeUpdateResult === 'fail' ? '#F87171' : '#FCD34D' }]}>
            {isUpdatingBridge ? 'Updating bridge...' :
             bridgeUpdateResult === 'success' ? 'Updated (please restart)' :
             bridgeUpdateResult === 'fail' ? 'Update failed' :
             `Update bridge to latest (v${BRIDGE_SERVER_VERSION})`}
          </Text>
          {!isUpdatingBridge && <MaterialIcons name="chevron-right" size={18} color="#6B7280" />}
        </Pressable>

        {/* Generate start-all script button */}
        <Pressable
          onPress={handleGenerateStartScript}
          disabled={isGeneratingScript}
          style={[styles.actionButton, { borderColor: '#4ADE8033' }, isGeneratingScript && styles.actionButtonDisabled]}
        >
          {isGeneratingScript ? (
            <ActivityIndicator size="small" color="#4ADE80" />
          ) : (
            <MaterialIcons name="play-circle-filled" size={18} color="#4ADE80" />
          )}
          <Text style={[styles.actionButtonText, { color: '#4ADE80' }]}>
            {isGeneratingScript ? 'Generating script...' :
             bridgeStatus === 'connected' ? 'Save start script (start-shelly.sh)' :
             'Share start script'}
          </Text>
          {!isGeneratingScript && <MaterialIcons name="chevron-right" size={18} color="#6B7280" />}
        </Pressable>
        <Text style={[styles.wsUrlHint, { marginHorizontal: 16, marginTop: -4, marginBottom: 8 }]}>
          Start llama-server + shelly-bridge with one command. No multi-window needed.{'\n'}
          Auto-saves when connected, shares content when disconnected.
        </Text>

        {/* Open Termux button */}
        <Pressable
          onPress={handleOpenTermux}
          style={[styles.actionButton, { borderColor: '#4ADE8033' }]}
        >
          <MaterialIcons name="open-in-new" size={18} color="#4ADE80" />
          <Text style={[styles.actionButtonText, { color: '#4ADE80' }]}>
            Open Termux
          </Text>
          <MaterialIcons name="chevron-right" size={18} color="#6B7280" />
        </Pressable>

        {/* ── Glass Background ────────────────────────────────────── */}
        {/* ── Pro Features Block 1: Local LLM + LlamaCpp + MCP + System Prompt ── */}
        <ProGate>
        {/* ── Local LLM (Ollama) ─────────────────────────────────────────── */}
        <SectionHeader
          title={t('settings.local_llm_title')}
          subtitle={t('settings.local_llm_subtitle')}
        />

        <SettingRow
          label={t('settings.use_local_llm')}
          description={settings.localLlmEnabled
            ? 'Enabled: Basic chat handled by llama-server (saves Claude/Gemini credits)'
            : 'Disabled: All AI tasks sent to Claude Code / Gemini CLI'}
        >
          <Switch
            value={settings.localLlmEnabled}
            onValueChange={(v) => updateSettings({ localLlmEnabled: v })}
            trackColor={{ false: '#2D2D2D', true: '#A78BFA50' }}
            thumbColor={settings.localLlmEnabled ? '#A78BFA' : '#6B7280'}
          />
        </SettingRow>

        {/* llama-server URL */}
        <View style={styles.wsUrlRow}>
          <Text style={styles.wsUrlLabel}>llama-server URL</Text>
          <View style={styles.wsUrlInputRow}>
            <TextInput
              style={[styles.wsUrlInput, { color: '#A78BFA' }]}
              value={llmUrlInput}
              onChangeText={setLlmUrlInput}
              placeholder="http://127.0.0.1:8080"
              placeholderTextColor="#3D4451"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="done"
              onSubmitEditing={handleLlmUrlSave}
            />
            <Pressable onPress={handleLlmUrlSave} style={[styles.wsUrlSaveBtn, { borderColor: '#A78BFA44', backgroundColor: '#A78BFA18' }]}>
              <Text style={[styles.wsUrlSaveBtnText, { color: '#A78BFA' }]}>Save</Text>
            </Pressable>
          </View>
          <Text style={styles.wsUrlHint}>
            llama-server URL running in Termux.{`\n`}
            Use http://127.0.0.1:8080 for same device.
          </Text>
        </View>

        {/* Model name */}
        <View style={styles.wsUrlRow}>
          <Text style={styles.wsUrlLabel}>Model name</Text>
          <View style={styles.wsUrlInputRow}>
            <TextInput
              style={[styles.wsUrlInput, { color: '#A78BFA' }]}
              value={llmModelInput}
              onChangeText={setLlmModelInput}
              placeholder="qwen2.5-1.5b-instruct-q4_k_m"
              placeholderTextColor="#3D4451"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={handleLlmModelSave}
            />
            <Pressable onPress={handleLlmModelSave} style={[styles.wsUrlSaveBtn, { borderColor: '#A78BFA44', backgroundColor: '#A78BFA18' }]}>
              <Text style={[styles.wsUrlSaveBtnText, { color: '#A78BFA' }]}>Save</Text>
            </Pressable>
          </View>
          <Text style={styles.wsUrlHint}>
            GGUF model name. Example: gemma-3-4b-it-Q4_K_M, Qwen3-4B-Instruct-2507-Q4_K_M{`\n`}
            Copy the filename from the model catalog below.
          </Text>
          <Text style={[styles.wsUrlHint, { marginTop: 4 }]}>
            {t('settings.llm_model_hint')}
          </Text>
        </View>

        {/* Test Ollama connection */}
        <Pressable
          onPress={handleTestLlm}
          disabled={isTestingLlm}
          style={[styles.actionButton, { borderColor: '#A78BFA33' }, isTestingLlm && styles.actionButtonDisabled]}
        >
          {isTestingLlm ? (
            <ActivityIndicator size="small" color="#A78BFA" />
          ) : (
            <MaterialIcons
              name={llmTestResult === 'success' ? 'check-circle' : llmTestResult === 'fail' ? 'error' : 'psychology'}
              size={18}
              color={llmTestResult === 'success' ? '#4ADE80' : llmTestResult === 'fail' ? '#F87171' : '#A78BFA'}
            />
          )}
          <Text style={[
            styles.actionButtonText,
            llmTestResult === 'success' && { color: '#4ADE80' },
            llmTestResult === 'fail' && { color: '#F87171' },
            !llmTestResult && { color: '#A78BFA' },
          ]}>
            {isTestingLlm ? 'Testing llama-server...' :
             llmTestResult === 'success' ? 'llama-server connected' :
             llmTestResult === 'fail' ? 'llama-server connection failed' :
             'Test llama-server'}
          </Text>
          {!isTestingLlm && <MaterialIcons name="chevron-right" size={18} color="#6B7280" />}
        </Pressable>

        {/* ── llama.cpp モデル管理 ──────────────────────────────────────────── */}
        <LlamaCppSection
          isConnected={bridgeStatus === 'connected'}
          activeModelId={activeModelId}
          installedModelIds={installedModelIds}
          onSelectModel={handleSelectModel}
          onRunCommand={handleRunCommandForSetup}
          onUpdateLocalLlmUrl={handleUpdateLocalLlmUrl}
        />


        {/* ── Custom Context ────────────────────────────────────────────── */}
        <SectionHeader
          title={t('settings.custom_context_title')}
          subtitle={t('settings.custom_context_subtitle')}
        />
        <View style={styles.wsUrlRow}>
          <TextInput
            style={[styles.wsUrlInput, {
              color: '#E5E7EB',
              minHeight: 120,
              textAlignVertical: 'top',
              fontFamily: 'monospace',
              fontSize: 12,
            }]}
            value={customContextText}
            onChangeText={setCustomContextText}
            placeholder={DEFAULT_CUSTOM_CONTEXT}
            placeholderTextColor="#4B5563"
            multiline
            numberOfLines={8}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable
            style={[styles.segmentBtn, { backgroundColor: customContextSaved ? '#065F46' : '#1F2937', marginTop: 8 }]}
            onPress={handleSaveCustomContext}
          >
            <Text style={styles.segmentBtnText}>
              {customContextSaved ? 'Saved' : 'Save'}
            </Text>
          </Pressable>
          <Text style={[styles.wsUrlHint, { marginTop: 4 }]}>
            When LLM is enabled, this content is auto-added to the system prompt
          </Text>
        </View>

        </ProGate>

        {/* ── CLI Auto-Approve ──────────────────────────────────────────── */}
        <SectionHeader
          title={t('settings.cli_approve_title')}
          subtitle={t('settings.cli_approve_subtitle')}
        />
        <View style={styles.wsUrlRow}>
          {(['none', 'safe', 'all'] as const).map((level) => {
            const labels: Record<string, { title: string; desc: string }> = {
              none: { title: t('settings.approve_none'), desc: t('settings.approve_none_desc') },
              safe: { title: t('settings.approve_safe'), desc: t('settings.approve_safe_desc') },
              all: { title: t('settings.approve_all'), desc: t('settings.approve_all_desc') },
            };
            const isActive = autoApproveLevel === level;
            return (
              <Pressable
                key={level}
                style={[styles.segmentBtn, {
                  backgroundColor: isActive ? '#1E3A5F' : '#111827',
                  borderColor: isActive ? '#3B82F6' : '#374151',
                  marginBottom: 6,
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }]}
                onPress={() => {
                  if (level === 'all') {
                    Alert.alert(
                      '⚠️ Security Warning',
                      'This grants --dangerouslySkipPermissions to the CLI agent, allowing it to execute any command without confirmation. Use only if you understand the risks.',
                      [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Enable', style: 'destructive', onPress: () => updateSettings({ autoApproveLevel: level }) },
                      ],
                    );
                  } else {
                    updateSettings({ autoApproveLevel: level });
                  }
                }}
              >
                <View>
                  <Text style={[styles.segmentBtnText, { fontWeight: isActive ? '700' : '400' }]}>
                    {labels[level].title}
                  </Text>
                  <Text style={[styles.wsUrlHint, { marginTop: 2 }]}>{labels[level].desc}</Text>
                </View>
                {isActive && <MaterialIcons name="check-circle" size={20} color="#3B82F6" />}
              </Pressable>
            );
          })}
        </View>

        {/* ── Default Agent ──────────────────────────────────────────────── */}
        <SectionHeader
          title={t('settings.default_agent_title')}
          subtitle={t('settings.default_agent_subtitle')}
        />
        <View style={styles.wsUrlRow}>
          {(['gemini-cli', 'claude-code', 'codex'] as const).map((agent) => {
            const labels: Record<string, { title: string; desc: string }> = {
              'gemini-cli': { title: 'Gemini CLI', desc: 'Free tier available. Only needs Google account. Recommended for beginners' },
              'claude-code': { title: 'Claude Code', desc: 'Most capable. Best for complex dev tasks. Paid' },
              'codex': { title: 'Codex CLI', desc: 'Fast and lightweight. Good for simple fixes' },
            };
            const isActive = (settings.defaultAgent ?? 'gemini-cli') === agent;
            return (
              <Pressable
                key={agent}
                style={[styles.segmentBtn, {
                  backgroundColor: isActive ? '#1E3A5F' : '#111827',
                  borderColor: isActive ? '#3B82F6' : '#374151',
                  marginBottom: 6,
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }]}
                onPress={() => updateSettings({ defaultAgent: agent })}
              >
                <View>
                  <Text style={[styles.segmentBtnText, { fontWeight: isActive ? '700' : '400' }]}>
                    {labels[agent].title}
                  </Text>
                  <Text style={[styles.wsUrlHint, { marginTop: 2 }]}>{labels[agent].desc}</Text>
                </View>
                {isActive && <MaterialIcons name="check-circle" size={20} color="#3B82F6" />}
              </Pressable>
            );
          })}
        </View>

        {/* ── Pro Features Block 2: API integrations + @team + Obsidian ─── */}
        <ProGate>
            {/* ── Groq API ──────────────────────────────────────────────────── */}
        <SectionHeader
          title={t('settings.groq_title')}
          subtitle={t('settings.groq_subtitle')}
        />

        <View style={styles.wsUrlRow}>
          <Text style={styles.wsUrlLabel}>{t('settings.api_key')}</Text>
          <View style={styles.wsUrlInputRow}>
            <TextInput
              style={[styles.wsUrlInput, { color: '#F97316' }]}
              value={settings.groqApiKey ?? ''}
              onChangeText={(v) => updateSettings({ groqApiKey: v.trim() })}
              placeholder="gsk_xxxxxxxxxxxxxxxxxxxx"
              placeholderTextColor="#4B5563"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              returnKeyType="done"
            />
          </View>
          <Text style={styles.wsUrlHint}>
            {settings.groqApiKey
              ? t('settings.groq_configured')
              : t('settings.groq_hint')
            }
          </Text>
        </View>

        <View style={styles.wsUrlRow}>
          <Text style={styles.wsUrlLabel}>{t('settings.model')}</Text>
          <View style={styles.wsUrlInputRow}>
            <TextInput
              style={[styles.wsUrlInput, { color: '#F97316' }]}
              value={settings.groqModel ?? 'llama-3.3-70b-versatile'}
              onChangeText={(v) => updateSettings({ groqModel: v.trim() || 'llama-3.3-70b-versatile' })}
              placeholder="llama-3.3-70b-versatile"
              placeholderTextColor="#4B5563"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
            />
          </View>
          <Text style={styles.wsUrlHint}>
            llama-3.3-70b-versatile (default) / llama-3.1-8b-instant (faster)
          </Text>
        </View>

            {/* ── Cerebras API ──────────────────────────────────────────────── */}
        <SectionHeader
          title={t('settings.cerebras_title')}
          subtitle={t('settings.cerebras_key_desc')}
        />

        <View style={styles.wsUrlRow}>
          <Text style={styles.wsUrlLabel}>{t('settings.api_key')}</Text>
          <View style={styles.wsUrlInputRow}>
            <TextInput
              style={[styles.wsUrlInput, { color: '#A78BFA' }]}
              value={settings.cerebrasApiKey ?? ''}
              onChangeText={(v) => updateSettings({ cerebrasApiKey: v.trim() })}
              placeholder="csk-xxxxxxxxxxxxxxxxxxxx"
              placeholderTextColor="#4B5563"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              returnKeyType="done"
            />
          </View>
          <Text style={styles.wsUrlHint}>
            {settings.cerebrasApiKey
              ? t('settings.cerebras_configured')
              : t('settings.cerebras_hint')
            }
          </Text>
        </View>

        <View style={styles.wsUrlRow}>
          <Text style={styles.wsUrlLabel}>{t('settings.model')}</Text>
          <View style={styles.wsUrlInputRow}>
            <TextInput
              style={[styles.wsUrlInput, { color: '#A78BFA' }]}
              value={settings.cerebrasModel ?? 'qwen-3-235b-a22b-instruct-2507'}
              onChangeText={(v) => updateSettings({ cerebrasModel: v.trim() || 'qwen-3-235b-a22b-instruct-2507' })}
              placeholder="qwen-3-235b-a22b-instruct-2507"
              placeholderTextColor="#4B5563"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
            />
          </View>
          <Text style={styles.wsUrlHint}>
            qwen-3-235b-a22b-instruct-2507 (default)
          </Text>
        </View>

            {/* ── Perplexity API ─────────────────────────────────────────────── */}
        <SectionHeader
          title={t('settings.perplexity_title')}
          subtitle={t('settings.perplexity_subtitle')}
        />

        <View style={styles.wsUrlRow}>
          <Text style={styles.wsUrlLabel}>{t('settings.api_key')}</Text>
          <View style={styles.wsUrlInputRow}>
            <TextInput
              style={[styles.wsUrlInput, { color: '#20B2AA' }]}
              value={settings.perplexityApiKey ?? ''}
              onChangeText={(v) => updateSettings({ perplexityApiKey: v.trim() })}
              placeholder="pplx-xxxxxxxxxxxxxxxxxxxx"
              placeholderTextColor="#4B5563"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              returnKeyType="done"
            />
          </View>
          <Text style={styles.wsUrlHint}>
            {settings.perplexityApiKey
              ? t('settings.perplexity_configured')
              : t('settings.perplexity_hint')
            }
          </Text>
        </View>

        <View style={styles.wsUrlRow}>
          <Text style={styles.wsUrlLabel}>{t('settings.model')}</Text>
          <View style={styles.wsUrlInputRow}>
            <TextInput
              style={[styles.wsUrlInput, { color: '#20B2AA' }]}
              value={settings.perplexityModel ?? 'sonar-reasoning-pro'}
              onChangeText={(v) => updateSettings({ perplexityModel: v.trim() || 'sonar-reasoning-pro' })}
              placeholder="sonar-reasoning-pro"
              placeholderTextColor="#4B5563"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
            />
          </View>
          <Text style={styles.wsUrlHint}>
            sonar-reasoning-pro (papers) / sonar-pro (general) / sonar (light & fast)
          </Text>
        </View>

        {/* ── Gemini API ─────────────────────────────────────────────── */}
        <SectionHeader
          title={t('settings.gemini_api_title')}
          subtitle={t('settings.gemini_api_subtitle')}
        />
        <View style={styles.wsUrlRow}>
          <Text style={styles.wsUrlLabel}>{t('settings.api_key')}</Text>
          <View style={styles.wsUrlInputRow}>
            <TextInput
              style={[styles.wsUrlInput, { color: '#A78BFA' }]}
              value={settings.geminiApiKey ?? ''}
              onChangeText={(v) => updateSettings({ geminiApiKey: v.trim() })}
              placeholder="AIzaSy..."
              placeholderTextColor="#4B5563"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              returnKeyType="done"
            />
          </View>
          <Text style={styles.wsUrlHint}>
            {settings.geminiApiKey
              ? t('settings.gemini_configured')
              : t('settings.gemini_hint')
            }
          </Text>
        </View>
        <View style={styles.wsUrlRow}>
          <Text style={styles.wsUrlLabel}>{t('settings.model')}</Text>
          <View style={styles.wsUrlInputRow}>
            <TextInput
              style={[styles.wsUrlInput, { color: '#A78BFA' }]}
              value={settings.geminiModel ?? 'gemini-2.0-flash'}
              onChangeText={(v) => updateSettings({ geminiModel: v.trim() || 'gemini-2.0-flash' })}
              placeholder="gemini-2.0-flash"
              placeholderTextColor="#4B5563"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
            />
          </View>
          <Text style={styles.wsUrlHint}>
            gemini-2.0-flash (fast, recommended) / gemini-2.5-pro (high accuracy)
          </Text>
        </View>
           {/* ── @team Table ────────────────────────────────────────── */}
        <SectionHeader title={t('settings.team_title')} subtitle={t('settings.team_subtitle')} />
        <View style={styles.wsUrlRow}>
          <View style={{ gap: 12 }}>
            {([
              { key: 'claude' as const, label: 'Claude CLI', desc: 'Requires Claude Pro/Max plan', color: '#F59E0B' },
              { key: 'gemini' as const, label: 'Gemini CLI', desc: 'Gemini Advanced recommended', color: '#3B82F6' },
              { key: 'codex' as const, label: 'Codex CLI', desc: 'Requires ChatGPT Plus/Pro', color: '#10B981' },
              { key: 'perplexity' as const, label: 'Perplexity API', desc: 'Latest info with source citations', color: '#20B2AA' },
              { key: 'local' as const, label: 'Local LLM (Facilitator)', desc: 'Auto-facilitator when running', color: '#8B5CF6' },
            ]).map(({ key, label, desc, color }) => {
              const members = settings.teamMembers ?? { claude: true, gemini: true, codex: false, perplexity: true, local: true };
              const isOn = members[key] ?? false;
              return (
                <View key={key} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.settingLabelText, { color }]}>{label}</Text>
                    <Text style={styles.wsUrlHint}>{desc}</Text>
                  </View>
                  <Switch
                    value={isOn}
                    onValueChange={(v) => updateSettings({ teamMembers: { ...members, [key]: v } })}
                    trackColor={{ false: '#374151', true: color + '80' }}
                    thumbColor={isOn ? color : '#6B7280'}
                  />
                </View>
              );
            })}
          </View>
        </View>
        <View style={styles.wsUrlRow}>
          <Text style={styles.wsUrlLabel}>Codex CLI command name</Text>
          <View style={styles.wsUrlInputRow}>
            <TextInput
              style={styles.wsUrlInput}
              value={settings.codexCmd ?? 'codex'}
              onChangeText={(v) => updateSettings({ codexCmd: v.trim() || 'codex' })}
              placeholder="codex"
              placeholderTextColor="#4B5563"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
            />
          </View>
          <Text style={styles.wsUrlHint}>Codex command name in Termux (usually just &quot;codex&quot;)</Text>
        </View>
        </ProGate>


        </>)}

        {/* ── Usage Alerts ─────────────────────────────────────────────────── */}
        <SectionHeader title="Usage Alerts" subtitle="Claude Code cost notifications" />
        <UsageAlertToggle />

        {/* ── Data ─────────────────────────────────────────────────────────── */}
        <SectionHeader title={t('settings.data_title')} />

        <Pressable onPress={handleExportLog} style={styles.actionButton}>
          <MaterialIcons name="share" size={18} color="#00D4AA" />
          <Text style={styles.actionButtonText}>Export logs (share as text)</Text>
          <MaterialIcons name="chevron-right" size={18} color="#6B7280" />
        </Pressable>

        <Pressable onPress={handleClearAll} style={[styles.actionButton, styles.dangerButton]}>
          <MaterialIcons name="delete-sweep" size={18} color="#F87171" />
          <Text style={[styles.actionButtonText, styles.dangerText]}>Delete all history</Text>
          <MaterialIcons name="chevron-right" size={18} color="#6B7280" />
        </Pressable>

        {/* ── Theme Engine ─────────────────────────────────────────────── */}
        <SectionHeader title={t('settings.theme') + ' (Engine)'} subtitle="WezTerm-style full color themes" />
        <View style={styles.themeOptions}>
          {(showAllThemes ? allThemes : allThemes.slice(0, 6)).map((th) => (
            <Pressable
              key={th.id}
              onPress={() => setEngineTheme(th.id)}
              style={[
                styles.themeOption,
                { backgroundColor: th.colors.background, borderColor: th.colors.border },
                currentThemeId === th.id && { borderColor: th.colors.accent, borderWidth: 2 },
              ]}
            >
              <Text style={[styles.themePreview, { color: th.colors.accent }]}>{'> _'}</Text>
              <Text style={[styles.themeLabel, { color: th.colors.foreground }]}>{th.name}</Text>
              {currentThemeId === th.id && (
                <MaterialIcons name="check-circle" size={16} color={th.colors.accent} style={styles.themeCheck} />
              )}
            </Pressable>
          ))}
        </View>
        {allThemes.length > 6 && (
          <Pressable onPress={() => setShowAllThemes(!showAllThemes)} style={{ paddingVertical: 8, alignItems: 'center' }}>
            <Text style={{ color: '#00D4AA', fontSize: 12, fontFamily: 'monospace' }}>
              {showAllThemes ? `▲ ${allThemes.length - 6} themes hidden` : `▼ +${allThemes.length - 6} more themes`}
            </Text>
          </Pressable>
        )}

        {/* ── Language / i18n ──────────────────────────────────────────────── */}
        <SectionHeader title={t('settings.language')} subtitle={t('settings.language_desc')} />
        <View style={styles.cursorOptions}>
          {AVAILABLE_LOCALES.map((loc) => (
            <Pressable
              key={loc.code}
              onPress={() => setLocale(loc.code)}
              style={[
                styles.cursorOption,
                locale === loc.code && styles.cursorOptionActive,
              ]}
            >
              <Text style={[
                styles.cursorPreview,
                locale === loc.code && styles.cursorPreviewActive,
                { fontSize: 16 },
              ]}>
                {loc.code === 'en' ? '🇺🇸' : '🇯🇵'}
              </Text>
              <Text style={[
                styles.cursorLabel,
                locale === loc.code && styles.cursorLabelActive,
              ]}>
                {loc.nativeLabel}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* ── Dotfiles Sync ──────────────────────────────────────────────── */}
        <SectionHeader title={t('dotfiles.title')} subtitle="GitHub Gist" />
        <View style={styles.wsUrlRow}>
          <Text style={styles.wsUrlLabel}>GitHub PAT</Text>
          <View style={styles.wsUrlInputRow}>
            <TextInput
              style={styles.wsUrlInput}
              value={dotfiles.pat || patInput}
              onChangeText={(v) => {
                setPatInput(v);
                dotfiles.setPat(v.trim());
              }}
              placeholder="ghp_xxxxxxxxxxxx"
              placeholderTextColor="#4B5563"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              returnKeyType="done"
            />
          </View>
          <Text style={styles.wsUrlHint}>
            {dotfiles.pat ? '✓ PAT configured' : t('dotfiles.pat_required')}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 8 }}>
          <Pressable
            onPress={() => dotfiles.syncToGist()}
            style={[styles.actionButton, { flex: 1, borderColor: '#00D4AA33' }]}
          >
            <MaterialIcons name="cloud-upload" size={18} color="#00D4AA" />
            <Text style={styles.actionButtonText}>
              {dotfiles.isSyncing ? t('dotfiles.syncing') : t('dotfiles.sync_to_gist')}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => dotfiles.syncFromGist()}
            style={[styles.actionButton, { flex: 1, borderColor: '#60A5FA33' }]}
          >
            <MaterialIcons name="cloud-download" size={18} color="#60A5FA" />
            <Text style={[styles.actionButtonText, { color: '#60A5FA' }]}>
              {dotfiles.isSyncing ? t('dotfiles.syncing') : t('dotfiles.sync_from_gist')}
            </Text>
          </Pressable>
        </View>
        <Text style={[styles.wsUrlHint, { paddingHorizontal: 16, paddingBottom: 8 }]}>
          {dotfiles.lastSync
            ? t('dotfiles.last_sync', { time: new Date(dotfiles.lastSync).toLocaleString() })
            : t('dotfiles.never_synced')}
        </Text>

        {/* ── Auto-check (GitHub Actions) ───────────────────────────────── */}
        <SectionHeader title={t('wizard.actions_title')} />
        <Pressable
          onPress={handleOpenAutoCheckWizard}
          style={[styles.actionButton, { borderColor: '#F9731633' }]}
        >
          <MaterialIcons name="verified" size={18} color="#F97316" />
          <Text style={[styles.actionButtonText, { color: '#F97316' }]}>
            {t('wizard.step1_title')}
          </Text>
          <MaterialIcons name="chevron-right" size={18} color="#6B7280" />
        </Pressable>

        {/* Auto-check wizard modal */}
        <Modal
          visible={showAutoCheckWizard}
          transparent
          animationType="slide"
          onRequestClose={() => setShowAutoCheckWizard(false)}
        >
          <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 16 }}>
            <View style={{ backgroundColor: '#1A1A1A', borderRadius: 16, padding: 4 }}>
              {wizardStatus === 'working' ? (
                <View style={{ padding: 20, alignItems: 'center', gap: 8 }}>
                  <ActivityIndicator size="large" color="#F97316" />
                  <Text style={{ color: '#9CA3AF', fontFamily: 'monospace', fontSize: 12 }}>{t('wizard.setting_up')}</Text>
                </View>
              ) : wizardStatus === 'done' ? (
                <View style={{ padding: 20, alignItems: 'center', gap: 8 }}>
                  <MaterialIcons name="check-circle" size={40} color="#4ADE80" />
                  <Text style={{ color: '#E8E8E8', fontFamily: 'monospace', fontSize: 13, textAlign: 'center' }}>
                    {t('wizard.done', { trigger: t(`wizard.done_${wizardData.trigger || 'push'}`) })}
                  </Text>
                  <Pressable
                    onPress={() => setShowAutoCheckWizard(false)}
                    style={{ marginTop: 8, paddingHorizontal: 20, paddingVertical: 10, backgroundColor: '#4ADE80', borderRadius: 20 }}
                  >
                    <Text style={{ color: '#000', fontFamily: 'monospace', fontWeight: '700', fontSize: 13 }}>OK</Text>
                  </Pressable>
                </View>
              ) : wizardStatus === 'error' ? (
                <View style={{ padding: 20, alignItems: 'center', gap: 8 }}>
                  <MaterialIcons name="error-outline" size={40} color="#F87171" />
                  <Text style={{ color: '#F87171', fontFamily: 'monospace', fontSize: 12, textAlign: 'center' }}>
                    {t('wizard.error', { error: wizardError })}
                  </Text>
                  <Pressable
                    onPress={() => setShowAutoCheckWizard(false)}
                    style={{ marginTop: 8, paddingHorizontal: 20, paddingVertical: 10, borderWidth: 1, borderColor: '#6B7280', borderRadius: 20 }}
                  >
                    <Text style={{ color: '#9CA3AF', fontFamily: 'monospace', fontWeight: '600', fontSize: 12 }}>{t('wizard.btn_back')}</Text>
                  </Pressable>
                </View>
              ) : (
                <>
                  <ActionsWizardBubble
                    wizardData={wizardData}
                    onUpdate={setWizardData}
                    onComplete={handleWizardComplete}
                  />
                  <Pressable
                    onPress={() => setShowAutoCheckWizard(false)}
                    style={{ alignItems: 'center', paddingVertical: 10 }}
                  >
                    <Text style={{ color: '#6B7280', fontFamily: 'monospace', fontSize: 12 }}>{t('wizard.btn_back')}</Text>
                  </Pressable>
                </>
              )}
            </View>
          </View>
        </Modal>

        {/* ── Package Manager ─────────────────────────────────────────────── */}
        <SectionHeader title={t('pkg.title')} subtitle="Termux pkg GUI" />
        <Pressable
          onPress={() => setShowPkgManager(true)}
          style={styles.actionButton}
        >
          <MaterialIcons name="inventory-2" size={18} color="#00D4AA" />
          <Text style={styles.actionButtonText}>{t('pkg.title')}</Text>
          <MaterialIcons name="chevron-right" size={18} color="#6B7280" />
        </Pressable>

        {/* ── AI Authentication ──────────────────────────────── */}
        <SectionHeader title={t('auth.settings_title')} subtitle={t('auth.settings_subtitle')} />
        <Pressable
          onPress={() => setShowAuthWizard(true)}
          style={[styles.actionButton, { borderColor: '#60A5FA33' }]}
        >
          <MaterialIcons name="vpn-key" size={18} color="#60A5FA" />
          <Text style={[styles.actionButtonText, { color: '#60A5FA' }]}>
            {t('auth.settings_button')}
          </Text>
          <MaterialIcons name="chevron-right" size={18} color="#6B7280" />
        </Pressable>

        {/* ── Setup Reset ──────────────────────────────────── */}
        <Pressable
          onPress={() => setShowSetupWizard(true)}
          style={[styles.actionButton, { borderColor: '#60A5FA33' }]}
        >
          <MaterialIcons name="build" size={18} color="#60A5FA" />
          <Text style={[styles.actionButtonText, { color: '#60A5FA' }]}>
            {bridgeStatus === 'connected' ? 'Setup Wizard (reconfigure)' : 'Open Setup Wizard'}
          </Text>
          <MaterialIcons name="chevron-right" size={18} color="#6B7280" />
        </Pressable>

        {/* ── Diagnostics ──────────────────────────────────────────────────── */}
        <SectionHeader title={t('settings.diagnostics_title')} subtitle={t('settings.diagnostics_subtitle')} />

        <Pressable
          onPress={runDiagnostics}
          disabled={isDiagRunning}
          style={[styles.actionButton, { borderColor: '#00D4AA33', marginBottom: 8 }]}
        >
          {isDiagRunning ? (
            <ActivityIndicator size="small" color="#00D4AA" style={{ marginRight: 4 }} />
          ) : (
            <MaterialIcons name="health-and-safety" size={18} color="#00D4AA" />
          )}
          <Text style={[styles.actionButtonText, { color: '#00D4AA' }]}>
            {isDiagRunning ? 'Running diagnostics...' : 'Run diagnostics'}
          </Text>
        </Pressable>

        {diagResults.bridge !== null && (
          <View style={styles.aboutCard}>
            {([
              ['Termux Bridge', diagResults.bridge, diagResults.latency ? `${diagResults.latency}ms` : undefined],
              ['Claude CLI', diagResults.claudeCli],
              ['Gemini CLI', diagResults.geminiCli],
              ['Codex CLI', diagResults.codexCli],
              ['Ollama / llama-server', diagResults.ollama],
              ['Storage Access', diagResults.storage],
            ] as [string, typeof diagResults.bridge, string?][]).map(([label, status, extra]) => (
              <View key={label} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 4 }}>
                <MaterialIcons
                  name={status === 'ok' ? 'check-circle' : status === 'fail' ? 'cancel' : status === 'checking' ? 'hourglass-top' : 'remove'}
                  size={16}
                  color={status === 'ok' ? '#4ADE80' : status === 'fail' ? '#F87171' : status === 'checking' ? '#FBBF24' : '#6B7280'}
                />
                <Text style={{ color: '#AAAAAA', fontFamily: 'monospace', fontSize: 13, marginLeft: 8, flex: 1 }}>
                  {label}
                </Text>
                {extra && <Text style={{ color: '#6B7280', fontFamily: 'monospace', fontSize: 12 }}>{extra}</Text>}
              </View>
            ))}

            <Pressable
              onPress={copyDiagnostics}
              style={[styles.actionButton, { marginTop: 8, borderColor: '#60A5FA33' }]}
            >
              <MaterialIcons name="content-copy" size={16} color="#60A5FA" />
              <Text style={[styles.actionButtonText, { color: '#60A5FA', fontSize: 12 }]}>Copy diagnostics (for GitHub Issues)</Text>
            </Pressable>
          </View>
        )}

        {/* ── About ────────────────────────────────────────────────────────── */}
        <SectionHeader title={t('settings.about_title')} />
        <View style={styles.aboutCard}>
          <Text style={styles.aboutTitle}>Shelly (Unofficial)</Text>
          <Text style={styles.aboutVersion}>Version 4.2.0 — Termux Bridge + Local LLM + @team + Browser</Text>
          <Text style={styles.aboutDesc}>
            A terminal app prototype designed for Samsung Galaxy Z Fold6.
            Features Japanese IME support, command block UI, shortcut bar, Termux WebSocket integration, 4-layer AI routing (@claude / @gemini / @local / @team / @open), LLM output interpreter, and in-app browser.
          </Text>
          <Text style={styles.aboutNote}>
            Note: Termux integration requires the shelly-bridge server.
          </Text>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Package Manager */}
      {showPkgManager && (
        <PackageManagerModal
          visible={showPkgManager}
          onClose={() => setShowPkgManager(false)}
          isConnected={bridgeStatus === 'connected'}
          onRunCommand={(cmd: string) => {
            runCommand(cmd);
            setShowPkgManager(false);
          }}
        />
      )}
      {/* Setup Wizard (re-setup from settings) */}
      <SetupWizard
        visible={showSetupWizard}
        onComplete={() => setShowSetupWizard(false)}
        isResetup
      />
      {/* Auth Wizard */}
      <AuthWizard
        visible={showAuthWizard}
        onComplete={() => setShowAuthWizard(false)}
      />
    </View>
  );
}

export default function SettingsScreen() {
  return (
    <SettingsErrorBoundary>
      <SettingsScreenInner />
    </SettingsErrorBoundary>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0A0A0A',
  },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#111111',
    borderBottomWidth: 1,
    borderBottomColor: '#222222',
  },
  headerTitle: {
    color: '#E8E8E8',
    fontSize: 16,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 20 },
  sectionHeader: {
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 6,
  },
  sectionTitle: {
    color: '#00D4AA',
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  sectionSubtitle: {
    color: '#4B5563',
    fontSize: 11,
    fontFamily: 'monospace',
    marginTop: 3,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#1A1A1A',
    borderBottomWidth: 1,
    borderBottomColor: '#242424',
  },
  settingLabel: { flex: 1, marginRight: 12 },
  settingLabelText: { color: '#E8E8E8', fontSize: 14 },
  settingDesc: { color: '#6B7280', fontSize: 11, marginTop: 2 },
  settingControl: { alignItems: 'flex-end' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stepBtn: {
    width: 32,
    height: 32,
    borderRadius: 6,
    backgroundColor: '#2D2D2D',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBtnText: { color: '#E8E8E8', fontSize: 18, fontWeight: '600' },
  stepValue: {
    color: '#00D4AA',
    fontSize: 14,
    fontFamily: 'monospace',
    minWidth: 36,
    textAlign: 'center',
  },
  // Theme
  themeOptions: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 10,
  },
  themeOption: {
    flex: 1,
    borderRadius: 10,
    padding: 12,
    borderWidth: 2,
    borderColor: 'transparent',
    alignItems: 'center',
    gap: 4,
  },
  themeOptionActive: { borderColor: '#00D4AA' },
  themePreview: { color: '#00D4AA', fontFamily: 'monospace', fontSize: 12 },
  themeLabel: { color: '#9BA1A6', fontSize: 11 },
  themeCheck: { position: 'absolute', top: 6, right: 6 },
  // Cursor
  cursorOptions: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 10,
  },
  cursorOption: {
    flex: 1,
    borderRadius: 8,
    padding: 10,
    backgroundColor: '#1A1A1A',
    borderWidth: 1,
    borderColor: '#2D2D2D',
    alignItems: 'center',
    gap: 4,
  },
  cursorOptionActive: { borderColor: '#00D4AA', backgroundColor: '#00D4AA10' },
  cursorPreview: { color: '#4B5563', fontSize: 18, fontFamily: 'monospace' },
  cursorPreviewActive: { color: '#00D4AA' },
  cursorLabel: { color: '#6B7280', fontSize: 11 },
  cursorLabelActive: { color: '#00D4AA' },
  // Termux section
  termuxStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#1A1A1A',
    borderBottomWidth: 1,
    borderBottomColor: '#242424',
  },
  termuxStatusLabel: {
    color: '#E8E8E8',
    fontSize: 14,
  },
  modeChips: {
    flexDirection: 'row',
    gap: 6,
  },
  modeChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 5,
    backgroundColor: '#2D2D2D',
    borderWidth: 1,
    borderColor: '#3D3D3D',
  },
  modeChipActive: {
    backgroundColor: '#93C5FD18',
    borderColor: '#93C5FD',
  },
  modeChipText: {
    color: '#6B7280',
    fontSize: 11,
    fontFamily: 'monospace',
  },
  modeChipTextActive: {
    color: '#93C5FD',
  },
  wsUrlRow: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#1A1A1A',
    borderBottomWidth: 1,
    borderBottomColor: '#242424',
  },
  wsUrlLabel: {
    color: '#E8E8E8',
    fontSize: 14,
    marginBottom: 8,
  },
  wsUrlInputRow: {
    flexDirection: 'row',
    gap: 8,
  },
  wsUrlInput: {
    flex: 1,
    backgroundColor: '#111111',
    borderWidth: 1,
    borderColor: '#2D2D2D',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: '#93C5FD',
    fontFamily: 'monospace',
    fontSize: 13,
  },
  wsUrlSaveBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: '#93C5FD18',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#93C5FD44',
    justifyContent: 'center',
  },
  wsUrlSaveBtnText: {
    color: '#93C5FD',
    fontSize: 13,
    fontWeight: '600',
  },
  wsUrlHint: {
    color: '#4B5563',
    fontSize: 11,
    fontFamily: 'monospace',
    marginTop: 6,
    lineHeight: 16,
  },
  testButton: {
    borderColor: '#93C5FD33',
  },
  updateBridgeButton: {
    borderColor: '#FCD34D33',
  },
  // Actions
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#1A1A1A',
    borderBottomWidth: 1,
    borderBottomColor: '#242424',
    gap: 10,
  },
  actionButtonDisabled: {
    opacity: 0.5,
  },
  actionButtonText: {
    flex: 1,
    color: '#E8E8E8',
    fontSize: 14,
  },
  dangerButton: {},
  dangerText: { color: '#F87171' },
  // About
  aboutCard: {
    marginHorizontal: 16,
    marginTop: 8,
    backgroundColor: '#1A1A1A',
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: '#2D2D2D',
    gap: 6,
  },
  aboutTitle: { color: '#00D4AA', fontSize: 15, fontWeight: '700', fontFamily: 'monospace' },
  aboutVersion: { color: '#4B5563', fontSize: 11, fontFamily: 'monospace' },
  // Local LLM
  llmTestButton: {
    borderColor: '#A78BFA33',
  },
  aboutDesc: { color: '#9BA1A6', fontSize: 12, lineHeight: 18 },
  aboutNote: { color: '#3D4451', fontSize: 11, lineHeight: 16 },
  // Snippet run mode segment control
  segmentRow: { flexDirection: 'row', gap: 6 },
  segmentBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#333333',
    backgroundColor: '#1A1A1A',
  },
  segmentBtnActive: { borderColor: '#00D4AA', backgroundColor: '#00D4AA22' },
  segmentBtnText: { color: '#9BA1A6', fontSize: 12, fontFamily: 'monospace' },
  segmentBtnTextActive: { color: '#00D4AA' },
});
