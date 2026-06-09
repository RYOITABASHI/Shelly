import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { logError } from '@/lib/debug-logger';

export type AgentChatRole = 'user' | 'assistant' | 'system' | 'tool';

export type AgentChatKind =
  | 'user_message'
  | 'assistant_message'
  | 'status'
  | 'tool_start'
  | 'tool_result'
  | 'approval'
  | 'error';

export type AgentChatStatus =
  | 'idle'
  | 'thinking'
  | 'tool_running'
  | 'waiting_input'
  | 'error';

export type AgentChatBindingConfidence = 'none' | 'candidate' | 'reliable';

export type AgentChatBinding = {
  codexSessionId: string;
  ptySessionId: string | null;
  shellySessionId?: string | null;
  cwd: string | null;
  confidence: AgentChatBindingConfidence;
  matchedAt: number | null;
  reason: 'cwd-time' | 'cwd-only' | 'previous' | 'resume' | 'none';
};

export type CodexPtyLaunch = {
  ptySessionId: string;
  shellySessionId?: string | null;
  cwd: string | null;
  startedAt: number;
  lastSeenAt: number;
};

export type CodexPtyCandidate = {
  ptySessionId: string;
  shellySessionId?: string | null;
  cwd?: string | null;
  startedAt?: number;
  lastSeenAt?: number;
};

export type AgentChatEvent = {
  id: string;
  source: 'codex';
  codexSessionId: string;
  ptySessionId?: string;
  role: AgentChatRole;
  kind: AgentChatKind;
  text: string;
  status?: AgentChatStatus;
  toolName?: string;
  timestamp: number;
  rawEvent?: unknown;
};

export type AgentChatSession = {
  codexSessionId: string;
  projectName: string;
  currentStatus: string;
  currentTool?: string | null;
  lastEventAt: number;
  sessionStartAt: number;
  modelName?: string | null;
  tokensUsed?: number;
  cwd?: string | null;
  ptySessionId?: string | null;
  shellySessionId?: string | null;
  bindingConfidence: AgentChatBindingConfidence;
};

type ScouterSession = {
  sessionId?: string;
  source?: string;
  projectName?: string;
  currentStatus?: string;
  currentTool?: string | null;
  lastEventAt?: number;
  sessionStartAt?: number;
  modelName?: string | null;
  tokensUsed?: number;
  lastError?: string | null;
  lastMessage?: string | null;
  cwd?: string | null;
};

type ScouterRecentEvent = {
  eventId?: string;
  source?: string;
  sessionId?: string;
  projectName?: string;
  timestamp?: number;
  eventType?: string;
  derivedStatus?: string;
  toolName?: string | null;
  commandSummary?: string | null;
  errorMessage?: string | null;
  lastMessage?: string | null;
  modelName?: string | null;
  tokensUsed?: number;
  cwd?: string | null;
};

type ScouterWidgetConversation = {
  lastPrompt?: string | null;
  lastPromptAt?: number | null;
  lastAnswer?: string | null;
  lastAnswerAt?: number | null;
  lastApproval?: string | null;
  lastApprovalAt?: number | null;
  widgetPrompt?: string | null;
  widgetPromptAt?: number | null;
  widgetStatus?: string | null;
  widgetStatusAt?: number | null;
  widgetError?: string | null;
};

type ScouterDebugInfo = {
  enabled?: boolean;
  jsonlWatcherRunning?: boolean;
  sessions?: ScouterSession[];
  recentEvents?: ScouterRecentEvent[];
  widgetConversation?: ScouterWidgetConversation | null;
};

type AgentChatState = {
  enabled: boolean;
  jsonlWatcherRunning: boolean;
  sessions: AgentChatSession[];
  events: AgentChatEvent[];
  bindings: Record<string, AgentChatBinding>;
  codexPtyLaunches: CodexPtyLaunch[];
  dismissedSessionIds: string[];
  sessionTitleOverrides: Record<string, string>;
  composeFocusSignal: number;
  latestSessionId: string | null;
  loading: boolean;
  error: string | null;
  lastUpdatedAt: number | null;
  ingestNativeEvent: (payload: NativeScouterEventPayload) => void;
  recordCodexPtyCandidate: (candidate: CodexPtyCandidate) => void;
  bindCodexSessionToPty: (sessionId: string, candidate: CodexPtyCandidate) => void;
  dismissSession: (sessionId: string) => void;
  renameSession: (sessionId: string, title: string) => void;
  requestComposeFocus: () => void;
  refresh: () => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
};

type NativeScouterEventPayload = {
  eventJson?: string;
  snapshotJson?: string;
  emittedAt?: number;
};

const MAX_EVENTS = 200;
const MAX_DISMISSED_SESSIONS = 200;
const MAX_SESSION_TITLE_LENGTH = 48;
const REFRESH_MS = 5_000;
const DEDUPE_WINDOW_MS = 2_000;
// User/assistant messages can legitimately repeat (e.g. "yes"/"continue"), so
// they are deduped only when an identical copy falls inside this window — the
// case where the optimistic widget echo and the JSONL transcript copy of the
// SAME send arrive close together. Identical text sent further apart is an
// intentional re-send and must be kept (a windowless set silently dropped it).
// Matches the widget echo match window in AgentChatPane.
const MESSAGE_DEDUPE_WINDOW_MS = 30_000;
const BINDING_MATCH_WINDOW_MS = 15 * 60_000;
const RESUME_BINDING_RESERVATION_MS = 5 * 60_000;
const PTY_LAUNCH_TTL_MS = 2 * 60 * 60_000;
const MAX_PTY_LAUNCHES = 12;
const DISMISSED_SESSIONS_STORAGE_KEY = 'shelly_agent_chat_dismissed_sessions';
const SESSION_TITLES_STORAGE_KEY = 'shelly_agent_chat_session_titles';
let pollingRefCount = 0;
let pollingTimer: ReturnType<typeof setInterval> | null = null;
let liveSubscription: { remove(): void } | null = null;
let dismissedSessionsHydrated = false;
let dismissedSessionsHydratePromise: Promise<void> | null = null;
let sessionTitlesHydrated = false;
let sessionTitlesHydratePromise: Promise<void> | null = null;

export const useAgentChatStore = create<AgentChatState>((set, get) => ({
  enabled: false,
  jsonlWatcherRunning: false,
  sessions: [],
  events: [],
  bindings: {},
  codexPtyLaunches: [],
  dismissedSessionIds: [],
  sessionTitleOverrides: {},
  composeFocusSignal: 0,
  latestSessionId: null,
  loading: false,
  error: null,
  lastUpdatedAt: null,

  ingestNativeEvent: (payload) => {
    const parsed = parseNativeScouterPayload(payload);
    const dismissedIds = new Set(get().dismissedSessionIds);
    const parsedSession = parsed.session && !isDismissedSessionId(parsed.session.sessionId, dismissedIds)
      ? parsed.session
      : null;
    const parsedEvent = parsed.event && !isDismissedSessionId(parsed.event.sessionId, dismissedIds)
      ? parsed.event
      : null;
    if (!parsedEvent && !parsedSession) return;

    const currentSessions = get().sessions.map(agentSessionToScouterSession);
    const incomingSessions = [
      ...(parsedSession ? [parsedSession] : []),
      ...(!parsedSession && parsedEvent ? [recentEventToScouterSession(parsedEvent)] : []),
    ];
    const sessions = dedupeCodexSessions([
      ...incomingSessions,
      ...currentSessions,
    ]).map((session) => toAgentChatSession(session));

    if (sessions.length === 0) return;

    const sessionCwdById = collectRecentEventCwd(parsedEvent ? [parsedEvent] : []);
    const sessionsWithCwd = applyRecentEventCwd(sessions, sessionCwdById);
    const launches = applyResumeBindingCwdToLaunches(get().codexPtyLaunches, sessionsWithCwd, get().bindings);
    const bindings = reconcileBindings(sessionsWithCwd, launches, get().bindings);
    const boundSessions = applySessionTitleOverrides(
      applyBindingsToSessions(sessionsWithCwd, bindings),
      get().sessionTitleOverrides,
    );
    const incomingEvents = [
      ...(parsedSession ? sessionToEvents(parsedSession) : []),
      ...(parsedEvent ? scouterRecentEventToAgentChatEvent(parsedEvent) : []),
    ].sort((a, b) => a.timestamp - b.timestamp);
    const events = applyBindingsToEvents(
      mergeEvents(filterDismissedEvents(get().events, dismissedIds), incomingEvents, boundSessions),
      bindings,
    );

    set({
      enabled: true,
      sessions: boundSessions,
      events,
      bindings,
      codexPtyLaunches: launches,
      latestSessionId: boundSessions[0]?.codexSessionId ?? null,
      loading: false,
      error: null,
      lastUpdatedAt: parsed.emittedAt ?? Date.now(),
    });
    persistLatestWidgetCodexBinding(boundSessions);
  },

  recordCodexPtyCandidate: (candidate) => {
    const launch = normalizePtyCandidate(candidate);
    const launches = applyResumeBindingCwdToLaunches(
      upsertPtyLaunch(get().codexPtyLaunches, launch),
      get().sessions,
      get().bindings,
    );
    const bindings = reconcileBindings(get().sessions, launches, get().bindings);
    set({
      codexPtyLaunches: launches,
      bindings,
      sessions: applySessionTitleOverrides(
        applyBindingsToSessions(get().sessions, bindings),
        get().sessionTitleOverrides,
      ),
      events: applyBindingsToEvents(get().events, bindings),
    });
    persistLatestWidgetCodexBinding(get().sessions);
  },

  bindCodexSessionToPty: (sessionId, candidate) => {
    const normalizedSessionId = normalizeCodexSessionId(sessionId);
    const launch = normalizePtyCandidate(candidate);
    if (!normalizedSessionId || !launch.ptySessionId) return;

    const currentSessions = get().sessions;
    const targetSession = currentSessions.find((session) => (
      normalizeCodexSessionId(session.codexSessionId) === normalizedSessionId
    ));
    const bindingSessionId = targetSession?.codexSessionId ?? normalizedSessionId;
    const bindingCwd = targetSession?.cwd ?? launch.cwd ?? null;
    const launches = upsertPtyLaunch(get().codexPtyLaunches, {
      ...launch,
      cwd: bindingCwd,
    });
    const bindings = {
      ...omitBindingsForNormalizedSession(get().bindings, normalizedSessionId),
      [bindingSessionId]: {
        codexSessionId: bindingSessionId,
        ptySessionId: launch.ptySessionId,
        shellySessionId: launch.shellySessionId ?? null,
        cwd: bindingCwd,
        confidence: 'reliable' as const,
        matchedAt: Date.now(),
        reason: 'resume' as const,
      },
    };
    const sessions = applySessionTitleOverrides(
      applyBindingsToSessions(currentSessions, bindings),
      get().sessionTitleOverrides,
    );
    set({
      codexPtyLaunches: launches,
      bindings,
      sessions,
      events: applyBindingsToEvents(get().events, bindings),
      latestSessionId: sessions[0]?.codexSessionId ?? null,
      lastUpdatedAt: Date.now(),
    });
    persistLatestWidgetCodexBinding(sessions);
  },

  dismissSession: (sessionId) => {
    const normalized = normalizeCodexSessionId(sessionId);
    if (!normalized) return;
    const dismissedSessionIds = [
      normalized,
      ...get().dismissedSessionIds.filter((id) => id !== normalized),
    ].slice(0, MAX_DISMISSED_SESSIONS);
    const dismissedSet = new Set(dismissedSessionIds);
    const sessions = get().sessions.filter((session) => !isDismissedSessionId(session.codexSessionId, dismissedSet));
    const events = filterDismissedEvents(get().events, dismissedSet);
    const bindings = omitDismissedBindings(get().bindings, dismissedSet);
    set({
      dismissedSessionIds,
      sessions,
      events,
      bindings,
      latestSessionId: sessions[0]?.codexSessionId ?? null,
      lastUpdatedAt: Date.now(),
    });
    persistDismissedSessionIds(dismissedSessionIds);
  },

  renameSession: (sessionId, title) => {
    const normalized = normalizeCodexSessionId(sessionId);
    const nextTitle = normalizeSessionTitle(title);
    if (!normalized || !nextTitle) return;
    const sessionTitleOverrides = {
      ...get().sessionTitleOverrides,
      [normalized]: nextTitle,
    };
    const sessions = get().sessions.map((session) => (
      normalizeCodexSessionId(session.codexSessionId) === normalized
        ? { ...session, projectName: nextTitle }
        : session
    ));
    set({
      sessionTitleOverrides,
      sessions,
      latestSessionId: sessions[0]?.codexSessionId ?? null,
      lastUpdatedAt: Date.now(),
    });
    persistSessionTitleOverrides(sessionTitleOverrides);
  },

  requestComposeFocus: () => {
    set({ composeFocusSignal: Date.now() });
  },

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      await hydrateDismissedSessionIds(set, get);
      await hydrateSessionTitleOverrides(set, get);
      const dismissedIds = new Set(get().dismissedSessionIds);
      const raw = await (
        TerminalEmulator.refreshScouter?.()
        ?? TerminalEmulator.getScouterDebugInfo()
      );
      const parsed = JSON.parse(raw) as ScouterDebugInfo;
      const codexSessions = filterDismissedScouterSessions(
        dedupeCodexSessions(parsed.sessions ?? []),
        dismissedIds,
      );
      const recentEvents = filterDismissedRecentEvents(parsed.recentEvents ?? [], dismissedIds);
      const sessionCwdById = collectRecentEventCwd(recentEvents);
      const sessions = codexSessions.map((session) => {
        const sessionId = session.sessionId?.trim() ?? '';
        return toAgentChatSession(session, sessionCwdById.get(normalizeCodexSessionId(sessionId)));
      });
      const launches = applyResumeBindingCwdToLaunches(
        prunePtyLaunches(get().codexPtyLaunches, Date.now()),
        sessions,
        get().bindings,
      );
      const bindings = reconcileBindings(sessions, launches, get().bindings);
      const boundSessions = applySessionTitleOverrides(
        applyBindingsToSessions(sessions, bindings),
        get().sessionTitleOverrides,
      );
      const newEvents = [
        ...codexSessions.flatMap(sessionToEvents),
        ...recentEvents.flatMap(scouterRecentEventToAgentChatEvent),
        ...widgetConversationToAgentChatEvents(parsed.widgetConversation, boundSessions),
      ]
        .sort((a, b) => a.timestamp - b.timestamp);
      const events = applyBindingsToEvents(
        mergeEvents(filterDismissedEvents(get().events, dismissedIds), newEvents, boundSessions),
        bindings,
      );

      set({
        enabled: Boolean(parsed.enabled),
        jsonlWatcherRunning: Boolean(parsed.jsonlWatcherRunning),
        sessions: boundSessions,
        events,
        bindings,
        codexPtyLaunches: launches,
        latestSessionId: boundSessions[0]?.codexSessionId ?? null,
        loading: false,
        error: null,
        lastUpdatedAt: Date.now(),
      });
      persistLatestWidgetCodexBinding(boundSessions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ loading: false, error: message, lastUpdatedAt: Date.now() });
      logError('AgentChatStore', 'refresh failed', error);
    }
  },

  startPolling: () => {
    pollingRefCount += 1;
    void hydrateDismissedSessionIds(set, get);
    void hydrateSessionTitleOverrides(set, get);
    startLiveSubscription();
    if (pollingTimer !== null) return;
    void get().refresh();
    pollingTimer = setInterval(() => {
      void get().refresh();
    }, REFRESH_MS);
  },

  stopPolling: () => {
    pollingRefCount = Math.max(0, pollingRefCount - 1);
    if (pollingRefCount > 0) return;
    if (pollingTimer !== null) {
      clearInterval(pollingTimer);
      pollingTimer = null;
    }
    stopLiveSubscription();
  },
}));

function startLiveSubscription(): void {
  if (liveSubscription !== null) return;
  try {
    liveSubscription = TerminalEmulator.addListener('onScouterEvent', (payload: NativeScouterEventPayload) => {
      useAgentChatStore.getState().ingestNativeEvent(payload);
    });
  } catch (error) {
    liveSubscription = null;
    logError('AgentChatStore', 'live event subscription failed', error);
  }
}

function stopLiveSubscription(): void {
  const sub = liveSubscription;
  liveSubscription = null;
  if (!sub) return;
  try {
    sub.remove();
  } catch (error) {
    logError('AgentChatStore', 'live event unsubscribe failed', error);
  }
}

function persistLatestWidgetCodexBinding(sessions: AgentChatSession[]): void {
  const session = sessions
    .filter((candidate) => (
      candidate.bindingConfidence === 'reliable' && Boolean(candidate.ptySessionId?.trim())
    ))
    .sort((a, b) => (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0))[0];
  if (!session?.ptySessionId) {
    TerminalEmulator.setScouterCodexBinding?.({
      codexSessionId: '',
      ptySessionId: null,
      shellySessionId: null,
      cwd: null,
    }).catch((error) => {
      logError('AgentChatStore', 'Failed to clear Scouter Codex binding for widget', error);
    });
    return;
  }
  TerminalEmulator.setScouterCodexBinding?.({
    codexSessionId: session.codexSessionId,
    ptySessionId: session.ptySessionId,
    shellySessionId: session.shellySessionId ?? null,
    cwd: session.cwd ?? null,
  }).catch((error) => {
    logError('AgentChatStore', 'Failed to persist Scouter Codex binding for widget', error);
  });
}

async function hydrateDismissedSessionIds(
  setState: (partial: Partial<AgentChatState>) => void,
  getState: () => AgentChatState,
): Promise<void> {
  if (dismissedSessionsHydrated) return;
  if (dismissedSessionsHydratePromise) return dismissedSessionsHydratePromise;
  dismissedSessionsHydratePromise = AsyncStorage.getItem(DISMISSED_SESSIONS_STORAGE_KEY)
    .then((raw) => {
      const parsed = parseJsonObject<unknown>(raw ?? undefined);
      const stored = Array.isArray(parsed)
        ? parsed
          .map((value) => typeof value === 'string' ? normalizeCodexSessionId(value) : '')
          .filter(Boolean)
        : [];
      const merged = [
        ...getState().dismissedSessionIds,
        ...stored,
      ];
      const dismissedSessionIds = Array.from(new Set(merged))
        .slice(0, MAX_DISMISSED_SESSIONS);
      if (dismissedSessionIds.length > 0) {
        const dismissedSet = new Set(dismissedSessionIds);
        const sessions = getState().sessions.filter((session) => !isDismissedSessionId(session.codexSessionId, dismissedSet));
        setState({
          dismissedSessionIds,
          sessions,
          events: filterDismissedEvents(getState().events, dismissedSet),
          bindings: omitDismissedBindings(getState().bindings, dismissedSet),
          latestSessionId: sessions[0]?.codexSessionId ?? null,
        });
      }
      dismissedSessionsHydrated = true;
    })
    .catch((error) => {
      dismissedSessionsHydrated = true;
      logError('AgentChatStore', 'dismissed session hydration failed', error);
    })
    .finally(() => {
      dismissedSessionsHydratePromise = null;
    });
  return dismissedSessionsHydratePromise;
}

async function hydrateSessionTitleOverrides(
  setState: (partial: Partial<AgentChatState>) => void,
  getState: () => AgentChatState,
): Promise<void> {
  if (sessionTitlesHydrated) return;
  if (sessionTitlesHydratePromise) return sessionTitlesHydratePromise;
  sessionTitlesHydratePromise = AsyncStorage.getItem(SESSION_TITLES_STORAGE_KEY)
    .then((raw) => {
      const stored = normalizeSessionTitleOverrides(parseJsonObject<unknown>(raw ?? undefined));
      const sessionTitleOverrides = {
        ...stored,
        ...getState().sessionTitleOverrides,
      };
      const sessions = applySessionTitleOverrides(getState().sessions, sessionTitleOverrides);
      setState({
        sessionTitleOverrides,
        sessions,
        latestSessionId: sessions[0]?.codexSessionId ?? null,
      });
      sessionTitlesHydrated = true;
    })
    .catch((error) => {
      sessionTitlesHydrated = true;
      logError('AgentChatStore', 'session title hydration failed', error);
    })
    .finally(() => {
      sessionTitlesHydratePromise = null;
    });
  return sessionTitlesHydratePromise;
}

function persistDismissedSessionIds(sessionIds: string[]): void {
  AsyncStorage.setItem(
    DISMISSED_SESSIONS_STORAGE_KEY,
    JSON.stringify(sessionIds.slice(0, MAX_DISMISSED_SESSIONS)),
  ).catch((error) => {
    logError('AgentChatStore', 'dismissed session persist failed', error);
  });
}

function persistSessionTitleOverrides(overrides: Record<string, string>): void {
  AsyncStorage.setItem(SESSION_TITLES_STORAGE_KEY, JSON.stringify(overrides))
    .catch((error) => {
      logError('AgentChatStore', 'session title persist failed', error);
    });
}

function parseNativeScouterPayload(payload: NativeScouterEventPayload): {
  event: ScouterRecentEvent | null;
  session: ScouterSession | null;
  emittedAt: number | null;
} {
  const event = parseJsonObject<ScouterRecentEvent>(payload.eventJson);
  const session = parseJsonObject<ScouterSession>(payload.snapshotJson);
  return {
    event,
    session,
    emittedAt: typeof payload.emittedAt === 'number' ? payload.emittedAt : null,
  };
}

function parseJsonObject<T>(value?: string): T | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as T : null;
  } catch {
    return null;
  }
}

function agentSessionToScouterSession(session: AgentChatSession): ScouterSession {
  return {
    source: 'CODEX',
    sessionId: session.codexSessionId,
    projectName: session.projectName,
    currentStatus: session.currentStatus,
    currentTool: session.currentTool ?? null,
    lastEventAt: session.lastEventAt,
    sessionStartAt: session.sessionStartAt,
    modelName: session.modelName ?? null,
    tokensUsed: session.tokensUsed ?? 0,
    cwd: session.cwd ?? null,
  };
}

function recentEventToScouterSession(event: ScouterRecentEvent): ScouterSession {
  return {
    source: event.source,
    sessionId: event.sessionId,
    projectName: event.projectName,
    currentStatus: event.derivedStatus,
    currentTool: event.toolName ?? null,
    lastEventAt: event.timestamp,
    sessionStartAt: event.timestamp,
    modelName: event.modelName ?? null,
    tokensUsed: event.tokensUsed ?? 0,
    lastError: event.errorMessage ?? null,
    lastMessage: event.lastMessage ?? null,
    cwd: event.cwd ?? extractCwdFromMessage(event.lastMessage),
  };
}

function dedupeCodexSessions(sessions: ScouterSession[]): ScouterSession[] {
  const byId = new Map<string, ScouterSession>();
  for (const session of sessions) {
    if (session.source !== 'CODEX') continue;
    const sessionId = session.sessionId?.trim();
    if (!sessionId) continue;
    const normalizedSessionId = normalizeCodexSessionId(sessionId);
    const previous = byId.get(normalizedSessionId);
    if (!previous || timestampOf(session) > timestampOf(previous)) {
      byId.set(normalizedSessionId, { ...session, sessionId });
    }
  }
  return Array.from(byId.values()).sort((a, b) => timestampOf(b) - timestampOf(a));
}

function filterDismissedScouterSessions(
  sessions: ScouterSession[],
  dismissedIds: Set<string>,
): ScouterSession[] {
  if (dismissedIds.size === 0) return sessions;
  return sessions.filter((session) => !isDismissedSessionId(session.sessionId, dismissedIds));
}

function filterDismissedRecentEvents(
  events: ScouterRecentEvent[],
  dismissedIds: Set<string>,
): ScouterRecentEvent[] {
  if (dismissedIds.size === 0) return events;
  return events.filter((event) => !isDismissedSessionId(event.sessionId, dismissedIds));
}

function filterDismissedEvents(
  events: AgentChatEvent[],
  dismissedIds: Set<string>,
): AgentChatEvent[] {
  if (dismissedIds.size === 0) return events;
  return events.filter((event) => !isDismissedSessionId(event.codexSessionId, dismissedIds));
}

function omitDismissedBindings(
  bindings: Record<string, AgentChatBinding>,
  dismissedIds: Set<string>,
): Record<string, AgentChatBinding> {
  if (dismissedIds.size === 0) return bindings;
  const next: Record<string, AgentChatBinding> = {};
  for (const [sessionId, binding] of Object.entries(bindings)) {
    if (!isDismissedSessionId(sessionId, dismissedIds)) next[sessionId] = binding;
  }
  return next;
}

function isDismissedSessionId(sessionId: string | null | undefined, dismissedIds: Set<string>): boolean {
  const normalized = normalizeCodexSessionId(sessionId);
  return Boolean(normalized && dismissedIds.has(normalized));
}

function normalizeCodexSessionId(sessionId: string | null | undefined): string {
  const trimmed = sessionId?.trim() ?? '';
  return /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/.exec(trimmed)?.[1]
    ?? trimmed;
}

function normalizeSessionTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').slice(0, MAX_SESSION_TITLE_LENGTH);
}

function normalizeSessionTitleOverrides(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const next: Record<string, string> = {};
  for (const [sessionId, title] of Object.entries(value)) {
    const normalizedSessionId = normalizeCodexSessionId(sessionId);
    const normalizedTitle = typeof title === 'string' ? normalizeSessionTitle(title) : '';
    if (normalizedSessionId && normalizedTitle) {
      next[normalizedSessionId] = normalizedTitle;
    }
  }
  return next;
}

function applySessionTitleOverrides(
  sessions: AgentChatSession[],
  overrides: Record<string, string>,
): AgentChatSession[] {
  if (Object.keys(overrides).length === 0) return sessions;
  return sessions.map((session) => {
    const title = overrides[normalizeCodexSessionId(session.codexSessionId)];
    return title ? { ...session, projectName: title } : session;
  });
}

function toAgentChatSession(session: ScouterSession, cwdOverride?: string | null): AgentChatSession {
  const codexSessionId = session.sessionId?.trim() ?? '';
  const cwd = normalizeCwd(cwdOverride ?? session.cwd ?? extractCwdFromMessage(session.lastMessage));
  return {
    codexSessionId,
    projectName: session.projectName?.trim() || 'Codex',
    currentStatus: session.currentStatus?.trim() || 'IDLE',
    currentTool: session.currentTool ?? null,
    lastEventAt: timestampOf(session),
    sessionStartAt: session.sessionStartAt ?? timestampOf(session),
    modelName: session.modelName ?? null,
    tokensUsed: session.tokensUsed ?? 0,
    cwd,
    ptySessionId: null,
    shellySessionId: null,
    bindingConfidence: 'none',
  };
}

function collectRecentEventCwd(events: ScouterRecentEvent[]): Map<string, string> {
  const bySession = new Map<string, string>();
  for (const event of events) {
    if (event.source !== 'CODEX') continue;
    const sessionId = normalizeCodexSessionId(event.sessionId);
    if (!sessionId || bySession.has(sessionId)) continue;
    const cwd = normalizeCwd(event.cwd ?? extractCwdFromMessage(event.lastMessage));
    if (cwd) bySession.set(sessionId, cwd);
  }
  return bySession;
}

function applyRecentEventCwd(
  sessions: AgentChatSession[],
  cwdBySessionId: Map<string, string>,
): AgentChatSession[] {
  if (cwdBySessionId.size === 0) return sessions;
  return sessions.map((session) => {
    if (session.cwd) return session;
    const cwd = cwdBySessionId.get(normalizeCodexSessionId(session.codexSessionId));
    return cwd ? { ...session, cwd } : session;
  });
}

function normalizePtyCandidate(candidate: CodexPtyCandidate): CodexPtyLaunch {
  const now = Date.now();
  return {
    ptySessionId: candidate.ptySessionId.trim(),
    shellySessionId: candidate.shellySessionId ?? null,
    cwd: normalizeCwd(candidate.cwd),
    startedAt: candidate.startedAt ?? now,
    lastSeenAt: candidate.lastSeenAt ?? now,
  };
}

function upsertPtyLaunch(existing: CodexPtyLaunch[], incoming: CodexPtyLaunch): CodexPtyLaunch[] {
  const now = Date.now();
  const previous = existing.find((launch) => launch.ptySessionId === incoming.ptySessionId);
  const merged: CodexPtyLaunch = {
    ...previous,
    ...incoming,
    cwd: incoming.cwd ?? previous?.cwd ?? null,
    startedAt: previous?.startedAt ?? incoming.startedAt,
    lastSeenAt: Math.max(previous?.lastSeenAt ?? 0, incoming.lastSeenAt),
  };
  const others = existing.filter((launch) => launch.ptySessionId !== incoming.ptySessionId);
  return prunePtyLaunches([merged, ...others], now)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_PTY_LAUNCHES);
}

function prunePtyLaunches(launches: CodexPtyLaunch[], now: number): CodexPtyLaunch[] {
  return launches.filter((launch) => (
    launch.ptySessionId.trim()
    && now - launch.lastSeenAt <= PTY_LAUNCH_TTL_MS
  ));
}

function reconcileBindings(
  sessions: AgentChatSession[],
  launches: CodexPtyLaunch[],
  previous: Record<string, AgentChatBinding>,
): Record<string, AgentChatBinding> {
  const next: Record<string, AgentChatBinding> = {};
  const reusableResumeBindings = collectReusableResumeBindings(sessions, launches, previous);
  const usedPtySessionIds = new Set(
    Array.from(reusableResumeBindings.values())
      .map((binding) => binding.ptySessionId)
      .filter((ptySessionId): ptySessionId is string => Boolean(ptySessionId)),
  );
  for (const session of sessions) {
    const existing = findBindingForSession(previous, session.codexSessionId);
    const resumeBinding = reusableResumeBindings.get(session.codexSessionId);
    if (resumeBinding) {
      next[session.codexSessionId] = resumeBinding;
      continue;
    }

    const match = findReliablePtyMatch(session, launches, usedPtySessionIds);
    if (match) {
      usedPtySessionIds.add(match.launch.ptySessionId);
      next[session.codexSessionId] = {
        codexSessionId: session.codexSessionId,
        ptySessionId: match.launch.ptySessionId,
        shellySessionId: match.launch.shellySessionId ?? null,
        cwd: match.launch.cwd ?? session.cwd ?? null,
        confidence: 'reliable',
        matchedAt: Date.now(),
        reason: 'cwd-time',
      };
      continue;
    }

    if (
      canReuseReliableBinding(session, existing, launches)
      && existing?.ptySessionId
      && !usedPtySessionIds.has(existing.ptySessionId)
    ) {
      usedPtySessionIds.add(existing.ptySessionId);
      next[session.codexSessionId] = {
        ...existing,
        codexSessionId: session.codexSessionId,
        reason: 'previous',
      };
      continue;
    }

    const candidate = findCwdCandidate(session, launches, usedPtySessionIds);
    if (candidate) {
      next[session.codexSessionId] = {
        codexSessionId: session.codexSessionId,
        ptySessionId: candidate.ptySessionId,
        shellySessionId: candidate.shellySessionId ?? null,
        cwd: candidate.cwd ?? session.cwd ?? null,
        confidence: 'candidate',
        matchedAt: null,
        reason: 'cwd-only',
      };
      continue;
    }

    next[session.codexSessionId] = {
      codexSessionId: session.codexSessionId,
      ptySessionId: null,
      shellySessionId: null,
      cwd: session.cwd ?? null,
      confidence: 'none',
      matchedAt: null,
      reason: 'none',
    };
  }
  return next;
}

function collectReusableResumeBindings(
  sessions: AgentChatSession[],
  launches: CodexPtyLaunch[],
  previous: Record<string, AgentChatBinding>,
): Map<string, AgentChatBinding> {
  const bindings = new Map<string, AgentChatBinding>();
  const reservedPtySessionIds = new Set<string>();
  for (const session of sessions) {
    const binding = findBindingForSession(previous, session.codexSessionId);
    if (!canReuseRecentResumeBinding(session, binding, launches)) continue;
    if (!binding.ptySessionId) continue;
    if (reservedPtySessionIds.has(binding.ptySessionId)) continue;
    reservedPtySessionIds.add(binding.ptySessionId);
    bindings.set(session.codexSessionId, {
      ...binding,
      codexSessionId: session.codexSessionId,
      cwd: session.cwd ?? binding.cwd,
    });
  }
  return bindings;
}

function applyResumeBindingCwdToLaunches(
  launches: CodexPtyLaunch[],
  sessions: AgentChatSession[],
  previous: Record<string, AgentChatBinding>,
): CodexPtyLaunch[] {
  const cwdByPtySessionId = new Map<string, string>();
  for (const session of sessions) {
    const cwd = normalizeCwd(session.cwd);
    if (!cwd) continue;
    const binding = findBindingForSession(previous, session.codexSessionId);
    if (!canReuseRecentResumeBinding(session, binding, launches) || !binding.ptySessionId) continue;
    cwdByPtySessionId.set(binding.ptySessionId, cwd);
  }
  if (cwdByPtySessionId.size === 0) return launches;
  return launches.map((launch) => {
    const cwd = cwdByPtySessionId.get(launch.ptySessionId);
    if (!cwd || normalizeCwd(launch.cwd) === cwd) return launch;
    return { ...launch, cwd };
  });
}

function findBindingForSession(
  bindings: Record<string, AgentChatBinding>,
  sessionId: string | null | undefined,
): AgentChatBinding | undefined {
  const directKey = sessionId?.trim() ?? '';
  if (directKey && bindings[directKey]) return bindings[directKey];
  const normalized = normalizeCodexSessionId(sessionId);
  if (!normalized) return undefined;
  return Object.entries(bindings).find(([key, binding]) => (
    normalizeCodexSessionId(key) === normalized
    || normalizeCodexSessionId(binding.codexSessionId) === normalized
  ))?.[1];
}

function omitBindingsForNormalizedSession(
  bindings: Record<string, AgentChatBinding>,
  normalizedSessionId: string,
): Record<string, AgentChatBinding> {
  const next: Record<string, AgentChatBinding> = {};
  for (const [key, binding] of Object.entries(bindings)) {
    if (
      normalizeCodexSessionId(key) === normalizedSessionId
      || normalizeCodexSessionId(binding.codexSessionId) === normalizedSessionId
    ) {
      continue;
    }
    next[key] = binding;
  }
  return next;
}

function canReuseRecentResumeBinding(
  session: AgentChatSession,
  binding: AgentChatBinding | undefined,
  launches: CodexPtyLaunch[],
): binding is AgentChatBinding {
  return Boolean(
    binding?.reason === 'resume'
    && binding.confidence === 'reliable'
    && binding.ptySessionId
    && isRecentResumeBinding(binding)
    && launches.some((launch) => launch.ptySessionId === binding.ptySessionId),
  );
}

function isRecentResumeBinding(binding: AgentChatBinding): boolean {
  return typeof binding.matchedAt === 'number'
    && Date.now() - binding.matchedAt <= RESUME_BINDING_RESERVATION_MS;
}

function canReuseReliableBinding(
  session: AgentChatSession,
  binding: AgentChatBinding | undefined,
  launches: CodexPtyLaunch[],
): binding is AgentChatBinding {
  return Boolean(
    binding?.confidence === 'reliable'
    && (!session.cwd || normalizeCwd(binding.cwd) === normalizeCwd(session.cwd))
    && binding.ptySessionId
    && launches.some((launch) => launch.ptySessionId === binding.ptySessionId),
  );
}

function findReliablePtyMatch(
  session: AgentChatSession,
  launches: CodexPtyLaunch[],
  usedPtySessionIds: Set<string>,
): { launch: CodexPtyLaunch; distance: number } | null {
  const sessionCwd = normalizeCwd(session.cwd);
  if (!sessionCwd) return null;
  let best: { launch: CodexPtyLaunch; distance: number } | null = null;
  for (const launch of launches) {
    if (usedPtySessionIds.has(launch.ptySessionId)) continue;
    if (normalizeCwd(launch.cwd) !== sessionCwd) continue;
    const distance = bindingTimeDistance(session, launch);
    if (distance > BINDING_MATCH_WINDOW_MS) continue;
    if (!best || distance < best.distance) {
      best = { launch, distance };
    }
  }
  return best;
}

function findCwdCandidate(
  session: AgentChatSession,
  launches: CodexPtyLaunch[],
  usedPtySessionIds: Set<string>,
): CodexPtyLaunch | null {
  const sessionCwd = normalizeCwd(session.cwd);
  if (!sessionCwd) return null;
  return launches.find((launch) => (
    !usedPtySessionIds.has(launch.ptySessionId)
    && normalizeCwd(launch.cwd) === sessionCwd
  )) ?? null;
}

function bindingTimeDistance(session: AgentChatSession, launch: CodexPtyLaunch): number {
  const sessionTimes = [session.sessionStartAt, session.lastEventAt].filter(isFiniteTimestamp);
  const launchTimes = [launch.startedAt, launch.lastSeenAt].filter(isFiniteTimestamp);
  let best = Number.POSITIVE_INFINITY;
  for (const sessionTime of sessionTimes) {
    for (const launchTime of launchTimes) {
      best = Math.min(best, Math.abs(sessionTime - launchTime));
    }
  }
  return best;
}

function applyBindingsToSessions(
  sessions: AgentChatSession[],
  bindings: Record<string, AgentChatBinding>,
): AgentChatSession[] {
  return sessions.map((session) => {
    const binding = findBindingForSession(bindings, session.codexSessionId);
    if (!binding) return session;
    return {
      ...session,
      ptySessionId: binding.ptySessionId,
      shellySessionId: binding.shellySessionId ?? null,
      cwd: session.cwd ?? binding.cwd,
      bindingConfidence: binding.confidence,
    };
  });
}

function applyBindingsToEvents(
  events: AgentChatEvent[],
  bindings: Record<string, AgentChatBinding>,
): AgentChatEvent[] {
  return events.map((event) => {
    const binding = findBindingForSession(bindings, event.codexSessionId);
    if (!binding?.ptySessionId) {
      return event.ptySessionId ? { ...event, ptySessionId: undefined } : event;
    }
    return {
      ...event,
      ptySessionId: binding.ptySessionId,
    };
  });
}

function sessionToEvents(session: ScouterSession): AgentChatEvent[] {
  const codexSessionId = session.sessionId?.trim();
  if (!codexSessionId) return [];

  const timestamp = timestampOf(session);
  const status = mapStatus(session.currentStatus);
  const events: AgentChatEvent[] = [
    {
      id: eventId(codexSessionId, 'status', timestamp, session.currentStatus ?? 'IDLE'),
      source: 'codex',
      codexSessionId,
      role: 'system',
      kind: 'status',
      text: session.currentStatus ?? 'IDLE',
      status,
      timestamp,
      rawEvent: session,
    },
  ];

  const toolName = session.currentTool?.trim();
  if (toolName) {
    events.push({
      id: eventId(codexSessionId, 'tool_start', timestamp, toolName),
      source: 'codex',
      codexSessionId,
      role: 'tool',
      kind: 'tool_start',
      text: toolName,
      status: 'tool_running',
      toolName,
      timestamp: timestamp + 1,
      rawEvent: session,
    });
  }

  const currentStatus = (session.currentStatus ?? '').toUpperCase();
  const lastMessage = cleanScouterMessage(session.lastMessage);
  if (currentStatus === 'WAITING_PERMISSION') {
    const approvalText = approvalTextForEvent(toolName, null, lastMessage);
    if (approvalText) {
      events.push({
        id: eventId(codexSessionId, 'approval', timestamp, approvalText),
        source: 'codex',
        codexSessionId,
        role: 'system',
        kind: 'approval',
        text: approvalText,
        status: 'waiting_input',
        toolName: toolName || undefined,
        timestamp: timestamp + 2,
        rawEvent: session,
      });
    }
  }

  if (lastMessage && currentStatus === 'IDLE') {
    events.push({
      id: eventId(codexSessionId, 'assistant_message', timestamp, lastMessage),
      source: 'codex',
      codexSessionId,
      role: 'assistant',
      kind: 'assistant_message',
      text: lastMessage,
      status,
      timestamp: timestamp + 2,
      rawEvent: session,
    });
  }

  const lastError = cleanScouterMessage(session.lastError);
  if (lastError && currentStatus === 'ERROR') {
    events.push({
      id: eventId(codexSessionId, 'error', timestamp, lastError),
      source: 'codex',
      codexSessionId,
      role: 'system',
      kind: 'error',
      text: lastError,
      status: 'error',
      timestamp: timestamp + 3,
      rawEvent: session,
    });
  }

  return events;
}

function scouterRecentEventToAgentChatEvent(event: ScouterRecentEvent): AgentChatEvent[] {
  if (event.source !== 'CODEX') return [];
  const codexSessionId = event.sessionId?.trim();
  if (!codexSessionId) return [];

  const eventType = (event.eventType ?? '').toUpperCase();
  const derivedStatus = (event.derivedStatus ?? '').toUpperCase();
  const timestamp = event.timestamp ?? Date.now();
  const status = mapStatus(event.derivedStatus);
  const base = {
    id: event.eventId?.trim() ? `agent-chat-scouter-${event.eventId}` : '',
    source: 'codex' as const,
    codexSessionId,
    status,
    timestamp,
    rawEvent: event,
  };

  const lastMessage = cleanScouterMessage(event.lastMessage);
  const userMessage = cleanScouterUserMessage(event.lastMessage);
  const toolName = event.toolName?.trim();
  const commandSummary = event.commandSummary?.trim();
  const errorMessage = cleanScouterMessage(event.errorMessage) ?? lastMessage;

  if (eventType === 'USER_PROMPT' && userMessage) {
    return [{
      ...base,
      id: base.id || eventId(codexSessionId, 'user_message', timestamp, userMessage),
      role: 'user',
      kind: 'user_message',
      text: userMessage,
    }];
  }

  if (isApprovalScouterEvent(eventType, derivedStatus)) {
    const approvalText = approvalTextForEvent(toolName, commandSummary, lastMessage);
    if (approvalText) {
      return [{
        ...base,
        id: base.id || eventId(codexSessionId, 'approval', timestamp, approvalText),
        role: 'system',
        kind: 'approval',
        text: approvalText,
        status: 'waiting_input',
        toolName: toolName || undefined,
      }];
    }
  }

  if ((eventType === 'SNAPSHOT' || derivedStatus === 'IDLE' || derivedStatus === 'COMPLETED') && lastMessage) {
    return [{
      ...base,
      id: base.id || eventId(codexSessionId, 'assistant_message', timestamp, lastMessage),
      role: 'assistant',
      kind: 'assistant_message',
      text: lastMessage,
    }];
  }

  if (eventType === 'PRE_TOOL_USE' && (toolName || commandSummary)) {
    const text = toolName || commandSummary || 'tool';
    return [{
      ...base,
      id: base.id || eventId(codexSessionId, 'tool_start', timestamp, text),
      role: 'tool',
      kind: 'tool_start',
      text,
      status: 'tool_running',
      toolName: toolName || text,
    }];
  }

  if (eventType === 'POST_TOOL_USE' && (toolName || commandSummary)) {
    const text = toolName || commandSummary || 'tool';
    return [{
      ...base,
      id: base.id || eventId(codexSessionId, 'tool_result', timestamp, text),
      role: 'tool',
      kind: 'tool_result',
      text,
      toolName: toolName || text,
    }];
  }

  if ((eventType === 'POST_TOOL_USE_FAILURE' || derivedStatus === 'ERROR') && errorMessage) {
    return [{
      ...base,
      id: base.id || eventId(codexSessionId, 'error', timestamp, errorMessage),
      role: 'system',
      kind: 'error',
      text: errorMessage,
      status: 'error',
    }];
  }

  return [];
}

function widgetConversationToAgentChatEvents(
  conversation: ScouterWidgetConversation | null | undefined,
  sessions: AgentChatSession[],
): AgentChatEvent[] {
  const prompt = cleanScouterUserMessage(conversation?.widgetPrompt);
  const timestamp = normalizeEventTimestamp(conversation?.widgetPromptAt);
  if (!prompt || !timestamp) return [];
  if (!isWidgetPromptSentStatus(conversation?.widgetStatus)) return [];

  const session = pickWidgetConversationSession(sessions, timestamp);
  if (!session) return [];

  return [{
    id: eventId(session.codexSessionId, 'widget_user_message', timestamp, prompt),
    source: 'codex',
    codexSessionId: session.codexSessionId,
    ptySessionId: session.ptySessionId ?? undefined,
    role: 'user',
    kind: 'user_message',
    text: prompt,
    status: mapStatus(session.currentStatus),
    timestamp,
    rawEvent: {
      source: 'widgetConversation',
      conversation,
    },
  }];
}

function isWidgetPromptSentStatus(status?: string | null): boolean {
  const normalized = status?.trim().toLowerCase();
  if (!normalized) return true;
  return normalized === 'queued'
    || normalized === 'sending'
    || normalized === 'observed'
    || normalized === 'answered';
}

function pickWidgetConversationSession(
  sessions: AgentChatSession[],
  timestamp: number,
): AgentChatSession | null {
  const reliable = sessions.find((session) => (
    session.bindingConfidence === 'reliable' && Boolean(session.ptySessionId?.trim())
  ));
  if (reliable) return reliable;
  return [...sessions]
    .sort((a, b) => Math.abs(a.lastEventAt - timestamp) - Math.abs(b.lastEventAt - timestamp))[0]
    ?? null;
}

function mergeEvents(
  existing: AgentChatEvent[],
  incoming: AgentChatEvent[],
  sessions: AgentChatSession[],
): AgentChatEvent[] {
  if (sessions.length === 0) return [];

  const activeSessionIdByNormalizedId = new Map(
    sessions.map((session) => [normalizeCodexSessionId(session.codexSessionId), session.codexSessionId]),
  );
  const incomingWidgetConversationIds = new Set(
    incoming
      .filter((event) => isWidgetConversationRawEvent(event.rawEvent))
      .map((event) => event.id),
  );
  const byId = new Map<string, AgentChatEvent>();
  for (const event of existing) {
    if (
      isWidgetConversationRawEvent(event.rawEvent)
      && !incomingWidgetConversationIds.has(event.id)
    ) {
      continue;
    }
    const activeSessionId = activeSessionIdByNormalizedId.get(normalizeCodexSessionId(event.codexSessionId));
    if (!activeSessionId) continue;
    byId.set(event.id, event.codexSessionId === activeSessionId ? event : {
      ...event,
      codexSessionId: activeSessionId,
    });
  }
  for (const event of incoming) {
    const activeSessionId = activeSessionIdByNormalizedId.get(normalizeCodexSessionId(event.codexSessionId));
    if (!activeSessionId) continue;
    byId.set(event.id, event.codexSessionId === activeSessionId ? event : {
      ...event,
      codexSessionId: activeSessionId,
    });
  }
  return dedupeTimelineEvents(Array.from(byId.values()))
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-MAX_EVENTS);
}

function isWidgetConversationRawEvent(rawEvent: unknown): rawEvent is { source: 'widgetConversation' } {
  return Boolean(
    rawEvent
    && typeof rawEvent === 'object'
    && 'source' in rawEvent
    && (rawEvent as { source?: unknown }).source === 'widgetConversation',
  );
}

function dedupeTimelineEvents(events: AgentChatEvent[]): AgentChatEvent[] {
  const recentByContent = new Map<string, AgentChatEvent>();
  const seenUsersBySession = new Map<string, Map<string, number>>();
  const seenAssistantsBySession = new Map<string, Map<string, number>>();
  const latestStatusBySession = new Map<string, AgentChatEvent>();
  const kept: AgentChatEvent[] = [];
  for (const event of [...events].sort((a, b) => a.timestamp - b.timestamp)) {
    if (isSyntheticAgentChatEvent(event)) continue;
    if (event.kind === 'status') {
      const previous = latestStatusBySession.get(event.codexSessionId);
      if (!previous || event.timestamp >= previous.timestamp) {
        latestStatusBySession.set(event.codexSessionId, event);
      }
      continue;
    }
    const key = messageContentKey(event);
    if (key && event.kind === 'user_message') {
      const seenUsers = getSeenTimestampMap(seenUsersBySession, event.codexSessionId);
      const previousTs = seenUsers.get(key);
      // Events are sorted ascending, so the delta is always >= 0.
      if (previousTs !== undefined && event.timestamp - previousTs <= MESSAGE_DEDUPE_WINDOW_MS) continue;
      seenUsers.set(key, event.timestamp);
      seenAssistantsBySession.delete(event.codexSessionId);
    } else if (key && event.kind === 'assistant_message') {
      const seenAssistants = getSeenTimestampMap(seenAssistantsBySession, event.codexSessionId);
      const previousTs = seenAssistants.get(key);
      if (previousTs !== undefined && event.timestamp - previousTs <= MESSAGE_DEDUPE_WINDOW_MS) continue;
      seenAssistants.set(key, event.timestamp);
      seenUsersBySession.delete(event.codexSessionId);
    } else if (key) {
      const previous = recentByContent.get(key);
      if (previous && Math.abs(event.timestamp - previous.timestamp) <= DEDUPE_WINDOW_MS) {
        continue;
      }
      recentByContent.set(key, event);
    }
    kept.push(event);
  }
  return [
    ...kept,
    ...latestStatusBySession.values(),
  ].sort((a, b) => a.timestamp - b.timestamp);
}

function getSeenTimestampMap(map: Map<string, Map<string, number>>, sessionId: string): Map<string, number> {
  const existing = map.get(sessionId);
  if (existing) return existing;
  const created = new Map<string, number>();
  map.set(sessionId, created);
  return created;
}

function messageContentKey(event: AgentChatEvent): string | null {
  if (
    event.kind !== 'user_message'
    && event.kind !== 'assistant_message'
    && event.kind !== 'tool_start'
    && event.kind !== 'tool_result'
    && event.kind !== 'approval'
    && event.kind !== 'error'
  ) return null;
  return `${event.codexSessionId}:${event.kind}:${hashText(normalizeTimelineText(event.text))}`;
}

function isApprovalScouterEvent(eventType: string, derivedStatus: string): boolean {
  return eventType === 'PERMISSION_REQUEST'
    || eventType.includes('APPROVAL')
    || derivedStatus === 'WAITING_PERMISSION';
}

function approvalTextForEvent(
  toolName?: string | null,
  commandSummary?: string | null,
  lastMessage?: string | null,
): string | null {
  return commandSummary?.trim()
    || lastMessage?.trim()
    || toolName?.trim()
    || null;
}

function cleanScouterMessage(message?: string | null): string | null {
  const value = message?.trim();
  if (!value) return null;
  if (value === 'Codex tokens updated') return null;
  return value;
}

function cleanScouterUserMessage(message?: string | null): string | null {
  const value = cleanScouterMessage(message);
  if (!value) return null;
  if (isSyntheticCodexUserMessage(value)) return null;
  return value;
}

function isSyntheticAgentChatEvent(event: AgentChatEvent): boolean {
  return event.kind === 'user_message' && isSyntheticCodexUserMessage(event.text);
}

function isSyntheticCodexUserMessage(message: string): boolean {
  const value = message.trim();
  if (value.startsWith('<environment_context>')) {
    return value.includes('<cwd>') || value.includes('<current_date>') || value.includes('<timezone>');
  }
  return value.startsWith('# AGENTS.md instructions') && value.includes('<INSTRUCTIONS>');
}

function normalizeTimelineText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function extractCwdFromMessage(message?: string | null): string | null {
  const value = message?.trim();
  if (!value) return null;
  const cwd = /<cwd>([^<]+)<\/cwd>/.exec(value)?.[1];
  return normalizeCwd(cwd);
}

function normalizeCwd(cwd?: string | null): string | null {
  const value = cwd?.trim();
  if (!value) return null;
  if (value === '/') return value;
  return value.replace(/\/+$/g, '');
}

function isFiniteTimestamp(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function normalizeEventTimestamp(value?: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function mapStatus(status?: string): AgentChatStatus {
  switch ((status ?? '').toUpperCase()) {
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

function timestampOf(session: ScouterSession): number {
  return session.lastEventAt ?? session.sessionStartAt ?? Date.now();
}

function eventId(sessionId: string, kind: string, timestamp: number, text: string): string {
  return `agent-chat-${sessionId}-${kind}-${timestamp}-${hashText(text)}`;
}

function hashText(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}
