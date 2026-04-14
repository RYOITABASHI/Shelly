/**
 * components/settings/McpSection.tsx
 *
 * Settings画面のMCP (Model Context Protocol) 管理セクション。
 * - MCPサーバーカタログ（推奨表示・ワンタップ有効化）
 * - 各サーバーの状態表示（running/stopped/error）
 * - Claude Codeへの設定反映ボタン
 * - ローカルサーバー（Serena）の起動/停止
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  Share,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTranslation } from '@/lib/i18n';
import { useMcpStore } from '@/store/mcp-store';
import {
  MCP_CATALOG,
  McpServerDef,
  buildMcpInstallCommand,
  buildMcpStartCommand,
  buildMcpStopCommand,
  buildMcpStatusCommand,
} from '@/lib/mcp-manager';

// ─── Props ────────────────────────────────────────────────────────────────────

interface McpSectionProps {
  isConnected: boolean;
  onRunCommand: (command: string, label: string) => Promise<{ success: boolean; output?: string }>;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function McpSection({ isConnected, onRunCommand }: McpSectionProps) {
  const { t } = useTranslation();
  const {
    servers,
    isLoaded,
    initialized,
    loadState,
    toggleServer,
    setServerStatus,
    markInstalled,
    enableRecommended,
    getEnabledIds,
    generateClaudeConfig,
  } = useMcpStore();

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [isApplying, setIsApplying] = useState(false);

  // Load state on mount
  useEffect(() => {
    loadState();
  }, []);

  // Auto-enable recommended on first load
  useEffect(() => {
    if (isLoaded && !initialized) {
      enableRecommended();
    }
  }, [isLoaded, initialized]);

  // ── Claude Code設定への反映 ──────────────────────────────────────────────

  const handleApplyToClaudeCode = useCallback(async () => {
    const config = generateClaudeConfig();
    const enabledCount = getEnabledIds().length;

    if (enabledCount === 0) {
      Alert.alert(t('mcp.no_selection_title'), t('mcp.no_selection_msg'));
      return;
    }

    // Bridge接続時: 直接 settings.json を更新
    if (isConnected) {
      setIsApplying(true);
      try {
        // 現在の settings.json を読み込み
        const readResult = await onRunCommand(
          'cat ~/.claude/settings.json 2>/dev/null || echo "{}"',
          t('mcp.loading_config'),
        );
        let currentSettings: Record<string, any> = {};
        try {
          currentSettings = JSON.parse(readResult.output || '{}');
        } catch {
          currentSettings = {};
        }

        // mcpServers を追加/更新
        currentSettings.mcpServers = {
          ...(currentSettings.mcpServers ?? {}),
          ...config,
        };

        // 書き戻し
        const jsonStr = JSON.stringify(currentSettings, null, 2);
        const escaped = jsonStr.replace(/'/g, "'\\''");
        const writeResult = await onRunCommand(
          `echo '${escaped}' > ~/.claude/settings.json`,
          t('mcp.writing_config'),
        );

        setIsApplying(false);
        if (writeResult.success) {
          Alert.alert(
            t('mcp.applied_title'),
            t('mcp.applied_msg', { count: String(enabledCount) }),
          );
        } else {
          Alert.alert(t('mcp.write_error_title'), t('mcp.write_error_msg'));
        }
      } catch {
        setIsApplying(false);
        Alert.alert(t('mcp.apply_error_title'), t('mcp.apply_error_msg'));
      }
    } else {
      // 未接続時: クリップボードに設定JSONをコピー
      const configJson = JSON.stringify({ mcpServers: config }, null, 2);
      try {
        await Clipboard.setStringAsync(configJson);
        Alert.alert(
          t('mcp.copied_title'),
          t('mcp.copied_msg', { count: String(enabledCount) }),
        );
      } catch {
        await Share.share({
          message: configJson,
          title: 'MCP Server Settings',
        });
      }
    }
  }, [isConnected, onRunCommand, generateClaudeConfig, getEnabledIds]);

  // ── ローカルサーバー操作 ─────────────────────────────────────────────────

  const handleInstall = useCallback(async (server: McpServerDef) => {
    const cmd = buildMcpInstallCommand(server);
    if (!cmd) return;
    if (!isConnected) {
      Alert.alert(t('mcp.not_connected_title'), t('mcp.not_connected_msg'));
      return;
    }
    setBusyId(server.id);
    setServerStatus(server.id, 'starting');
    const result = await onRunCommand(cmd, t('mcp.server_install', { name: server.name }));
    if (result.success) {
      markInstalled(server.id);
      setServerStatus(server.id, 'stopped');
    } else {
      setServerStatus(server.id, 'error', result.output);
    }
    setBusyId(null);
  }, [isConnected, onRunCommand, setServerStatus, markInstalled]);

  const handleStart = useCallback(async (server: McpServerDef) => {
    const cmd = buildMcpStartCommand(server);
    if (!cmd || !isConnected) return;
    setBusyId(server.id);
    setServerStatus(server.id, 'starting');
    const result = await onRunCommand(
      `nohup ${cmd} > ~/mcp-${server.id}.log 2>&1 & echo $!`,
      t('mcp.server_start', { name: server.name }),
    );
    if (result.success) {
      setServerStatus(server.id, 'running');
    } else {
      setServerStatus(server.id, 'error', result.output);
    }
    setBusyId(null);
  }, [isConnected, onRunCommand, setServerStatus]);

  const handleStop = useCallback(async (server: McpServerDef) => {
    const cmd = buildMcpStopCommand(server);
    if (!cmd || !isConnected) return;
    setBusyId(server.id);
    await onRunCommand(cmd, t('mcp.server_stop', { name: server.name }));
    setServerStatus(server.id, 'stopped');
    setBusyId(null);
  }, [isConnected, onRunCommand, setServerStatus]);

  const handleCheckStatus = useCallback(async (server: McpServerDef) => {
    const cmd = buildMcpStatusCommand(server);
    if (!cmd || !isConnected) return;
    const result = await onRunCommand(cmd, t('mcp.server_status_check', { name: server.name }));
    const isRunning = result.output?.trim() === 'running';
    setServerStatus(server.id, isRunning ? 'running' : 'stopped');
  }, [isConnected, onRunCommand, setServerStatus]);

  // ── Render ──────────────────────────────────────────────────────────────

  if (!isLoaded) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="small" color="#60A5FA" />
      </View>
    );
  }

  const enabledCount = getEnabledIds().length;

  return (
    <View>
      {/* ヘッダーステータス */}
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <Text style={styles.enabledCount}>{enabledCount}</Text>
          <Text style={styles.enabledLabel}>{t('mcp.servers_enabled')}</Text>
        </View>
        <TouchableOpacity
          style={[styles.applyBtn, enabledCount === 0 && styles.applyBtnDisabled]}
          onPress={handleApplyToClaudeCode}
          disabled={isApplying || enabledCount === 0}
        >
          {isApplying ? (
            <ActivityIndicator size="small" color="#0A0A0A" />
          ) : (
            <>
              <MaterialIcons name="sync" size={14} color={enabledCount > 0 ? '#0A0A0A' : '#4B5563'} />
              <Text style={[styles.applyBtnText, enabledCount === 0 && styles.applyBtnTextDisabled]}>
                {isConnected ? t('mcp.apply_btn') : t('mcp.copy_btn')}
              </Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      {/* サーバーカタログ */}
      {MCP_CATALOG.map((server) => {
        const state = servers[server.id] ?? { enabled: false, status: 'stopped' as const };
        const isExpanded = expandedId === server.id;
        const isBusy = busyId === server.id;

        return (
          <View key={server.id} style={[styles.card, state.enabled && styles.cardEnabled]}>
            {/* カードヘッダー */}
            <TouchableOpacity
              style={styles.cardHeader}
              onPress={() => setExpandedId(isExpanded ? null : server.id)}
              activeOpacity={0.7}
            >
              <View style={styles.cardLeft}>
                <MaterialIcons
                  name={server.icon as any}
                  size={20}
                  color={state.enabled ? server.iconColor : '#4B5563'}
                />
                <View style={styles.cardInfo}>
                  <View style={styles.cardTitleRow}>
                    <Text style={[styles.cardName, state.enabled && styles.cardNameEnabled]}>
                      {server.name}
                    </Text>
                    {server.recommended && (
                      <View style={styles.recBadge}>
                        <Text style={styles.recBadgeText}>{t('mcp.recommended')}</Text>
                      </View>
                    )}
                    <TypeBadge type={server.type} />
                  </View>
                  <Text style={styles.cardDesc} numberOfLines={isExpanded ? undefined : 1}>
                    {server.description}
                  </Text>
                </View>
              </View>

              {/* 有効/無効トグル */}
              <TouchableOpacity
                style={[styles.toggleBtn, state.enabled && styles.toggleBtnOn]}
                onPress={() => toggleServer(server.id)}
              >
                <Text style={[styles.toggleText, state.enabled && styles.toggleTextOn]}>
                  {state.enabled ? 'ON' : 'OFF'}
                </Text>
              </TouchableOpacity>
            </TouchableOpacity>

            {/* 展開時の詳細 */}
            {isExpanded && (
              <View style={styles.cardDetail}>
                {/* Shellyとの相性 */}
                <View style={styles.noteBox}>
                  <MaterialIcons name="lightbulb" size={14} color="#FBBF24" />
                  <Text style={styles.noteText}>{server.shellyNote}</Text>
                </View>

                {/* タグ */}
                <View style={styles.tagRow}>
                  {server.tags.map((tag) => (
                    <View key={tag} style={styles.tag}>
                      <Text style={styles.tagText}>{tag}</Text>
                    </View>
                  ))}
                </View>

                {/* ローカルサーバーの操作ボタン */}
                {server.type === 'local' && (
                  <View style={styles.actionRow}>
                    {state.status !== 'running' ? (
                      <TouchableOpacity
                        style={[styles.actionBtn, styles.actionBtnStart]}
                        onPress={() => handleStart(server)}
                        disabled={isBusy || !isConnected}
                      >
                        {isBusy ? (
                          <ActivityIndicator size="small" color="#0A0A0A" />
                        ) : (
                          <>
                            <MaterialIcons name="play-arrow" size={14} color="#0A0A0A" />
                            <Text style={styles.actionBtnText}>{t('mcp.start')}</Text>
                          </>
                        )}
                      </TouchableOpacity>
                    ) : (
                      <TouchableOpacity
                        style={[styles.actionBtn, styles.actionBtnStop]}
                        onPress={() => handleStop(server)}
                        disabled={isBusy}
                      >
                        <MaterialIcons name="stop" size={14} color="#F87171" />
                        <Text style={[styles.actionBtnText, { color: '#F87171' }]}>{t('mcp.stop')}</Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity
                      style={[styles.actionBtn, styles.actionBtnStatus]}
                      onPress={() => handleCheckStatus(server)}
                      disabled={!isConnected}
                    >
                      <StatusDot status={state.status} />
                      <Text style={styles.actionBtnStatusText}>
                        {state.status === 'running' ? t('mcp.status_running') :
                         state.status === 'starting' ? t('mcp.status_starting') :
                         state.status === 'error' ? t('mcp.status_error') : t('mcp.status_stopped')}
                      </Text>
                    </TouchableOpacity>
                  </View>
                )}

                {/* リモート/npxサーバーのステータス */}
                {server.type !== 'local' && (
                  <View style={styles.remoteStatus}>
                    <StatusDot status={state.enabled ? 'running' : 'stopped'} />
                    <Text style={styles.remoteStatusText}>
                      {server.type === 'remote' ? t('mcp.remote_status') : t('mcp.npx_status')}
                    </Text>
                  </View>
                )}

                {/* エラー表示 */}
                {state.lastError && (
                  <View style={styles.errorBox}>
                    <Text style={styles.errorText}>{state.lastError}</Text>
                  </View>
                )}
              </View>
            )}
          </View>
        );
      })}

      {/* フッター説明 */}
      <Text style={styles.footer}>
        {t('mcp.footer')}
      </Text>
    </View>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function TypeBadge({ type }: { type: McpServerDef['type'] }) {
  const { t } = useTranslation();
  const config = {
    local: { label: t('mcp.type_local'), color: '#34D399', bg: '#34D39920' },
    remote: { label: t('mcp.type_remote'), color: '#818CF8', bg: '#818CF820' },
    npx: { label: 'npx', color: '#60A5FA', bg: '#60A5FA20' },
  };
  const c = config[type];
  return (
    <View style={[styles.typeBadge, { backgroundColor: c.bg }]}>
      <Text style={[styles.typeBadgeText, { color: c.color }]}>{c.label}</Text>
    </View>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === 'running' ? '#4ADE80' :
    status === 'starting' ? '#FBBF24' :
    status === 'error' ? '#F87171' : '#4B5563';
  return <View style={[styles.statusDot, { backgroundColor: color }]} />;
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  loading: {
    padding: 20,
    alignItems: 'center',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
  },
  enabledCount: {
    fontSize: 20,
    fontWeight: '700',
    color: '#60A5FA',
  },
  enabledLabel: {
    fontSize: 12,
    color: '#6B7280',
  },
  applyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#60A5FA',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  applyBtnDisabled: {
    backgroundColor: '#1F2937',
  },
  applyBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#0A0A0A',
  },
  applyBtnTextDisabled: {
    color: '#4B5563',
  },
  card: {
    backgroundColor: '#111318',
    borderRadius: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#1F2937',
    overflow: 'hidden',
  },
  cardEnabled: {
    borderColor: '#60A5FA40',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
  },
  cardLeft: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    flex: 1,
    gap: 10,
  },
  cardInfo: {
    flex: 1,
  },
  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  cardName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#6B7280',
  },
  cardNameEnabled: {
    color: '#E5E7EB',
  },
  cardDesc: {
    fontSize: 11,
    color: '#6B7280',
    marginTop: 2,
  },
  recBadge: {
    backgroundColor: '#FBBF2420',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
  },
  recBadgeText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#FBBF24',
  },
  typeBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
  },
  typeBadgeText: {
    fontSize: 9,
    fontWeight: '600',
  },
  toggleBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: '#1F2937',
    marginLeft: 8,
  },
  toggleBtnOn: {
    backgroundColor: '#60A5FA',
  },
  toggleText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#4B5563',
  },
  toggleTextOn: {
    color: '#0A0A0A',
  },
  cardDetail: {
    paddingHorizontal: 12,
    paddingBottom: 12,
    gap: 8,
  },
  noteBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    backgroundColor: '#FBBF2410',
    padding: 8,
    borderRadius: 6,
  },
  noteText: {
    fontSize: 11,
    color: '#D1D5DB',
    flex: 1,
  },
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },
  tag: {
    backgroundColor: '#1F2937',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
  },
  tagText: {
    fontSize: 10,
    color: '#9CA3AF',
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 5,
  },
  actionBtnStart: {
    backgroundColor: '#34D399',
  },
  actionBtnStop: {
    backgroundColor: '#1F2937',
    borderWidth: 1,
    borderColor: '#F8717140',
  },
  actionBtnStatus: {
    backgroundColor: '#1F2937',
  },
  actionBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#0A0A0A',
  },
  actionBtnStatusText: {
    fontSize: 11,
    color: '#9CA3AF',
  },
  remoteStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  },
  remoteStatusText: {
    fontSize: 11,
    color: '#6B7280',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  errorBox: {
    backgroundColor: '#F8717115',
    padding: 8,
    borderRadius: 6,
  },
  errorText: {
    fontSize: 10,
    color: '#F87171',
  },
  footer: {
    fontSize: 11,
    color: '#4B5563',
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 16,
  },
});
