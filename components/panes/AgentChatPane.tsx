import React, { useCallback, useContext, useEffect, useMemo } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ListRenderItemInfo,
} from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { MultiPaneContext } from '@/components/multi-pane/PaneSlot';
import {
  useAgentChatStore,
  type AgentChatEvent,
  type AgentChatSession,
  type AgentChatStatus,
} from '@/store/agent-chat-store';
import { useTranslation } from '@/lib/i18n';
import { useTheme } from '@/hooks/use-theme';
import type { ThemeColorPalette } from '@/lib/theme';
import { fonts as F } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';
import { usePanelBackground } from '@/hooks/use-panel-background';

export default function AgentChatPane() {
  const { t } = useTranslation();
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
  const lastUpdatedAt = useAgentChatStore((s) => s.lastUpdatedAt);
  const startPolling = useAgentChatStore((s) => s.startPolling);
  const stopPolling = useAgentChatStore((s) => s.stopPolling);

  useEffect(() => {
    startPolling();
    return () => stopPolling();
  }, [startPolling, stopPolling]);

  const activeSession = useMemo(
    () => sessions.find((session) => session.codexSessionId === latestSessionId) ?? sessions[0] ?? null,
    [latestSessionId, sessions],
  );

  const visibleEvents = useMemo(() => {
    const sessionId = activeSession?.codexSessionId;
    if (!sessionId) return [];
    return events.filter((event) => event.codexSessionId === sessionId);
  }, [activeSession?.codexSessionId, events]);
  const hasTimelineEvents = visibleEvents.some((event) => event.kind !== 'status');

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

  return (
    <View style={[styles.root, { backgroundColor: paneBg }]}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <MaterialIcons name="forum" size={15} color={colors.accent} />
          <Text style={styles.title}>{t('agent_chat.title')}</Text>
          <View style={styles.readOnlyPill}>
            <Text style={styles.readOnlyText}>{t('agent_chat.read_only')}</Text>
          </View>
          <View style={styles.headerSpacer} />
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
        <SessionStrip session={activeSession} lastUpdatedAt={lastUpdatedAt} styles={styles} t={t} />
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
        <Text style={styles.footerText}>{t('agent_chat.phase1_hint')}</Text>
      </View>
    </View>
  );
}

function SessionStrip({
  session,
  lastUpdatedAt,
  styles,
  t,
}: {
  session: AgentChatSession | null;
  lastUpdatedAt: number | null;
  styles: ReturnType<typeof makeStyles>;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  if (!session) {
    return <Text style={styles.sessionLine}>{t('agent_chat.no_session')}</Text>;
  }

  const status = statusLabel(rawStatusToAgentStatus(session.currentStatus), session.currentStatus, t);
  const updated = lastUpdatedAt ? formatClock(lastUpdatedAt) : formatClock(session.lastEventAt);

  return (
    <View style={styles.sessionStrip}>
      <Text style={styles.sessionProject} numberOfLines={1}>
        {session.projectName || t('agent_chat.session_fallback')}
      </Text>
      <Text style={styles.sessionMeta} numberOfLines={1}>
        {status}
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

function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
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
    readOnlyText: {
      color: colors.muted,
      fontFamily: F.family,
      fontSize: 7,
      fontWeight: '700',
      letterSpacing: 0,
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
  });
}
