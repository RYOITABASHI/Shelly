// components/layout/WorktreeAddModal.tsx
//
// Bottom-sheet that collects a branch name + agent binding and calls
// worktree-store.addWorktree on Submit. Keeps the UX local to this
// component so the Sidebar's WORKTREES section stays declarative.

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  
  Pressable,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { ShellyModal } from '@/components/layout/ShellyModal';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useWorktreeStore, type WorktreeAgent } from '@/store/worktree-store';
import { colors as C, fonts as F, sizes as S } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';
import { useTranslation } from '@/lib/i18n';

type Props = {
  visible: boolean;
  repoPath: string | null;
  initialAgent?: WorktreeAgent;
  onClose: () => void;
};

const AGENTS: { id: WorktreeAgent; label: string; color: string }[] = [
  { id: 'codex', label: 'Codex', color: '#22C55E' },
  { id: 'none', label: 'None', color: '#9CA3AF' },
];

function supportedInitialAgent(agent: WorktreeAgent): WorktreeAgent {
  return agent === 'codex' || agent === 'none' ? agent : 'codex';
}

export function WorktreeAddModal({ visible, repoPath, initialAgent = 'codex', onClose }: Props) {
  const { t } = useTranslation();
  const addWorktree = useWorktreeStore((s) => s.addWorktree);
  const [agent, setAgent] = useState<WorktreeAgent>(supportedInitialAgent(initialAgent));
  const [branch, setBranch] = useState('');
  const [busy, setBusy] = useState(false);

  // Reset local state each time the modal opens so a fresh create never
  // inherits stale input from a previous aborted attempt.
  React.useEffect(() => {
    if (visible) {
      setAgent(supportedInitialAgent(initialAgent));
      setBranch('');
      setBusy(false);
    }
  }, [visible, initialAgent]);

  const handleSubmit = useCallback(async () => {
    if (!repoPath || !branch.trim() || busy) return;
    setBusy(true);
    const result = await addWorktree(repoPath, branch.trim(), agent);
    setBusy(false);
    if (result.ok === true) {
      onClose();
    } else {
      Alert.alert(t('worktrees.create_failed'), result.error);
    }
  }, [repoPath, branch, agent, busy, addWorktree, onClose, t]);

  const canSubmit = !busy && repoPath != null && branch.trim().length > 0;

  return (
    <ShellyModal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.handle} />

          <Text style={styles.title}>{t('worktrees.new_title')}</Text>
          <Text style={styles.subtitle}>
            {t('worktrees.new_subtitle')}
          </Text>

          {/* Agent chooser */}
          <Text style={styles.label}>{t('worktrees.agent')}</Text>
          <View style={styles.agentRow}>
            {AGENTS.map((a) => (
              <Pressable
                key={a.id}
                onPress={() => setAgent(a.id)}
                style={[styles.agentChip, agent === a.id && { borderColor: a.color, backgroundColor: withAlpha(C.accent, 0.06) }]}
              >
                <Text style={[styles.agentLabel, agent === a.id && { color: a.color }]}>
                  {a.label}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* Branch input */}
          <Text style={styles.label}>{t('worktrees.branch')}</Text>
          <TextInput
            style={styles.input}
            value={branch}
            onChangeText={setBranch}
            placeholder="feat-whatever"
            placeholderTextColor={C.text3}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="go"
            onSubmitEditing={handleSubmit}
            editable={!busy}
          />
          <Text style={styles.hint}>
            {t('worktrees.branch_hint')}
          </Text>

          {/* Actions */}
          <View style={styles.actions}>
            <Pressable style={styles.cancelBtn} onPress={onClose} disabled={busy}>
              <Text style={styles.cancelText}>{t('common.cancel')}</Text>
            </Pressable>
            <Pressable
              style={[styles.submitBtn, !canSubmit && styles.submitBtnDisabled]}
              onPress={handleSubmit}
              disabled={!canSubmit}
            >
              {busy ? (
                <ActivityIndicator size="small" color={C.btnPrimaryText} />
              ) : (
                <>
                  <MaterialIcons name="add" size={14} color={C.btnPrimaryText} />
                  <Text style={styles.submitText}>{t('common.create')}</Text>
                </>
              )}
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </ShellyModal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: C.bgSidebar,
    borderTopWidth: S.borderWidth,
    borderTopColor: C.border,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  handle: {
    width: 36,
    height: 4,
    backgroundColor: C.border,
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: 8,
    marginBottom: 12,
  },
  title: {
    fontSize: 12,
    fontFamily: F.family,
    fontWeight: '700',
    color: C.text1,
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 9,
    fontFamily: F.family,
    color: C.text3,
    marginBottom: 12,
    lineHeight: 14,
  },
  label: {
    fontSize: 9,
    fontFamily: F.family,
    fontWeight: '700',
    color: C.text2,
    letterSpacing: 0.5,
    marginTop: 12,
    marginBottom: 6,
  },
  agentRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  agentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  agentLabel: {
    fontSize: 10,
    fontFamily: F.family,
    fontWeight: '700',
    color: C.text2,
    letterSpacing: 0.3,
  },
  input: {
    backgroundColor: C.bgSurface,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontFamily: F.family,
    fontSize: 11,
    color: C.text1,
  },
  hint: {
    fontSize: 9,
    fontFamily: F.family,
    color: C.text3,
    marginTop: 4,
    lineHeight: 13,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 16,
  },
  cancelBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: C.border,
  },
  cancelText: {
    fontSize: 11,
    fontFamily: F.family,
    fontWeight: '700',
    color: C.text2,
    letterSpacing: 0.3,
  },
  submitBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: C.accent,
  },
  submitBtnDisabled: {
    backgroundColor: C.bgSurface,
    borderWidth: 1,
    borderColor: C.border,
  },
  submitText: {
    fontSize: 11,
    fontFamily: F.family,
    fontWeight: '700',
    color: C.btnPrimaryText,
    letterSpacing: 0.3,
  },
});
