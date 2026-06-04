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
import {
  resumeCodexSession,
  sendTerminalInterruptToCodexSession,
  type CodexSessionResumeFailureReason,
} from '@/lib/codex-session-resume';
import {
  getCodexReplyReadiness,
  sendCodexReply,
  type CodexReplyBlockedReason,
  type CodexReplyReadiness,
} from '@/lib/codex-session-reply';
import { useTranslation } from '@/lib/i18n';
import { useTerminalStore } from '@/store/terminal-store';
import { useTheme } from '@/hooks/use-theme';
import type { ThemeColorPalette } from '@/lib/theme';
import { fonts as F } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';
import { usePanelBackground } from '@/hooks/use-panel-background';

const MAX_VISIBLE_SESSION_TABS = 4;

type ResumeNotice =
  | { status: 'pending'; sessionId: string }
  | { status: 'focused' | 'queued'; sessionId: string; terminalSessionId: string }
  | { status: 'failed'; sessionId: string; reason: CodexSessionResumeFailureReason };

type InterruptNotice =
  | { status: 'pending'; sessionId: string }
  | { status: 'sent'; sessionId: string; terminalSessionId: string }
  | { status: 'failed'; sessionId: string; reason: CodexSessionResumeFailureReason };

type ReplyNotice =
  | { status: 'sent'; sessionId: string; text: string; sentAt: number }
  | { status: 'observed'; sessionId: string; text: string; sentAt: number };

type AgentNotice = {
  icon: string;
  text: string;
  tone: 'info' | 'success' | 'warning' | 'error';
};

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
  const composeFocusSignal = useAgentChatStore((s) => s.composeFocusSignal);
  const agentChatLastUpdatedAt = useAgentChatStore((s) => s.lastUpdatedAt);
  const startPolling = useAgentChatStore((s) => s.startPolling);
  const stopPolling = useAgentChatStore((s) => s.stopPolling);
  const dismissSession = useAgentChatStore((s) => s.dismissSession);
  const bindCodexSessionToPty = useAgentChatStore((s) => s.bindCodexSessionToPty);
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
  const [replyReadiness, setReplyReadiness] = useState<CodexReplyReadiness | null>(null);
  const [replyChecking, setReplyChecking] = useState(false);
  const [replySending, setReplySending] = useState(false);
  const [replyNotice, setReplyNotice] = useState<ReplyNotice | null>(null);
  const [resumeNotice, setResumeNotice] = useState<ResumeNotice | null>(null);
  const [resumeWorkingSessionId, setResumeWorkingSessionId] = useState<string | null>(null);
  const [interruptNotice, setInterruptNotice] = useState<InterruptNotice | null>(null);
  const [interruptWorkingSessionId, setInterruptWorkingSessionId] = useState<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);

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
  activeSessionIdRef.current = activeSession?.codexSessionId ?? null;

  const visibleEvents = useMemo(() => {
    const sessionId = activeSession?.codexSessionId;
    if (!sessionId) return [];
    return events.filter((event) => event.codexSessionId === sessionId && event.kind !== 'status');
  }, [activeSession?.codexSessionId, events]);
  const hasTimelineEvents = visibleEvents.length > 0;
  const replyReady = replyReadiness?.ready ?? false;
  const resumeWorking = Boolean(activeSession && resumeWorkingSessionId === activeSession.codexSessionId);
  const interruptWorking = Boolean(activeSession && interruptWorkingSessionId === activeSession.codexSessionId);
  const interruptVisible = interruptWorking || replyReadiness?.reason === 'busy';
  const interruptEnabled = Boolean(
    activeSession
    && interruptVisible
    && !resumeWorking
    && !interruptWorking,
  );

  useEffect(() => {
    setResumeNotice(null);
    setInterruptNotice(null);
    setReplyNotice(null);
  }, [activeSession?.codexSessionId]);

  useEffect(() => {
    if (!replyNotice || replyNotice.status !== 'sent') return;
    const observed = visibleEvents.some((event) => (
      event.role === 'user'
      && normalizeReplyTextForMatch(event.text) === normalizeReplyTextForMatch(replyNotice.text)
      && event.timestamp >= replyNotice.sentAt - 30_000
    ));
    if (observed) {
      setReplyNotice({ ...replyNotice, status: 'observed' });
    }
  }, [replyNotice, visibleEvents]);

  useEffect(() => {
    if (!replyNotice) return;
    const timeout = setTimeout(() => {
      setReplyNotice((current) => current === replyNotice ? null : current);
    }, replyNotice.status === 'observed' ? 5_000 : 12_000);
    return () => clearTimeout(timeout);
  }, [replyNotice]);

  useEffect(() => {
    if (!interruptNotice || interruptNotice.status === 'pending') return;
    const timeout = setTimeout(() => {
      setInterruptNotice((current) => current === interruptNotice ? null : current);
    }, 6_000);
    return () => clearTimeout(timeout);
  }, [interruptNotice]);

  useEffect(() => {
    const session = activeSession;
    let cancelled = false;
    setReplyReadiness(null);
    if (!session) {
      setReplyChecking(false);
      return () => {
        cancelled = true;
      };
    }
    setReplyChecking(true);
    void getCodexReplyReadiness(session)
      .then((readiness) => {
        if (!cancelled) setReplyReadiness(readiness);
      })
      .catch(() => {
        if (!cancelled) setReplyReadiness({ ready: false, reason: 'screen_unavailable' });
      })
      .finally(() => {
        if (!cancelled) setReplyChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeSession,
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
    const sessionId = activeSession.codexSessionId;
    setResumeWorkingSessionId(sessionId);
    setResumeNotice({ status: 'pending', sessionId });
    const result = await resumeCodexSession(activeSession, { addTerminalPane: addPane })
      .catch(() => ({ status: 'failed' as const, reason: 'no_terminal' as const }));
    if (result.status !== 'failed') {
      const terminalSession = useTerminalStore.getState().sessions.find((session) => session.id === result.sessionId);
      if (terminalSession?.nativeSessionId) {
        const now = Date.now();
        bindCodexSessionToPty(sessionId, {
          ptySessionId: terminalSession.nativeSessionId,
          shellySessionId: terminalSession.id,
          cwd: activeSession.cwd ?? terminalSession.currentDir,
          startedAt: now,
          lastSeenAt: now,
        });
      }
    }
    if (activeSessionIdRef.current !== sessionId) {
      setResumeWorkingSessionId((current) => current === sessionId ? null : current);
      return;
    }
    setResumeWorkingSessionId(null);
    if (result.status === 'failed') {
      setResumeNotice({
        status: 'failed',
        sessionId,
        reason: result.reason,
      });
      Alert.alert(t('sidebar.codex_resume_failed_title'), t(resumeFailureBodyKey(result.reason)));
      return;
    }
    setResumeNotice({
      status: result.status,
      sessionId,
      terminalSessionId: result.sessionId,
    });
    setReplyReadiness(null);
    setTimeout(() => void refresh(), 400);
    setTimeout(() => void refresh(), 1_500);
  }, [activeSession, addPane, bindCodexSessionToPty, refresh, t]);

  const interruptSelectedSession = useCallback(async () => {
    if (!activeSession || interruptWorking) return;
    const sessionId = activeSession.codexSessionId;
    setInterruptWorkingSessionId(sessionId);
    setInterruptNotice({ status: 'pending', sessionId });
    const result = await sendTerminalInterruptToCodexSession(activeSession)
      .catch(() => ({ status: 'failed' as const, reason: 'terminal_busy' as const }));
    if (activeSessionIdRef.current !== sessionId) {
      setInterruptWorkingSessionId((current) => current === sessionId ? null : current);
      return;
    }
    setInterruptWorkingSessionId(null);
    if (result.status === 'failed') {
      setInterruptNotice({ status: 'failed', sessionId, reason: result.reason });
      Alert.alert(t('agent_chat.interrupt_failed_title'), t(interruptFailureBodyKey(result.reason)));
      return;
    }
    setInterruptNotice({
      status: 'sent',
      sessionId,
      terminalSessionId: result.sessionId,
    });
    setReplyReadiness(null);
    setTimeout(() => void refresh(), 300);
    setTimeout(() => void refresh(), 1_200);
  }, [activeSession, interruptWorking, refresh, t]);

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
    const sessionId = activeSession.codexSessionId;
    const sentText = normalizeReplyTextForMatch(draft);
    setReplySending(true);
    const result = await sendCodexReply(activeSession, draft).catch(() => ({
      status: 'failed' as const,
      reason: 'screen_unavailable' as const,
    }));
    setReplySending(false);
    if (result.status === 'sent') {
      setDraft('');
      setReplyNotice({
        status: 'sent',
        sessionId,
        text: sentText,
        sentAt: Date.now(),
      });
      setReplyReadiness(null);
      setTimeout(() => void refresh(), 350);
      setTimeout(() => void refresh(), 1_200);
      return;
    }
    setReplyReadiness({ ready: false, reason: result.reason });
    const bodyKey = result.status === 'failed'
      ? 'agent_chat.reply_failed_body'
      : replyBlockedReasonBodyKey(result.reason);
    Alert.alert(t('agent_chat.reply_not_ready_title'), t(bodyKey));
  }, [activeSession, draft, refresh, replySending, t]);

  const notice = useMemo(
    () => buildAgentNotice({
      hasSession: Boolean(activeSession),
      sessionId: activeSession?.codexSessionId ?? null,
      replyChecking,
      replyReadiness,
      interruptNotice,
      replyNotice,
      resumeNotice,
      t,
    }),
    [activeSession, interruptNotice, replyChecking, replyNotice, replyReadiness, resumeNotice, t],
  );

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
            disabled={!activeSession || resumeWorking}
            accessibilityRole="button"
            accessibilityLabel={t('agent_chat.resume_selected_a11y')}
            hitSlop={6}
          >
            {resumeWorking ? (
              <ActivityIndicator size="small" color={colors.accent} />
            ) : (
              <MaterialIcons name="play-arrow" size={17} color={activeSession ? colors.accent : colors.inactive} />
            )}
          </Pressable>
          {interruptVisible ? (
            <Pressable
              style={[styles.iconButton, !interruptEnabled && styles.iconButtonDisabled]}
              onPress={interruptSelectedSession}
              disabled={!interruptEnabled}
              accessibilityRole="button"
              accessibilityLabel={t('agent_chat.interrupt_selected_a11y')}
              hitSlop={6}
            >
              {interruptWorking ? (
                <ActivityIndicator size="small" color={colors.warning} />
              ) : (
                <MaterialIcons
                  name="stop-circle"
                  size={16}
                  color={interruptEnabled ? colors.warning : colors.inactive}
                />
              )}
            </Pressable>
          ) : null}
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

      {notice ? (
        <View style={[styles.noticeBar, noticeToneStyle(styles, notice.tone)]}>
          <MaterialIcons name={notice.icon as any} size={13} color={noticeToneColor(colors, notice.tone)} />
          <Text style={[styles.noticeText, { color: noticeToneColor(colors, notice.tone) }]} numberOfLines={2}>
            {notice.text}
          </Text>
        </View>
      ) : null}

      <View style={styles.footer}>
        <MaterialIcons name="lock-outline" size={13} color={colors.muted} />
        <Text style={styles.footerText}>{t('agent_chat.operational_hint')}</Text>
      </View>
      <AgentChatReplyComposer
        draft={draft}
        onChangeDraft={setDraft}
        onSend={sendReply}
        hasSession={Boolean(activeSession)}
        ready={replyReady}
        checking={replyChecking}
        sending={replySending}
        composeFocusSignal={composeFocusSignal}
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
  composeFocusSignal,
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
  composeFocusSignal: number;
  styles: ReturnType<typeof makeStyles>;
  colors: ThemeColorPalette;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const inputRef = useRef<TextInput>(null);
  const canSend = hasSession && ready && !checking && !sending && draft.trim().length > 0;
  const placeholder = hasSession
    ? t(ready ? 'agent_chat.reply_placeholder' : 'agent_chat.reply_locked_placeholder')
    : t('agent_chat.reply_no_session_placeholder');

  useEffect(() => {
    if (!composeFocusSignal) return;
    const timeout = setTimeout(() => inputRef.current?.focus(), 120);
    return () => clearTimeout(timeout);
  }, [composeFocusSignal]);

  return (
    <View style={styles.replyBar}>
      <TextInput
        ref={inputRef}
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

  if (event.kind === 'approval') {
    return (
      <View style={styles.systemRow}>
        <View style={[styles.approvalBubble, maxWidth > 0 && { maxWidth }]}>
          <MaterialIcons name="verified-user" size={12} color={colors.warning} />
          <View style={styles.approvalContent}>
            <Text style={styles.approvalTitle}>{t('agent_chat.approval_title')}</Text>
            <Text style={styles.approvalText} selectable>{event.text}</Text>
            <Text style={styles.approvalHint}>{t('agent_chat.approval_read_only_hint')}</Text>
          </View>
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

function normalizeReplyTextForMatch(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd();
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

function buildAgentNotice({
  hasSession,
  sessionId,
  replyChecking,
  replyReadiness,
  interruptNotice,
  replyNotice,
  resumeNotice,
  t,
}: {
  hasSession: boolean;
  sessionId: string | null;
  replyChecking: boolean;
  replyReadiness: CodexReplyReadiness | null;
  interruptNotice: InterruptNotice | null;
  replyNotice: ReplyNotice | null;
  resumeNotice: ResumeNotice | null;
  t: (key: string, params?: Record<string, string | number>) => string;
}): AgentNotice | null {
  if (!hasSession) return null;
  const scopedResumeNotice = resumeNotice?.sessionId === sessionId ? resumeNotice : null;
  const scopedInterruptNotice = interruptNotice?.sessionId === sessionId ? interruptNotice : null;
  const scopedReplyNotice = replyNotice?.sessionId === sessionId ? replyNotice : null;
  if (scopedResumeNotice?.status === 'pending') {
    return {
      icon: 'sync',
      text: t('agent_chat.resume_notice_pending'),
      tone: 'info',
    };
  }
  if (scopedInterruptNotice?.status === 'pending') {
    return {
      icon: 'stop-circle',
      text: t('agent_chat.interrupt_notice_pending'),
      tone: 'warning',
    };
  }
  if (replyChecking) {
    return {
      icon: 'sync',
      text: t('agent_chat.reply_status_checking'),
      tone: 'info',
    };
  }
  if (scopedInterruptNotice?.status === 'sent') {
    return {
      icon: 'stop-circle',
      text: t('agent_chat.interrupt_notice_sent'),
      tone: 'success',
    };
  }
  if (scopedInterruptNotice?.status === 'failed') {
    return {
      icon: 'error-outline',
      text: t(interruptFailureBodyKey(scopedInterruptNotice.reason)),
      tone: 'error',
    };
  }
  if (scopedReplyNotice?.status === 'observed') {
    return {
      icon: 'check-circle',
      text: t('agent_chat.reply_notice_observed'),
      tone: 'success',
    };
  }
  if (scopedReplyNotice?.status === 'sent') {
    return {
      icon: 'terminal',
      text: t('agent_chat.reply_notice_sent'),
      tone: 'info',
    };
  }
  if (replyReadiness?.ready) {
    return {
      icon: 'check-circle',
      text: t('agent_chat.reply_status_ready'),
      tone: 'success',
    };
  }
  if (scopedResumeNotice?.status === 'queued') {
    return {
      icon: 'terminal',
      text: t('agent_chat.resume_notice_queued'),
      tone: 'info',
    };
  }
  if (scopedResumeNotice?.status === 'focused') {
    return {
      icon: 'center-focus-strong',
      text: t('agent_chat.resume_notice_focused'),
      tone: 'success',
    };
  }
  if (scopedResumeNotice?.status === 'failed') {
    return {
      icon: 'error-outline',
      text: t(resumeFailureBodyKey(scopedResumeNotice.reason)),
      tone: 'error',
    };
  }
  if (replyReadiness?.ready === false) {
    return {
      icon: replyReadiness.reason === 'busy' ? 'pending' : 'lock-outline',
      text: t(replyBlockedReasonBodyKey(replyReadiness.reason)),
      tone: replyReadiness.reason === 'busy' ? 'info' : 'warning',
    };
  }
  return null;
}

function replyBlockedReasonBodyKey(reason: CodexReplyBlockedReason): string {
  switch (reason) {
    case 'empty_message':
      return 'agent_chat.reply_status_empty_message';
    case 'no_session':
      return 'agent_chat.reply_status_no_session';
    case 'not_reliably_bound':
      return 'agent_chat.reply_status_not_reliably_bound';
    case 'terminal_missing':
      return 'agent_chat.reply_status_terminal_missing';
    case 'terminal_exited':
    case 'native_exited':
      return 'agent_chat.reply_status_terminal_exited';
    case 'busy':
      return 'agent_chat.reply_status_busy';
    case 'screen_unavailable':
      return 'agent_chat.reply_status_screen_unavailable';
    case 'not_codex_terminal':
      return 'agent_chat.reply_status_not_codex_terminal';
    default:
      return 'agent_chat.reply_not_ready_body';
  }
}

function noticeToneColor(colors: ThemeColorPalette, tone: AgentNotice['tone']): string {
  switch (tone) {
    case 'success':
      return colors.success;
    case 'warning':
      return colors.warning;
    case 'error':
      return colors.error;
    case 'info':
    default:
      return colors.muted;
  }
}

function noticeToneStyle(styles: ReturnType<typeof makeStyles>, tone: AgentNotice['tone']) {
  switch (tone) {
    case 'success':
      return styles.noticeSuccess;
    case 'warning':
      return styles.noticeWarning;
    case 'error':
      return styles.noticeError;
    case 'info':
    default:
      return styles.noticeInfo;
  }
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

function interruptFailureBodyKey(reason: 'terminal_busy' | 'terminal_cap' | 'layout_full' | 'no_terminal' | undefined): string {
  switch (reason) {
    case 'no_terminal':
      return 'agent_chat.interrupt_status_no_session';
    case 'terminal_cap':
    case 'layout_full':
    case 'terminal_busy':
    default:
      return 'agent_chat.interrupt_failed_body';
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
    approvalBubble: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 6,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: withAlpha(colors.warning, 0.44),
      paddingHorizontal: 9,
      paddingVertical: 7,
      backgroundColor: withAlpha(colors.warning, 0.08),
    },
    approvalContent: {
      flex: 1,
      minWidth: 0,
    },
    approvalTitle: {
      color: colors.warning,
      fontFamily: F.family,
      fontSize: 7,
      fontWeight: '800',
      lineHeight: 11,
      marginBottom: 3,
    },
    approvalText: {
      color: colors.foreground,
      fontFamily: F.family,
      fontSize: 8,
      lineHeight: 13,
    },
    approvalHint: {
      color: colors.muted,
      fontFamily: F.family,
      fontSize: 7,
      lineHeight: 11,
      marginTop: 4,
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
    noticeBar: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 6,
      paddingHorizontal: 10,
      paddingVertical: 7,
      borderTopWidth: 1,
    },
    noticeInfo: {
      borderTopColor: withAlpha(colors.muted, 0.26),
      backgroundColor: withAlpha(colors.surfaceHigh, 0.34),
    },
    noticeSuccess: {
      borderTopColor: withAlpha(colors.success, 0.34),
      backgroundColor: withAlpha(colors.success, 0.08),
    },
    noticeWarning: {
      borderTopColor: withAlpha(colors.warning, 0.34),
      backgroundColor: withAlpha(colors.warning, 0.08),
    },
    noticeError: {
      borderTopColor: withAlpha(colors.error, 0.34),
      backgroundColor: withAlpha(colors.error, 0.08),
    },
    noticeText: {
      flex: 1,
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
