/**
 * BridgeRecoveryBanner — ブリッジ切断時の復帰案内 (v3)
 *
 * フロー:
 *   1. 自動再接続5回失敗 → Native Module経由で自動復旧試行
 *   2. 自動復旧中は「自動復旧中...」を表示
 *   3. 自動復旧失敗 → 10秒後に自動リトライ（手動操作不要）
 *   4. 復旧成功 + 前回CLIセッションあり → セッション引き継ぎ提案
 */
import React, { useState, useEffect, useRef } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTranslation } from '@/lib/i18n';
import { useTermuxBridge } from '@/hooks/use-termux-bridge';
import { useTerminalStore } from '@/store/terminal-store';

export function BridgeRecoveryBanner() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { connectionMode, bridgeStatus } = useTerminalStore();
  const {
    isReconnectExhausted,
    isAutoRecovering,
    autoRecoveryFailed,
    recoveredFromCrash,
    resetReconnect,
    sendCommand,
  } = useTermuxBridge();
  const [dismissed, setDismissed] = useState(false);
  const [showSessionResume, setShowSessionResume] = useState(false);
  const sessionResumeShownRef = useRef(false);

  // Show session resume prompt after recovery from crash
  useEffect(() => {
    if (
      bridgeStatus === 'connected' &&
      recoveredFromCrash &&
      !sessionResumeShownRef.current
    ) {
      const { activeCliSession } = useTerminalStore.getState();
      if (activeCliSession === 'claude') {
        sessionResumeShownRef.current = true;
        setShowSessionResume(true);
      }
    }
  }, [bridgeStatus, recoveredFromCrash]);

  // Reset dismissed state when connection is restored
  useEffect(() => {
    if (bridgeStatus === 'connected') {
      setDismissed(false);
    }
  }, [bridgeStatus]);

  const isDisconnected =
    connectionMode === 'termux' &&
    (bridgeStatus === 'error' || bridgeStatus === 'disconnected');

  const bannerPadding = { paddingTop: insets.top };

  // Show auto-recovering banner
  if (isDisconnected && isAutoRecovering) {
    return (
      <View style={[styles.container, bannerPadding]}>
        <View style={styles.content}>
          <ActivityIndicator size="small" color="#00D4AA" />
          <Text style={styles.recoveringText}>{t('bridge.auto_recovering')}</Text>
        </View>
      </View>
    );
  }

  // Show session resume banner after successful recovery
  if (showSessionResume && bridgeStatus === 'connected') {
    return (
      <View style={[styles.container, styles.successContainer, bannerPadding]}>
        <View style={styles.content}>
          <MaterialIcons name="refresh" size={18} color="#00D4AA" />
          <Text style={styles.successText}>{t('bridge.session_resume_prompt')}</Text>
        </View>
        <View style={styles.actions}>
          <Pressable
            style={[styles.btn, styles.successBtn]}
            onPress={() => {
              setShowSessionResume(false);
              sendCommand('claude --continue');
            }}
          >
            <Text style={styles.successBtnText}>{t('bridge.session_resume_yes')}</Text>
          </Pressable>
          <Pressable
            style={styles.dismissBtn}
            onPress={() => setShowSessionResume(false)}
          >
            <MaterialIcons name="close" size={16} color="#6B7280" />
          </Pressable>
        </View>
      </View>
    );
  }

  // Auto-recovery now retries automatically, so the "manual" banner is a
  // gentle "still trying" message rather than asking the user to do anything.
  // Only show if reconnect exhausted AND auto-recovery is between rounds.
  const shouldShowRetrying =
    isDisconnected &&
    !isAutoRecovering &&
    !dismissed;

  if (!shouldShowRetrying) return null;

  const handleReconnect = () => {
    setDismissed(false);
    resetReconnect();
  };

  return (
    <View style={[styles.container, bannerPadding]}>
      <View style={styles.content}>
        <ActivityIndicator size="small" color="#FBBF24" />
        <Text style={styles.text}>
          {t('bridge.auto_recovery_retrying')}
        </Text>
      </View>
      <View style={styles.actions}>
        <Pressable style={styles.btn} onPress={handleReconnect}>
          <Text style={styles.btnText}>{t('bridge.reconnect')}</Text>
        </Pressable>
        <Pressable style={styles.dismissBtn} onPress={() => setDismissed(true)}>
          <MaterialIcons name="close" size={16} color="#6B7280" />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#1A1A00',
    borderBottomWidth: 1,
    borderBottomColor: '#FBBF2433',
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  successContainer: {
    backgroundColor: '#001A10',
    borderBottomColor: '#00D4AA33',
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  text: {
    color: '#FBBF24',
    fontSize: 11,
    fontFamily: 'monospace',
    flex: 1,
  },
  recoveringText: {
    color: '#00D4AA',
    fontSize: 11,
    fontFamily: 'monospace',
    flex: 1,
  },
  successText: {
    color: '#00D4AA',
    fontSize: 11,
    fontFamily: 'monospace',
    flex: 1,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  btn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#FBBF2444',
  },
  successBtn: {
    borderColor: '#00D4AA44',
  },
  btnText: {
    color: '#FBBF24',
    fontSize: 10,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  successBtnText: {
    color: '#00D4AA',
    fontSize: 10,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  dismissBtn: {
    padding: 4,
  },
});
