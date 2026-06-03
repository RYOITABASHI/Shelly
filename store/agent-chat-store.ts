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
  reason: 'cwd-time' | 'cwd-only' | 'previous' | 'none';
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

type ScouterDebugInfo = {
  enabled?: boolean;
  jsonlWatcherRunning?: boolean;
  sessions?: ScouterSession[];
  recentEvents?: ScouterRecentEvent[];
};

type AgentChatState = {
  enabled: boolean;
  jsonlWatcherRunning: boolean;
  sessions: AgentChatSession[];
  events: AgentChatEvent[];
  bindings: Record<string, AgentChatBinding>;
  codexPtyLaunches: CodexPtyLaunch[];
  dismissedSessionIds: string[];
  latestSessionId: string | null;
  loading: boolean;
  error: string | null;
  lastUpdatedAt: number | null;
  ingestNativeEvent: (payload: NativeScouterEventPayload) => void;
  recordCodexPtyCandidate: (candidate: CodexPtyCandidate) => void;
  dismissSession: (sessionId: string) => void;
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
const REFRESH_MS = 5_000;
const DEDUPE_WINDOW_MS = 2_000;
const BINDING_MATCH_WINDOW_MS = 15 * 60_000;
const PTY_LAUNCH_TTL_MS = 2 * 60 * 60_000;
const MAX_PTY_LAUNCHES = 12;
const DISMISSED_SESSIONS_STORAGE_KEY = 'shelly_agent_chat_dismissed_sessions';
let pollingRefCount = 0;
let pollingTimer: ReturnType<typeof setInterval> | null = null;
let liveSubscription: { remove(): void } | null = null;
let dismissedSessionsHydrated = false;
let dismissedSessionsHydratePromise: Promise<void> | null = null;

export const useAgentChatStore = create<AgentChatState>((set, get) => ({
  enabled: false,
  jsonlWatcherRunning: false,
  sessions: [],
  events: [],
  bindings: {},
  codexPtyLaunches: [],
  dismissedSessionIds: [],
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
    const bindings = reconcileBindings(sessionsWithCwd, get().codexPtyLaunches, get().bindings);
    const boundSessions = applyBindingsToSessions(sessionsWithCwd, bindings);
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
      latestSessionId: boundSessions[0]?.codexSessionId ?? null,
      loading: false,
      error: null,
      lastUpdatedAt: parsed.emittedAt ?? Date.now(),
    });
  },

  recordCodexPtyCandidate: (candidate) => {
    const launch = normalizePtyCandidate(candidate);
    const launches = upsertPtyLaunch(get().codexPtyLaunches, launch);
    const bindings = reconcileBindings(get().sessions, launches, get().bindings);
    set({
      codexPtyLaunches: launches,
      bindings,
      sessions: applyBindingsToSessions(get().sessions, bindings),
      events: applyBindingsToEvents(get().events, bindings),
    });
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

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      await hydrateDismissedSessionIds(set, get);
      const dismissedIds = new Set(get().dismissedSessionIds);
      const raw = await TerminalEmulator.getScouterDebugInfo();
      const parsed = JSON.parse(raw) as ScouterDebugInfo;
      const codexSessions = filterDismissedScouterSessions(
        dedupeCodexSessions(parsed.sessions ?? []),
        dismissedIds,
      );
      const recentEvents = filterDismissedRecentEvents(parsed.recentEvents ?? [], dismissedIds);
      const sessionCwdById = collectRecentEventCwd(recentEvents);
      const sessions = codexSessions.map((session) => {
        const sessionId = session.sessionId?.trim() ?? '';
        return toAgentChatSession(session, sessionCwdById.get(sessionId));
      });
      const launches = prunePtyLaunches(get().codexPtyLaunches, Date.now());
      const bindings = reconcileBindings(sessions, launches, get().bindings);
      const boundSessions = applyBindingsToSessions(sessions, bindings);
      const newEvents = [
        ...codexSessions.flatMap(sessionToEvents),
        ...recentEvents.flatMap(scouterRecentEventToAgentChatEvent),
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ loading: false, error: message, lastUpdatedAt: Date.now() });
      logError('AgentChatStore', 'refresh failed', error);
    }
  },

  startPolling: () => {
    pollingRefCount += 1;
    void hydrateDismissedSessionIds(set, get);
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

function persistDismissedSessionIds(sessionIds: string[]): void {
  AsyncStorage.setItem(
    DISMISSED_SESSIONS_STORAGE_KEY,
    JSON.stringify(sessionIds.slice(0, MAX_DISMISSED_SESSIONS)),
  ).catch((error) => {
    logError('AgentChatStore', 'dismissed session persist failed', error);
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
    const previous = byId.get(sessionId);
    if (!previous || timestampOf(session) >= timestampOf(previous)) {
      byId.set(sessionId, { ...session, sessionId });
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
    const sessionId = event.sessionId?.trim();
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
    const cwd = cwdBySessionId.get(session.codexSessionId);
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
  const usedPtySessionIds = new Set<string>();
  for (const session of sessions) {
    const existing = previous[session.codexSessionId];
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
      existing?.confidence === 'reliable'
      && (!session.cwd || normalizeCwd(existing.cwd) === normalizeCwd(session.cwd))
      && existing.ptySessionId
      && launches.some((launch) => launch.ptySessionId === existing.ptySessionId)
      && !usedPtySessionIds.has(existing.ptySessionId)
    ) {
      usedPtySessionIds.add(existing.ptySessionId);
      next[session.codexSessionId] = { ...existing, reason: 'previous' };
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
    const binding = bindings[session.codexSessionId];
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
    const binding = bindings[event.codexSessionId];
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

function mergeEvents(
  existing: AgentChatEvent[],
  incoming: AgentChatEvent[],
  sessions: AgentChatSession[],
): AgentChatEvent[] {
  if (sessions.length === 0) return [];

  const activeSessionIds = new Set(sessions.map((session) => session.codexSessionId));
  const byId = new Map<string, AgentChatEvent>();
  for (const event of existing) {
    if (activeSessionIds.has(event.codexSessionId)) {
      byId.set(event.id, event);
    }
  }
  for (const event of incoming) {
    if (!activeSessionIds.has(event.codexSessionId)) continue;
    byId.set(event.id, event);
  }
  return dedupeTimelineEvents(Array.from(byId.values()))
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-MAX_EVENTS);
}

function dedupeTimelineEvents(events: AgentChatEvent[]): AgentChatEvent[] {
  const recentByContent = new Map<string, AgentChatEvent>();
  const seenUsersBySession = new Map<string, Set<string>>();
  const seenAssistantsBySession = new Map<string, Set<string>>();
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
      const seenUsers = getSeenMessageSet(seenUsersBySession, event.codexSessionId);
      if (seenUsers.has(key)) continue;
      seenUsers.add(key);
      seenAssistantsBySession.delete(event.codexSessionId);
    } else if (key && event.kind === 'assistant_message') {
      const seenAssistants = getSeenMessageSet(seenAssistantsBySession, event.codexSessionId);
      if (seenAssistants.has(key)) continue;
      seenAssistants.add(key);
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

function getSeenMessageSet(map: Map<string, Set<string>>, sessionId: string): Set<string> {
  const existing = map.get(sessionId);
  if (existing) return existing;
  const created = new Set<string>();
  map.set(sessionId, created);
  return created;
}

function messageContentKey(event: AgentChatEvent): string | null {
  if (
    event.kind !== 'user_message'
    && event.kind !== 'assistant_message'
    && event.kind !== 'tool_start'
    && event.kind !== 'tool_result'
    && event.kind !== 'error'
  ) return null;
  return `${event.codexSessionId}:${event.kind}:${hashText(normalizeTimelineText(event.text))}`;
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
