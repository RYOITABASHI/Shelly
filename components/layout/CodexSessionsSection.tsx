import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type GestureResponderEvent,
} from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useAddPane } from '@/hooks/use-add-pane';
import { useAgentChatStore, type AgentChatSession } from '@/store/agent-chat-store';
import { resumeCodexSession } from '@/lib/codex-session-resume';
import { useTranslation } from '@/lib/i18n';
import { colors as C, fonts as F, sizes as S, padding as P, radii as R } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';
import { SidebarSection } from './SidebarSection';

type Props = {
  isOpen: boolean;
  onToggle: () => void;
  iconsOnly: boolean;
};

export function CodexSessionsSection({ isOpen, onToggle, iconsOnly }: Props) {
  const { t } = useTranslation();
  const addPane = useAddPane();
  const sessions = useAgentChatStore((s) => s.sessions);
  const loading = useAgentChatStore((s) => s.loading);
  const startPolling = useAgentChatStore((s) => s.startPolling);
  const stopPolling = useAgentChatStore((s) => s.stopPolling);
  const dismissSession = useAgentChatStore((s) => s.dismissSession);
  const renameSession = useAgentChatStore((s) => s.renameSession);
  const [renamingSession, setRenamingSession] = useState<AgentChatSession | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  useEffect(() => {
    if (!isOpen || iconsOnly) return undefined;
    startPolling();
    return () => stopPolling();
  }, [iconsOnly, isOpen, startPolling, stopPolling]);

  const codexSessions = useMemo(
    () => sessions
      .filter((session) => session.codexSessionId.trim())
      .sort((a, b) => b.lastEventAt - a.lastEventAt)
      .slice(0, 6),
    [sessions],
  );

  const resume = useCallback(async (session: AgentChatSession) => {
    const result = await resumeCodexSession(session, { addTerminalPane: addPane });
    if (result.status === 'failed') {
      Alert.alert(t('sidebar.codex_resume_failed_title'), t(resumeFailureBodyKey(result.reason)));
    }
  }, [addPane, t]);

  const confirmDismiss = useCallback((session: AgentChatSession) => {
    const name = session.projectName || session.codexSessionId;
    Alert.alert(
      t('agent_chat.dismiss_session_title'),
      t('agent_chat.dismiss_session_body', { name }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => dismissSession(session.codexSessionId),
        },
      ],
    );
  }, [dismissSession, t]);

  const beginRename = useCallback((session: AgentChatSession) => {
    setRenamingSession(session);
    setRenameDraft(session.projectName || t('agent_chat.session_fallback'));
  }, [t]);

  const closeRename = useCallback(() => {
    setRenamingSession(null);
    setRenameDraft('');
  }, []);

  const confirmRename = useCallback(() => {
    if (!renamingSession) return;
    const title = renameDraft.trim();
    if (!title) return;
    renameSession(renamingSession.codexSessionId, title);
    closeRename();
  }, [closeRename, renameDraft, renameSession, renamingSession]);

  const renameSaveDisabled = renameDraft.trim().length === 0;

  return (
    <>
      <SidebarSection
        title={t('sidebar.codex_sessions')}
        icon="history"
        isOpen={isOpen}
        onToggle={onToggle}
        badge={codexSessions.length}
        iconsOnly={iconsOnly}
      >
        {codexSessions.length === 0 ? (
          <Text style={styles.empty}>
            {loading ? t('agent_chat.loading') : t('sidebar.codex_sessions_empty')}
          </Text>
        ) : (
          codexSessions.map((session) => (
            <Pressable
              key={session.codexSessionId}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              onPress={() => resume(session)}
              hitSlop={4}
              accessibilityRole="button"
              accessibilityLabel={t('sidebar.codex_resume_a11y', {
                name: session.projectName || session.codexSessionId,
              })}
            >
              <View style={[
                styles.dot,
                { backgroundColor: session.bindingConfidence === 'reliable' ? C.accent : C.text3 },
              ]} />
              <View style={styles.info}>
                <Text style={styles.name} numberOfLines={1}>
                  {(session.projectName || t('agent_chat.session_fallback')).toUpperCase()}
                </Text>
                <View style={styles.metaRow}>
                  <Text style={styles.meta} numberOfLines={1}>
                    {session.modelName || shortSessionId(session.codexSessionId)}
                  </Text>
                  <Text style={styles.age} numberOfLines={1}>
                    {formatAge(session.lastEventAt, t)}
                  </Text>
                </View>
              </View>
              <View style={styles.actionGroup}>
                <MaterialIcons name="play-arrow" size={13} color={C.accent} />
                <Pressable
                  style={styles.actionButton}
                  onPress={(event: GestureResponderEvent) => {
                    event.stopPropagation();
                    beginRename(session);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={t('agent_chat.rename_session_a11y', {
                    name: session.projectName || session.codexSessionId,
                  })}
                  hitSlop={6}
                >
                  <MaterialIcons name="edit" size={11} color={C.text3} />
                </Pressable>
                <Pressable
                  style={styles.actionButton}
                  onPress={(event: GestureResponderEvent) => {
                    event.stopPropagation();
                    confirmDismiss(session);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={t('agent_chat.dismiss_session_a11y', {
                    name: session.projectName || session.codexSessionId,
                  })}
                  hitSlop={6}
                >
                  <MaterialIcons name="close" size={11} color={C.text3} />
                </Pressable>
              </View>
            </Pressable>
          ))
        )}
      </SidebarSection>
      <Modal
        transparent
        visible={Boolean(renamingSession)}
        animationType="fade"
        onRequestClose={closeRename}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.renameDialog}>
            <Text style={styles.renameTitle}>{t('agent_chat.rename_session_title')}</Text>
            <Text style={styles.renameBody}>
              {t('agent_chat.rename_session_body', {
                name: renamingSession?.projectName || renamingSession?.codexSessionId || t('agent_chat.session_fallback'),
              })}
            </Text>
            <TextInput
              value={renameDraft}
              onChangeText={setRenameDraft}
              placeholder={t('agent_chat.rename_session_placeholder')}
              placeholderTextColor={C.text3}
              style={styles.renameInput}
              autoFocus
              selectTextOnFocus
              maxLength={48}
              returnKeyType="done"
              onSubmitEditing={confirmRename}
              accessibilityLabel={t('agent_chat.rename_session_title')}
            />
            <View style={styles.renameActions}>
              <Pressable
                style={({ pressed }) => [styles.renameButton, pressed && styles.rowPressed]}
                onPress={closeRename}
                accessibilityRole="button"
              >
                <Text style={styles.renameButtonText}>{t('common.cancel')}</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.renameButton,
                  styles.renameButtonPrimary,
                  renameSaveDisabled && styles.renameButtonDisabled,
                  pressed && !renameSaveDisabled && styles.renameButtonPressed,
                ]}
                onPress={confirmRename}
                disabled={renameSaveDisabled}
                accessibilityRole="button"
              >
                <Text style={[styles.renameButtonText, styles.renameButtonPrimaryText]}>
                  {t('common.save')}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function formatAge(
  timestamp: number,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const diff = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diff < 60) return t('time.seconds_ago_short', { count: diff });
  if (diff < 3600) return t('time.minutes_ago_short', { count: Math.floor(diff / 60) });
  if (diff < 86400) return t('time.hours_ago_short', { count: Math.floor(diff / 3600) });
  return t('time.days_ago_short', { count: Math.floor(diff / 86400) });
}

function resumeFailureBodyKey(reason: 'terminal_busy' | 'terminal_cap' | 'layout_full' | 'no_terminal' | undefined): string {
  switch (reason) {
    case 'terminal_cap':
      return 'sidebar.codex_resume_failed_terminal_cap_body';
    case 'layout_full':
      return 'sidebar.codex_resume_failed_layout_full_body';
    case 'terminal_busy':
      return 'sidebar.codex_resume_failed_terminal_busy_body';
    case 'no_terminal':
    default:
      return 'sidebar.codex_resume_failed_body';
  }
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: P.sidebarItem.px,
    paddingVertical: 4,
    minHeight: 34,
    borderRadius: R.badge,
  },
  rowPressed: {
    backgroundColor: withAlpha(C.accent, 0.08),
  },
  dot: {
    width: S.agentDotSize,
    height: S.agentDotSize,
    borderRadius: S.agentDotSize / 2,
  },
  info: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  name: {
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: F.sidebarItem.weight,
    color: C.text1,
    letterSpacing: 0.3,
  },
  meta: {
    flexShrink: 1,
    fontSize: F.badge.size,
    fontFamily: F.family,
    color: C.text3,
    letterSpacing: 0.2,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minWidth: 0,
  },
  age: {
    fontSize: F.badge.size,
    fontFamily: F.family,
    fontWeight: F.sidebarItem.weight,
    color: C.text2,
    letterSpacing: 0.3,
  },
  actionGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 2,
    flexShrink: 0,
  },
  actionButton: {
    width: 20,
    height: 20,
    borderRadius: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: {
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    color: C.text3,
    paddingHorizontal: P.sidebarItem.px,
    paddingVertical: 6,
    letterSpacing: 0.3,
  },
  modalBackdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 18,
    backgroundColor: withAlpha('#000000', 0.72),
  },
  renameDialog: {
    width: '100%',
    maxWidth: 360,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 6,
    backgroundColor: C.bgSurface,
    padding: 14,
    gap: 10,
  },
  renameTitle: {
    fontSize: F.sidebarSection.size,
    fontFamily: F.family,
    fontWeight: F.sidebarSection.weight,
    color: C.text1,
    letterSpacing: 0,
  },
  renameBody: {
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    color: C.text3,
    lineHeight: 18,
    letterSpacing: 0,
  },
  renameInput: {
    height: 38,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: R.badge,
    paddingHorizontal: 10,
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    color: C.text1,
    backgroundColor: C.bgDeep,
  },
  renameActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  renameButton: {
    minWidth: 74,
    height: 32,
    borderRadius: R.badge,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  renameButtonPrimary: {
    borderColor: C.accent,
    backgroundColor: withAlpha(C.accent, 0.14),
  },
  renameButtonPressed: {
    backgroundColor: withAlpha(C.accent, 0.24),
  },
  renameButtonDisabled: {
    opacity: 0.45,
  },
  renameButtonText: {
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: F.sidebarItem.weight,
    color: C.text2,
    letterSpacing: 0,
  },
  renameButtonPrimaryText: {
    color: C.text1,
  },
});
