/**
 * AuthWizard.tsx — CLI Authentication Wizard
 *
 * A modal flow that guides non-engineers through authenticating
 * CLI tools (Claude Code, Gemini CLI, Codex) entirely within
 * the Shelly app. No Termux interaction required.
 *
 * Two paths per tool:
 * 1. "Sign in with browser" — opens OAuth URL (where supported)
 * 2. "I have an API key" — paste key into text field
 *
 * Launchable from:
 * - SetupWizard (after tool installation)
 * - Settings screen (re-authenticate)
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  Pressable,
  Modal,
  StyleSheet,
  TextInput,
  ActivityIndicator,
  Linking,
  ScrollView,
  Alert,
} from 'react-native';
import Animated, { FadeInDown, FadeIn } from 'react-native-reanimated';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTranslation } from '@/lib/i18n';
import { useTerminalStore } from '@/store/terminal-store';
import { execCommand } from '@/hooks/use-native-exec';
import { logInfo, logWarn, logError, logLifecycle } from '@/lib/debug-logger';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import {
  AUTH_TOOL_CONFIGS,
  checkAllAuthStatus,
  storeApiKey,
  verifyAuth,
  type AuthToolId,
  type AuthStatus,
  type AuthToolConfig,
} from '@/lib/cli-auth';

// ── Props ──────────────────────────────────────────────────────────────────────

type Props = {
  visible: boolean;
  onComplete: () => void;
  /** Only show specific tools (e.g., from SetupWizard after installing specific tools) */
  toolFilter?: AuthToolId[];
  /** Title override */
  title?: string;
};

// ── Main Component ─────────────────────────────────────────────────────────────

export function AuthWizard({ visible, onComplete, toolFilter, title }: Props) {
  const { t } = useTranslation();
  const { runCommand } = useTerminalStore();
  const isConnected = true; // Plan B: native terminal is always available

  useEffect(() => {
    logLifecycle('AuthWizard', 'mounted, visible=' + visible);
  }, [visible]);

  const [authStatuses, setAuthStatuses] = useState<Record<AuthToolId, AuthStatus>>({
    'claude-code': 'checking',
    'gemini-cli': 'checking',
    'codex': 'checking',
  });
  const [expandedTool, setExpandedTool] = useState<AuthToolId | null>(null);
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
  const [savingTool, setSavingTool] = useState<AuthToolId | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Filter tools to show
  const toolsToShow = AUTH_TOOL_CONFIGS.filter(
    (config) => !toolFilter || toolFilter.includes(config.id),
  );

  // ── Native runner: executes command and returns real output ─────────────────
  const nativeRunner = useCallback(async (cmd: string, _opts?: any): Promise<any> => {
    try {
      const result = await execCommand(cmd);
      return { ok: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    } catch (e: any) {
      return { ok: false, stdout: '', stderr: e.message || '', exitCode: 1 };
    }
  }, []);

  // ── Check auth status on open ─────────────────────────────────────────────

  const refreshStatuses = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const statuses = await checkAllAuthStatus(nativeRunner);
      setAuthStatuses(statuses);
    } catch (error) {
      logError('AuthWizard', 'refreshStatuses failed', error);
    } finally {
      setIsRefreshing(false);
    }
  }, [nativeRunner]);

  useEffect(() => {
    if (visible) {
      refreshStatuses();
    }
  }, [visible]);

  // ── Handle API key save ───────────────────────────────────────────────────

  const handleSaveApiKey = useCallback(async (toolId: AuthToolId) => {
    const key = apiKeyInputs[toolId]?.trim();
    logInfo('AuthWizard', 'Saving API key for ' + toolId + ', key: ' + (key ? 'set' : 'empty'));
    if (!key) {
      Alert.alert(t('auth.error'), t('auth.key_empty'));
      return;
    }

    setSavingTool(toolId);
    try {
      const result = await storeApiKey(toolId, key, nativeRunner);
      if (result.success) {
        // Verify
        const verified = await verifyAuth(toolId, nativeRunner);
        setAuthStatuses((prev) => ({
          ...prev,
          [toolId]: verified ? 'authenticated' : 'not-authenticated',
        }));
        if (verified) {
          logInfo('AuthWizard', 'Auth success for ' + toolId);
          setExpandedTool(null);
          setApiKeyInputs((prev) => ({ ...prev, [toolId]: '' }));
        } else {
          logWarn('AuthWizard', 'API key saved but verify failed for ' + toolId);
          Alert.alert(t('auth.error'), t('auth.verify_failed'));
        }
      } else {
        logWarn('AuthWizard', 'storeApiKey failed for ' + toolId + ': ' + result.error);
        Alert.alert(t('auth.error'), result.error || t('auth.save_failed'));
      }
    } catch (e) {
      logError('AuthWizard', 'handleSaveApiKey failed', e);
      Alert.alert(t('auth.error'), String(e));
    } finally {
      setSavingTool(null);
    }
  }, [apiKeyInputs, nativeRunner, t]);

  // ── Handle browser/OAuth auth ────────────────────────────────────────────
  const [oauthRunning, setOauthRunning] = useState<AuthToolId | null>(null);
  const [oauthOutput, setOauthOutput] = useState('');
  const oauthPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Clean up any ongoing poll on unmount
  useEffect(() => {
    return () => {
      if (oauthPollRef.current !== null) {
        clearInterval(oauthPollRef.current);
        oauthPollRef.current = null;
      }
    };
  }, []);

  const handleBrowserAuth = useCallback(async (config: AuthToolConfig) => {
    logInfo('AuthWizard', 'Starting browser auth for ' + config.id);
    // If the tool has a loginCommand, run OAuth via real PTY
    if (config.loginCommand) {
      setOauthRunning(config.id);
      setOauthOutput('Running: ' + config.loginCommand);

      // Get the native session ID from the first terminal session
      const sessionId = useTerminalStore.getState().sessions[0]?.nativeSessionId;
      logInfo('AuthWizard', 'Writing to PTY session: ' + (sessionId ?? 'none (fallback)'));
      if (!sessionId) {
        // Fallback: route through store's runCommand
        runCommand(config.loginCommand);
      } else {
        try {
          await TerminalEmulator.writeToSession(sessionId, config.loginCommand + '\n');
        } catch (e) {
          logError('AuthWizard', 'writeToSession failed, falling back to runCommand', e);
          runCommand(config.loginCommand);
        }
      }

      // Clear any existing poll
      if (oauthPollRef.current !== null) {
        clearInterval(oauthPollRef.current);
        oauthPollRef.current = null;
      }

      const startTime = Date.now();
      const TIMEOUT_MS = 60_000;
      let urlOpened = false;

      oauthPollRef.current = setInterval(async () => {
        if (!mountedRef.current) {
          clearInterval(oauthPollRef.current!);
          oauthPollRef.current = null;
          return;
        }

        // Timeout after 60s
        if (Date.now() - startTime > TIMEOUT_MS) {
          clearInterval(oauthPollRef.current!);
          oauthPollRef.current = null;
          setOauthRunning(null);
          setOauthOutput('');
          logWarn('AuthWizard', 'Auth timeout for ' + config.id);
          Alert.alert(t('auth.error'), t('auth.oauth_timeout'));
          return;
        }

        // Read recent terminal output
        let recentText = '';
        if (sessionId) {
          try {
            recentText = await TerminalEmulator.getTranscriptText(sessionId, 40);
          } catch {
            // Fallback to store entries
            const session = useTerminalStore.getState().sessions.find(
              (s: any) => s.nativeSessionId === sessionId,
            );
            recentText = session?.entries?.slice(-10)
              .flatMap((e: any) => e.output || [])
              .map((o: any) => o.text)
              .join('\n') ?? '';
          }
        } else {
          const session = useTerminalStore.getState().sessions[0];
          recentText = session?.entries?.slice(-10)
            .flatMap((e: any) => e.output || [])
            .map((o: any) => o.text)
            .join('\n') ?? '';
        }

        // Detect OAuth URL and open in browser (only once)
        if (!urlOpened) {
          const urlMatch = recentText.match(/https?:\/\/[^\s\x1b\]]+/);
          if (urlMatch) {
            urlOpened = true;
            logInfo('AuthWizard', 'URL detected: ' + urlMatch[0]);
            Linking.openURL(urlMatch[0]).catch((e) => {
              logError('AuthWizard', 'Failed to open browser URL', e);
              Alert.alert(t('auth.error'), t('auth.browser_failed'));
            });
            setOauthOutput(urlMatch[0]);
          }
        }

        // Detect success patterns
        const successPattern = /authenticated|success|logged in|Logged in/i;
        if (successPattern.test(recentText)) {
          clearInterval(oauthPollRef.current!);
          oauthPollRef.current = null;
          setOauthRunning(null);
          setOauthOutput('');
          logInfo('AuthWizard', 'Auth success for ' + config.id);
          setAuthStatuses((prev) => ({ ...prev, [config.id]: 'authenticated' }));
          setExpandedTool(null);
          refreshStatuses();
        }
      }, 2000);

      return;
    }

    // Fallback: open API key URL
    Linking.openURL(config.apiKeyUrl).catch(() => {
      Alert.alert(t('auth.error'), t('auth.browser_failed'));
    });
  }, [t, runCommand, refreshStatuses]);

  // ── Count statuses ────────────────────────────────────────────────────────

  const authenticatedCount = toolsToShow.filter(
    (c) => authStatuses[c.id] === 'authenticated',
  ).length;
  const installedCount = toolsToShow.filter(
    (c) => authStatuses[c.id] !== 'not-installed',
  ).length;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            <Animated.View entering={FadeInDown.duration(400)} style={styles.content}>
              {/* Header */}
              <View style={styles.headerRow}>
                <View style={[styles.iconCircle, { backgroundColor: '#60A5FA20' }]}>
                  <MaterialIcons name="vpn-key" size={36} color="#60A5FA" />
                </View>
              </View>

              <Text style={styles.title}>
                {title || t('auth.title')}
              </Text>
              <Text style={styles.description}>
                {t('auth.description')}
              </Text>

              {/* Connection warning */}
              {!isConnected && (
                <View style={styles.warningCard}>
                  <MaterialIcons name="warning" size={18} color="#FBBF24" />
                  <Text style={styles.warningText}>
                    {t('auth.bridge_required')}
                  </Text>
                </View>
              )}

              {/* Status summary */}
              <View style={styles.summaryRow}>
                <Text style={styles.summaryText}>
                  {t('auth.status_summary', {
                    authenticated: String(authenticatedCount),
                    total: String(installedCount),
                  })}
                </Text>
                {isRefreshing && (
                  <ActivityIndicator size="small" color="#60A5FA" />
                )}
                {!isRefreshing && (
                  <Pressable onPress={refreshStatuses} hitSlop={12}>
                    <MaterialIcons name="refresh" size={20} color="#6B7280" />
                  </Pressable>
                )}
              </View>

              {/* Tool cards */}
              {toolsToShow.map((config) => (
                <ToolAuthCard
                  key={config.id}
                  config={config}
                  status={authStatuses[config.id]}
                  isExpanded={expandedTool === config.id}
                  onToggle={() => setExpandedTool(
                    expandedTool === config.id ? null : config.id,
                  )}
                  apiKeyValue={apiKeyInputs[config.id] || ''}
                  onApiKeyChange={(v) => setApiKeyInputs((prev) => ({ ...prev, [config.id]: v }))}
                  onSaveApiKey={() => handleSaveApiKey(config.id)}
                  onBrowserAuth={() => handleBrowserAuth(config)}
                  isSaving={savingTool === config.id}
                  isConnected={isConnected}
                  oauthRunning={oauthRunning}
                />
              ))}

              {/* Done button */}
              <Pressable
                style={[styles.primaryBtn, { backgroundColor: '#60A5FA' }]}
                onPress={onComplete}
              >
                <Text style={styles.primaryBtnText}>
                  {authenticatedCount > 0 ? t('auth.done') : t('auth.skip')}
                </Text>
                <MaterialIcons name="arrow-forward" size={18} color="#000" />
              </Pressable>
            </Animated.View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ── Tool Auth Card ──────────────────────────────────────────────────────────────

function ToolAuthCard({
  config,
  status,
  isExpanded,
  onToggle,
  apiKeyValue,
  onApiKeyChange,
  onSaveApiKey,
  onBrowserAuth,
  isSaving,
  isConnected,
  oauthRunning,
}: {
  config: AuthToolConfig;
  status: AuthStatus;
  isExpanded: boolean;
  onToggle: () => void;
  apiKeyValue: string;
  onApiKeyChange: (v: string) => void;
  onSaveApiKey: () => void;
  onBrowserAuth: () => void;
  isSaving: boolean;
  isConnected: boolean;
  oauthRunning: AuthToolId | null;
}) {
  const { t } = useTranslation();

  const statusIcon = status === 'authenticated' ? 'check-circle'
    : status === 'not-installed' ? 'cancel'
    : status === 'checking' ? 'hourglass-top'
    : 'warning';

  const statusColor = status === 'authenticated' ? '#4ADE80'
    : status === 'not-installed' ? '#6B7280'
    : status === 'checking' ? '#FBBF24'
    : '#F59E0B';

  const statusLabel = status === 'authenticated' ? t('auth.status_authenticated')
    : status === 'not-installed' ? t('auth.status_not_installed')
    : status === 'checking' ? t('auth.status_checking')
    : t('auth.status_not_authenticated');

  // Always allow expansion and browser auth attempt — CLI may have just been installed
  // and status check may be stale. Let the user try; handleBrowserAuth will show errors if CLI missing.
  const canExpand = status !== 'checking';
  const canBrowserAuth = status !== 'checking';

  return (
    <View style={[styles.toolCard, { borderColor: isExpanded ? config.color + '44' : '#2A2A2A' }]}>
      {/* Header row */}
      <Pressable style={styles.toolCardHeader} onPress={canExpand ? onToggle : undefined}>
        <View style={[styles.toolIcon, { backgroundColor: config.color + '18' }]}>
          <MaterialIcons name={config.icon as any} size={20} color={config.color} />
        </View>
        <View style={styles.toolInfo}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={[styles.toolName, { color: config.color }]}>{config.name}</Text>
            {config.id === 'gemini-cli' && (
              <View style={{ backgroundColor: '#4ADE8030', paddingHorizontal: 5, paddingVertical: 1, borderRadius: 3 }}>
                <Text style={{ color: '#4ADE80', fontSize: 8, fontWeight: '700', fontFamily: 'monospace' }}>
                  {t('setup2.free_badge')}
                </Text>
              </View>
            )}
          </View>
          <View style={styles.statusBadge}>
            {status === 'checking' ? (
              <ActivityIndicator size={12} color={statusColor} />
            ) : (
              <MaterialIcons name={statusIcon} size={14} color={statusColor} />
            )}
            <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
          </View>
        </View>
        {canExpand && (
          <MaterialIcons
            name={isExpanded ? 'expand-less' : 'expand-more'}
            size={24}
            color="#6B7280"
          />
        )}
      </Pressable>

      {/* Expanded auth options */}
      {isExpanded && canExpand && (
        <Animated.View entering={FadeIn.duration(200)} style={styles.authOptions}>
          {/* Browser/OAuth sign-in (recommended) — requires CLI installed */}
          <Pressable
            style={[styles.authMethodBtn, { borderColor: config.color + '44' }]}
            onPress={onBrowserAuth}
            disabled={oauthRunning === config.id}
          >
            {oauthRunning === config.id ? (
              <ActivityIndicator size={18} color={config.color} />
            ) : (
              <MaterialIcons name="open-in-browser" size={18} color={config.color} />
            )}
            <View style={styles.authMethodInfo}>
              <Text style={[styles.authMethodTitle, { color: config.color }]}>
                {config.loginCommand ? t('auth.oauth_signin') : t('auth.browser_signin')}
              </Text>
              <Text style={styles.authMethodDesc}>
                {oauthRunning === config.id
                  ? t('auth.oauth_waiting')
                  : config.loginCommand
                    ? t('auth.oauth_signin_desc')
                    : t('auth.browser_signin_desc')}
              </Text>
            </View>
            {oauthRunning !== config.id && (
              <MaterialIcons name="chevron-right" size={18} color="#6B7280" />
            )}
          </Pressable>

          {/* API key input */}
          <View style={styles.apiKeySection}>
            <Text style={styles.apiKeyLabel}>
              {t('auth.api_key_label', { envVar: config.envVar })}
            </Text>
            <View style={styles.apiKeyInputRow}>
              <TextInput
                style={styles.apiKeyInput}
                value={apiKeyValue}
                onChangeText={onApiKeyChange}
                placeholder={t('auth.api_key_placeholder')}
                placeholderTextColor="#4B5563"
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                returnKeyType="done"
                onSubmitEditing={onSaveApiKey}
              />
              <Pressable
                style={[styles.saveBtn, { backgroundColor: config.color + '22', borderColor: config.color + '44' }]}
                onPress={onSaveApiKey}
                disabled={isSaving}
              >
                {isSaving ? (
                  <ActivityIndicator size="small" color={config.color} />
                ) : (
                  <Text style={[styles.saveBtnText, { color: config.color }]}>
                    {t('auth.save')}
                  </Text>
                )}
              </Pressable>
            </View>
            <Pressable onPress={() => Linking.openURL(config.apiKeyUrl)}>
              <Text style={styles.getKeyLink}>
                {t('auth.get_key_link')}
              </Text>
            </Pressable>
          </View>
        </Animated.View>
      )}
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────────

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
    maxHeight: '90%',
  },
  content: {
    paddingHorizontal: 24,
    paddingVertical: 28,
    alignItems: 'center',
  },
  headerRow: {
    alignItems: 'center',
    marginBottom: 16,
  },
  iconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 20,
    fontWeight: '800',
    fontFamily: 'monospace',
    color: '#60A5FA',
    textAlign: 'center',
    marginBottom: 8,
  },
  description: {
    color: '#9CA3AF',
    fontSize: 13,
    fontFamily: 'monospace',
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: 16,
  },
  warningCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FBBF2410',
    borderWidth: 1,
    borderColor: '#FBBF2433',
    borderRadius: 10,
    padding: 12,
    width: '100%',
    marginBottom: 12,
  },
  warningText: {
    color: '#FBBF24',
    fontSize: 12,
    fontFamily: 'monospace',
    flex: 1,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  summaryText: {
    color: '#6B7280',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  // ── Tool card ──────────────────────────────────────────────────────
  toolCard: {
    width: '100%',
    backgroundColor: '#1A1A1A',
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 10,
    overflow: 'hidden',
  },
  toolCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    gap: 12,
  },
  toolIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolInfo: {
    flex: 1,
    gap: 2,
  },
  toolName: {
    fontSize: 14,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  statusText: {
    fontSize: 11,
    fontFamily: 'monospace',
  },
  // ── Auth options ──────────────────────────────────────────────────
  authOptions: {
    borderTopWidth: 1,
    borderTopColor: '#2A2A2A',
    padding: 14,
    gap: 10,
  },
  authMethodBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    backgroundColor: '#0D0D0D',
  },
  authMethodInfo: {
    flex: 1,
  },
  authMethodTitle: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  authMethodDesc: {
    color: '#6B7280',
    fontSize: 11,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  // ── API key input ─────────────────────────────────────────────────
  apiKeySection: {
    gap: 6,
  },
  apiKeyLabel: {
    color: '#9CA3AF',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  apiKeyInputRow: {
    flexDirection: 'row',
    gap: 8,
  },
  apiKeyInput: {
    flex: 1,
    backgroundColor: '#0D0D0D',
    borderWidth: 1,
    borderColor: '#2A2A2A',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#E5E7EB',
    fontSize: 13,
    fontFamily: 'monospace',
  },
  saveBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 60,
  },
  saveBtnText: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  getKeyLink: {
    color: '#60A5FA',
    fontSize: 11,
    fontFamily: 'monospace',
    textDecorationLine: 'underline',
    marginTop: 2,
  },
  // ── Primary button ────────────────────────────────────────────────
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
});
