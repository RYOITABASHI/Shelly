import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type GestureResponderEvent,
  type ListRenderItemInfo,
} from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { MultiPaneContext } from '@/components/multi-pane/PaneSlot';
import { useAddPane } from '@/hooks/use-add-pane';
import {
  useAgentChatStore,
  type AgentChatBindingConfidence,
  type AgentChatEvent,
  type AgentChatSession,
  type AgentChatStatus,
} from '@/store/agent-chat-store';
import { resumeCodexSession } from '@/lib/codex-session-resume';
import { getCodexReplyReadiness, sendCodexReply } from '@/lib/codex-session-reply';
import { useTranslation } from '@/lib/i18n';
import { useTerminalStore } from '@/store/terminal-store';
import { useTheme } from '@/hooks/use-theme';
import type { ThemeColorPalette } from '@/lib/theme';
import { fonts as F } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';
import { usePanelBackground } from '@/hooks/use-panel-background';

const MAX_VISIBLE_SESSION_TABS = 4;

export default function AgentChatPane() {
  const { t } = useTranslation();
  const addPane = useAddPane();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const paneBg = usePanelBackground(colors.background);
  const mp = useContext(MultiPaneContext);
  const paneWidth = mp?.paneWidth ?? 0;
  const bubbleMaxWidth = paneWidth > 0 ? Math.max(Math.floor(paneWidth * 0.82), 180) : 0;

  const refresh = useAgentChatStore((s) => s.refresh);
  const loading = useAgentChatStore((s) => s.loading);
  const error = useAgentChatStore((s) => s.error);
  const sessions = useAgentChatStore((s) => s.sessions);
  const events = useAgentChatStore((s) => s.events);
  const latestSessionId = useAgentChatStore((s) => s.latestSessionId);
  const agentChatLastUpdatedAt = useAgentChatStore((s) => s.lastUpdatedAt);
  const startPolling = useAgentChatStore((s) => s.startPolling);
  const stopPolling = useAgentChatStore((s) => s.stopPolling);
  const dismissSession = useAgentChatStore((s) => s.dismissSession);
  const terminalReadinessSignature = useTerminalStore((s) =>
    s.sessions
      .map((session) => [
        session.id,
        session.nativeSessionId,
        session.sessionStatus,
        session.isAlive ? '1' : '0',
        session.activeCli ?? '',
      ].join(':'))
      .join('|')
  );
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [replyReady, setReplyReady] = useState(false);
  const [replyChecking, setReplyChecking] = useState(false);
  const [replySending, setReplySending] = useState(false);

  useEffect(() => {
    startPolling();
    return () => stopPolling();
  }, [startPolling, stopPolling]);

  const sessionTabs = useMemo(
    () => compactSessionTabs(sessions, MAX_VISIBLE_SESSION_TABS, selectedSessionId),
    [selectedSessionId, sessions],
  );

  useEffect(() => {
    const fallbackSessionId = latestSessionId ?? sessions[0]?.codexSessionId ?? null;
    const selectedExists = selectedSessionId
      ? sessions.some((session) => session.codexSessionId === selectedSessionId)
      : false;
    const nextSessionId = selectedExists ? selectedSessionId : fallbackSessionId;
    if (nextSessionId !== selectedSessionId) {
      setSelectedSessionId(nextSessionId);
    }
  }, [latestSessionId, selectedSessionId, sessions]);

  const activeSession = useMemo(
    () => (
      sessions.find((session) => session.codexSessionId === selectedSessionId)
      ?? sessions.find((session) => session.codexSessionId === latestSessionId)
      ?? sessions[0]
      ?? null
    ),
    [latestSessionId, selectedSessionId, sessions],
  );

  const visibleEvents = useMemo(() => {
    const sessionId = activeSession?.codexSessionId;
    if (!sessionId) return [];
    return events.filter((event) => event.codexSessionId === sessionId && event.kind !== 'status');
  }, [activeSession?.codexSessionId, events]);
  const hasTimelineEvents = visibleEvents.length > 0;

  useEffect(() => {
    const session = activeSession;
    let cancelled = false;
    setReplyReady(false);
    if (!session) {
      setReplyChecking(false);
      return () => {
        cancelled = true;
      };
    }
    setReplyChecking(true);
    void getCodexReplyReadiness(session)
      .then((readiness) => {
        if (!cancelled) setReplyReady(readiness.ready);
      })
      .catch(() => {
        if (!cancelled) setReplyReady(false);
      })
      .finally(() => {
        if (!cancelled) setReplyChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeSession?.codexSessionId,
    activeSession?.bindingConfidence,
    activeSession?.ptySessionId,
    activeSession?.shellySessionId,
    activeSession?.currentStatus,
    activeSession?.lastEventAt,
    agentChatLastUpdatedAt,
    terminalReadinessSignature,
  ]);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<AgentChatEvent>) => (
      <AgentChatBubble
        event={item}
        maxWidth={bubbleMaxWidth}
        colors={colors}
        t={t}
      />
    ),
    [bubbleMaxWidth, colors, t],
  );

  const keyExtractor = useCallback((item: AgentChatEvent) => item.id, []);
  const resumeSelectedSession = useCallback(async () => {
    if (!activeSession) return;
    const result = await resumeCodexSession(activeSession, { addTerminalPane: addPane });
    if (result.status === 'failed') {
      Alert.alert(t('sidebar.codex_resume_failed_title'), t(resumeFailureBodyKey(result.reason)));
    }
  }, [activeSession, addPane, t]);

  const confirmDismissSession = useCallback((session: AgentChatSession) => {
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

  const sendReply = useCallback(async () => {
    if (!activeSession || replySending || !draft.trim()) return;
    setReplySending(true);
    const result = await sendCodexReply(activeSession, draft).catch(() => ({
      status: 'failed' as const,
      reason: 'screen_unavailable' as const,
    }));
    setReplySending(false);
    if (result.status === 'sent') {
      setDraft('');
      setReplyReady(false);
      setTimeout(() => void refresh(), 350);
      return;
    }
    setReplyReady(false);
    const bodyKey = result.status === 'failed'
      ? 'agent_chat.reply_failed_body'
      : 'agent_chat.reply_not_ready_body';
    Alert.alert(t('agent_chat.reply_not_ready_title'), t(bodyKey));
  }, [activeSession, draft, refresh, replySending, t]);

  return (
    <View style={[styles.root, { backgroundColor: paneBg }]}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <MaterialIcons name="forum" size={15} color={colors.accent} />
          <Text style={styles.title}>{t('agent_chat.title')}</Text>
          <View style={[styles.readOnlyPill, replyReady && styles.replyReadyPill]}>
            <Text style={[styles.readOnlyText, replyReady && styles.replyReadyText]}>
              {t(replyReady ? 'agent_chat.reply_ready' : 'agent_chat.reply_locked')}
            </Text>
          </View>
          <View style={styles.headerSpacer} />
          <Pressable
            style={[styles.iconButton, !activeSession && styles.iconButtonDisabled]}
            onPress={resumeSelectedSession}
            disabled={!activeSession}
            accessibilityRole="button"
            accessibilityLabel={t('agent_chat.resume_selected_a11y')}
            hitSlop={6}
          >
            <MaterialIcons name="play-arrow" size={17} color={activeSession ? colors.accent : colors.inactive} />
          </Pressable>
          <Pressable
            style={styles.iconButton}
            onPress={() => void refresh()}
            accessibilityRole="button"
            accessibilityLabel={t('agent_chat.refresh_a11y')}
            hitSlop={6}
          >
            {loading ? (
              <ActivityIndicator size="small" color={colors.accent} />
            ) : (
              <MaterialIcons name="refresh" size={16} color={colors.muted} />
            )}
          </Pressable>
        </View>
        <SessionStrip session={activeSession} styles={styles} t={t} />
        <SessionTabs
          sessions={sessionTabs}
          selectedSessionId={activeSession?.codexSessionId ?? null}
          onSelect={setSelectedSessionId}
          onDismiss={confirmDismissSession}
          styles={styles}
          colors={colors}
          t={t}
        />
      </View>

      {!hasTimelineEvents ? (
        <AgentChatEmpty
          loading={loading}
          error={error}
          hasSession={Boolean(activeSession)}
          styles={styles}
          colors={colors}
          t={t}
        />
      ) : (
        <FlatList
          style={styles.list}
          data={visibleEvents}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          removeClippedSubviews
        />
      )}

      {error ? (
        <View style={styles.errorBar}>
          <MaterialIcons name="error-outline" size={13} color={colors.error} />
          <Text style={styles.errorBarText} numberOfLines={2}>
            {t('agent_chat.error_prefix', { message: error })}
          </Text>
        </View>
      ) : null}

      <View style={styles.footer}>
        <MaterialIcons name="lock-outline" size={13} color={colors.muted} />
        <Text style={styles.footerText}>{t('agent_chat.phase4_hint')}</Text>
      </View>
      <AgentChatReplyComposer
        draft={draft}
        onChangeDraft={setDraft}
        onSend={sendReply}
        hasSession={Boolean(activeSession)}
        ready={replyReady}
        checking={replyChecking}
        sending={replySending}
        styles={styles}
        colors={colors}
        t={t}
      />
    </View>
  );
}

function AgentChatReplyComposer({
  draft,
  onChangeDraft,
  onSend,
  hasSession,
  ready,
  checking,
  sending,
  styles,
  colors,
  t,
}: {
  draft: string;
  onChangeDraft: (value: string) => void;
  onSend: () => void;
  hasSession: boolean;
  ready: boolean;
  checking: boolean;
  sending: boolean;
  styles: ReturnType<typeof makeStyles>;
  colors: ThemeColorPalette;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const canSend = hasSession && ready && !checking && !sending && draft.trim().length > 0;
  const placeholder = hasSession
    ? t(ready ? 'agent_chat.reply_placeholder' : 'agent_chat.reply_locked_placeholder')
    : t('agent_chat.reply_no_session_placeholder');

  return (
    <View style={styles.replyBar}>
      <TextInput
        style={[styles.replyInput, !hasSession && styles.replyInputDisabled]}
        value={draft}
        onChangeText={onChangeDraft}
        editable={hasSession && !sending}
        multiline
        placeholder={placeholder}
        placeholderTextColor={colors.inactive}
        accessibilityLabel={t('agent_chat.reply_input_a11y')}
      />
      <Pressable
        style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
        onPress={onSend}
        disabled={!canSend}
        accessibilityRole="button"
        accessibilityLabel={t('agent_chat.send_reply_a11y')}
        hitSlop={6}
      >
        {sending ? (
          <ActivityIndicator size="small" color={colors.accent} />
        ) : (
          <MaterialIcons name="send" size={15} color={canSend ? colors.accent : colors.inactive} />
        )}
      </Pressable>
    </View>
  );
}

function SessionStrip({
  session,
  styles,
  t,
}: {
  session: AgentChatSession | null;
  styles: ReturnType<typeof makeStyles>;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  if (!session) {
    return <Text style={styles.sessionLine}>{t('agent_chat.no_session')}</Text>;
  }

  const status = statusLabel(rawStatusToAgentStatus(session.currentStatus), session.currentStatus, t);
  const updated = formatClock(session.lastEventAt);

  return (
    <View style={styles.sessionStrip}>
      <Text style={styles.sessionProject} numberOfLines={1}>
        {session.projectName || t('agent_chat.session_fallback')}
      </Text>
      <Text style={styles.sessionMeta} numberOfLines={1}>
        {status}
      </Text>
      <Text
        style={[
          styles.sessionMeta,
          session.bindingConfidence === 'reliable' ? styles.sessionBindingReliable : styles.sessionBindingMuted,
        ]}
        numberOfLines={1}
      >
        {bindingLabel(session.bindingConfidence, session.ptySessionId, t)}
      </Text>
      {session.modelName ? (
        <Text style={styles.sessionMeta} numberOfLines={1}>
          {t('agent_chat.model', { model: session.modelName })}
        </Text>
      ) : null}
      {session.tokensUsed ? (
        <Text style={styles.sessionMeta} numberOfLines={1}>
          {t('agent_chat.tokens', { count: session.tokensUsed })}
        </Text>
      ) : null}
      <Text style={styles.sessionMeta} numberOfLines={1}>
        {t('agent_chat.last_event', { time: updated })}
      </Text>
    </View>
  );
}

function SessionTabs({
  sessions,
  selectedSessionId,
  onSelect,
  onDismiss,
  styles,
  colors,
  t,
}: {
  sessions: AgentChatSession[];
  selectedSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onDismiss: (session: AgentChatSession) => void;
  styles: ReturnType<typeof makeStyles>;
  colors: ThemeColorPalette;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const sessionOrderKey = sessions.map((session) => session.codexSessionId).join('|');

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ x: 0, animated: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [sessionOrderKey]);

  if (sessions.length === 0) return null;
  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.sessionTabsScroll}
      contentContainerStyle={styles.sessionTabs}
    >
      {sessions.map((session) => {
        const selected = session.codexSessionId === selectedSessionId;
        const bound = session.bindingConfidence === 'reliable';
        return (
          <Pressable
            key={session.codexSessionId}
            style={[
              styles.sessionTab,
              selected && styles.sessionTabSelected,
            ]}
            onPress={() => onSelect(session.codexSessionId)}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={t('agent_chat.session_tab_a11y', {
              name: session.projectName || session.codexSessionId,
            })}
            hitSlop={4}
          >
            <View style={[
              styles.sessionTabDot,
              { backgroundColor: bound ? colors.accent : colors.inactive },
            ]} />
            <View style={styles.sessionTabTextWrap}>
              <Text style={[styles.sessionTabTitle, selected && styles.sessionTabTitleSelected]} numberOfLines={1}>
                {session.projectName || t('agent_chat.session_fallback')}
              </Text>
              <Text style={styles.sessionTabMeta} numberOfLines={1}>
                {session.modelName || shortSessionId(session.codexSessionId)}
              </Text>
            </View>
            <Text style={styles.sessionTabAge} numberOfLines={1}>
              {formatAge(session.lastEventAt, t)}
            </Text>
            <Pressable
              style={styles.sessionTabDeleteButton}
              onPress={(event: GestureResponderEvent) => {
                event.stopPropagation();
                onDismiss(session);
              }}
              accessibilityRole="button"
              accessibilityLabel={t('agent_chat.dismiss_session_a11y', {
                name: session.projectName || session.codexSessionId,
              })}
              hitSlop={6}
            >
              <MaterialIcons name="close" size={11} color={selected ? colors.muted : colors.inactive} />
            </Pressable>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function AgentChatEmpty({
  loading,
  error,
  hasSession,
  styles,
  colors,
  t,
}: {
  loading: boolean;
  error: string | null;
  hasSession: boolean;
  styles: ReturnType<typeof makeStyles>;
  colors: ThemeColorPalette;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const title = loading
    ? t('agent_chat.loading')
    : hasSession
      ? t('agent_chat.empty_events_title')
      : t('agent_chat.empty_title');
  const body = error
    ? t('agent_chat.error_prefix', { message: error })
    : hasSession
      ? t('agent_chat.empty_events_body')
      : t('agent_chat.empty_body');

  return (
    <View style={styles.empty}>
      <MaterialIcons name="forum" size={28} color={colors.muted} />
      <Text style={styles.emptyTitle}>
        {title}
      </Text>
      <Text style={styles.emptyBody}>
        {body}
      </Text>
    </View>
  );
}

function AgentChatBubble({
  event,
  maxWidth,
  colors,
  t,
}: {
  event: AgentChatEvent;
  maxWidth: number;
  colors: ThemeColorPalette;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const styles = useMemo(() => makeStyles(colors), [colors]);

  if (event.kind === 'status') {
    return (
      <View style={styles.statusRow}>
        <View style={[styles.statusPill, { borderColor: statusColor(event.status, colors) }]}>
          <View style={[styles.statusDot, { backgroundColor: statusColor(event.status, colors) }]} />
          <Text style={styles.statusText}>
            {statusLabel(event.status, event.text, t)}
          </Text>
        </View>
      </View>
    );
  }

  if (event.kind === 'tool_start' || event.kind === 'tool_result') {
    return (
      <View style={styles.toolRow}>
        <View style={[styles.toolBubble, maxWidth > 0 && { maxWidth }]}>
          <MaterialIcons name="build" size={12} color={colors.command} />
          <Text style={styles.toolText} selectable>
            {t('agent_chat.tool_prefix', { tool: event.toolName || event.text })}
          </Text>
        </View>
      </View>
    );
  }

  if (event.kind === 'error') {
    return (
      <View style={styles.systemRow}>
        <View style={[styles.errorBubble, maxWidth > 0 && { maxWidth }]}>
          <MaterialIcons name="error-outline" size={12} color={colors.error} />
          <Text style={styles.errorText} selectable>{event.text}</Text>
        </View>
      </View>
    );
  }

  const isUser = event.role === 'user';
  const role = isUser ? t('agent_chat.role_user') : t('agent_chat.role_assistant');
  const rowStyle = isUser ? styles.messageRowUser : styles.messageRowAssistant;
  const bubbleStyle = isUser ? styles.userBubble : styles.assistantBubble;
  const textStyle = isUser ? styles.userText : styles.assistantText;

  return (
    <View style={rowStyle}>
      <View style={[styles.messageBubble, bubbleStyle, maxWidth > 0 && { maxWidth }]}>
        <Text style={styles.roleLabel}>{role}</Text>
        <Text style={textStyle} selectable>{event.text}</Text>
        <Text style={styles.timeLabel}>{formatClock(event.timestamp)}</Text>
      </View>
    </View>
  );
}

function rawStatusToAgentStatus(raw?: string): AgentChatStatus {
  switch ((raw ?? '').toUpperCase()) {
    case 'THINKING':
      return 'thinking';
    case 'TOOL_RUNNING':
      return 'tool_running';
    case 'WAITING_PERMISSION':
      return 'waiting_input';
    case 'ERROR':
      return 'error';
    case 'IDLE':
    case 'COMPLETED':
    default:
      return 'idle';
  }
}

function statusLabel(
  status: AgentChatStatus | undefined,
  rawText: string | undefined,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if ((rawText ?? '').toUpperCase() === 'COMPLETED') return t('agent_chat.status_completed');
  switch (status) {
    case 'thinking':
      return t('agent_chat.status_thinking');
    case 'tool_running':
      return t('agent_chat.status_tool_running');
    case 'waiting_input':
      return t('agent_chat.status_waiting_input');
    case 'error':
      return t('agent_chat.status_error');
    case 'idle':
    default:
      return t('agent_chat.status_idle');
  }
}

function statusColor(status: AgentChatStatus | undefined, colors: ThemeColorPalette): string {
  switch (status) {
    case 'thinking':
      return colors.link;
    case 'tool_running':
      return colors.command;
    case 'waiting_input':
      return colors.warning;
    case 'error':
      return colors.error;
    case 'idle':
    default:
      return colors.success;
  }
}

function bindingLabel(
  confidence: AgentChatBindingConfidence,
  ptySessionId: string | null | undefined,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (confidence === 'reliable' && ptySessionId) {
    return t('agent_chat.binding_reliable', { pty: ptySessionId });
  }
  if (confidence === 'candidate' && ptySessionId) {
    return t('agent_chat.binding_candidate', { pty: ptySessionId });
  }
  return t('agent_chat.binding_unbound');
}

function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
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

function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function compactSessionTabs(
  sessions: AgentChatSession[],
  limit: number,
  selectedSessionId?: string | null,
): AgentChatSession[] {
  const sortedSessions = [...sessions].sort((a, b) => b.lastEventAt - a.lastEventAt);
  const byWorkspace = new Map<string, AgentChatSession>();
  const selectedSession = selectedSessionId
    ? sortedSessions.find((session) => session.codexSessionId === selectedSessionId)
    : null;

  for (const session of sortedSessions) {
    const key = sessionTabWorkspaceKey(session);
    if (!byWorkspace.has(key)) {
      byWorkspace.set(key, session);
    }
    if (byWorkspace.size >= limit) break;
  }

  if (selectedSession && !Array.from(byWorkspace.values()).some((session) => session.codexSessionId === selectedSessionId)) {
    const selectedKey = sessionTabWorkspaceKey(selectedSession);
    if (byWorkspace.has(selectedKey)) {
      byWorkspace.set(selectedKey, selectedSession);
    } else {
      const compacted = Array.from(byWorkspace.entries());
      if (compacted.length >= limit) compacted.pop();
      compacted.push([selectedKey, selectedSession]);
      return compacted.map(([, session]) => session);
    }
  }
  return Array.from(byWorkspace.values());
}

function sessionTabWorkspaceKey(session: AgentChatSession): string {
  const workspace = session.cwd?.trim() || session.projectName?.trim();
  const model = session.modelName?.trim();
  if (!workspace || !model) return `session:${session.codexSessionId}`;
  return `${workspace}:${model}`;
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

function makeStyles(colors: ThemeColorPalette) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: colors.background,
    },
    header: {
      paddingHorizontal: 10,
      paddingTop: 8,
      paddingBottom: 7,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      backgroundColor: withAlpha(colors.surface, 0.86),
      gap: 6,
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      minHeight: 24,
    },
    title: {
      color: colors.foreground,
      fontFamily: F.family,
      fontSize: 11,
      fontWeight: '800',
      letterSpacing: 0,
    },
    readOnlyPill: {
      borderRadius: 5,
      borderWidth: 1,
      borderColor: withAlpha(colors.muted, 0.38),
      paddingHorizontal: 6,
      paddingVertical: 2,
      backgroundColor: withAlpha(colors.muted, 0.1),
    },
    replyReadyPill: {
      borderColor: withAlpha(colors.success, 0.62),
      backgroundColor: withAlpha(colors.success, 0.12),
    },
    readOnlyText: {
      color: colors.muted,
      fontFamily: F.family,
      fontSize: 7,
      fontWeight: '700',
      letterSpacing: 0,
    },
    replyReadyText: {
      color: colors.success,
    },
    headerSpacer: {
      flex: 1,
    },
    iconButton: {
      width: 28,
      height: 28,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 6,
    },
    iconButtonDisabled: {
      opacity: 0.5,
    },
    sessionStrip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      minHeight: 18,
      overflow: 'hidden',
    },
    sessionLine: {
      color: colors.muted,
      fontFamily: F.family,
      fontSize: 8,
      lineHeight: 13,
    },
    sessionProject: {
      color: colors.accent,
      fontFamily: F.family,
      fontSize: 8,
      fontWeight: '800',
      maxWidth: 120,
    },
    sessionMeta: {
      color: colors.muted,
      fontFamily: F.family,
      fontSize: 7,
      lineHeight: 12,
    },
    sessionBindingReliable: {
      color: colors.success,
    },
    sessionBindingMuted: {
      color: colors.inactive,
    },
    sessionTabsScroll: {
      flexGrow: 0,
      marginTop: -1,
    },
    sessionTabs: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingRight: 2,
    },
    sessionTab: {
      minWidth: 108,
      maxWidth: 168,
      height: 30,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingHorizontal: 8,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: withAlpha(colors.border, 0.74),
      backgroundColor: withAlpha(colors.surfaceHigh, 0.48),
    },
    sessionTabSelected: {
      borderColor: withAlpha(colors.accent, 0.74),
      backgroundColor: withAlpha(colors.accent, 0.13),
    },
    sessionTabDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
    },
    sessionTabTextWrap: {
      flex: 1,
      minWidth: 0,
    },
    sessionTabTitle: {
      color: colors.muted,
      fontFamily: F.family,
      fontSize: 7,
      fontWeight: '800',
      lineHeight: 10,
      letterSpacing: 0,
    },
    sessionTabTitleSelected: {
      color: colors.foreground,
    },
    sessionTabMeta: {
      color: colors.inactive,
      fontFamily: F.family,
      fontSize: 6,
      lineHeight: 9,
      letterSpacing: 0,
    },
    sessionTabAge: {
      color: colors.inactive,
      fontFamily: F.family,
      fontSize: 6,
      lineHeight: 9,
    },
    sessionTabDeleteButton: {
      width: 16,
      height: 18,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 5,
    },
    list: {
      flex: 1,
    },
    listContent: {
      paddingHorizontal: 10,
      paddingVertical: 10,
      gap: 8,
    },
    statusRow: {
      alignItems: 'center',
      paddingVertical: 2,
    },
    statusPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      borderWidth: 1,
      borderRadius: 7,
      paddingHorizontal: 8,
      paddingVertical: 4,
      backgroundColor: withAlpha(colors.surfaceHigh, 0.72),
    },
    statusDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
    },
    statusText: {
      color: colors.muted,
      fontFamily: F.family,
      fontSize: 7,
      fontWeight: '700',
      letterSpacing: 0,
    },
    toolRow: {
      alignItems: 'center',
      paddingVertical: 2,
    },
    toolBubble: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: withAlpha(colors.command, 0.34),
      paddingHorizontal: 9,
      paddingVertical: 6,
      backgroundColor: withAlpha(colors.command, 0.08),
    },
    toolText: {
      color: colors.command,
      fontFamily: F.family,
      fontSize: 8,
      lineHeight: 13,
    },
    systemRow: {
      alignItems: 'center',
      paddingVertical: 2,
    },
    errorBubble: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 6,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: withAlpha(colors.error, 0.38),
      paddingHorizontal: 9,
      paddingVertical: 7,
      backgroundColor: withAlpha(colors.error, 0.08),
    },
    errorText: {
      flex: 1,
      color: colors.error,
      fontFamily: F.family,
      fontSize: 8,
      lineHeight: 13,
    },
    messageRowAssistant: {
      alignItems: 'flex-start',
      paddingVertical: 2,
    },
    messageRowUser: {
      alignItems: 'flex-end',
      paddingVertical: 2,
    },
    messageBubble: {
      borderRadius: 7,
      paddingHorizontal: 10,
      paddingVertical: 7,
      minWidth: 120,
      borderWidth: 1,
    },
    assistantBubble: {
      borderColor: withAlpha(colors.border, 0.95),
      backgroundColor: withAlpha(colors.surfaceHigh, 0.88),
    },
    userBubble: {
      borderColor: withAlpha(colors.accent, 0.48),
      backgroundColor: withAlpha(colors.accent, 0.18),
    },
    roleLabel: {
      color: colors.muted,
      fontFamily: F.family,
      fontSize: 7,
      fontWeight: '800',
      marginBottom: 3,
      letterSpacing: 0,
    },
    assistantText: {
      color: colors.foreground,
      fontFamily: F.family,
      fontSize: 9,
      lineHeight: 15,
    },
    userText: {
      color: colors.foreground,
      fontFamily: F.family,
      fontSize: 9,
      lineHeight: 15,
    },
    timeLabel: {
      color: colors.inactive,
      fontFamily: F.family,
      fontSize: 7,
      alignSelf: 'flex-end',
      marginTop: 4,
    },
    empty: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 24,
      gap: 9,
    },
    emptyTitle: {
      color: colors.foreground,
      fontFamily: F.family,
      fontSize: 11,
      fontWeight: '800',
      letterSpacing: 0,
      textAlign: 'center',
    },
    emptyBody: {
      color: colors.muted,
      fontFamily: F.family,
      fontSize: 8,
      lineHeight: 14,
      textAlign: 'center',
    },
    errorBar: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 6,
      paddingHorizontal: 10,
      paddingVertical: 7,
      borderTopWidth: 1,
      borderTopColor: withAlpha(colors.error, 0.3),
      backgroundColor: withAlpha(colors.error, 0.07),
    },
    errorBarText: {
      flex: 1,
      color: colors.error,
      fontFamily: F.family,
      fontSize: 8,
      lineHeight: 13,
    },
    footer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      backgroundColor: withAlpha(colors.surface, 0.76),
    },
    footerText: {
      flex: 1,
      color: colors.muted,
      fontFamily: F.family,
      fontSize: 7,
      lineHeight: 12,
    },
    replyBar: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 7,
      paddingHorizontal: 10,
      paddingTop: 7,
      paddingBottom: 8,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      backgroundColor: withAlpha(colors.background, 0.94),
    },
    replyInput: {
      flex: 1,
      minHeight: 34,
      maxHeight: 96,
      borderRadius: 7,
      borderWidth: 1,
      borderColor: withAlpha(colors.accent, 0.44),
      backgroundColor: withAlpha(colors.surfaceHigh, 0.72),
      color: colors.foreground,
      fontFamily: F.family,
      fontSize: 9,
      lineHeight: 14,
      paddingHorizontal: 10,
      paddingTop: 8,
      paddingBottom: 8,
      textAlignVertical: 'top',
    },
    replyInputDisabled: {
      opacity: 0.58,
      borderColor: withAlpha(colors.border, 0.78),
    },
    sendButton: {
      width: 34,
      height: 34,
      borderRadius: 7,
      borderWidth: 1,
      borderColor: withAlpha(colors.accent, 0.58),
      backgroundColor: withAlpha(colors.accent, 0.12),
      alignItems: 'center',
      justifyContent: 'center',
    },
    sendButtonDisabled: {
      borderColor: withAlpha(colors.border, 0.7),
      backgroundColor: withAlpha(colors.surfaceHigh, 0.52),
      opacity: 0.62,
    },
  });
}
