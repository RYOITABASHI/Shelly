import { create } from 'zustand';
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
  latestSessionId: string | null;
  loading: boolean;
  error: string | null;
  lastUpdatedAt: number | null;
  ingestNativeEvent: (payload: NativeScouterEventPayload) => void;
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
const REFRESH_MS = 5_000;
const DEDUPE_WINDOW_MS = 2_000;
let pollingRefCount = 0;
let pollingTimer: ReturnType<typeof setInterval> | null = null;
let liveSubscription: { remove(): void } | null = null;

export const useAgentChatStore = create<AgentChatState>((set, get) => ({
  enabled: false,
  jsonlWatcherRunning: false,
  sessions: [],
  events: [],
  latestSessionId: null,
  loading: false,
  error: null,
  lastUpdatedAt: null,

  ingestNativeEvent: (payload) => {
    const parsed = parseNativeScouterPayload(payload);
    if (!parsed.event && !parsed.session) return;

    const currentSessions = get().sessions.map(agentSessionToScouterSession);
    const incomingSessions = [
      ...(parsed.session ? [parsed.session] : []),
      ...(!parsed.session && parsed.event ? [recentEventToScouterSession(parsed.event)] : []),
    ];
    const sessions = dedupeCodexSessions([
      ...incomingSessions,
      ...currentSessions,
    ]).map(toAgentChatSession);

    if (sessions.length === 0) return;

    const incomingEvents = [
      ...(parsed.session ? sessionToEvents(parsed.session) : []),
      ...(parsed.event ? scouterRecentEventToAgentChatEvent(parsed.event) : []),
    ].sort((a, b) => a.timestamp - b.timestamp);

    set({
      enabled: true,
      sessions,
      events: mergeEvents(get().events, incomingEvents, sessions),
      latestSessionId: sessions[0]?.codexSessionId ?? null,
      loading: false,
      error: null,
      lastUpdatedAt: parsed.emittedAt ?? Date.now(),
    });
  },

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const raw = await TerminalEmulator.getScouterDebugInfo();
      const parsed = JSON.parse(raw) as ScouterDebugInfo;
      const codexSessions = dedupeCodexSessions(parsed.sessions ?? []);
      const sessions = codexSessions.map(toAgentChatSession);
      const newEvents = [
        ...codexSessions.flatMap(sessionToEvents),
        ...(parsed.recentEvents ?? []).flatMap(scouterRecentEventToAgentChatEvent),
      ]
        .sort((a, b) => a.timestamp - b.timestamp);
      const events = mergeEvents(get().events, newEvents, sessions);

      set({
        enabled: Boolean(parsed.enabled),
        jsonlWatcherRunning: Boolean(parsed.jsonlWatcherRunning),
        sessions,
        events,
        latestSessionId: sessions[0]?.codexSessionId ?? null,
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

function toAgentChatSession(session: ScouterSession): AgentChatSession {
  const codexSessionId = session.sessionId?.trim() ?? '';
  return {
    codexSessionId,
    projectName: session.projectName?.trim() || 'Codex',
    currentStatus: session.currentStatus?.trim() || 'IDLE',
    currentTool: session.currentTool ?? null,
    lastEventAt: timestampOf(session),
    sessionStartAt: session.sessionStartAt ?? timestampOf(session),
    modelName: session.modelName ?? null,
    tokensUsed: session.tokensUsed ?? 0,
  };
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
  const kept: AgentChatEvent[] = [];
  for (const event of [...events].sort((a, b) => a.timestamp - b.timestamp)) {
    if (isSyntheticAgentChatEvent(event)) continue;
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
  return kept;
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
