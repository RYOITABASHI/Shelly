import React, { useState, useCallback } from 'react';
import * as ImagePicker from 'expo-image-picker';
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
} from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTerminalStore } from '@/store/terminal-store';
import { useObsidianStore } from '@/store/obsidian-store';
import { useTermuxBridge } from '@/hooks/use-termux-bridge';
import { useSnippetStore } from '@/store/snippet-store';
import { exportSnippets } from '@/lib/snippet-io';
import { ImportModal } from '@/components/snippets/ImportModal';
import { exportProjects } from '@/lib/project-io';
import { ImportProjectsModal } from '@/components/creator/ImportProjectsModal';
import { useCreatorStore } from '@/store/creator-store';
import { BRIDGE_SERVER_JS, BRIDGE_SERVER_VERSION } from '@/lib/bridge-bundle';
import { CursorShape, ThemeVariant, BridgeStatus } from '@/store/types';
import { LlamaCppSection } from '@/components/settings/LlamaCppSection';
import { McpSection } from '@/components/settings/McpSection';
import { LlamaCppModel, buildStartAllScript, getRecommendedModel } from '@/lib/llamacpp-setup';
import { useTranslation } from '@/lib/i18n';
import { useI18n, AVAILABLE_LOCALES, type Locale } from '@/lib/i18n';
import { useTheme, useThemeStore, BUILTIN_THEMES, getAllThemes, type Theme } from '@/lib/theme-engine';
import { useDotfilesStore } from '@/lib/dotfiles-sync';
import { resetOnboarding } from '@/components/Onboarding';
import { resetSetupWizard } from '@/components/SetupWizard';
import { PackageManager as PackageManagerModal } from '@/components/PackageManager';
import { saveCustomContext, loadCustomContext, DEFAULT_CUSTOM_CONTEXT } from '@/lib/shelly-system-prompt';

const THEME_OPTIONS: { value: ThemeVariant; label: string; bg: string }[] = [
  { value: 'black', label: '漆黒', bg: '#0D0D0D' },
  { value: 'navy',  label: '濃紺', bg: '#0A0E1A' },
  { value: 'gray',  label: 'グレー', bg: '#1C1C1E' },
];

const CURSOR_OPTIONS: { value: CursorShape; label: string; preview: string }[] = [
  { value: 'block',     label: 'ブロック',       preview: '█' },
  { value: 'underline', label: 'アンダーライン', preview: '_' },
  { value: 'bar',       label: 'バー',           preview: '|' },
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
  const config: Record<BridgeStatus, { label: string; color: string; bg: string }> = {
    idle:         { label: '未接続',   color: '#4B5563', bg: '#4B556320' },
    connecting:   { label: '接続中...', color: '#FBBF24', bg: '#FBBF2420' },
    connected:    { label: '接続済み', color: '#4ADE80', bg: '#4ADE8020' },
    disconnected: { label: '切断',     color: '#6B7280', bg: '#6B728020' },
    error:        { label: 'エラー',   color: '#F87171', bg: '#F8717120' },
  };
  const c = config[status];
  return (
    <View style={[statusBadgeStyles.badge, { backgroundColor: c.bg }]}>
      {status === 'connecting' && (
        <ActivityIndicator size="small" color={c.color} style={{ transform: [{ scale: 0.6 }], marginRight: 2 }} />
      )}
      <Text style={[statusBadgeStyles.text, { color: c.color }]}>{c.label}</Text>
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

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function SettingsScreen() {
  const {
    settings, updateSettings,
    sessions, clearSession,
    termuxSettings, updateTermuxSettings,
    bridgeStatus, connectionMode, setConnectionMode,
  } = useTerminalStore();
  const { settings: obsidianSettings, saveSettings: saveObsidianSettings, loadSettings: loadObsidianSettings } = useObsidianStore();
  React.useEffect(() => { loadObsidianSettings(); }, []);
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();

  // Theme engine
  const currentTheme = useTheme();
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
  const [ttyUrlInput, setTtyUrlInput] = useState(termuxSettings.ttyUrl || 'http://localhost:7681');
  const [showImportModal, setShowImportModal] = useState(false);
  const [showImportProjectsModal, setShowImportProjectsModal] = useState(false);
  const [isUpdatingBridge, setIsUpdatingBridge] = useState(false);
  const [bridgeUpdateResult, setBridgeUpdateResult] = useState<'success' | 'fail' | null>(null);
  const [isGeneratingScript, setIsGeneratingScript] = useState(false);

  // Local LLM state
  const [llmUrlInput, setLlmUrlInput] = useState(settings.localLlmUrl);
  const [llmModelInput, setLlmModelInput] = useState(settings.localLlmModel);
  const [isTestingLlm, setIsTestingLlm] = useState(false);
  const [llmTestResult, setLlmTestResult] = useState<'success' | 'fail' | null>(null);

  // llama.cpp model management state
  const [activeModelId, setActiveModelId] = useState<string | null>(settings.localLlmModel ?? null);
  const [installedModelIds, setInstalledModelIds] = useState<Set<string>>(new Set());

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

  const handleSelectModel = (model: LlamaCppModel) => {
    setActiveModelId(model.id);
    updateSettings({ localLlmModel: model.id });
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
  const { snippets } = useSnippetStore();
  const { projects } = useCreatorStore();

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
      Alert.alert('URLエラー', 'ws:// または wss:// で始まるURLを入力してください');
      return;
    }
    updateTermuxSettings({ wsUrl: trimmed });
    Alert.alert('保存完了', `WebSocket URL を更新しました:\n${trimmed}`);
  };

  const handleTtyUrlSave = () => {
    const trimmed = ttyUrlInput.trim();
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
      Alert.alert('URLエラー', 'http:// または https:// で始まるURLを入力してください');
      return;
    }
    updateTermuxSettings({ ttyUrl: trimmed });
    Alert.alert('保存完了', `TTY URL を更新しました:\n${trimmed}`);
  };

  const handleOpenTermux = () => {
    Linking.openURL('com.termux://').catch(() => {
      Linking.openURL('https://play.google.com/store/apps/details?id=com.termux').catch(() => {});
    });
  };

  const handleLlmUrlSave = () => {
    const trimmed = llmUrlInput.trim();
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
      Alert.alert('URLエラー', 'http:// または https:// で始まるURLを入力してください');
      return;
    }
    updateSettings({ localLlmUrl: trimmed });
    Alert.alert('保存完了', `Local LLM URL を更新しました:\n${trimmed}`);
  };

  const handleLlmModelSave = () => {
    const trimmed = llmModelInput.trim();
    if (!trimmed) {
      Alert.alert('エラー', 'モデル名を入力してください');
      return;
    }
    updateSettings({ localLlmModel: trimmed });
    Alert.alert('保存完了', `モデルを更新しました: ${trimmed}`);
  };

  const handleTestLlm = useCallback(async () => {
    setIsTestingLlm(true);
    setLlmTestResult(null);
    try {
      const url = `${settings.localLlmUrl}/api/tags`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(url, { signal: controller.signal }).catch(() => null);
      clearTimeout(timer);
      if (res && res.ok) {
        const data = await res.json().catch(() => null);
        const models: string[] = (data?.models ?? []).map((m: { name: string }) => m.name);
        setLlmTestResult('success');
        Alert.alert(
          'llama-server接続成功 ✓',
          'llama-serverに接続できました。'
        );
      } else {
        setLlmTestResult('fail');
        Alert.alert(
          'llama-server接続失敗',
          `${settings.localLlmUrl} に接続できませんでした。\n\nTermuxでllama-serverが起動しているか確認してください:\n$ llama-server --model ~/models/qwen2.5-3b-instruct-q4_k_m.gguf --port 8080 --host 127.0.0.1`
        );
      }
    } catch {
      setLlmTestResult('fail');
      Alert.alert('llama-server接続失敗', '接続中にエラーが発生しました。');
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
        Alert.alert('接続成功 ✓', 'Termuxブリッジサーバに接続できました。');
      } else {
        Alert.alert(
          '接続失敗',
          `${termuxSettings.wsUrl} に接続できませんでした。\n\nTermuxでブリッジサーバが起動しているか確認してください。`
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
        message: `# Termuxに以下を1行貼り付けてEnter:\n${installCmd}\n\n# 保存後はこれだけでOK:\n# ~/shelly-bridge/start-shelly.sh`,
        title: 'Shelly 起動コマンド',
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
          '一括起動スクリプトを保存しました ✓',
          `start-shelly.sh をTermuxに書き込みました。\n\n次回からはこれだけでOK:\n~/shelly-bridge/start-shelly.sh\n\n(両方停止: Ctrl+C)`
        );
      } else {
        Alert.alert('保存失敗', result.error ?? '不明なエラー');
      }
    } catch {
      Alert.alert('エラー', '予期しないエラーが発生しました。');
    } finally {
      setIsGeneratingScript(false);
    }
  }, [bridgeStatus, writeFile, runRawCommand, activeModelId]);

  const handleUpdateBridge = useCallback(async () => {
    if (bridgeStatus !== 'connected') {
      Alert.alert(
        'Termux未接続',
        'Termuxブリッジに接続してから更新してください。\n\nTermuxで以下を実行してください:\nnode ~/shelly-bridge/bridge.js'
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
          'Bridge更新完了 ✓',
          `server.js v${BRIDGE_SERVER_VERSION} をTermuxに書き込みました。\n\n次のステップ:\n1. Termuxで古いbridgeを停止 (Ctrl+C)\n2. 新しいbridgeを起動:\n   node ~/shelly-bridge/server.js\n3. ShellyのSettings → 接続テスト`
        );
      } else {
        setBridgeUpdateResult('fail');
        Alert.alert('更新失敗', `ファイルの書き込みに失敗しました:\n${result.error}`);
      }
    } catch (e) {
      setBridgeUpdateResult('fail');
      Alert.alert('更新失敗', '予期しないエラーが発生しました。');
    } finally {
      setIsUpdatingBridge(false);
    }
  }, [bridgeStatus, writeFile]);

  const handleExportProjects = useCallback(async () => {
    if (projects.length === 0) {
      Alert.alert('エクスポート', 'プロジェクトがまだないよ。');
      return;
    }
    const ok = await exportProjects(projects);
    if (!ok) {
      Alert.alert('エラー', 'エクスポートできなかったよ。もう一度試してみて。');
    }
  }, [projects]);

  const handleExportSnippets = useCallback(async () => {
    if (snippets.length === 0) {
      Alert.alert('エクスポート', 'スニペットがありません。先にスニペットを保存してください。');
      return;
    }
    const ok = await exportSnippets(snippets);
    if (!ok) {
      Alert.alert('エクスポート', 'キャンセルされました。');
    }
  }, [snippets]);

  const handleExportLog = useCallback(async () => {
    const allBlocks = sessions.flatMap((s) =>
      s.blocks.map((b) => {
        const ts = new Date(b.timestamp).toLocaleString('ja-JP');
        const output = b.output.map((l) => l.text).join('\n');
        const mode = b.connectionMode ? ` [${b.connectionMode}]` : '';
        return `[${ts}]${mode} $ ${b.command}\n${output}`;
      })
    );

    if (allBlocks.length === 0) {
      Alert.alert('エクスポート', 'ログがありません。コマンドを実行してからお試しください。');
      return;
    }

    const logText = [
      '# Shelly Terminal Log',
      `# Export: ${new Date().toLocaleString('ja-JP')}`,
      '# ─────────────────────────────────',
      '',
      ...allBlocks,
    ].join('\n');

    try {
      await Share.share({ message: logText, title: 'Shelly Terminal Log' });
    } catch {
      Alert.alert('エラー', 'ログのエクスポートに失敗しました');
    }
  }, [sessions]);

  const handleClearAll = () => {
    Alert.alert(
      '全セッションをクリア',
      '全てのコマンド履歴を削除しますか？',
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: '削除',
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
        <Text style={styles.headerTitle}>設定</Text>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">

        {/* ── Display ──────────────────────────────────────────────────────── */}
        <SectionHeader title="表示" />

        <SettingRow label="フォントサイズ" description={`現在: ${settings.fontSize}px`}>
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

        <SettingRow label="行間" description={`現在: ${settings.lineHeight.toFixed(1)}×`}>
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

              {/* ── Glass Background ────────────────────────────────────── */}
        <SectionHeader title="ガラス背景" subtitle="壁紙と透明度でターミナルをカスタマイズ" />
        {/* 壁紙選択 */}
        <View style={styles.wsUrlRow}>
          <Text style={styles.wsUrlLabel}>壁紙</Text>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Pressable
              onPress={async () => {
                const result = await ImagePicker.launchImageLibraryAsync({
                  mediaTypes: ['images'],
                  allowsEditing: false,
                  quality: 0.8,
                });
                if (!result.canceled && result.assets[0]) {
                  updateSettings({ wallpaperUri: result.assets[0].uri });
                }
              }}
              style={[styles.actionButton, { borderColor: '#4ADE8033', flex: 1 }]}
            >
              <MaterialIcons name="image" size={18} color="#4ADE80" />
              <Text style={[styles.actionButtonText, { color: '#4ADE80' }]}>
                {settings.wallpaperUri ? '壁紙を変更' : '壁紙を選択'}
              </Text>
            </Pressable>
            {settings.wallpaperUri ? (
              <Pressable
                onPress={() => updateSettings({ wallpaperUri: undefined })}
                style={[styles.actionButton, { borderColor: '#F8717133', flex: 0 }]}
              >
                <MaterialIcons name="delete" size={18} color="#F87171" />
              </Pressable>
            ) : null}
          </View>
          <Text style={styles.wsUrlHint}>
            {settings.wallpaperUri ? '壁紙設定済み — 下の透明度で調整できます' : 'フォトライブラリから画像を選択してください'}
          </Text>
        </View>
        {/* 背景透明度 */}
        <SettingRow
          label="背景透明度"
          description={`ターミナル背景の不透明度: ${Math.round((settings.backgroundOpacity ?? 1.0) * 100)}%`}
        >
          <View style={styles.stepper}>
            <Pressable
              onPress={() => updateSettings({ backgroundOpacity: Math.max(0.1, Math.round(((settings.backgroundOpacity ?? 1.0) - 0.1) * 10) / 10) })}
              style={styles.stepBtn}
            >
              <Text style={styles.stepBtnText}>−</Text>
            </Pressable>
            <Text style={styles.stepValue}>{Math.round((settings.backgroundOpacity ?? 1.0) * 100)}%</Text>
            <Pressable
              onPress={() => updateSettings({ backgroundOpacity: Math.min(1.0, Math.round(((settings.backgroundOpacity ?? 1.0) + 0.1) * 10) / 10) })}
              style={styles.stepBtn}
            >
              <Text style={styles.stepBtnText}>+</Text>
            </Pressable>
          </View>
        </SettingRow>
        {/* ブラー強度 */}
        <SettingRow
          label="ブラー強度"
          description={`壁紙のぼかし具合: ${settings.blurIntensity ?? 0}`}
        >
          <View style={styles.stepper}>
            <Pressable
              onPress={() => updateSettings({ blurIntensity: Math.max(0, (settings.blurIntensity ?? 0) - 5) })}
              style={styles.stepBtn}
            >
              <Text style={styles.stepBtnText}>−</Text>
            </Pressable>
            <Text style={styles.stepValue}>{settings.blurIntensity ?? 0}</Text>
            <Pressable
              onPress={() => updateSettings({ blurIntensity: Math.min(100, (settings.blurIntensity ?? 0) + 5) })}
              style={styles.stepBtn}
            >
              <Text style={styles.stepBtnText}>+</Text>
            </Pressable>
          </View>
        </SettingRow>
        {/* ── Theme ──────────────────────────────────────────────────── */}
        <SectionHeader title="テーマ" />
        <View style={styles.themeOptions}>
          {THEME_OPTIONS.map((theme) => (
            <Pressable
              key={theme.value}
              onPress={() => updateSettings({ themeVariant: theme.value })}
              style={[
                styles.themeOption,
                { backgroundColor: theme.bg },
                settings.themeVariant === theme.value && styles.themeOptionActive,
              ]}
            >
              <Text style={styles.themePreview}>{'> _'}</Text>
              <Text style={styles.themeLabel}>{theme.label}</Text>
              {settings.themeVariant === theme.value && (
                <MaterialIcons name="check-circle" size={16} color="#00D4AA" style={styles.themeCheck} />
              )}
            </Pressable>
          ))}
        </View>

        {/* ── Cursor ───────────────────────────────────────────────────────── */}
        <SectionHeader title="カーソル形状" />
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

        {/* ── Behavior ─────────────────────────────────────────────────────── */}
        <SectionHeader title="動作" />

        <SettingRow label="タップ振動" description="ボタン操作時にバイブレーション">
          <Switch
            value={settings.hapticFeedback}
            onValueChange={(v) => updateSettings({ hapticFeedback: v })}
            trackColor={{ false: '#2D2D2D', true: '#00D4AA50' }}
            thumbColor={settings.hapticFeedback ? '#00D4AA' : '#6B7280'}
          />
        </SettingRow>

        <SettingRow label="自動スクロール" description="出力後に最下部へスクロール">
          <Switch
            value={settings.autoScroll}
            onValueChange={(v) => updateSettings({ autoScroll: v })}
            trackColor={{ false: '#2D2D2D', true: '#00D4AA50' }}
            thumbColor={settings.autoScroll ? '#00D4AA' : '#6B7280'}
          />
        </SettingRow>

        <SettingRow
          label="高コントラスト出力"
          description={settings.highContrastOutput
            ? 'stdout #E8E8E8 / stderr #FF7878 — OLED最適化'
            : 'テーマ依存色（暗い画面では見えにくい場合あり）'}
        >
          <Switch
            value={settings.highContrastOutput ?? true}
            onValueChange={(v) => updateSettings({ highContrastOutput: v })}
            trackColor={{ false: '#2D2D2D', true: '#FBBF2450' }}
            thumbColor={(settings.highContrastOutput ?? true) ? '#FBBF24' : '#6B7280'}
          />
        </SettingRow>

        <SettingRow
          label="体験モード"
          description={
            (settings.experienceMode ?? 'learning') === 'learning'
              ? '学習モード: 安全確認を多く表示・AIによるコマンド解説付き'
              : '高速モード: 確認を最小限に・解説なし（経験者向け）'
          }
        >
          <View style={styles.segmentRow}>
            {(['learning', 'fast'] as const).map((mode) => (
              <Pressable key={mode} style={[styles.segmentBtn,
                (settings.experienceMode ?? 'learning') === mode && styles.segmentBtnActive,
              ]} onPress={() => updateSettings({ experienceMode: mode })}>
                <Text style={[styles.segmentBtnText,
                  (settings.experienceMode ?? 'learning') === mode && styles.segmentBtnTextActive,
                ]}>{mode === 'learning' ? '学習' : '高速'}</Text>
              </Pressable>
            ))}
          </View>
        </SettingRow>

        {/* ── Sound & Effects ─────────────────────────────────────────────── */}
        <SectionHeader title="サウンド＆エフェクト" />

        <SettingRow label="効果音" description="UI操作時のサウンドフィードバック">
          <Switch
            value={settings.soundEffects ?? true}
            onValueChange={(v) => updateSettings({ soundEffects: v })}
            trackColor={{ false: '#2D2D2D', true: '#00D4AA50' }}
            thumbColor={(settings.soundEffects ?? true) ? '#00D4AA' : '#6B7280'}
          />
        </SettingRow>

        <SettingRow label="音量" description={`${Math.round((settings.soundVolume ?? 0.6) * 100)}%`}>
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

        {/* ── Termux Bridge ─────────────────────────────────────────────────── */}
        <SectionHeader
          title="Termux連携"
          subtitle="WebSocket経由でTermuxの実シェルに接続します"
        />

        {/* Status row */}
        <View style={styles.termuxStatusRow}>
          <Text style={styles.termuxStatusLabel}>接続状態</Text>
          <BridgeStatusBadge status={bridgeStatus} />
        </View>

        {/* Current mode */}
        <View style={styles.termuxStatusRow}>
          <Text style={styles.termuxStatusLabel}>現在のモード</Text>
          <View style={styles.modeChips}>
            {(['termux', 'disconnected'] as const).map((m) => (
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
                  {m === 'termux' ? 'Termux' : 'Off'}
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
              <Text style={styles.wsUrlSaveBtnText}>保存</Text>
            </Pressable>
          </View>
          <Text style={styles.wsUrlHint}>
            Termux側で起動するブリッジサーバのURL。{'\n'}
            同一端末の場合は ws://127.0.0.1:8765 のまま使用できます。{'\n'}
            起動コマンド: node ~/shelly-bridge/server.js
          </Text>
        </View>

        {/* Auto-reconnect */}
        <SettingRow label="自動再接続" description="切断時に自動で再接続を試みる（最大5回）">
          <Switch
            value={termuxSettings.autoReconnect}
            onValueChange={(v) => updateTermuxSettings({ autoReconnect: v })}
            trackColor={{ false: '#2D2D2D', true: '#93C5FD50' }}
            thumbColor={termuxSettings.autoReconnect ? '#93C5FD' : '#6B7280'}
          />
        </SettingRow>

        {/* Timeout */}
        <SettingRow label="タイムアウト" description={`コマンド実行タイムアウト: ${termuxSettings.timeoutSeconds}秒`}>
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

        {/* TTY URL (ttyd) */}
        <View style={styles.wsUrlRow}>
          <Text style={styles.wsUrlLabel}>TTY URL (ttyd)</Text>
          <View style={styles.wsUrlInputRow}>
            <TextInput
              style={[styles.wsUrlInput, { color: '#00D4AA' }]}
              value={ttyUrlInput}
              onChangeText={setTtyUrlInput}
              placeholder="http://localhost:7681"
              placeholderTextColor="#3D4451"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="done"
              onSubmitEditing={handleTtyUrlSave}
            />
            <Pressable onPress={handleTtyUrlSave} style={[styles.wsUrlSaveBtn, { borderColor: '#00D4AA44', backgroundColor: '#00D4AA18' }]}>
              <Text style={[styles.wsUrlSaveBtnText, { color: '#00D4AA' }]}>保存</Text>
            </Pressable>
          </View>
          <Text style={styles.wsUrlHint}>
            ttyd -W -p 7681 bash & で起動するttydのURL。{'\n'}
            TTYタブでWebViewに表示されるアドレスです。
          </Text>
        </View>

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
            {isTesting ? '接続テスト中...' :
             testResult === 'success' ? '接続成功' :
             testResult === 'fail' ? '接続失敗' :
             '接続テスト'}
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
            {isUpdatingBridge ? 'Bridge更新中...' :
             bridgeUpdateResult === 'success' ? '更新完了 (再起動してください)' :
             bridgeUpdateResult === 'fail' ? '更新失敗' :
             `Bridgeを最新版に更新 (v${BRIDGE_SERVER_VERSION})`}
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
            {isGeneratingScript ? 'スクリプト生成中...' :
             bridgeStatus === 'connected' ? '一括起動スクリプトを保存 (start-shelly.sh)' :
             '一括起動スクリプトを共有'}
          </Text>
          {!isGeneratingScript && <MaterialIcons name="chevron-right" size={18} color="#6B7280" />}
        </Pressable>
        <Text style={[styles.wsUrlHint, { marginHorizontal: 16, marginTop: -4, marginBottom: 8 }]}>
          llama-server + shelly-bridge を1コマンドで起動。マルチウィンド不要。{'\n'}
          接続済なら自動保存、未接続なら内容を共有します。
        </Text>

        {/* Open Termux button */}
        <Pressable
          onPress={handleOpenTermux}
          style={[styles.actionButton, { borderColor: '#4ADE8033' }]}
        >
          <MaterialIcons name="open-in-new" size={18} color="#4ADE80" />
          <Text style={[styles.actionButtonText, { color: '#4ADE80' }]}>
            Termux を開く
          </Text>
          <MaterialIcons name="chevron-right" size={18} color="#6B7280" />
        </Pressable>

        {/* ── Local LLM (Ollama) ─────────────────────────────────────────── */}
        <SectionHeader
          title="ローカルLLM (llama-server)"
          subtitle="Termux上のllama-serverをAIチャットに使用します"
        />

        <SettingRow
          label="ローカルLLMを使用"
          description={settings.localLlmEnabled
            ? '有効: 基本チャットはllama-serverで処理（Claude/Geminiのクレジット節約）'
            : '無効: すべてのAIタスクをClaude Code / Gemini CLIに送信'}
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
              <Text style={[styles.wsUrlSaveBtnText, { color: '#A78BFA' }]}>保存</Text>
            </Pressable>
          </View>
          <Text style={styles.wsUrlHint}>
            Termux側で起動するllama-serverのURL。{`\n`}
            同一端末の場合は http://127.0.0.1:8080 のまま使用できます。
          </Text>
        </View>

        {/* Model name */}
        <View style={styles.wsUrlRow}>
          <Text style={styles.wsUrlLabel}>モデル名</Text>
          <View style={styles.wsUrlInputRow}>
            <TextInput
              style={[styles.wsUrlInput, { color: '#A78BFA' }]}
              value={llmModelInput}
              onChangeText={setLlmModelInput}
              placeholder="qwen2.5-3b-instruct-q4_k_m"
              placeholderTextColor="#3D4451"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={handleLlmModelSave}
            />
            <Pressable onPress={handleLlmModelSave} style={[styles.wsUrlSaveBtn, { borderColor: '#A78BFA44', backgroundColor: '#A78BFA18' }]}>
              <Text style={[styles.wsUrlSaveBtnText, { color: '#A78BFA' }]}>保存</Text>
            </Pressable>
          </View>
          <Text style={styles.wsUrlHint}>
            使用するGGUFモデル名。例: qwen2.5-3b-instruct-q4_k_m, qwen2.5-7b-instruct-q3_k_m{`\n`}
            ※ 下のモデルカタログからファイル名をコピーして使用してください。
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
            {isTestingLlm ? 'llama-server接続テスト中...' :
             llmTestResult === 'success' ? 'llama-server接続成功' :
             llmTestResult === 'fail' ? 'llama-server接続失敗' :
             'llama-server接続テスト'}
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

        {/* ── MCP Servers ─────────────────────────────────────────────────── */}
        <SectionHeader
          title="MCP Servers"
          subtitle="Claude Codeのコンテキストを強化するサーバー群"
        />
        <McpSection
          isConnected={bridgeStatus === 'connected'}
          onRunCommand={handleRunCommandForSetup}
        />

        {/* ── Custom Context ────────────────────────────────────────────── */}
        <SectionHeader
          title="カスタムコンテキスト"
          subtitle="ローカルLLMに自動注入されるMD。設計思想やルールを記述"
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
              {customContextSaved ? '保存済み' : '保存する'}
            </Text>
          </Pressable>
          <Text style={[styles.wsUrlHint, { marginTop: 4 }]}>
            LLMをONにした時、ここの内容がシステムプロンプトに自動追加されます
          </Text>
        </View>

        {/* ── CLI Auto-Approve ──────────────────────────────────────────── */}
        <SectionHeader
          title="CLI自動承認"
          subtitle="Chatタブ経由でClaude Code/Geminiを使う時の権限承認"
        />
        <View style={styles.wsUrlRow}>
          {(['none', 'safe', 'all'] as const).map((level) => {
            const labels: Record<string, { title: string; desc: string }> = {
              none: { title: '全て手動', desc: '毎回確認する（安全）' },
              safe: { title: '読み取りのみ自動', desc: 'ファイル読み取りは自動承認' },
              all: { title: '全自動', desc: '全て自動承認（上級者向け）' },
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
                onPress={() => updateSettings({ autoApproveLevel: level })}
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

            {/* ── Perplexity API ─────────────────────────────────────────────── */}
        <SectionHeader
          title="Perplexity API"
          subtitle="論文・ウェブ検索。@perplexity で呼び出す"
        />

        <View style={styles.wsUrlRow}>
          <Text style={styles.wsUrlLabel}>APIキー</Text>
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
              ? `✓ 設定済み — @perplexity 論文検索で利用可能`
              : `https://www.perplexity.ai/settings/api で取得`
            }
          </Text>
        </View>

        <View style={styles.wsUrlRow}>
          <Text style={styles.wsUrlLabel}>モデル</Text>
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
            sonar-reasoning-pro (論文向き) / sonar-pro (汎用) / sonar (軽量・高速)
          </Text>
        </View>

        {/* ── Gemini API ─────────────────────────────────────────────── */}
        <SectionHeader
          title="Gemini API"
          subtitle="Google AI。@gemini で呼び出す"
        />
        <View style={styles.wsUrlRow}>
          <Text style={styles.wsUrlLabel}>APIキー</Text>
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
              ? `✓ 設定済み — @gemini で利用可能`
              : `https://aistudio.google.com/app/apikey で取得（無料）`
            }
          </Text>
        </View>
        <View style={styles.wsUrlRow}>
          <Text style={styles.wsUrlLabel}>モデル</Text>
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
            gemini-2.0-flash (高速・推奨) / gemini-2.5-pro (高精度)
          </Text>
        </View>
           {/* ── @team Table ────────────────────────────────────────── */}
        <SectionHeader title="@team Table" subtitle="複数AIに同じ質問を投げてローカルLLMが結果を統合" />
        <View style={styles.wsUrlRow}>
          <View style={{ gap: 12 }}>
            {([
              { key: 'claude' as const, label: 'Claude CLI', desc: 'Claude Pro/Maxプラン必須', color: '#F59E0B' },
              { key: 'gemini' as const, label: 'Gemini CLI', desc: 'Gemini Advanced推奨', color: '#3B82F6' },
              { key: 'codex' as const, label: 'Codex CLI', desc: 'ChatGPT Plus/Pro必須', color: '#10B981' },
              { key: 'perplexity' as const, label: 'Perplexity API', desc: '最新情報・ソース付き回答', color: '#20B2AA' },
              { key: 'local' as const, label: 'Local LLM (ファシリ)', desc: '起動中の場合自動でファシリ役', color: '#8B5CF6' },
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
          <Text style={styles.wsUrlLabel}>Codex CLIコマンド名</Text>
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
          <Text style={styles.wsUrlHint}>Termuxでの codex コマンド名（通常は "codex" のまま）</Text>
        </View>
        {/* ── Obsidian ────────────────────────────────────────────── */}
        <SectionHeader title="Obsidian" subtitle="自動収集・知識管理の設定" />
        <View style={styles.wsUrlRow}>
          <Text style={styles.wsUrlLabel}>Vault Path</Text>
          <View style={styles.wsUrlInputRow}>
            <TextInput
              style={[styles.wsUrlInput, { color: '#A78BFA' }]}
              value={obsidianSettings.vaultPath}
              onChangeText={(v) => saveObsidianSettings({ vaultPath: v.trim() })}
              placeholder="/storage/emulated/0/ObsidianVault"
              placeholderTextColor="#4B5563"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
            />
          </View>
          <Text style={styles.wsUrlHint}>
            Obsidian Vaultのフルパス。収集した記事・論文はここに保存されます。
          </Text>
        </View>
        <SettingRow label="自動収集" description="毎朝指定時刻に記事・論文を自動収集">
          <Pressable
            style={[styles.segmentBtn, obsidianSettings.autoCollectEnabled && styles.segmentBtnActive]}
            onPress={() => saveObsidianSettings({ autoCollectEnabled: !obsidianSettings.autoCollectEnabled })}
          >
            <Text style={[styles.segmentBtnText, obsidianSettings.autoCollectEnabled && styles.segmentBtnTextActive]}>
              {obsidianSettings.autoCollectEnabled ? 'ON' : 'OFF'}
            </Text>
          </Pressable>
        </SettingRow>
        <SettingRow label="収集時刻" description="自動収集を実行する時刻（例: 6:00）">
          <View style={styles.stepper}>
            <Pressable onPress={() => saveObsidianSettings({ collectTimeHour: Math.max(0, obsidianSettings.collectTimeHour - 1) })} style={styles.stepBtn}>
              <Text style={styles.stepBtnText}>−</Text>
            </Pressable>
            <Text style={styles.stepValue}>{String(obsidianSettings.collectTimeHour).padStart(2, '0')}:00</Text>
            <Pressable onPress={() => saveObsidianSettings({ collectTimeHour: Math.min(23, obsidianSettings.collectTimeHour + 1) })} style={styles.stepBtn}>
              <Text style={styles.stepBtnText}>+</Text>
            </Pressable>
          </View>
        </SettingRow>
        <SettingRow label="1日最大件数" description="収集する記事・論文の最大件数">
          <View style={styles.stepper}>
            <Pressable onPress={() => saveObsidianSettings({ maxItemsPerDay: Math.max(3, obsidianSettings.maxItemsPerDay - 1) })} style={styles.stepBtn}>
              <Text style={styles.stepBtnText}>−</Text>
            </Pressable>
            <Text style={styles.stepValue}>{obsidianSettings.maxItemsPerDay}件</Text>
            <Pressable onPress={() => saveObsidianSettings({ maxItemsPerDay: Math.min(30, obsidianSettings.maxItemsPerDay + 1) })} style={styles.stepBtn}>
              <Text style={styles.stepBtnText}>+</Text>
            </Pressable>
          </View>
        </SettingRow>
        <SettingRow label="収集期間" description="過去N日以内の記事・論文のみ収集">
          <View style={styles.stepper}>
            <Pressable onPress={() => saveObsidianSettings({ daysBack: Math.max(7, obsidianSettings.daysBack - 7) })} style={styles.stepBtn}>
              <Text style={styles.stepBtnText}>−</Text>
            </Pressable>
            <Text style={styles.stepValue}>{obsidianSettings.daysBack}日</Text>
            <Pressable onPress={() => saveObsidianSettings({ daysBack: Math.min(90, obsidianSettings.daysBack + 7) })} style={styles.stepBtn}>
              <Text style={styles.stepBtnText}>+</Text>
            </Pressable>
          </View>
        </SettingRow>
        {obsidianSettings.lastCollectedAt && (
          <Text style={[styles.wsUrlHint, { paddingHorizontal: 16, paddingBottom: 8 }]}>
            最終収集: {new Date(obsidianSettings.lastCollectedAt).toLocaleString('ja-JP')}
          </Text>
        )}
        {/* ── Snippets ────────────────────────────────────────────────── */}
        <SectionHeader title="スニペット"subtitle="コマンド資産の実行方式を設定します" />

        <SettingRow
          label="実行方式"
          description={settings.snippetRunMode === 'insertAndRun' ? '▶ タップで即実行' : '✎ 入力欄に挿入のみ'}
        >
          <View style={styles.segmentRow}>
            {(['insertAndRun', 'insertOnly'] as const).map((mode) => (
              <Pressable
                key={mode}
                style={[styles.segmentBtn, settings.snippetRunMode === mode && styles.segmentBtnActive]}
                onPress={() => updateSettings({ snippetRunMode: mode })}
              >
                <Text style={[styles.segmentBtnText, settings.snippetRunMode === mode && styles.segmentBtnTextActive]}>
                  {mode === 'insertAndRun' ? '即実行' : '挿入のみ'}
                </Text>
              </Pressable>
            ))}
          </View>
        </SettingRow>

        <SettingRow label="Terminal画面に戻る" description="スニペット実行後にTerminalタブへ自動遷移">
          <Switch
            value={settings.snippetAutoReturn}
            onValueChange={(v) => updateSettings({ snippetAutoReturn: v })}
            trackColor={{ false: '#2D2D2D', true: '#00D4AA44' }}
            thumbColor={settings.snippetAutoReturn ? '#00D4AA' : '#6B7280'}
          />
        </SettingRow>

        {/* ── Snippets Backup ───────────────────────────────────────────── */}
        <SectionHeader
          title="スニペットバックアップ"
          subtitle={`${snippets.length} 件のスニペットを管理`}
        />

        <Pressable onPress={handleExportSnippets} style={styles.actionButton}>
          <MaterialIcons name="upload" size={18} color="#00D4AA" />
          <Text style={styles.actionButtonText}>
            スニペットをエクスポート（JSON共有）
          </Text>
          <MaterialIcons name="chevron-right" size={18} color="#6B7280" />
        </Pressable>

        <Pressable onPress={() => setShowImportModal(true)} style={styles.actionButton}>
          <MaterialIcons name="download" size={18} color="#60A5FA" />
          <Text style={[styles.actionButtonText, { color: '#60A5FA' }]}>
            スニペットをインポート（JSONから読み込み）
          </Text>
          <MaterialIcons name="chevron-right" size={18} color="#6B7280" />
        </Pressable>

        {/* ── Projects Backup ──────────────────────────────────────────── */}
        <SectionHeader
          title="プロジェクトバックアップ"
          subtitle={`${projects.length} 件のプロジェクトを管理`}
        />

        <Pressable onPress={handleExportProjects} style={styles.actionButton}>
          <MaterialIcons name="upload" size={18} color="#00D4AA" />
          <Text style={styles.actionButtonText}>
            プロジェクトをエクスポート（JSON共有）
          </Text>
          <MaterialIcons name="chevron-right" size={18} color="#6B7280" />
        </Pressable>

        <Pressable onPress={() => setShowImportProjectsModal(true)} style={styles.actionButton}>
          <MaterialIcons name="download" size={18} color="#60A5FA" />
          <Text style={[styles.actionButtonText, { color: '#60A5FA' }]}>
            プロジェクトをインポート（JSONから読み込み）
          </Text>
          <MaterialIcons name="chevron-right" size={18} color="#6B7280" />
        </Pressable>

        {/* ── Data ─────────────────────────────────────────────────────────── */}
        <SectionHeader title="データ" />

        <Pressable onPress={handleExportLog} style={styles.actionButton}>
          <MaterialIcons name="share" size={18} color="#00D4AA" />
          <Text style={styles.actionButtonText}>ログをエクスポート（テキスト共有）</Text>
          <MaterialIcons name="chevron-right" size={18} color="#6B7280" />
        </Pressable>

        <Pressable onPress={handleClearAll} style={[styles.actionButton, styles.dangerButton]}>
          <MaterialIcons name="delete-sweep" size={18} color="#F87171" />
          <Text style={[styles.actionButtonText, styles.dangerText]}>全履歴を削除</Text>
          <MaterialIcons name="chevron-right" size={18} color="#6B7280" />
        </Pressable>

        {/* ── Theme Engine (New) ──────────────────────────────────────────── */}
        <SectionHeader title={t('settings.theme') + ' (Engine)'} subtitle="WezTerm-style full color themes" />
        <View style={styles.themeOptions}>
          {allThemes.map((th) => (
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
            {dotfiles.pat ? '✓ PAT設定済み' : t('dotfiles.pat_required')}
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

        {/* ── Onboarding / Setup Reset ──────────────────────────────────── */}
        <Pressable
          onPress={async () => {
            await resetOnboarding();
            Alert.alert('OK', 'Onboarding will show on next launch.');
          }}
          style={styles.actionButton}
        >
          <MaterialIcons name="replay" size={18} color="#6B7280" />
          <Text style={[styles.actionButtonText, { color: '#6B7280' }]}>Reset Onboarding</Text>
          <MaterialIcons name="chevron-right" size={18} color="#6B7280" />
        </Pressable>

        <Pressable
          onPress={async () => {
            await resetSetupWizard();
            Alert.alert('OK', t('settings.rerun_setup'));
          }}
          style={styles.actionButton}
        >
          <MaterialIcons name="build" size={18} color="#60A5FA" />
          <Text style={[styles.actionButtonText, { color: '#60A5FA' }]}>{t('settings.rerun_setup')}</Text>
          <MaterialIcons name="chevron-right" size={18} color="#6B7280" />
        </Pressable>

        {/* ── About ────────────────────────────────────────────────────────── */}
        <SectionHeader title="このアプリについて" />
        <View style={styles.aboutCard}>
          <Text style={styles.aboutTitle}>Shelly (Unofficial)</Text>
          <Text style={styles.aboutVersion}>Version 4.2.0 — Termux Bridge + Local LLM + @team + Browser</Text>
          <Text style={styles.aboutDesc}>
            Samsung Galaxy Z Fold6向けに設計されたターミナルアプリのプロトタイプです。
            日本語IME対応、コマンドブロックUI、ショートカットバー、Termux WebSocket連携、4層AIルーティング（@claude / @gemini / @local / @team / @open）、LLM出力通訳、インアプリブラウザを搭載しています。
          </Text>
          <Text style={styles.aboutNote}>
            ※ Termux連携にはshelly-bridgeサーバが必要です。
          </Text>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Import Modal */}
      <ImportModal
        visible={showImportModal}
        onClose={() => setShowImportModal(false)}
      />
      <ImportProjectsModal
        visible={showImportProjectsModal}
        onClose={() => setShowImportProjectsModal(false)}
      />
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
    </View>
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
