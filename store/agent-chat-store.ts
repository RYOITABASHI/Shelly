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
  refresh: () => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
};

const MAX_EVENTS = 200;
const REFRESH_MS = 5_000;
let pollingRefCount = 0;
let pollingTimer: ReturnType<typeof setInterval> | null = null;

export const useAgentChatStore = create<AgentChatState>((set, get) => ({
  enabled: false,
  jsonlWatcherRunning: false,
  sessions: [],
  events: [],
  latestSessionId: null,
  loading: false,
  error: null,
  lastUpdatedAt: null,

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
    if (pollingTimer !== null) return;
    void get().refresh();
    pollingTimer = setInterval(() => {
      void get().refresh();
    }, REFRESH_MS);
  },

  stopPolling: () => {
    pollingRefCount = Math.max(0, pollingRefCount - 1);
    if (pollingRefCount > 0 || pollingTimer === null) return;
    clearInterval(pollingTimer);
    pollingTimer = null;
  },
}));

function dedupeCodexSessions(sessions: ScouterSession[]): ScouterSession[] {
  const byId = new Map<string, ScouterSession>();
  for (const session of sessions) {
    if (session.source !== 'CODEX') continue;
    const sessionId = session.sessionId?.trim();
    if (!sessionId) continue;
    const previous = byId.get(sessionId);
    if (!previous || timestampOf(session) >= timestampOf(previous)) {
      byId.set(sessionId, session);
    }
  }
  return Array.from(byId.values()).sort((a, b) => timestampOf(b) - timestampOf(a));
}

function toAgentChatSession(session: ScouterSession): AgentChatSession {
  return {
    codexSessionId: session.sessionId ?? '',
    projectName: session.projectName?.trim() || 'Codex',
    currentStatus: session.currentStatus || 'IDLE',
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
  const lastMessage = session.lastMessage?.trim();
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

  const lastError = session.lastError?.trim();
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
  const toolName = event.toolName?.trim();
  const commandSummary = event.commandSummary?.trim();
  const errorMessage = cleanScouterMessage(event.errorMessage) ?? lastMessage;

  if (eventType === 'USER_PROMPT' && lastMessage) {
    return [{
      ...base,
      id: base.id || eventId(codexSessionId, 'user_message', timestamp, lastMessage),
      role: 'user',
      kind: 'user_message',
      text: lastMessage,
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
  const contentKeys = new Set<string>();
  const snapshotContentIds = new Map<string, Set<string>>();
  for (const event of existing) {
    if (activeSessionIds.has(event.codexSessionId)) {
      byId.set(event.id, event);
      const key = messageContentKey(event);
      if (key) {
        contentKeys.add(key);
        if (!hasStableRawEventId(event.rawEvent)) addSnapshotContentId(snapshotContentIds, key, event.id);
      }
    }
  }
  for (const event of incoming) {
    if (!activeSessionIds.has(event.codexSessionId)) continue;
    const key = messageContentKey(event);
    const hasStableId = hasStableRawEventId(event.rawEvent);
    if (key) {
      if (hasStableId) {
        const snapshotIds = snapshotContentIds.get(key);
        snapshotIds?.forEach((id) => byId.delete(id));
        snapshotContentIds.delete(key);
      } else if (contentKeys.has(key)) {
        continue;
      }
    }
    byId.set(event.id, event);
    if (key) {
      contentKeys.add(key);
      if (!hasStableId) addSnapshotContentId(snapshotContentIds, key, event.id);
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-MAX_EVENTS);
}

function addSnapshotContentId(map: Map<string, Set<string>>, key: string, id: string): void {
  const existing = map.get(key);
  if (existing) {
    existing.add(id);
    return;
  }
  map.set(key, new Set([id]));
}

function messageContentKey(event: AgentChatEvent): string | null {
  if (
    event.kind !== 'user_message'
    && event.kind !== 'assistant_message'
    && event.kind !== 'tool_start'
    && event.kind !== 'error'
  ) return null;
  return `${event.codexSessionId}:${event.kind}:${hashText(event.text.trim())}`;
}

function hasStableRawEventId(rawEvent: unknown): boolean {
  if (!rawEvent || typeof rawEvent !== 'object') return false;
  return typeof (rawEvent as { eventId?: unknown }).eventId === 'string'
    && Boolean((rawEvent as { eventId?: string }).eventId?.trim());
}

function cleanScouterMessage(message?: string | null): string | null {
  const value = message?.trim();
  if (!value) return null;
  if (value === 'Codex tokens updated') return null;
  return value;
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
