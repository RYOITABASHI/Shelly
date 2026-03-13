/**
 * components/settings/LlamaCppSection.tsx
 *
 * Settings画面のLocal LLM (llama.cpp) 管理セクション。
 * - モデルカタログ表示（推奨バッジ・サイズ・RAM要件）
 * - 自動セットアップ（Bridge経由でTermuxにビルド・起動）
 * - モデルダウンロード・切替・削除
 * - llama-serverの起動/停止
 */

import React, { useState, useCallback } from 'react';
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

// ─── Props ────────────────────────────────────────────────────────────────────

interface LlamaCppSectionProps {
  isConnected: boolean;
  activeModelId: string | null;
  installedModelIds: Set<string>;
  onSelectModel: (model: LlamaCppModel) => void;
  onRunCommand: (command: string, label: string) => Promise<{ success: boolean; output?: string }>;
  onUpdateLocalLlmUrl: (url: string) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function LlamaCppSection({
  isConnected,
  activeModelId,
  installedModelIds,
  onSelectModel,
  onRunCommand,
  onUpdateLocalLlmUrl,
}: LlamaCppSectionProps) {
  const recommended = getRecommendedModel();
  const [expandedModelId, setExpandedModelId] = useState<string | null>(recommended?.id ?? null);
  const [loadingModelId, setLoadingModelId] = useState<string | null>(null);
  const [serverStatus, setServerStatus] = useState<'unknown' | 'running' | 'stopped'>('unknown');
  const [isSettingUp, setIsSettingUp] = useState(false);
  const [setupLog, setSetupLog] = useState<string[]>([]);
  const [showSetupLog, setShowSetupLog] = useState(false);

  // ── llama.cpp セットアップ ────────────────────────────────────────────────

  const handleSetup = useCallback(async () => {
    if (!isConnected) {
      Alert.alert('未接続', 'Termux Bridgeを先に接続してください。\nTermuxで shelly-bridge を起動してください。');
      return;
    }

    const steps = buildSetupSteps();
    const totalMin = Math.round(estimateTotalSetupTime(steps) / 60);

    Alert.alert(
      'llama.cpp セットアップ',
      `Termux上でllama.cppをインストールします。\n\n所要時間: 約${totalMin}分\n\n続けますか？`,
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: 'セットアップ開始',
          onPress: async () => {
            setIsSettingUp(true);
            setShowSetupLog(true);
            setSetupLog(['[shelly] llama.cpp セットアップ開始...']);

            for (const step of steps) {
              setSetupLog((prev) => [...prev, `[shelly] ${step.label}...`]);
              const result = await onRunCommand(step.command, step.label);
              if (!result.success && step.critical) {
                setSetupLog((prev) => [...prev, `[ERROR] ${step.label} 失敗。セットアップを中断しました。`]);
                setIsSettingUp(false);
                return;
              }
              if (result.output) {
                setSetupLog((prev) => [...prev, result.output as string]);
              }
            }

            setSetupLog((prev) => [...prev, '[shelly] セットアップ完了！']);
            setIsSettingUp(false);
            onUpdateLocalLlmUrl('http://127.0.0.1:8080');
          },
        },
      ]
    );
  }, [isConnected, onRunCommand, onUpdateLocalLlmUrl]);

  // ── モデルダウンロード ────────────────────────────────────────────────────

  const handleDownload = useCallback(async (model: LlamaCppModel) => {
    if (!isConnected) {
      Alert.alert('未接続', 'Termux Bridgeを先に接続してください。');
      return;
    }
    setLoadingModelId(model.id);
    const cmd = buildDownloadCommand(model);
    const result = await onRunCommand(cmd, `${model.name} ダウンロード`);
    setLoadingModelId(null);
    if (result.success) {
      Alert.alert('完了', `${model.name} のダウンロードが完了しました。`);
    } else {
      Alert.alert('エラー', 'ダウンロードに失敗しました。');
    }
  }, [isConnected, onRunCommand]);

  // ── サーバー起動/停止 ────────────────────────────────────────────────────

  const handleStartServer = useCallback(async (model: LlamaCppModel) => {
    if (!isConnected) {
      Alert.alert('未接続', 'Termux Bridgeを先に接続してください。');
      return;
    }
    const script = buildDaemonStartScript(model);
    const result = await onRunCommand(script, `${model.name} 起動`);
    if (result.success) {
      setServerStatus('running');
      onSelectModel(model);
      onUpdateLocalLlmUrl('http://127.0.0.1:8080');
    } else {
      Alert.alert('エラー', '起動に失敗しました。');
    }
  }, [isConnected, onRunCommand, onSelectModel, onUpdateLocalLlmUrl]);

  const handleStopServer = useCallback(async () => {
    if (!isConnected) return;
    const cmd = buildStopCommand();
    const result = await onRunCommand(cmd, 'llama-server 停止');
    if (result.success) {
      setServerStatus('stopped');
    }
  }, [isConnected, onRunCommand]);

  const handleCheckStatus = useCallback(async () => {
    if (!isConnected) return;
    const cmd = buildStatusCommand();
    const result = await onRunCommand(cmd, 'サーバー状態確認');
    setServerStatus(result.success ? 'running' : 'stopped');
  }, [isConnected, onRunCommand]);

  const handleDeleteModel = useCallback(async (model: LlamaCppModel) => {
    Alert.alert(
      'モデルを削除',
      `${model.name} を削除しますか？`,
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: '削除',
          style: 'destructive',
          onPress: async () => {
            const cmd = buildDeleteModelCommand(model);
            await onRunCommand(cmd, `${model.name} 削除`);
          },
        },
      ]
    );
  }, [onRunCommand]);

  // ── Render ────────────────────────────────────────────────────────────────

  const installedModels = MODEL_CATALOG.filter((m) => installedModelIds.has(m.id));
  const notInstalledModels = MODEL_CATALOG.filter((m) => !installedModelIds.has(m.id));

  return (
    <View>
      {/* セットアップボタン */}
      <View style={styles.setupRow}>
        <TouchableOpacity
          style={[styles.setupBtn, !isConnected && styles.setupBtnDisabled]}
          onPress={handleSetup}
          disabled={isSettingUp}
        >
          {isSettingUp
            ? <ActivityIndicator size="small" color="#00D4AA" />
            : <MaterialIcons name="build" size={16} color={isConnected ? '#00D4AA' : '#4B5563'} />
          }
          <Text style={[styles.setupBtnText, !isConnected && styles.setupBtnTextDisabled]}>
            {isSettingUp ? 'セットアップ中...' : 'llama.cpp セットアップ'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.statusBtn} onPress={handleCheckStatus}>
          <View style={[
            styles.statusDot,
            serverStatus === 'running' ? styles.statusDotGreen :
            serverStatus === 'stopped' ? styles.statusDotRed :
            styles.statusDotGray,
          ]} />
          <Text style={styles.statusBtnText}>
            {serverStatus === 'running' ? '稼働中' :
             serverStatus === 'stopped' ? '停止中' : '不明'}
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
      {serverStatus === 'running' && (
        <TouchableOpacity style={styles.stopBtn} onPress={handleStopServer}>
          <MaterialIcons name="stop" size={16} color="#F87171" />
          <Text style={styles.stopBtnText}>サーバーを停止</Text>
        </TouchableOpacity>
      )}

      {/* ── インストール済みモデル ──────────────────────────────────────── */}
      {installedModels.length > 0 && (
        <>
          <Text style={styles.catalogLabel}>インストール済み</Text>
          {installedModels.map((model) => {
            const isActive = activeModelId === model.id;
            return (
              <View key={model.id} style={[styles.modelCard, isActive && styles.modelCardActive]}>
                <View style={styles.installedRow}>
                  <View style={styles.installedInfo}>
                    <View style={styles.modelTitleRow}>
                      <Text style={styles.modelName}>{model.name}</Text>
                      {isActive && <View style={styles.activeBadge}><Text style={styles.activeBadgeText}>使用中</Text></View>}
                    </View>
                    <Text style={styles.modelMeta}>{model.sizeGb}GB · RAM {model.ramRequiredGb}GB</Text>
                  </View>
                  <View style={styles.installedActions}>
                    {!isActive && (
                      <TouchableOpacity
                        style={[styles.actionBtn, styles.actionBtnPrimary]}
                        onPress={() => handleStartServer(model)}
                      >
                        <Text style={styles.actionBtnPrimaryText}>起動</Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity
                      style={[styles.actionBtn, styles.actionBtnDanger]}
                      onPress={() => handleDeleteModel(model)}
                    >
                      <MaterialIcons name="delete-outline" size={14} color="#F87171" />
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            );
          })}
          <Text style={styles.storageSummary}>
            ストレージ使用量: {installedModels.reduce((sum, m) => sum + m.sizeGb, 0).toFixed(1)}GB
          </Text>
        </>
      )}

      {/* ── モデルカタログ（未インストールのみ） ──────────────────────────── */}
      <Text style={styles.catalogLabel}>モデルカタログ</Text>
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
                {isRec && <View style={styles.recBadge}><Text style={styles.recBadgeText}>推奨</Text></View>}
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
                    disabled={isLoading}
                  >
                    {isLoading
                      ? <ActivityIndicator size="small" color="#0A0A0A" />
                      : <Text style={styles.actionBtnPrimaryText}>ダウンロード ({model.sizeGb}GB)</Text>
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
  setupBtnText: { color: '#00D4AA', fontSize: 13, fontFamily: 'monospace' },
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
  statusDotRed: { backgroundColor: '#F87171' },
  statusDotGray: { backgroundColor: '#4B5563' },
  statusBtnText: { color: '#9CA3AF', fontSize: 12, fontFamily: 'monospace' },
  logBox: {
    backgroundColor: '#0D0D0D',
    borderRadius: 6,
    padding: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#1A1A1A',
  },
  logLine: { color: '#6B7280', fontSize: 10, fontFamily: 'monospace', lineHeight: 16 },
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
  stopBtnText: { color: '#F87171', fontSize: 13, fontFamily: 'monospace' },
  catalogLabel: {
    color: '#00D4AA',
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
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
  modelName: { color: '#E8E8E8', fontSize: 13, fontWeight: '600', fontFamily: 'monospace' },
  recBadge: { backgroundColor: '#00D4AA22', borderRadius: 3, paddingHorizontal: 5, paddingVertical: 1, borderWidth: 1, borderColor: '#00D4AA' },
  recBadgeText: { color: '#00D4AA', fontSize: 9, fontFamily: 'monospace', fontWeight: '700' },
  badge: { backgroundColor: '#1E1B4B', borderRadius: 3, paddingHorizontal: 5, paddingVertical: 1 },
  badgeText: { color: '#818CF8', fontSize: 9, fontFamily: 'monospace' },
  activeBadge: { backgroundColor: '#052E16', borderRadius: 3, paddingHorizontal: 5, paddingVertical: 1, borderWidth: 1, borderColor: '#166534' },
  activeBadgeText: { color: '#4ADE80', fontSize: 9, fontFamily: 'monospace', fontWeight: '700' },
  modelMeta: { color: '#6B7280', fontSize: 11, fontFamily: 'monospace', marginTop: 3 },
  modelDetail: { paddingHorizontal: 12, paddingBottom: 12, borderTopWidth: 1, borderTopColor: '#2D2D2D' },
  modelDesc: { color: '#9CA3AF', fontSize: 12, fontFamily: 'monospace', lineHeight: 18, marginTop: 8, marginBottom: 10 },
  modelActions: { flexDirection: 'row', gap: 8 },
  actionBtn: { borderRadius: 6, paddingVertical: 7, paddingHorizontal: 14 },
  actionBtnPrimary: { backgroundColor: '#00D4AA' },
  actionBtnPrimaryText: { color: '#0A0A0A', fontSize: 12, fontWeight: '700', fontFamily: 'monospace' },
  actionBtnDanger: { backgroundColor: '#1A0A0A', borderWidth: 1, borderColor: '#F87171' },
  actionBtnDangerText: { color: '#F87171', fontSize: 12, fontFamily: 'monospace' },
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
    fontFamily: 'monospace',
    textAlign: 'right',
    marginBottom: 12,
    marginTop: 2,
  },
});
