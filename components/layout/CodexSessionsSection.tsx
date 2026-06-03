import React, { useCallback, useEffect, useMemo } from 'react';
import { Alert, Pressable, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';
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
      Alert.alert(t('sidebar.codex_resume_failed_title'), t('sidebar.codex_resume_failed_body'));
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

  return (
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
              <Text style={styles.meta} numberOfLines={1}>
                {session.modelName || shortSessionId(session.codexSessionId)}
              </Text>
            </View>
            <Text style={styles.age} numberOfLines={1}>
              {formatAge(session.lastEventAt, t)}
            </Text>
            <MaterialIcons name="play-arrow" size={12} color={C.accent} />
            <Pressable
              style={styles.deleteButton}
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
          </Pressable>
        ))
      )}
    </SidebarSection>
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

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: P.sidebarItem.px,
    height: S.sidebarItemHeight,
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
  },
  name: {
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: F.sidebarItem.weight,
    color: C.text1,
    letterSpacing: 0.3,
  },
  meta: {
    fontSize: F.badge.size,
    fontFamily: F.family,
    color: C.text3,
    letterSpacing: 0.2,
  },
  age: {
    fontSize: F.badge.size,
    fontFamily: F.family,
    fontWeight: F.sidebarItem.weight,
    color: C.text2,
    letterSpacing: 0.3,
  },
  deleteButton: {
    width: 18,
    height: 18,
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
});
