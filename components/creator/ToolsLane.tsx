/**
 * components/creator/ToolsLane.tsx — v2.4.2
 *
 * Tools（CLI）モードのUI。
 * - CLI選択（Claude Code / Gemini CLI / カスタム）
 * - 対象プロジェクト選択（最後に開いたプロジェクト or 履歴から選択）
 * - 自然言語入力
 * - 依存確認・実行・キャンセル
 * - 結果表示（自然言語サマリ + 次のアクション）
 * - Local LLM (Ollama) 状態表示・AI Orchestration連携
 */
import React, { useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Platform,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import {
  CliTool,
  CLI_TOOLS,
  CliRunPlan,
  CliRunResult,
  CliCheckResult,
  buildCliCommand,
  interpretCheckResult,
  parseCliResult,
  maskSecrets,
} from '@/lib/cli-runner';
import {
  orchestrateTask,
  getCategoryLabel,
  getHandlerLabel,
  type OrchestrationResult,
  type LocalLlmConfig,
  type OllamaMessage,
} from '@/lib/local-llm';
import { CreatorProject } from '@/store/types';

// ─── Types ────────────────────────────────────────────────────────────────────

type ToolsStatus =
  | 'idle'
  | 'checking'      // 依存確認中
  | 'check_failed'  // 依存未導入
  | 'needs_auth'    // 認証が必要
  | 'ready'         // 実行可能
  | 'running'       // 実行中
  | 'done'          // 完了
  | 'error'         // エラー
  | 'cancelled';    // キャンセル済み

interface LogEntry {
  id: string;
  type: 'info' | 'stdout' | 'stderr' | 'system';
  text: string;
  timestamp: number;
}

interface ToolsLaneProps {
  /** 最後に開いたプロジェクト（デフォルトターゲット） */
  lastProject: CreatorProject | null;
  /** 全プロジェクト一覧（ターゲット選択用） */
  projects: CreatorProject[];
  /** Termux接続状態 */
  termuxConnected: boolean;
  /** コマンド実行（Termux bridge経由） */
  onRunCommand: (
    command: string,
    opts?: {
      cwd?: string;
      env?: Record<string, string>;
      onStream?: (type: 'stdout' | 'stderr', data: string) => void;
      timeoutMs?: number;
    }
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** キャンセル */
  onCancel: () => void;
  /** Terminalタブに送る */
  onSendToTerminal: (command: string) => void;
  /** Termux Bridge接続テスト */
  onTestConnection?: () => Promise<boolean>;
  /** Local LLM設定 */
  localLlmConfig?: LocalLlmConfig;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ToolsLane({
  lastProject,
  projects,
  termuxConnected,
  onRunCommand,
  onCancel,
  onSendToTerminal,
  onTestConnection,
  localLlmConfig,
}: ToolsLaneProps) {
  const [selectedTool, setSelectedTool] = useState<CliTool>('claude');
  const [userInput, setUserInput] = useState('');
  const [customCommand, setCustomCommand] = useState('');
  const [targetProject, setTargetProject] = useState<CreatorProject | null>(lastProject);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [status, setStatus] = useState<ToolsStatus>('idle');
  const [checkResult, setCheckResult] = useState<CliCheckResult | null>(null);
  const [runResult, setRunResult] = useState<CliRunResult | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [currentPlan, setCurrentPlan] = useState<CliRunPlan | null>(null);
  const cancelledRef = useRef(false);
  const [bridgeCheckStatus, setBridgeCheckStatus] = useState<'idle' | 'checking' | 'ok' | 'fail'>('idle');
  const [_orchestrationResult, setOrchestrationResult] = useState<OrchestrationResult | null>(null);
  const [localLlmStatus, setLocalLlmStatus] = useState<'idle' | 'thinking' | 'done' | 'error'>('idle');
  const [conversationHistory, setConversationHistory] = useState<OllamaMessage[]>([]);

  const handleBridgeCheck = useCallback(async () => {
    if (!onTestConnection) return;
    setBridgeCheckStatus('checking');
    const ok = await onTestConnection();
    setBridgeCheckStatus(ok ? 'ok' : 'fail');
    setTimeout(() => setBridgeCheckStatus('idle'), 3000);
  }, [onTestConnection]);

  const addLog = useCallback((type: LogEntry['type'], text: string) => {
    setLogs((prev) => [
      ...prev,
      { id: `${Date.now()}-${Math.random()}`, type, text: maskSecrets(text), timestamp: Date.now() },
    ]);
  }, []);

  const clearLogs = useCallback(() => {
    setLogs([]);
    setRunResult(null);
    setCheckResult(null);
    setCurrentPlan(null);
    cancelledRef.current = false;
  }, []);

  // ── Local LLM Orchestration ─────────────────────────────────────────────────

  const _handleOrchestrate = useCallback(async () => {
    const input = userInput.trim();
    if (!input) return;

    const config = localLlmConfig ?? { baseUrl: 'http://127.0.0.1:11434', model: 'llama3.2:3b', enabled: false };

    setLocalLlmStatus('thinking');
    setOrchestrationResult(null);
    clearLogs();
    addLog('system', `Classifying task: "${input.slice(0, 50)}${input.length > 50 ? '…' : ''}"`);

    try {
      const result = await orchestrateTask(input, config, conversationHistory);
      setOrchestrationResult(result);

      if (result.handledBy === 'local_llm' && result.response) {
        // Local LLMが直接回答した場合
        setLocalLlmStatus('done');
        addLog('info', `[${getHandlerLabel(result.handledBy)}] ${getCategoryLabel(result.category)}`);
        addLog('stdout', result.response);
        // 会話履歴に追加
        setConversationHistory((prev) => [
          ...prev,
          { role: 'user', content: input },
          { role: 'assistant', content: result.response! },
        ]);
        setStatus('done');
      } else if (result.delegatedCommand) {
        // Claude/Gemini/Termuxに委譲
        setLocalLlmStatus('done');
        addLog('info', `[${getHandlerLabel(result.handledBy)}] ${getCategoryLabel(result.category)} → ${result.reasoning}`);

        if (result.handledBy === 'termux') {
          // Termux直接実行
          onSendToTerminal(result.delegatedCommand);
          addLog('system', `Sent to Terminal: ${result.delegatedCommand}`);
          setStatus('done');
        } else {
          // Claude/GeminiはTermux経由で実行
          if (!termuxConnected) {
            addLog('stderr', `${getHandlerLabel(result.handledBy)} requires Termux Bridge connection.`);
            setStatus('error');
            return;
          }
          setStatus('running');
          addLog('system', `Running: ${result.delegatedCommand}`);
          const execResult = await onRunCommand(result.delegatedCommand);
          if (execResult.stdout) addLog('stdout', execResult.stdout);
          if (execResult.stderr) addLog('stderr', execResult.stderr);
          setStatus(execResult.exitCode === 0 ? 'done' : 'error');
        }
      }
    } catch (e) {
      setLocalLlmStatus('error');
      setStatus('error');
      addLog('stderr', `Orchestration error: ${e}`);
    }
  }, [userInput, localLlmConfig, conversationHistory, termuxConnected, onRunCommand, onSendToTerminal, clearLogs, addLog]);

  // ── Dependency Check ────────────────────────────────────────────────────────

  const handleCheck = useCallback(async () => {
    if (!termuxConnected) {
      Alert.alert(
        'Termux not connected',
        'Connect to Termux bridge first.\nSet WebSocket URL in Settings.',
      );
      return;
    }

    const config = CLI_TOOLS[selectedTool];
    if (selectedTool === 'custom') {
      setStatus('ready');
      return;
    }

    setStatus('checking');
    clearLogs();
    addLog('system', `${config.label}Checking availability...`);

    try {
      const result = await onRunCommand(config.checkCommand);
      const check = interpretCheckResult(selectedTool, result.exitCode, result.stdout);
      setCheckResult(check);

      if (!check.available) {
        setStatus('check_failed');
        addLog('system', check.message);
      } else if (check.needsAuth) {
        setStatus('needs_auth');
        addLog('system', check.message);
      } else {
        setStatus('ready');
        addLog('system', check.message);
      }
    } catch (e) {
      setStatus('check_failed');
      addLog('stderr', `Error during check: ${e}`);
    }
  }, [termuxConnected, selectedTool, onRunCommand, clearLogs, addLog]);

  // ── Run ─────────────────────────────────────────────────────────────────────

  const handleRun = useCallback(async () => {
    if (!userInput.trim() && selectedTool !== 'custom') return;
    if (!termuxConnected) {
      Alert.alert('Termux not connected', 'Connect to Termux bridge first.');
      return;
    }

    const targetPath = targetProject
      ? `~/Projects/${targetProject.path}`
      : '~/Projects';

    const plan = buildCliCommand({
      tool: selectedTool,
      userInput: userInput.trim() || customCommand.trim(),
      targetPath,
      customCommand: selectedTool === 'custom' ? customCommand.trim() : undefined,
    });
    setCurrentPlan(plan);

    // Confirmation for destructive operations
    if (plan.requiresConfirmation) {
      const confirmed = await new Promise<boolean>((resolve) => {
        Alert.alert(
          'Confirm',
          plan.confirmationMessage ?? 'Execute this operation?',
          [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
            { text: 'Execute', style: 'destructive', onPress: () => resolve(true) },
          ],
        );
      });
      if (!confirmed) return;
    }

    // Interactive fallback warning
    if (plan.isInteractiveFallback) {
      const proceed = await new Promise<boolean>((resolve) => {
        Alert.alert(
          'Interactive mode may be needed',
          plan.fallbackSuggestion ?? 'This operation may require interactive mode. Continue?',
          [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
            { text: 'Try anyway', onPress: () => resolve(true) },
            {
              text: 'Open in Terminal',
              onPress: () => {
                onSendToTerminal(plan.command);
                resolve(false);
              },
            },
          ],
        );
      });
      if (!proceed) return;
    }

    // Execute
    cancelledRef.current = false;
    setStatus('running');
    clearLogs();
    addLog('info', plan.naturalDescription);
    addLog('system', `Running: ${plan.command}`);

    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }

    try {
      const result = await onRunCommand(plan.command);

      if (cancelledRef.current) {
        setStatus('cancelled');
        addLog('system', 'Cancelled.');
        return;
      }

      const parsed = parseCliResult(
        selectedTool,
        userInput.trim(),
        result.stdout,
        result.stderr,
        result.exitCode,
      );
      setRunResult(parsed);

      if (result.stdout) addLog('stdout', result.stdout);
      if (result.stderr) addLog('stderr', result.stderr);

      setStatus(parsed.success ? 'done' : 'error');

      if (Platform.OS !== 'web') {
        if (parsed.success) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } else {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        }
      }
    } catch (e) {
      if (cancelledRef.current) {
        setStatus('cancelled');
        addLog('system', 'Cancelled.');
      } else {
        setStatus('error');
        addLog('stderr', `Execution error: ${e}`);
      }
    }
  }, [
    userInput, customCommand, selectedTool, targetProject, termuxConnected,
    onRunCommand, onSendToTerminal, clearLogs, addLog,
  ]);

  const handleCancel = useCallback(() => {
    cancelledRef.current = true;
    onCancel();
    setStatus('cancelled');
    addLog('system', 'Cancelling...');
  }, [onCancel, addLog]);

  const handleReset = useCallback(() => {
    setStatus('idle');
    setUserInput('');
    setCustomCommand('');
    setOrchestrationResult(null);
    setLocalLlmStatus('idle');
    clearLogs();
  }, [clearLogs]);

  // ── Render ──────────────────────────────────────────────────────────────────

  const isLocalLlmEnabled = localLlmConfig?.enabled ?? false;

  return (
    <View style={styles.container}>
      {/* Local LLM Status Banner */}
      {isLocalLlmEnabled && (
        <View style={styles.llmBanner}>
          <View style={[styles.llmDot, localLlmStatus === 'thinking' ? styles.llmDotThinking : styles.llmDotReady]} />
          <Text style={styles.llmBannerText}>
            {localLlmStatus === 'thinking'
              ? `Local LLM (${localLlmConfig?.model}) thinking...`
              : `Local LLM (${localLlmConfig?.model}) ready`}
          </Text>
          {conversationHistory.length > 0 && (
            <Pressable
              onPress={() => setConversationHistory([])}
              style={styles.llmClearBtn}
            >
              <Text style={styles.llmClearBtnText}>Clear history</Text>
            </Pressable>
          )}
        </View>
      )}

      {/* Tool Selector */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>▸ Select CLI tool</Text>
        <View style={styles.toolRow}>
          {(['claude', 'gemini', 'custom'] as CliTool[]).map((tool) => (
            <Pressable
              key={tool}
              style={[styles.toolBtn, selectedTool === tool && styles.toolBtnActive]}
              onPress={() => {
                setSelectedTool(tool);
                setStatus('idle');
                clearLogs();
              }}
            >
              <Text style={[styles.toolBtnText, selectedTool === tool && styles.toolBtnTextActive]}>
                {CLI_TOOLS[tool].label}
              </Text>
              <Text style={styles.toolBtnDesc}>{CLI_TOOLS[tool].description}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* Target Project */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>▸ Target folder</Text>
        <Pressable
          style={styles.targetBtn}
          onPress={() => setShowProjectPicker(!showProjectPicker)}
        >
          <Text style={styles.targetBtnText}>
            {targetProject
              ? `~/Projects/${targetProject.path}`
              : '~/Projects (no folder selected)'}
          </Text>
          <Text style={styles.targetBtnChevron}>{showProjectPicker ? '▲' : '▼'}</Text>
        </Pressable>

        {showProjectPicker && (
          <View style={styles.projectPicker}>
            <Pressable
              style={styles.projectPickerItem}
              onPress={() => {
                setTargetProject(null);
                setShowProjectPicker(false);
              }}
            >
              <Text style={styles.projectPickerItemText}>~/Projects (no folder selected)</Text>
            </Pressable>
            {projects.slice(0, 20).map((p) => (
              <Pressable
                key={p.id}
                style={[styles.projectPickerItem, targetProject?.id === p.id && styles.projectPickerItemActive]}
                onPress={() => {
                  setTargetProject(p);
                  setShowProjectPicker(false);
                }}
              >
                <Text style={styles.projectPickerItemText}>
                  ~/Projects/{p.path}
                </Text>
                {p.tags && p.tags.length > 0 && (
                  <Text style={styles.projectPickerItemTags}>
                    {p.tags.slice(0, 3).join(', ')}
                  </Text>
                )}
              </Pressable>
            ))}
          </View>
        )}
      </View>

      {/* Input */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>
          {selectedTool === 'custom' ? '▸ Enter command' : '▸ Describe what you want (natural language OK)'}
        </Text>
        {selectedTool === 'custom' ? (
          <TextInput
            style={styles.input}
            value={customCommand}
            onChangeText={setCustomCommand}
            placeholder="e.g. ls -la / cat README.md"
            placeholderTextColor="#374151"
            multiline
            numberOfLines={2}
            editable={status !== 'running'}
            returnKeyType="done"
          />
        ) : (
          <TextInput
            style={styles.input}
            value={userInput}
            onChangeText={setUserInput}
            placeholder={
              selectedTool === 'claude'
                ? 'e.g. Write a README for this folder'
                : 'e.g. Fix bugs in this code'
            }
            placeholderTextColor="#374151"
            multiline
            numberOfLines={3}
            editable={status !== 'running'}
            returnKeyType="done"
          />
        )}
      </View>

      {/* Action Buttons */}
      <View style={styles.actionRow}>
        {status === 'idle' && (
          <Pressable
            style={[styles.actionBtn, styles.checkBtn]}
            onPress={handleCheck}
          >
            <Text style={styles.actionBtnText}>
              {selectedTool === 'custom' ? '▶ Run' : '◎ Check & Run'}
            </Text>
          </Pressable>
        )}

        {status === 'ready' && (
          <>
            <Pressable
              style={[styles.actionBtn, styles.runBtn]}
              onPress={handleRun}
            >
              <Text style={styles.actionBtnText}>▶ Run</Text>
            </Pressable>
            <Pressable
              style={[styles.actionBtn, styles.resetBtn]}
              onPress={() => setStatus('idle')}
            >
              <Text style={styles.resetBtnText}>✕ Reset</Text>
            </Pressable>
          </>
        )}

        {(status === 'check_failed' || status === 'needs_auth') && checkResult && (
          <>
            {checkResult.setupCommands.length > 0 && (
              <Pressable
                style={[styles.actionBtn, styles.setupBtn]}
                onPress={() => {
                  onSendToTerminal(checkResult.setupCommands[0]);
                }}
              >
                <Text style={styles.actionBtnText}>
                  ↗ Setup in Terminal
                </Text>
              </Pressable>
            )}
            <Pressable
              style={[styles.actionBtn, styles.resetBtn]}
              onPress={() => setStatus('idle')}
            >
              <Text style={styles.resetBtnText}>← Back</Text>
            </Pressable>
          </>
        )}

        {status === 'running' && (
          <Pressable
            style={[styles.actionBtn, styles.cancelBtn]}
            onPress={handleCancel}
          >
            <Text style={styles.actionBtnText}>■ Cancel</Text>
          </Pressable>
        )}

        {(status === 'done' || status === 'error' || status === 'cancelled') && (
          <Pressable
            style={[styles.actionBtn, styles.resetBtn]}
            onPress={handleReset}
          >
            <Text style={styles.resetBtnText}>↺ New operation</Text>
          </Pressable>
        )}
      </View>

      {/* Status / Logs */}
      {status === 'checking' && (
        <View style={styles.statusRow}>
          <ActivityIndicator size="small" color="#00D4AA" />
          <Text style={styles.statusText}>Checking...</Text>
        </View>
      )}

      {status === 'running' && (
        <View style={styles.statusRow}>
          <ActivityIndicator size="small" color="#F59E0B" />
          <Text style={styles.statusText}>Running...</Text>
        </View>
      )}

      {/* Logs */}
      {logs.length > 0 && (
        <View style={styles.logContainer}>
          <Text style={styles.logHeader}>▸ Logs</Text>
          <ScrollView style={styles.logScroll} nestedScrollEnabled>
            {logs.map((entry) => (
              <Text
                key={entry.id}
                style={[
                  styles.logLine,
                  entry.type === 'stderr' && styles.logLineError,
                  entry.type === 'system' && styles.logLineSystem,
                  entry.type === 'info' && styles.logLineInfo,
                ]}
              >
                {entry.text}
              </Text>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Result */}
      {runResult && (status === 'done' || status === 'error') && (
        <View style={[styles.resultContainer, !runResult.success && styles.resultContainerError]}>
          <Text style={styles.resultTitle}>
            {runResult.success ? '✓ Done' : '✕ Error'}
          </Text>
          <Text style={styles.resultSummary}>{runResult.naturalSummary}</Text>

          {runResult.changedFiles.length > 0 && (
            <View style={styles.resultFiles}>
              <Text style={styles.resultFilesLabel}>Changed files:</Text>
              {runResult.changedFiles.map((f, i) => (
                <Text key={i} style={styles.resultFileItem}>  • {f}</Text>
              ))}
            </View>
          )}

          {runResult.nextActions.length > 0 && (
            <View style={styles.resultNext}>
              <Text style={styles.resultNextLabel}>Next steps:</Text>
              {runResult.nextActions.map((action, i) => (
                <Text key={i} style={styles.resultNextItem}>  {i + 1}. {action}</Text>
              ))}
            </View>
          )}

          {/* Send to Terminal */}
          {currentPlan && (
            <Pressable
              style={styles.terminalBtn}
              onPress={() => onSendToTerminal(currentPlan.command)}
            >
              <Text style={styles.terminalBtnText}>↗ View in Terminal</Text>
            </Pressable>
          )}
        </View>
      )}

      {/* Connection Status Banner */}
      <View style={[styles.connectionBanner, termuxConnected ? styles.connectionBannerOk : styles.connectionBannerOff]}>
        <View style={styles.connectionBannerLeft}>
          <View style={[styles.connectionDot, termuxConnected ? styles.connectionDotOk : styles.connectionDotOff]} />
          <Text style={[styles.connectionBannerText, termuxConnected ? styles.connectionBannerTextOk : styles.connectionBannerTextOff]}>
            {termuxConnected ? 'Termux Bridge connected' : 'Termux Bridge disconnected'}
          </Text>
        </View>
        {!termuxConnected && onTestConnection && (
          <Pressable
            style={styles.bridgeCheckBtn}
            onPress={handleBridgeCheck}
            disabled={bridgeCheckStatus === 'checking'}
          >
            <Text style={styles.bridgeCheckBtnText}>
              {bridgeCheckStatus === 'checking' ? 'Checking...' :
               bridgeCheckStatus === 'ok' ? '✓ OK' :
               bridgeCheckStatus === 'fail' ? '✕ Not running' :
               'Check connection'}
            </Text>
          </Pressable>
        )}
      </View>

      {/* Bridge Setup Guide (shown when disconnected) */}
      {!termuxConnected && (
        <View style={styles.setupGuide}>
          <Text style={styles.setupGuideTitle}>📱 Run the following in Termux</Text>
          <Text style={styles.setupGuideStep}>1. Open Termux</Text>
          <View style={styles.setupGuideCmd}>
            <Text style={styles.setupGuideCmdText}>cd ~/shelly-bridge && node server.js</Text>
          </View>
          <Text style={styles.setupGuideNote}>
            First-time setup required:
          </Text>
          <View style={styles.setupGuideCmd}>
            <Text style={styles.setupGuideCmdText}>{'pkg install nodejs && mkdir -p ~/shelly-bridge && cp -r /sdcard/shelly-bridge/* ~/shelly-bridge/ && cd ~/shelly-bridge && npm install'}</Text>
          </View>
          <Text style={styles.setupGuideNote}>
            After starting, go to Settings → Termux Bridge URL,
            set ws://127.0.0.1:8765 and tap &apos;Check connection&apos;.
          </Text>
        </View>
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  section: {
    marginBottom: 12,
  },
  sectionLabel: {
    fontSize: 10,
    fontFamily: 'monospace',
    color: '#6B7280',
    marginBottom: 6,
    letterSpacing: 0.5,
  },
  toolRow: {
    flexDirection: 'row',
    gap: 8,
  },
  toolBtn: {
    flex: 1,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#1F2937',
    borderRadius: 6,
    padding: 8,
    alignItems: 'center',
  },
  toolBtnActive: {
    borderColor: '#00D4AA',
    backgroundColor: '#0D2B26',
  },
  toolBtnText: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: '#6B7280',
    fontWeight: '600',
  },
  toolBtnTextActive: {
    color: '#00D4AA',
  },
  toolBtnDesc: {
    fontSize: 9,
    fontFamily: 'monospace',
    color: '#374151',
    marginTop: 2,
    textAlign: 'center',
  },
  targetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#1F2937',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  targetBtnText: {
    flex: 1,
    fontSize: 11,
    fontFamily: 'monospace',
    color: '#9CA3AF',
  },
  targetBtnChevron: {
    fontSize: 10,
    color: '#6B7280',
  },
  projectPicker: {
    backgroundColor: '#0D0D0D',
    borderWidth: 1,
    borderColor: '#1F2937',
    borderRadius: 6,
    marginTop: 4,
    maxHeight: 160,
  },
  projectPickerItem: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 0.5,
    borderBottomColor: '#1A1A1A',
  },
  projectPickerItemActive: {
    backgroundColor: '#0D2B26',
  },
  projectPickerItemText: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: '#9CA3AF',
  },
  projectPickerItemTags: {
    fontSize: 9,
    fontFamily: 'monospace',
    color: '#4B5563',
    marginTop: 2,
  },
  input: {
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#1F2937',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    fontFamily: 'monospace',
    color: '#E5E7EB',
    minHeight: 60,
    textAlignVertical: 'top',
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: 'center',
  },
  checkBtn: {
    backgroundColor: '#1F3A35',
    borderWidth: 1,
    borderColor: '#00D4AA',
  },
  runBtn: {
    backgroundColor: '#00D4AA',
  },
  setupBtn: {
    backgroundColor: '#1F2937',
    borderWidth: 1,
    borderColor: '#F59E0B',
  },
  cancelBtn: {
    backgroundColor: '#7F1D1D',
    borderWidth: 1,
    borderColor: '#EF4444',
  },
  resetBtn: {
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#374151',
  },
  actionBtnText: {
    fontSize: 12,
    fontFamily: 'monospace',
    color: '#E5E7EB',
    fontWeight: '600',
  },
  resetBtnText: {
    fontSize: 12,
    fontFamily: 'monospace',
    color: '#6B7280',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  statusText: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: '#9CA3AF',
  },
  logContainer: {
    backgroundColor: '#0A0A0A',
    borderWidth: 1,
    borderColor: '#1A1A1A',
    borderRadius: 6,
    padding: 8,
    marginBottom: 12,
    maxHeight: 200,
  },
  logHeader: {
    fontSize: 9,
    fontFamily: 'monospace',
    color: '#4B5563',
    marginBottom: 4,
  },
  logScroll: {
    maxHeight: 160,
  },
  logLine: {
    fontSize: 10,
    fontFamily: 'monospace',
    color: '#9CA3AF',
    lineHeight: 16,
  },
  logLineError: {
    color: '#F87171',
  },
  logLineSystem: {
    color: '#6B7280',
    fontStyle: 'italic',
  },
  logLineInfo: {
    color: '#00D4AA',
  },
  resultContainer: {
    backgroundColor: '#0D2B26',
    borderWidth: 1,
    borderColor: '#00D4AA',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  resultContainerError: {
    backgroundColor: '#1C0A0A',
    borderColor: '#EF4444',
  },
  resultTitle: {
    fontSize: 13,
    fontFamily: 'monospace',
    color: '#00D4AA',
    fontWeight: '700',
    marginBottom: 6,
  },
  resultSummary: {
    fontSize: 12,
    fontFamily: 'monospace',
    color: '#D1FAE5',
    lineHeight: 18,
    marginBottom: 8,
  },
  resultFiles: {
    marginBottom: 8,
  },
  resultFilesLabel: {
    fontSize: 10,
    fontFamily: 'monospace',
    color: '#6B7280',
    marginBottom: 2,
  },
  resultFileItem: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: '#9CA3AF',
    lineHeight: 16,
  },
  resultNext: {
    marginBottom: 8,
  },
  resultNextLabel: {
    fontSize: 10,
    fontFamily: 'monospace',
    color: '#6B7280',
    marginBottom: 2,
  },
  resultNextItem: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: '#9CA3AF',
    lineHeight: 16,
  },
  terminalBtn: {
    marginTop: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#374151',
    borderRadius: 4,
    alignSelf: 'flex-start',
  },
  terminalBtnText: {
    fontSize: 10,
    fontFamily: 'monospace',
    color: '#9CA3AF',
  },
  warningBox: {
    backgroundColor: '#1C1700',
    borderWidth: 1,
    borderColor: '#F59E0B',
    borderRadius: 6,
    padding: 10,
    marginBottom: 12,
  },
  warningText: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: '#FCD34D',
    lineHeight: 16,
  },
  // ─ Connection Banner ─
  connectionBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 10,
    borderWidth: 1,
  },
  connectionBannerOk: {
    backgroundColor: '#0D2B26',
    borderColor: '#00D4AA',
  },
  connectionBannerOff: {
    backgroundColor: '#1C1700',
    borderColor: '#F59E0B',
  },
  connectionBannerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  connectionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  connectionDotOk: {
    backgroundColor: '#00D4AA',
  },
  connectionDotOff: {
    backgroundColor: '#F59E0B',
  },
  connectionBannerText: {
    fontSize: 11,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  connectionBannerTextOk: {
    color: '#00D4AA',
  },
  connectionBannerTextOff: {
    color: '#FCD34D',
  },
  bridgeCheckBtn: {
    backgroundColor: '#1F2937',
    borderWidth: 1,
    borderColor: '#F59E0B',
    borderRadius: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  bridgeCheckBtnText: {
    fontSize: 10,
    fontFamily: 'monospace',
    color: '#FCD34D',
    fontWeight: '600',
  },
  // ─ Setup Guide ─
  setupGuide: {
    backgroundColor: '#0D0D0D',
    borderWidth: 1,
    borderColor: '#1F2937',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    gap: 6,
  },
  setupGuideTitle: {
    fontSize: 12,
    fontFamily: 'monospace',
    color: '#E8E8E8',
    fontWeight: '700',
    marginBottom: 4,
  },
  setupGuideStep: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: '#9CA3AF',
  },
  setupGuideCmd: {
    backgroundColor: '#111827',
    borderRadius: 4,
    padding: 8,
    marginVertical: 2,
  },
  setupGuideCmdText: {
    fontSize: 10,
    fontFamily: 'monospace',
    color: '#00D4AA',
    lineHeight: 16,
  },
  setupGuideNote: {
    fontSize: 10,
    fontFamily: 'monospace',
    color: '#6B7280',
    lineHeight: 15,
    marginTop: 2,
  },
  // ─ Local LLM Banner ─
  llmBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1A0D2E',
    borderWidth: 1,
    borderColor: '#A78BFA44',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginBottom: 10,
    gap: 6,
  },
  llmDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  llmDotReady: {
    backgroundColor: '#A78BFA',
  },
  llmDotThinking: {
    backgroundColor: '#FBBF24',
  },
  llmBannerText: {
    flex: 1,
    fontSize: 10,
    fontFamily: 'monospace',
    color: '#A78BFA',
  },
  llmClearBtn: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: '#2D1A4A',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#A78BFA44',
  },
  llmClearBtnText: {
    fontSize: 9,
    fontFamily: 'monospace',
    color: '#A78BFA',
  },
});
