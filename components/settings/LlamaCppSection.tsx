/**
 * components/settings/LlamaCppSection.tsx
 *
 * Settings画面のLocal LLM (llama.cpp) 管理セクション。
 * - モデルカタログ表示（推奨バッジ・サイズ・RAM要件）
 * - 自動セットアップ（ネイティブシェル経由でビルド・起動）
 * - モデルダウンロード・切替・削除
 * - llama-serverの起動/停止
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
} from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import {
  MODEL_CATALOG,
  LlamaCppModel,
  buildSetupSteps,
  buildDownloadCommand,
  buildDaemonStartScript,
  buildStopCommand,
  buildStatusCommand,
  buildDeleteModelCommand,
  getRecommendedModel,
  estimateTotalSetupTime,
} from '@/lib/llamacpp-setup';
import { useTranslation } from '@/lib/i18n';

// ─── Props ────────────────────────────────────────────────────────────────────

interface LlamaCppSectionProps {
  isConnected: boolean;
  activeModelId: string | null;
  installedModelIds: Set<string>;
  installedModelPaths?: Record<string, string>;
  onSelectModel: (model: LlamaCppModel) => void;
  onRunCommand: (command: string, label: string) => Promise<{ success: boolean; output?: string }>;
  onUpdateLocalLlmUrl: (url: string) => void;
}

type ServerStatus = 'unknown' | 'running' | 'starting' | 'stopped';

function resolveServerStatus(result: { success: boolean; output?: string }): ServerStatus {
  if (result.success) return 'running';
  const output = result.output ?? '';
  if (
    output.includes('starting_or_unreachable') ||
    output.includes('still running but did not become ready')
  ) {
    return 'starting';
  }
  return 'stopped';
}

// ─── Component ────────────────────────────────────────────────────────────────

export function LlamaCppSection({
  isConnected,
  activeModelId,
  installedModelIds,
  installedModelPaths,
  onSelectModel,
  onRunCommand,
  onUpdateLocalLlmUrl,
}: LlamaCppSectionProps) {
  const { t } = useTranslation();
  const recommended = getRecommendedModel();
  const [expandedModelId, setExpandedModelId] = useState<string | null>(recommended?.id ?? null);
  const [loadingModelId, setLoadingModelId] = useState<string | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerStatus>('unknown');
  const [isSettingUp, setIsSettingUp] = useState(false);
  const [setupLog, setSetupLog] = useState<string[]>([]);
  const [showSetupLog, setShowSetupLog] = useState(false);

  // ── Re-check server status while this settings sheet is open ───────────────
  useEffect(() => {
    if (!isConnected) {
      setServerStatus('unknown');
      return;
    }
    let cancelled = false;
    let inFlight = false;
    const cmd = buildStatusCommand();
    const checkStatus = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await onRunCommand(cmd, t('llama.status_check'));
        if (!cancelled) setServerStatus(resolveServerStatus(result));
      } finally {
        inFlight = false;
      }
    };

    checkStatus();
    const interval = setInterval(checkStatus, 7000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isConnected, onRunCommand, t]);

  // ── llama.cpp セットアップ ────────────────────────────────────────────────

  const handleSetup = useCallback(async () => {
    if (!isConnected) {
      Alert.alert(t('common.not_connected'), t('common.terminal_not_connected'));
      return;
    }

    const steps = buildSetupSteps();
    const totalMin = Math.round(estimateTotalSetupTime(steps) / 60);

    Alert.alert(
      t('llama.setup_title'),
      t('llama.setup_body', { minutes: totalMin }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('llama.start_setup'),
          onPress: async () => {
            setIsSettingUp(true);
            setShowSetupLog(true);
            setSetupLog(['[shelly] llama.cpp setup starting...']);

            for (const step of steps) {
              setSetupLog((prev) => [...prev, `[shelly] ${step.label}...`]);
              const result = await onRunCommand(step.command, step.label);
              if (result.output) {
                setSetupLog((prev) => [...prev, result.output as string]);
              }
              if (!result.success && step.critical) {
                setSetupLog((prev) => [...prev, `[ERROR] ${step.label} failed. ${t('llama.setup_aborted')}`]);
                setIsSettingUp(false);
                return;
              }
            }

            setSetupLog((prev) => [...prev, '[shelly] Setup complete!']);
            setIsSettingUp(false);
            onUpdateLocalLlmUrl('http://127.0.0.1:8080');
          },
        },
      ]
    );
  }, [isConnected, onRunCommand, onUpdateLocalLlmUrl, t]);

  // ── モデルダウンロード ────────────────────────────────────────────────────

  const handleDownload = useCallback(async (model: LlamaCppModel) => {
    if (!isConnected) {
      Alert.alert(t('common.not_connected'), t('common.terminal_not_connected'));
      return;
    }
    setLoadingModelId(model.id);
    const cmd = buildDownloadCommand(model);
    let result: { success: boolean; output?: string };
    try {
      result = await onRunCommand(cmd, `${model.name} download`);
    } catch (error) {
      result = {
        success: false,
        output: error instanceof Error ? error.message : String(error),
      };
    } finally {
      setLoadingModelId(null);
    }
    if (result.success) {
      Alert.alert(t('common.done'), t('llama.download_complete', { name: model.name }));
    } else {
      const details = (result.output ?? '').trim().slice(-800);
      Alert.alert(t('common.error'), `${t('llama.download_failed')}${details ? `\n\n${details}` : ''}`);
    }
  }, [isConnected, onRunCommand, t]);

  // ── サーバー起動/停止 ────────────────────────────────────────────────────

  const handleStartServer = useCallback(async (model: LlamaCppModel) => {
    if (!isConnected) {
      Alert.alert(t('common.not_connected'), t('common.terminal_not_connected'));
      return;
    }
    const script = buildDaemonStartScript(model, installedModelPaths?.[model.id]);
    let result: { success: boolean; output?: string };
    try {
      result = await onRunCommand(script, `${model.name} start`);
    } catch (error) {
      result = {
        success: false,
        output: error instanceof Error ? error.message : String(error),
      };
    }
    if (result.success) {
      setServerStatus('running');
      onSelectModel(model);
      onUpdateLocalLlmUrl('http://127.0.0.1:8080');
    } else {
      setServerStatus(resolveServerStatus(result));
      const detail = (result.output ?? '').trim() || t('llama.no_startup_output');
      Alert.alert(t('common.error'), `${t('llama.start_failed')}\n\n${detail.slice(-1200)}`);
    }
  }, [installedModelPaths, isConnected, onRunCommand, onSelectModel, onUpdateLocalLlmUrl, t]);

  const handleStopServer = useCallback(async () => {
    if (!isConnected) return;
    const cmd = buildStopCommand();
    const result = await onRunCommand(cmd, t('llama.stop_server'));
    if (result.success) {
      setServerStatus('stopped');
    }
  }, [isConnected, onRunCommand, t]);

  const handleCheckStatus = useCallback(async () => {
    if (!isConnected) return;
    const cmd = buildStatusCommand();
    const result = await onRunCommand(cmd, t('llama.status_check'));
    setServerStatus(resolveServerStatus(result));
  }, [isConnected, onRunCommand, t]);

  const handleDeleteModel = useCallback(async (model: LlamaCppModel) => {
    Alert.alert(
      t('llama.delete_model_title'),
      t('llama.delete_model_body', { name: model.name }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: async () => {
            const cmd = buildDeleteModelCommand(model);
            await onRunCommand(cmd, `${model.name} delete`);
          },
        },
      ]
    );
  }, [onRunCommand, t]);

  // ── Render ────────────────────────────────────────────────────────────────

  const installedModels = MODEL_CATALOG.filter((m) => installedModelIds.has(m.id));
  const notInstalledModels = MODEL_CATALOG.filter((m) => !installedModelIds.has(m.id));
  const operationInProgress = isSettingUp || loadingModelId !== null;

  return (
    <View>
      {/* セットアップボタン */}
      <View style={styles.setupRow}>
        <TouchableOpacity
          style={[styles.setupBtn, !isConnected && styles.setupBtnDisabled]}
          onPress={handleSetup}
          disabled={operationInProgress}
        >
          {isSettingUp
            ? <ActivityIndicator size="small" color="#00D4AA" />
            : <MaterialIcons name="build" size={16} color={isConnected ? '#00D4AA' : '#4B5563'} />
          }
          <Text style={[styles.setupBtnText, !isConnected && styles.setupBtnTextDisabled]}>
            {isSettingUp ? t('llama.setting_up') : t('llama.setup_button')}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.statusBtn} onPress={handleCheckStatus}>
          <View style={[
            styles.statusDot,
            serverStatus === 'running' ? styles.statusDotGreen :
            serverStatus === 'starting' ? styles.statusDotYellow :
            serverStatus === 'stopped' ? styles.statusDotRed :
            styles.statusDotGray,
          ]} />
          <Text style={styles.statusBtnText}>
            {serverStatus === 'running' ? t('llama.running') :
             serverStatus === 'starting' ? t('llama.starting') :
             serverStatus === 'stopped' ? t('llama.stopped') : t('llama.unknown')}
          </Text>
        </TouchableOpacity>
      </View>

      {/* セットアップログ */}
      {showSetupLog && (
        <View style={styles.logBox}>
          <ScrollView style={{ maxHeight: 120 }}>
            {setupLog.map((line, i) => (
              <Text key={i} style={styles.logLine}>{line}</Text>
            ))}
          </ScrollView>
        </View>
      )}

      {/* サーバー停止ボタン */}
      {(serverStatus === 'running' || serverStatus === 'starting') && (
        <TouchableOpacity style={styles.stopBtn} onPress={handleStopServer}>
          <MaterialIcons name="stop" size={16} color="#F87171" />
          <Text style={styles.stopBtnText}>{t('llama.stop_server')}</Text>
        </TouchableOpacity>
      )}

      {/* ── インストール済みモデル ──────────────────────────────────────── */}
      {installedModels.length > 0 && (
        <>
          <Text style={styles.catalogLabel}>{t('llama.installed')}</Text>
          {installedModels.map((model) => {
            const isActive = activeModelId === model.id;
            const canStart =
              !operationInProgress &&
              serverStatus !== 'starting' &&
              (serverStatus !== 'running' || !isActive);
            return (
              <View key={model.id} style={[styles.modelCard, isActive && styles.modelCardActive]}>
                <View style={styles.installedRow}>
                  <View style={styles.installedInfo}>
                    <View style={styles.modelTitleRow}>
                      <Text style={styles.modelName}>{model.name}</Text>
                      {isActive && <View style={styles.activeBadge}><Text style={styles.activeBadgeText}>{t('llama.active')}</Text></View>}
                    </View>
                    <Text style={styles.modelMeta}>{model.sizeGb}GB · RAM {model.ramRequiredGb}GB</Text>
                  </View>
                  <View style={styles.installedActions}>
                    {canStart && (
                      <TouchableOpacity
                        style={[styles.actionBtn, styles.actionBtnPrimary]}
                        onPress={() => handleStartServer(model)}
                      >
                        <Text style={styles.actionBtnPrimaryText}>{t('llama.start')}</Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity
                      style={[styles.actionBtn, styles.actionBtnDanger]}
                      onPress={() => handleDeleteModel(model)}
                      disabled={operationInProgress}
                    >
                      <MaterialIcons name="delete-outline" size={14} color="#F87171" />
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            );
          })}
          <Text style={styles.storageSummary}>
            {t('llama.storage_used', { size: installedModels.reduce((sum, m) => sum + m.sizeGb, 0).toFixed(1) })}
          </Text>
        </>
      )}

      {/* ── モデルカタログ（未インストールのみ） ──────────────────────────── */}
      <Text style={styles.catalogLabel}>{t('llama.model_catalog')}</Text>
      {notInstalledModels.map((model) => {
        const isExpanded = expandedModelId === model.id;
        const isLoading = loadingModelId === model.id;
        const isRec = recommended?.id === model.id;

        return (
          <View key={model.id} style={styles.modelCard}>
            <TouchableOpacity
              style={styles.modelHeader}
              onPress={() => setExpandedModelId(isExpanded ? null : model.id)}
            >
              <View style={styles.modelTitleRow}>
                <Text style={styles.modelName}>{model.name}</Text>
                {isRec && <View style={styles.recBadge}><Text style={styles.recBadgeText}>{t('llama.recommended')}</Text></View>}
                {model.badge && <View style={styles.badge}><Text style={styles.badgeText}>{model.badge}</Text></View>}
              </View>
              <Text style={styles.modelMeta}>{model.sizeGb}GB · RAM {model.ramRequiredGb}GB · {model.quantization}</Text>
            </TouchableOpacity>

            {isExpanded && (
              <View style={styles.modelDetail}>
                <Text style={styles.modelDesc}>{model.description}</Text>
                <View style={styles.modelActions}>
                  <TouchableOpacity
                    style={[styles.actionBtn, styles.actionBtnPrimary]}
                    onPress={() => handleDownload(model)}
                    disabled={operationInProgress}
                  >
                    {isLoading
                      ? <ActivityIndicator size="small" color="#0A0A0A" />
                      : <Text style={styles.actionBtnPrimaryText}>{t('llama.download', { size: model.sizeGb })}</Text>
                    }
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  setupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  setupBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#1A1A1A',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#00D4AA44',
  },
  setupBtnDisabled: { borderColor: '#2D2D2D' },
  setupBtnText: { color: '#00D4AA', fontSize: 13, fontFamily: 'JetBrainsMono_400Regular' },
  setupBtnTextDisabled: { color: '#4B5563' },
  statusBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#1A1A1A',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#2D2D2D',
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusDotGreen: { backgroundColor: '#4ADE80' },
  statusDotYellow: { backgroundColor: '#FACC15' },
  statusDotRed: { backgroundColor: '#F87171' },
  statusDotGray: { backgroundColor: '#4B5563' },
  statusBtnText: { color: '#9CA3AF', fontSize: 12, fontFamily: 'JetBrainsMono_400Regular' },
  logBox: {
    backgroundColor: '#0D0D0D',
    borderRadius: 6,
    padding: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#1A1A1A',
  },
  logLine: { color: '#6B7280', fontSize: 10, fontFamily: 'JetBrainsMono_400Regular', lineHeight: 16 },
  stopBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#1A0A0A',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#F8717144',
  },
  stopBtnText: { color: '#F87171', fontSize: 13, fontFamily: 'JetBrainsMono_400Regular' },
  catalogLabel: {
    color: '#00D4AA',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: 8,
    marginBottom: 8,
  },
  modelCard: {
    backgroundColor: '#1A1A1A',
    borderRadius: 8,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: '#2D2D2D',
    overflow: 'hidden',
  },
  modelCardActive: { borderColor: '#00D4AA' },
  modelHeader: { padding: 12 },
  modelTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  modelName: { color: '#E8E8E8', fontSize: 13, fontWeight: '600', fontFamily: 'JetBrainsMono_400Regular' },
  recBadge: { backgroundColor: '#00D4AA22', borderRadius: 3, paddingHorizontal: 5, paddingVertical: 1, borderWidth: 1, borderColor: '#00D4AA' },
  recBadgeText: { color: '#00D4AA', fontSize: 9, fontFamily: 'JetBrainsMono_400Regular', fontWeight: '700' },
  badge: { backgroundColor: '#1E1B4B', borderRadius: 3, paddingHorizontal: 5, paddingVertical: 1 },
  badgeText: { color: '#818CF8', fontSize: 9, fontFamily: 'JetBrainsMono_400Regular' },
  activeBadge: { backgroundColor: '#052E16', borderRadius: 3, paddingHorizontal: 5, paddingVertical: 1, borderWidth: 1, borderColor: '#166534' },
  activeBadgeText: { color: '#4ADE80', fontSize: 9, fontFamily: 'JetBrainsMono_400Regular', fontWeight: '700' },
  modelMeta: { color: '#6B7280', fontSize: 11, fontFamily: 'JetBrainsMono_400Regular', marginTop: 3 },
  modelDetail: { paddingHorizontal: 12, paddingBottom: 12, borderTopWidth: 1, borderTopColor: '#2D2D2D' },
  modelDesc: { color: '#9CA3AF', fontSize: 12, fontFamily: 'JetBrainsMono_400Regular', lineHeight: 18, marginTop: 8, marginBottom: 10 },
  modelActions: { flexDirection: 'row', gap: 8 },
  actionBtn: { borderRadius: 6, paddingVertical: 7, paddingHorizontal: 14 },
  actionBtnPrimary: { backgroundColor: '#00D4AA' },
  actionBtnPrimaryText: { color: '#0A0A0A', fontSize: 12, fontWeight: '700', fontFamily: 'JetBrainsMono_400Regular' },
  actionBtnDanger: { backgroundColor: '#1A0A0A', borderWidth: 1, borderColor: '#F87171' },
  actionBtnDangerText: { color: '#F87171', fontSize: 12, fontFamily: 'JetBrainsMono_400Regular' },
  installedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
  },
  installedInfo: { flex: 1 },
  installedActions: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  storageSummary: {
    color: '#6B7280',
    fontSize: 10,
    textAlign: 'right',
    marginBottom: 12,
    marginTop: 2,
  },
});
