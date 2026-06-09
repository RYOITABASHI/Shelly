import React, { useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ScrollView,
  Share,
  Alert,
} from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { ShellyModal } from './ShellyModal';
import { ModalHeader } from '@/components/settings/ModalHeader';
import { buildRecentTerminalLogsText } from '@/lib/terminal-logs';
import { useExecutionLogStore } from '@/store/execution-log-store';
import { useTerminalStore } from '@/store/terminal-store';
import { colors as C, fonts as F, radii as R } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';
import { useTranslation } from '@/lib/i18n';

type Props = {
  visible: boolean;
  onClose: () => void;
};

export function RecentLogsModal({ visible, onClose }: Props) {
  const { t } = useTranslation();
  const [copyBusy, setCopyBusy] = useState(false);
  const sessionBuffer = useExecutionLogStore((s) => s.sessionBuffer);
  const terminalSessions = useTerminalStore((s) => s.sessions);
  // Keep subscriptions active so the generated export text refreshes on log/session changes.
  void sessionBuffer;
  void terminalSessions;

  const text = buildRecentTerminalLogsText(500);
  const hasLogs = text.trim().length > 0 && text.trim() !== 'No terminal output to export.';

  const handleCopy = async () => {
    if (!hasLogs || copyBusy) return;
    setCopyBusy(true);
    try {
      await Clipboard.setStringAsync(text);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } finally {
      setCopyBusy(false);
    }
  };

  const handleShare = async () => {
    if (!hasLogs) return;
    try {
      await Share.share({ message: text, title: t('recent_logs.share_title') });
    } catch {
      Alert.alert(t('recent_logs.share_failed_title'), t('recent_logs.share_failed_body'));
    }
  };

  return (
    <ShellyModal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <ModalHeader title={t('recent_logs.title')} onClose={onClose} />

          <View style={styles.toolbar}>
            <Pressable
              style={({ pressed }) => [
                styles.actionBtn,
                pressed && styles.actionBtnPressed,
                !hasLogs && styles.actionBtnDisabled,
              ]}
              onPress={handleCopy}
              disabled={!hasLogs || copyBusy}
              accessibilityRole="button"
              accessibilityLabel={t('recent_logs.copy_a11y')}
            >
              <MaterialIcons name="content-copy" size={14} color={C.text2} />
              <Text style={styles.actionText}>{t('common.copy')}</Text>
            </Pressable>

            <Pressable
              style={({ pressed }) => [
                styles.actionBtn,
                pressed && styles.actionBtnPressed,
                !hasLogs && styles.actionBtnDisabled,
              ]}
              onPress={handleShare}
              disabled={!hasLogs}
              accessibilityRole="button"
              accessibilityLabel={t('recent_logs.share_a11y')}
            >
              <MaterialIcons name="share" size={14} color={C.text2} />
              <Text style={styles.actionText}>{t('common.share')}</Text>
            </Pressable>

            <View style={styles.metaWrap}>
              <MaterialIcons name="history" size={13} color={C.text3} />
              <Text style={styles.metaText}>
                {sessionBuffer.length > 0
                  ? t('recent_logs.lines_buffered', { count: sessionBuffer.length })
                  : t('recent_logs.no_buffered_logs')}
              </Text>
            </View>
          </View>

          <View style={styles.body}>
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              <Text selectable style={styles.logText}>
                {text}
              </Text>
            </ScrollView>
          </View>
        </Pressable>
      </Pressable>
    </ShellyModal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.72)',
    justifyContent: 'center',
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  sheet: {
    flex: 1,
    backgroundColor: C.bgSidebar,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 10,
    overflow: 'hidden',
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    backgroundColor: withAlpha(C.bgSidebar, 0.96),
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: R.agentTab,
    borderWidth: 1,
    borderColor: withAlpha(C.text2, 0.18),
    backgroundColor: withAlpha(C.bgSidebar, 0.6),
  },
  actionBtnPressed: {
    backgroundColor: withAlpha(C.text2, 0.08),
  },
  actionBtnDisabled: {
    opacity: 0.45,
  },
  actionText: {
    color: C.text2,
    fontFamily: F.family,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0,
  },
  metaWrap: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  metaText: {
    color: C.text3,
    fontFamily: F.family,
    fontSize: 11,
    fontWeight: '600',
  },
  body: {
    flex: 1,
    backgroundColor: '#090909',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    paddingBottom: 24,
  },
  logText: {
    color: C.text1,
    fontFamily: F.family,
    fontSize: 11,
    lineHeight: 16,
    letterSpacing: 0,
  },
});
