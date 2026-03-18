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
import React, { useState, useCallback, useEffect } from 'react';
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
import { useTermuxBridge } from '@/hooks/use-termux-bridge';
import {
  AUTH_TOOL_CONFIGS,
  checkAllAuthStatus,
  storeApiKey,
  verifyAuth,
  ensureShellyrcSourced,
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
  const { runRawCommand, isConnected } = useTermuxBridge();

  const [authStatuses, setAuthStatuses] = useState<Record<AuthToolId, AuthStatus>>({
    'claude-code': 'checking',
    'gemini-cli': 'checking',
    'codex': 'checking',
  });
  const [expandedTool, setExpandedTool] = useState<AuthToolId | null>(null);
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
  const [savingTool, setSavingTool] = useState<AuthToolId | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Filter tools to show
  const toolsToShow = AUTH_TOOL_CONFIGS.filter(
    (config) => !toolFilter || toolFilter.includes(config.id),
  );

  // ── Check auth status on open ─────────────────────────────────────────────

  const refreshStatuses = useCallback(async () => {
    if (!isConnected) return;
    setIsRefreshing(true);
    try {
      const runner = (cmd: string, opts?: { timeoutMs?: number }) =>
        runRawCommand(cmd, { ...opts, reason: 'auth-check' });
      const statuses = await checkAllAuthStatus(runner);
      setAuthStatuses(statuses);
    } catch {
      // Keep existing statuses
    } finally {
      setIsRefreshing(false);
    }
  }, [isConnected, runRawCommand]);

  useEffect(() => {
    if (visible && isConnected) {
      refreshStatuses();
      // Ensure ~/.shellyrc is sourced by .bashrc
      const runner = (cmd: string, opts?: { timeoutMs?: number }) =>
        runRawCommand(cmd, { ...opts, reason: 'auth-setup' });
      ensureShellyrcSourced(runner);
    }
  }, [visible, isConnected]);

  // ── Handle API key save ───────────────────────────────────────────────────

  const handleSaveApiKey = useCallback(async (toolId: AuthToolId) => {
    const key = apiKeyInputs[toolId]?.trim();
    if (!key) {
      Alert.alert(t('auth.error'), t('auth.key_empty'));
      return;
    }

    setSavingTool(toolId);
    try {
      const runner = (cmd: string, opts?: { timeoutMs?: number }) =>
        runRawCommand(cmd, { ...opts, reason: 'auth-store-key' });

      const result = await storeApiKey(toolId, key, runner);
      if (result.success) {
        // Verify
        const verified = await verifyAuth(toolId, runner);
        setAuthStatuses((prev) => ({
          ...prev,
          [toolId]: verified ? 'authenticated' : 'not-authenticated',
        }));
        if (verified) {
          setExpandedTool(null);
          setApiKeyInputs((prev) => ({ ...prev, [toolId]: '' }));
        } else {
          Alert.alert(t('auth.error'), t('auth.verify_failed'));
        }
      } else {
        Alert.alert(t('auth.error'), result.error || t('auth.save_failed'));
      }
    } catch (e) {
      Alert.alert(t('auth.error'), String(e));
    } finally {
      setSavingTool(null);
    }
  }, [apiKeyInputs, runRawCommand, t]);

  // ── Handle browser/OAuth auth ────────────────────────────────────────────
  const [oauthRunning, setOauthRunning] = useState<AuthToolId | null>(null);
  const [oauthOutput, setOauthOutput] = useState('');

  const handleBrowserAuth = useCallback(async (config: AuthToolConfig) => {
    // If the tool has a loginCommand, run OAuth via CLI
    if (config.loginCommand && isConnected) {
      setOauthRunning(config.id);
      setOauthOutput('');
      try {
        const runner = (cmd: string, opts?: { timeoutMs?: number; onStream?: (type: 'stdout' | 'stderr', data: string) => void }) =>
          runRawCommand(cmd, { ...opts, reason: 'oauth-login' });

        let output = '';
        const result = await runner(config.loginCommand, {
          timeoutMs: 60000,
          onStream: (_type, data) => {
            output += data;
            setOauthOutput(output);
            // Detect OAuth URLs in output and open in browser
            const urlMatch = data.match(/https?:\/\/[^\s"'<>\])+]+/g);
            if (urlMatch) {
              for (const url of urlMatch) {
                Linking.openURL(url).catch(() => {});
              }
            }
          },
        });

        // Check if auth succeeded after login command completes
        output += result.stdout || '';
        const urlMatch = output.match(/https?:\/\/[^\s"'<>]+/);
        if (urlMatch) {
          Linking.openURL(urlMatch[0]).catch(() => {});
        }

        // Wait a moment then re-check auth status
        setTimeout(() => {
          refreshStatuses();
          setOauthRunning(null);
          setOauthOutput('');
        }, 2000);
      } catch (e) {
        setOauthRunning(null);
        setOauthOutput('');
        Alert.alert(t('auth.error'), String(e));
      }
      return;
    }

    // Fallback: open API key URL
    Linking.openURL(config.apiKeyUrl).catch(() => {
      Alert.alert(t('auth.error'), t('auth.browser_failed'));
    });
  }, [t, isConnected, runRawCommand, refreshStatuses]);

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

  const canAuth = status !== 'not-installed' && status !== 'checking' && isConnected;

  return (
    <View style={[styles.toolCard, { borderColor: isExpanded ? config.color + '44' : '#2A2A2A' }]}>
      {/* Header row */}
      <Pressable style={styles.toolCardHeader} onPress={canAuth ? onToggle : undefined}>
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
        {canAuth && (
          <MaterialIcons
            name={isExpanded ? 'expand-less' : 'expand-more'}
            size={24}
            color="#6B7280"
          />
        )}
      </Pressable>

      {/* Expanded auth options */}
      {isExpanded && canAuth && (
        <Animated.View entering={FadeIn.duration(200)} style={styles.authOptions}>
          {/* Browser/OAuth sign-in (recommended) */}
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
