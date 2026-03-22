/**
 * SavepointBubble — Inline undo/view-changes buttons after file-changing operations.
 * Appears below chat bubbles when a savepoint was created for that message.
 */
import React, { useState, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, Alert } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/lib/theme-engine';
import { useTranslation } from '@/lib/i18n';
import { useSavepointStore } from '@/store/savepoint-store';
import { revertLastSavepoint, getLastDiff } from '@/lib/auto-savepoint';
import { DiffViewerModal } from './DiffViewerModal';

type Props = {
  messageId: string;
  projectDir: string;
  runCommand: (cmd: string) => Promise<{ stdout: string; exitCode: number }>;
};

export function SavepointBubble({ messageId, projectDir, runCommand }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const info = useSavepointStore((s) => s.messageSavepoints[messageId]);
  const markReverted = useSavepointStore((s) => s.markReverted);
  const [diffVisible, setDiffVisible] = useState(false);
  const [diffContent, setDiffContent] = useState('');
  const [reverting, setReverting] = useState(false);

  if (!info) return null;

  const totalFiles = info.filesChanged + info.filesCreated + info.filesDeleted;

  const handleUndo = useCallback(async () => {
    if (info.reverted || reverting) return;
    setReverting(true);
    const success = await revertLastSavepoint(projectDir, runCommand);
    setReverting(false);
    if (success) {
      markReverted(messageId);
    } else {
      Alert.alert('', t('savepoint.revert_failed'));
    }
  }, [info.reverted, reverting, projectDir, runCommand, messageId, markReverted, t]);

  const handleViewDiff = useCallback(async () => {
    const diff = await getLastDiff(projectDir, runCommand);
    setDiffContent(diff);
    setDiffVisible(true);
  }, [projectDir, runCommand]);

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <MaterialIcons name="folder" size={14} color={colors.inactive} />
        <Text style={[styles.text, { color: colors.inactive }]}>
          {t('savepoint.files_changed', { count: String(totalFiles) })}
        </Text>
      </View>
      <View style={styles.actions}>
        <Pressable
          style={[styles.btn, info.reverted && styles.btnDisabled]}
          onPress={handleUndo}
          disabled={info.reverted || reverting}
        >
          <Text style={[styles.btnText, { color: info.reverted ? '#666' : '#F87171' }]}>
            {info.reverted ? t('savepoint.reverted') : t('savepoint.undo')}
          </Text>
        </Pressable>
        <Pressable style={styles.btn} onPress={handleViewDiff}>
          <Text style={[styles.btnText, { color: colors.accent }]}>
            {t('savepoint.view_changes')}
          </Text>
        </Pressable>
      </View>

      <DiffViewerModal
        visible={diffVisible}
        diff={diffContent}
        onClose={() => setDiffVisible(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginTop: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  text: {
    fontFamily: 'monospace',
    fontSize: 11,
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
  },
  btn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#333',
  },
  btnDisabled: {
    opacity: 0.5,
  },
  btnText: {
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: '600',
  },
});
