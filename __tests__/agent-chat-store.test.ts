const mockGetScouterDebugInfo = jest.fn();
const mockRefreshScouter = jest.fn();
const mockAddListener = jest.fn();
const mockAsyncStorageValues = new Map<string, string>();
const mockAsyncStorageGetItem = jest.fn((key: string) => Promise.resolve(mockAsyncStorageValues.get(key) ?? null));
const mockAsyncStorageSetItem = jest.fn((key: string, value: string) => {
  mockAsyncStorageValues.set(key, value);
  return Promise.resolve();
});

jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: {
    getScouterDebugInfo: mockGetScouterDebugInfo,
    refreshScouter: mockRefreshScouter,
    addListener: mockAddListener,
  },
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: mockAsyncStorageGetItem,
    setItem: mockAsyncStorageSetItem,
  },
}));

jest.mock('@/lib/debug-logger', () => ({
  logError: jest.fn(),
}));

import { useAgentChatStore } from '@/store/agent-chat-store';

function resetAgentChatStore(): void {
  useAgentChatStore.setState({
    enabled: false,
    jsonlWatcherRunning: false,
    sessions: [],
    events: [],
    bindings: {},
    codexPtyLaunches: [],
    dismissedSessionIds: [],
    sessionTitleOverrides: {},
    latestSessionId: null,
    loading: false,
    error: null,
    lastUpdatedAt: null,
  });
}

describe('agent chat store', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAsyncStorageValues.clear();
    mockAddListener.mockReturnValue({ remove: jest.fn() });
    mockRefreshScouter.mockImplementation(() => mockGetScouterDebugInfo());
    resetAgentChatStore();
  });

  it('forces a native Scouter scan when refreshing Agent Chat', async () => {
    mockRefreshScouter.mockResolvedValueOnce(JSON.stringify({
      enabled: true,
      jsonlWatcherRunning: true,
      sessions: [],
      recentEvents: [],
    }));

    await useAgentChatStore.getState().refresh();

    expect(mockRefreshScouter).toHaveBeenCalledTimes(1);
    expect(mockGetScouterDebugInfo).not.toHaveBeenCalled();
    expect(useAgentChatStore.getState().loading).toBe(false);
  });

  it('filters synthetic Codex context and collapses duplicate message events', async () => {
    const baseTime = 1_811_111_000_000;
    mockGetScouterDebugInfo.mockResolvedValue(JSON.stringify({
      enabled: true,
      jsonlWatcherRunning: true,
      sessions: [{
        source: 'CODEX',
        sessionId: 'session-a',
        projectName: 'home',
        currentStatus: 'IDLE',
        lastEventAt: baseTime + 6,
        sessionStartAt: baseTime,
        modelName: 'gpt-5.5',
        tokensUsed: 11607,
        lastMessage: 'こんにちは。今日は何を手伝いましょうか。',
      }],
      recentEvents: [
        {
          eventId: 'event-context',
          source: 'CODEX',
          sessionId: 'session-a',
          timestamp: baseTime + 1,
          eventType: 'USER_PROMPT',
          derivedStatus: 'THINKING',
          lastMessage: '<environment_context>\n<cwd>/data/data/dev.shelly.terminal/files/home</cwd>\n<current_date>2026-06-02</current_date>\n</environment_context>',
        },
        {
          eventId: 'event-user-a',
          source: 'CODEX',
          sessionId: 'session-a',
          timestamp: baseTime + 2,
          eventType: 'USER_PROMPT',
          derivedStatus: 'THINKING',
          lastMessage: 'こんにちは',
        },
        {
          eventId: 'event-user-b',
          source: 'CODEX',
          sessionId: 'session-a',
          timestamp: baseTime + 3,
          eventType: 'USER_PROMPT',
          derivedStatus: 'THINKING',
          lastMessage: ' こんにちは ',
        },
        {
          eventId: 'event-assistant-a',
          source: 'CODEX',
          sessionId: 'session-a',
          timestamp: baseTime + 4,
          eventType: 'SNAPSHOT',
          derivedStatus: 'IDLE',
          lastMessage: 'こんにちは。今日は何を手伝いましょうか。',
        },
        {
          eventId: 'event-assistant-b',
          source: 'CODEX',
          sessionId: 'session-a',
          timestamp: baseTime + 5,
          eventType: 'SNAPSHOT',
          derivedStatus: 'IDLE',
          lastMessage: 'こんにちは。今日は何を手伝いましょうか。',
        },
      ],
    }));

    await useAgentChatStore.getState().refresh();

    const events = useAgentChatStore.getState().events;
    expect(events.some((event) => event.text.includes('<environment_context>'))).toBe(false);
    expect(events.filter((event) => event.kind === 'user_message').map((event) => event.text)).toEqual(['こんにちは']);
    expect(events.filter((event) => event.kind === 'assistant_message').map((event) => event.text)).toEqual([
      'こんにちは。今日は何を手伝いましょうか。',
    ]);
  });

  it('keeps repeated prompts when an assistant response separates the turns', async () => {
    const baseTime = 1_811_112_000_000;
    mockGetScouterDebugInfo.mockResolvedValue(JSON.stringify({
      enabled: true,
      jsonlWatcherRunning: true,
      sessions: [{
        source: 'CODEX',
        sessionId: 'session-b',
        projectName: 'home',
        currentStatus: 'THINKING',
        lastEventAt: baseTime + 8_000,
        sessionStartAt: baseTime,
      }],
      recentEvents: [
        {
          eventId: 'event-user-a',
          source: 'CODEX',
          sessionId: 'session-b',
          timestamp: baseTime,
          eventType: 'USER_PROMPT',
          derivedStatus: 'THINKING',
          lastMessage: 'もう一回',
        },
        {
          eventId: 'event-assistant-a',
          source: 'CODEX',
          sessionId: 'session-b',
          timestamp: baseTime + 2_500,
          eventType: 'SNAPSHOT',
          derivedStatus: 'IDLE',
          lastMessage: '了解しました。',
        },
        {
          eventId: 'event-user-b',
          source: 'CODEX',
          sessionId: 'session-b',
          timestamp: baseTime + 5_000,
          eventType: 'USER_PROMPT',
          derivedStatus: 'THINKING',
          lastMessage: 'もう一回',
        },
      ],
    }));

    await useAgentChatStore.getState().refresh();

    expect(useAgentChatStore.getState().events.filter((event) => event.kind === 'user_message')).toHaveLength(2);
  });

  it('keeps synthetic-looking content when it is not a user prompt', async () => {
    const baseTime = 1_811_113_000_000;
    const quotedContext = '<environment_context>\n<cwd>/tmp/project</cwd>\n<current_date>2026-06-02</current_date>\n</environment_context>';
    mockGetScouterDebugInfo.mockResolvedValue(JSON.stringify({
      enabled: true,
      jsonlWatcherRunning: true,
      sessions: [{
        source: 'CODEX',
        sessionId: 'session-c',
        projectName: 'home',
        currentStatus: 'IDLE',
        lastEventAt: baseTime + 1,
        sessionStartAt: baseTime,
      }],
      recentEvents: [{
        eventId: 'event-assistant-context',
        source: 'CODEX',
        sessionId: 'session-c',
        timestamp: baseTime + 1,
        eventType: 'SNAPSHOT',
        derivedStatus: 'IDLE',
        lastMessage: quotedContext,
      }],
    }));

    await useAgentChatStore.getState().refresh();

    expect(useAgentChatStore.getState().events.filter((event) => event.kind === 'assistant_message')).toEqual([
      expect.objectContaining({ text: quotedContext }),
    ]);
  });

  it('converts Codex permission recent events into read-only approval cards', async () => {
    const baseTime = 1_811_113_500_000;
    mockGetScouterDebugInfo.mockResolvedValue(JSON.stringify({
      enabled: true,
      jsonlWatcherRunning: true,
      sessions: [{
        source: 'CODEX',
        sessionId: 'session-approval-event',
        projectName: 'home',
        currentStatus: 'THINKING',
        currentTool: 'shell',
        lastEventAt: baseTime,
        sessionStartAt: baseTime,
      }],
      recentEvents: [{
        eventId: 'event-approval-request',
        source: 'CODEX',
        sessionId: 'session-approval-event',
        timestamp: baseTime + 1,
        eventType: 'PERMISSION_REQUEST',
        derivedStatus: 'WAITING_PERMISSION',
        toolName: 'shell',
        commandSummary: 'git push origin main',
      }],
    }));

    await useAgentChatStore.getState().refresh();

    expect(useAgentChatStore.getState().events.filter((event) => event.kind === 'approval')).toEqual([
      expect.objectContaining({
        codexSessionId: 'session-approval-event',
        role: 'system',
        text: 'git push origin main',
        status: 'waiting_input',
        toolName: 'shell',
      }),
    ]);
  });

  it('converts waiting-permission session snapshots into read-only approval cards', async () => {
    const baseTime = 1_811_113_750_000;
    mockGetScouterDebugInfo.mockResolvedValue(JSON.stringify({
      enabled: true,
      jsonlWatcherRunning: true,
      sessions: [{
        source: 'CODEX',
        sessionId: 'session-approval-snapshot',
        projectName: 'home',
        currentStatus: 'WAITING_PERMISSION',
        currentTool: 'apply_patch',
        lastEventAt: baseTime,
        sessionStartAt: baseTime,
        lastMessage: 'Apply patch to store/agent-chat-store.ts?',
      }],
      recentEvents: [],
    }));

    await useAgentChatStore.getState().refresh();

    expect(useAgentChatStore.getState().events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'approval',
        codexSessionId: 'session-approval-snapshot',
        text: 'Apply patch to store/agent-chat-store.ts?',
        status: 'waiting_input',
        toolName: 'apply_patch',
      }),
    ]));
  });

  it('ingests native Scouter events without waiting for polling refresh', () => {
    const baseTime = 1_811_114_000_000;

    useAgentChatStore.getState().ingestNativeEvent({
      emittedAt: baseTime + 2,
      snapshotJson: JSON.stringify({
        source: 'CODEX',
        sessionId: 'session-live',
        projectName: 'home',
        currentStatus: 'THINKING',
        lastEventAt: baseTime + 2,
        sessionStartAt: baseTime,
        modelName: 'gpt-5.5',
        tokensUsed: 42,
      }),
      eventJson: JSON.stringify({
        eventId: 'event-live-user',
        source: 'CODEX',
        sessionId: 'session-live',
        projectName: 'home',
        timestamp: baseTime + 1,
        eventType: 'USER_PROMPT',
        derivedStatus: 'THINKING',
        lastMessage: 'ライブイベント',
      }),
    });

    expect(useAgentChatStore.getState().latestSessionId).toBe('session-live');
    expect(useAgentChatStore.getState().sessions).toEqual([
      expect.objectContaining({
        codexSessionId: 'session-live',
        currentStatus: 'THINKING',
        modelName: 'gpt-5.5',
        tokensUsed: 42,
      }),
    ]);
    expect(useAgentChatStore.getState().events).toEqual([
      expect.objectContaining({ kind: 'user_message', text: 'ライブイベント' }),
      expect.objectContaining({ kind: 'status', text: 'THINKING' }),
    ]);
  });

  it('keeps live timeline events visible when Scouter normalizes a rollout session id', async () => {
    const baseTime = 1_811_114_500_000;
    const rawSessionId = 'rollout-2026-06-03T11-42-51-019e8b5c-bc3f-7582-88f6-e8a26ba24d66';
    const normalizedSessionId = '019e8b5c-bc3f-7582-88f6-e8a26ba24d66';

    mockGetScouterDebugInfo.mockResolvedValue(JSON.stringify({
      enabled: true,
      jsonlWatcherRunning: true,
      sessions: [{
        source: 'CODEX',
        sessionId: rawSessionId,
        projectName: 'home',
        currentStatus: 'IDLE',
        lastEventAt: baseTime,
        sessionStartAt: baseTime,
      }],
      recentEvents: [{
        eventId: 'event-raw-user',
        source: 'CODEX',
        sessionId: rawSessionId,
        timestamp: baseTime,
        eventType: 'USER_PROMPT',
        derivedStatus: 'THINKING',
        lastMessage: 'raw hello',
      }],
    }));

    await useAgentChatStore.getState().refresh();
    useAgentChatStore.getState().ingestNativeEvent({
      emittedAt: baseTime + 2_000,
      snapshotJson: JSON.stringify({
        source: 'CODEX',
        sessionId: normalizedSessionId,
        projectName: 'home',
        currentStatus: 'THINKING',
        lastEventAt: baseTime + 2_000,
        sessionStartAt: baseTime,
      }),
      eventJson: JSON.stringify({
        eventId: 'event-normalized-live',
        source: 'CODEX',
        sessionId: normalizedSessionId,
        timestamp: baseTime + 2_000,
        eventType: 'USER_PROMPT',
        derivedStatus: 'THINKING',
        lastMessage: 'normalized live',
      }),
    });

    expect(useAgentChatStore.getState().sessions.map((session) => session.codexSessionId)).toEqual([
      normalizedSessionId,
    ]);
    expect(useAgentChatStore.getState().events.filter((event) => event.kind === 'user_message')).toEqual([
      expect.objectContaining({ codexSessionId: normalizedSessionId, text: 'raw hello' }),
      expect.objectContaining({ codexSessionId: normalizedSessionId, text: 'normalized live' }),
    ]);
  });

  it('keeps only the latest status event per session', () => {
    const baseTime = 1_811_115_000_000;

    useAgentChatStore.getState().ingestNativeEvent({
      emittedAt: baseTime,
      snapshotJson: JSON.stringify({
        source: 'CODEX',
        sessionId: 'session-status',
        projectName: 'home',
        currentStatus: 'THINKING',
        lastEventAt: baseTime,
        sessionStartAt: baseTime,
      }),
    });
    useAgentChatStore.getState().ingestNativeEvent({
      emittedAt: baseTime + 1_000,
      snapshotJson: JSON.stringify({
        source: 'CODEX',
        sessionId: 'session-status',
        projectName: 'home',
        currentStatus: 'IDLE',
        lastEventAt: baseTime + 1_000,
        sessionStartAt: baseTime,
      }),
    });

    const statusEvents = useAgentChatStore.getState().events.filter((event) => event.kind === 'status');
    expect(statusEvents).toEqual([
      expect.objectContaining({ codexSessionId: 'session-status', text: 'IDLE' }),
    ]);
  });

  it('binds a Codex JSONL session to a recent foreground PTY with matching cwd', async () => {
    const baseTime = 1_811_116_000_000;
    const cwd = '/data/data/dev.shelly.terminal/files/home';

    useAgentChatStore.getState().recordCodexPtyCandidate({
      ptySessionId: 'shelly-1',
      shellySessionId: 'session-1',
      cwd,
      startedAt: baseTime - 1_000,
      lastSeenAt: baseTime + 2_000,
    });

    mockGetScouterDebugInfo.mockResolvedValue(JSON.stringify({
      enabled: true,
      jsonlWatcherRunning: true,
      sessions: [{
        source: 'CODEX',
        sessionId: 'session-bound',
        projectName: 'home',
        currentStatus: 'IDLE',
        lastEventAt: baseTime + 3_000,
        sessionStartAt: baseTime,
        modelName: 'gpt-5.5',
        tokensUsed: 11,
      }],
      recentEvents: [{
        eventId: 'event-context-cwd',
        source: 'CODEX',
        sessionId: 'session-bound',
        timestamp: baseTime + 1,
        eventType: 'USER_PROMPT',
        derivedStatus: 'THINKING',
        lastMessage: `<environment_context><cwd>${cwd}</cwd></environment_context>`,
      }, {
        eventId: 'event-bound-user',
        source: 'CODEX',
        sessionId: 'session-bound',
        timestamp: baseTime + 2_000,
        eventType: 'USER_PROMPT',
        derivedStatus: 'THINKING',
        lastMessage: 'こんにちは',
      }],
    }));

    await useAgentChatStore.getState().refresh();

    expect(useAgentChatStore.getState().sessions).toEqual([
      expect.objectContaining({
        codexSessionId: 'session-bound',
        ptySessionId: 'shelly-1',
        shellySessionId: 'session-1',
        bindingConfidence: 'reliable',
        cwd,
      }),
    ]);
    expect(useAgentChatStore.getState().events.filter((event) => event.kind === 'user_message')).toEqual([
      expect.objectContaining({
        text: 'こんにちは',
        ptySessionId: 'shelly-1',
      }),
    ]);
  });

  it('backfills cwd from a rollout event when the session id is UUID-only', async () => {
    const baseTime = 1_811_116_500_000;
    const cwd = '/data/data/dev.shelly.terminal/files/home';
    const rawSessionId = 'rollout-2026-06-03T11-42-51-039e8b5c-bc3f-7582-88f6-e8a26ba24d66';
    const normalizedSessionId = '039e8b5c-bc3f-7582-88f6-e8a26ba24d66';

    useAgentChatStore.getState().recordCodexPtyCandidate({
      ptySessionId: 'shelly-mixed-cwd',
      shellySessionId: 'session-mixed-cwd',
      cwd,
      startedAt: baseTime,
      lastSeenAt: baseTime + 2_000,
    });

    mockGetScouterDebugInfo.mockResolvedValue(JSON.stringify({
      enabled: true,
      jsonlWatcherRunning: true,
      sessions: [{
        source: 'CODEX',
        sessionId: normalizedSessionId,
        projectName: 'home',
        currentStatus: 'IDLE',
        lastEventAt: baseTime + 2_000,
        sessionStartAt: baseTime,
        modelName: 'gpt-5.5',
      }],
      recentEvents: [{
        eventId: 'event-mixed-cwd-context',
        source: 'CODEX',
        sessionId: rawSessionId,
        timestamp: baseTime + 1,
        eventType: 'USER_PROMPT',
        derivedStatus: 'THINKING',
        lastMessage: `<environment_context><cwd>${cwd}</cwd></environment_context>`,
      }],
    }));

    await useAgentChatStore.getState().refresh();

    expect(useAgentChatStore.getState().sessions).toEqual([
      expect.objectContaining({
        codexSessionId: normalizedSessionId,
        bindingConfidence: 'reliable',
        ptySessionId: 'shelly-mixed-cwd',
        shellySessionId: 'session-mixed-cwd',
        cwd,
      }),
    ]);
  });

  it('does not reliably bind a JSONL session to a PTY candidate from another cwd', async () => {
    const baseTime = 1_811_117_000_000;

    useAgentChatStore.getState().recordCodexPtyCandidate({
      ptySessionId: 'shelly-1',
      shellySessionId: 'session-1',
      cwd: '/data/data/dev.shelly.terminal/files/home',
      startedAt: baseTime,
      lastSeenAt: baseTime,
    });

    mockGetScouterDebugInfo.mockResolvedValue(JSON.stringify({
      enabled: true,
      jsonlWatcherRunning: true,
      sessions: [{
        source: 'CODEX',
        sessionId: 'session-unbound',
        projectName: 'project',
        currentStatus: 'IDLE',
        lastEventAt: baseTime + 500,
        sessionStartAt: baseTime,
        cwd: '/data/data/dev.shelly.terminal/files/project',
      }],
      recentEvents: [],
    }));

    await useAgentChatStore.getState().refresh();

    expect(useAgentChatStore.getState().sessions).toEqual([
      expect.objectContaining({
        codexSessionId: 'session-unbound',
        ptySessionId: null,
        bindingConfidence: 'none',
      }),
    ]);
  });

  it('clears event PTY ids when a previously bound session becomes unbound', async () => {
    const baseTime = 1_811_118_000_000;
    const homeCwd = '/data/data/dev.shelly.terminal/files/home';

    useAgentChatStore.getState().recordCodexPtyCandidate({
      ptySessionId: 'shelly-1',
      shellySessionId: 'session-1',
      cwd: homeCwd,
      startedAt: baseTime,
      lastSeenAt: baseTime,
    });

    mockGetScouterDebugInfo.mockResolvedValueOnce(JSON.stringify({
      enabled: true,
      jsonlWatcherRunning: true,
      sessions: [{
        source: 'CODEX',
        sessionId: 'session-rebound',
        projectName: 'home',
        currentStatus: 'IDLE',
        lastEventAt: baseTime + 1_000,
        sessionStartAt: baseTime,
        cwd: homeCwd,
      }],
      recentEvents: [{
        eventId: 'event-rebound-user',
        source: 'CODEX',
        sessionId: 'session-rebound',
        timestamp: baseTime + 500,
        eventType: 'USER_PROMPT',
        derivedStatus: 'THINKING',
        lastMessage: 'binding test',
      }],
    }));

    await useAgentChatStore.getState().refresh();
    expect(useAgentChatStore.getState().events.find((event) => event.kind === 'user_message')).toEqual(
      expect.objectContaining({ ptySessionId: 'shelly-1' }),
    );

    mockGetScouterDebugInfo.mockResolvedValueOnce(JSON.stringify({
      enabled: true,
      jsonlWatcherRunning: true,
      sessions: [{
        source: 'CODEX',
        sessionId: 'session-rebound',
        projectName: 'project',
        currentStatus: 'IDLE',
        lastEventAt: baseTime + 2_000,
        sessionStartAt: baseTime,
        cwd: '/data/data/dev.shelly.terminal/files/project',
      }],
      recentEvents: [],
    }));

    await useAgentChatStore.getState().refresh();

    expect(useAgentChatStore.getState().sessions).toEqual([
      expect.objectContaining({ codexSessionId: 'session-rebound', bindingConfidence: 'none' }),
    ]);
    expect(useAgentChatStore.getState().events.find((event) => event.kind === 'user_message')).toEqual(
      expect.objectContaining({ ptySessionId: undefined }),
    );
  });

  it('does not keep a reliable binding after its PTY launch candidate disappears', async () => {
    const baseTime = 1_811_119_000_000;
    const cwd = '/data/data/dev.shelly.terminal/files/home';

    useAgentChatStore.getState().recordCodexPtyCandidate({
      ptySessionId: 'shelly-1',
      shellySessionId: 'session-1',
      cwd,
      startedAt: baseTime,
      lastSeenAt: baseTime,
    });

    mockGetScouterDebugInfo.mockResolvedValue(JSON.stringify({
      enabled: true,
      jsonlWatcherRunning: true,
      sessions: [{
        source: 'CODEX',
        sessionId: 'session-stale',
        projectName: 'home',
        currentStatus: 'IDLE',
        lastEventAt: baseTime + 500,
        sessionStartAt: baseTime,
        cwd,
      }],
      recentEvents: [],
    }));

    await useAgentChatStore.getState().refresh();
    expect(useAgentChatStore.getState().sessions[0]).toEqual(
      expect.objectContaining({ bindingConfidence: 'reliable', ptySessionId: 'shelly-1' }),
    );

    useAgentChatStore.setState({ codexPtyLaunches: [] });
    await useAgentChatStore.getState().refresh();

    expect(useAgentChatStore.getState().sessions[0]).toEqual(
      expect.objectContaining({ bindingConfidence: 'none', ptySessionId: null }),
    );
  });

  it('uses a PTY launch for only one reliable Codex session', async () => {
    const baseTime = 1_811_120_000_000;
    const cwd = '/data/data/dev.shelly.terminal/files/home';

    useAgentChatStore.getState().recordCodexPtyCandidate({
      ptySessionId: 'shelly-1',
      shellySessionId: 'session-1',
      cwd,
      startedAt: baseTime,
      lastSeenAt: baseTime + 3_000,
    });

    mockGetScouterDebugInfo.mockResolvedValue(JSON.stringify({
      enabled: true,
      jsonlWatcherRunning: true,
      sessions: [{
        source: 'CODEX',
        sessionId: 'session-newer',
        projectName: 'home',
        currentStatus: 'IDLE',
        lastEventAt: baseTime + 2_000,
        sessionStartAt: baseTime + 1_000,
        cwd,
      }, {
        source: 'CODEX',
        sessionId: 'session-older',
        projectName: 'home',
        currentStatus: 'IDLE',
        lastEventAt: baseTime + 1_000,
        sessionStartAt: baseTime,
        cwd,
      }],
      recentEvents: [],
    }));

    await useAgentChatStore.getState().refresh();

    expect(useAgentChatStore.getState().sessions).toEqual([
      expect.objectContaining({ codexSessionId: 'session-newer', bindingConfidence: 'reliable', ptySessionId: 'shelly-1' }),
      expect.objectContaining({ codexSessionId: 'session-older', bindingConfidence: 'none', ptySessionId: null }),
    ]);
  });

  it('reliably binds an old resumed Codex session to the targeted PTY', async () => {
    const baseTime = 1_811_120_250_000;
    const cwd = '/data/data/dev.shelly.terminal/files/home';
    const rawSessionId = 'rollout-2026-06-03T11-42-51-019e8b5c-bc3f-7582-88f6-e8a26ba24d66';
    const normalizedSessionId = '019e8b5c-bc3f-7582-88f6-e8a26ba24d66';

    mockGetScouterDebugInfo.mockResolvedValue(JSON.stringify({
      enabled: true,
      jsonlWatcherRunning: true,
      sessions: [{
        source: 'CODEX',
        sessionId: rawSessionId,
        projectName: 'home',
        currentStatus: 'IDLE',
        lastEventAt: baseTime,
        sessionStartAt: baseTime,
        cwd,
      }],
      recentEvents: [{
        eventId: 'event-resumed-user',
        source: 'CODEX',
        sessionId: rawSessionId,
        timestamp: baseTime + 1_000,
        eventType: 'USER_PROMPT',
        derivedStatus: 'THINKING',
        lastMessage: 'こんにちは',
      }],
    }));

    await useAgentChatStore.getState().refresh();
    expect(useAgentChatStore.getState().sessions[0]).toEqual(
      expect.objectContaining({ bindingConfidence: 'none', ptySessionId: null }),
    );

    useAgentChatStore.getState().bindCodexSessionToPty(normalizedSessionId, {
      ptySessionId: 'shelly-resume',
      shellySessionId: 'terminal-resume',
      cwd,
      startedAt: baseTime + 2 * 60 * 60_000,
      lastSeenAt: baseTime + 2 * 60 * 60_000,
    });

    expect(useAgentChatStore.getState().sessions[0]).toEqual(
      expect.objectContaining({
        codexSessionId: rawSessionId,
        bindingConfidence: 'reliable',
        ptySessionId: 'shelly-resume',
        shellySessionId: 'terminal-resume',
      }),
    );
    expect(useAgentChatStore.getState().bindings[rawSessionId]).toEqual(
      expect.objectContaining({ confidence: 'reliable', reason: 'resume' }),
    );
    expect(useAgentChatStore.getState().events.find((event) => event.kind === 'user_message')).toEqual(
      expect.objectContaining({ ptySessionId: 'shelly-resume' }),
    );

    mockGetScouterDebugInfo.mockResolvedValue(JSON.stringify({
      enabled: true,
      jsonlWatcherRunning: true,
      sessions: [{
        source: 'CODEX',
        sessionId: 'session-newer-same-cwd',
        projectName: 'home',
        currentStatus: 'IDLE',
        lastEventAt: baseTime + 2 * 60 * 60_000 + 500,
        sessionStartAt: baseTime + 2 * 60 * 60_000,
        cwd,
      }, {
        source: 'CODEX',
        sessionId: normalizedSessionId,
        projectName: 'home',
        currentStatus: 'IDLE',
        lastEventAt: baseTime,
        sessionStartAt: baseTime,
        cwd,
      }],
      recentEvents: [],
    }));

    await useAgentChatStore.getState().refresh();
    expect(useAgentChatStore.getState().sessions[0]).toEqual(
      expect.objectContaining({
        codexSessionId: 'session-newer-same-cwd',
        bindingConfidence: 'none',
        ptySessionId: null,
      }),
    );
    expect(useAgentChatStore.getState().sessions[1]).toEqual(
      expect.objectContaining({
        codexSessionId: normalizedSessionId,
        bindingConfidence: 'reliable',
        ptySessionId: 'shelly-resume',
        shellySessionId: 'terminal-resume',
      }),
    );
    expect(useAgentChatStore.getState().bindings[normalizedSessionId]).toEqual(
      expect.objectContaining({ confidence: 'reliable', reason: 'resume' }),
    );
    expect(useAgentChatStore.getState().events.find((event) => event.kind === 'user_message')).toEqual(
      expect.objectContaining({
        codexSessionId: normalizedSessionId,
        text: 'こんにちは',
        ptySessionId: 'shelly-resume',
      }),
    );

    const stateWithResumeBinding = useAgentChatStore.getState();
    useAgentChatStore.setState({
      bindings: {
        ...stateWithResumeBinding.bindings,
        [normalizedSessionId]: {
          ...stateWithResumeBinding.bindings[normalizedSessionId],
          matchedAt: Date.now() - 10 * 60_000,
        },
      },
    });
    await useAgentChatStore.getState().refresh();
    expect(useAgentChatStore.getState().sessions[0]).toEqual(
      expect.objectContaining({
        codexSessionId: 'session-newer-same-cwd',
        bindingConfidence: 'reliable',
        ptySessionId: 'shelly-resume',
      }),
    );
    expect(useAgentChatStore.getState().sessions[1]).toEqual(
      expect.objectContaining({
        codexSessionId: normalizedSessionId,
        bindingConfidence: 'none',
        ptySessionId: null,
      }),
    );
  });

  it('keeps a fresh resumed Codex binding when the terminal cwd snapshot was stale', async () => {
    const baseTime = 1_811_120_350_000;
    const cwd = '/data/data/dev.shelly.terminal/files/home';
    const staleTerminalCwd = '/data/data/dev.shelly.terminal/files/stale';
    const rawSessionId = 'rollout-2026-06-03T12-00-00-029e8b5c-bc3f-7582-88f6-e8a26ba24d66';
    const normalizedSessionId = '029e8b5c-bc3f-7582-88f6-e8a26ba24d66';

    mockGetScouterDebugInfo.mockResolvedValue(JSON.stringify({
      enabled: true,
      jsonlWatcherRunning: true,
      sessions: [{
        source: 'CODEX',
        sessionId: rawSessionId,
        projectName: 'home',
        currentStatus: 'IDLE',
        lastEventAt: baseTime,
        sessionStartAt: baseTime,
      }],
      recentEvents: [],
    }));

    await useAgentChatStore.getState().refresh();
    useAgentChatStore.getState().bindCodexSessionToPty(normalizedSessionId, {
      ptySessionId: 'shelly-resume-stale-cwd',
      shellySessionId: 'terminal-resume-stale-cwd',
      cwd: staleTerminalCwd,
      startedAt: baseTime + 30_000,
      lastSeenAt: baseTime + 30_000,
    });

    mockGetScouterDebugInfo.mockResolvedValue(JSON.stringify({
      enabled: true,
      jsonlWatcherRunning: true,
      sessions: [{
        source: 'CODEX',
        sessionId: rawSessionId,
        projectName: 'home',
        currentStatus: 'IDLE',
        lastEventAt: baseTime,
        sessionStartAt: baseTime,
        cwd,
      }],
      recentEvents: [],
    }));

    await useAgentChatStore.getState().refresh();
    expect(useAgentChatStore.getState().sessions[0]).toEqual(
      expect.objectContaining({
        bindingConfidence: 'reliable',
        ptySessionId: 'shelly-resume-stale-cwd',
        shellySessionId: 'terminal-resume-stale-cwd',
        cwd,
      }),
    );
    expect(useAgentChatStore.getState().bindings[rawSessionId]).toEqual(
      expect.objectContaining({ confidence: 'reliable', reason: 'resume', cwd }),
    );
    expect(useAgentChatStore.getState().codexPtyLaunches[0]).toEqual(
      expect.objectContaining({ ptySessionId: 'shelly-resume-stale-cwd', cwd }),
    );

    mockGetScouterDebugInfo.mockResolvedValue(JSON.stringify({
      enabled: true,
      jsonlWatcherRunning: true,
      sessions: [{
        source: 'CODEX',
        sessionId: 'session-newer-after-stale-cwd',
        projectName: 'home',
        currentStatus: 'IDLE',
        lastEventAt: baseTime + 30_500,
        sessionStartAt: baseTime + 30_000,
        cwd,
      }, {
        source: 'CODEX',
        sessionId: rawSessionId,
        projectName: 'home',
        currentStatus: 'IDLE',
        lastEventAt: baseTime,
        sessionStartAt: baseTime,
        cwd,
      }],
      recentEvents: [],
    }));
    const stateWithResumeBinding = useAgentChatStore.getState();
    useAgentChatStore.setState({
      bindings: {
        ...stateWithResumeBinding.bindings,
        [rawSessionId]: {
          ...stateWithResumeBinding.bindings[rawSessionId],
          matchedAt: Date.now() - 10 * 60_000,
        },
      },
    });

    await useAgentChatStore.getState().refresh();
    expect(useAgentChatStore.getState().sessions[0]).toEqual(
      expect.objectContaining({
        codexSessionId: 'session-newer-after-stale-cwd',
        bindingConfidence: 'reliable',
        ptySessionId: 'shelly-resume-stale-cwd',
      }),
    );
    expect(useAgentChatStore.getState().sessions[1]).toEqual(
      expect.objectContaining({
        codexSessionId: rawSessionId,
        bindingConfidence: 'none',
        ptySessionId: null,
      }),
    );
  });

  it('renames Codex sessions and keeps the title across refresh', async () => {
    const baseTime = 1_811_120_500_000;
    mockGetScouterDebugInfo.mockResolvedValueOnce(JSON.stringify({
      enabled: true,
      jsonlWatcherRunning: true,
      sessions: [{
        source: 'CODEX',
        sessionId: 'rollout-2026-06-03T11-42-51-019e8b5c-bc3f-7582-88f6-e8a26ba24d66',
        projectName: 'home',
        currentStatus: 'IDLE',
        lastEventAt: baseTime,
        sessionStartAt: baseTime,
        modelName: 'gpt-5.5',
      }],
      recentEvents: [],
    }));

    await useAgentChatStore.getState().refresh();
    useAgentChatStore.getState().renameSession(
      'rollout-2026-06-03T11-42-51-019e8b5c-bc3f-7582-88f6-e8a26ba24d66',
      'Shelly Dev',
    );

    expect(useAgentChatStore.getState().sessions[0]).toEqual(
      expect.objectContaining({ projectName: 'Shelly Dev' }),
    );
    expect(mockAsyncStorageSetItem).toHaveBeenCalledWith(
      'shelly_agent_chat_session_titles',
      JSON.stringify({ '019e8b5c-bc3f-7582-88f6-e8a26ba24d66': 'Shelly Dev' }),
    );

    mockGetScouterDebugInfo.mockResolvedValueOnce(JSON.stringify({
      enabled: true,
      jsonlWatcherRunning: true,
      sessions: [{
        source: 'CODEX',
        sessionId: '019e8b5c-bc3f-7582-88f6-e8a26ba24d66',
        projectName: 'home',
        currentStatus: 'IDLE',
        lastEventAt: baseTime + 1_000,
        sessionStartAt: baseTime,
        modelName: 'gpt-5.5',
      }],
      recentEvents: [],
    }));

    await useAgentChatStore.getState().refresh();

    expect(useAgentChatStore.getState().sessions[0]).toEqual(
      expect.objectContaining({ projectName: 'Shelly Dev' }),
    );
  });

  it('dismisses Codex sessions and keeps them hidden across refresh and live events', async () => {
    const baseTime = 1_811_121_000_000;
    mockGetScouterDebugInfo.mockResolvedValue(JSON.stringify({
      enabled: true,
      jsonlWatcherRunning: true,
      sessions: [{
        source: 'CODEX',
        sessionId: 'session-hide',
        projectName: 'hidden',
        currentStatus: 'IDLE',
        lastEventAt: baseTime + 2_000,
        sessionStartAt: baseTime,
      }, {
        source: 'CODEX',
        sessionId: 'session-keep',
        projectName: 'home',
        currentStatus: 'IDLE',
        lastEventAt: baseTime + 1_000,
        sessionStartAt: baseTime,
      }],
      recentEvents: [{
        eventId: 'event-hide',
        source: 'CODEX',
        sessionId: 'session-hide',
        timestamp: baseTime + 2_000,
        eventType: 'USER_PROMPT',
        derivedStatus: 'THINKING',
        lastMessage: 'hide me',
      }, {
        eventId: 'event-keep',
        source: 'CODEX',
        sessionId: 'session-keep',
        timestamp: baseTime + 1_000,
        eventType: 'USER_PROMPT',
        derivedStatus: 'THINKING',
        lastMessage: 'keep me',
      }],
    }));

    await useAgentChatStore.getState().refresh();
    useAgentChatStore.getState().dismissSession('session-hide');

    expect(useAgentChatStore.getState().sessions.map((session) => session.codexSessionId)).toEqual(['session-keep']);
    expect(useAgentChatStore.getState().events.every((event) => event.codexSessionId === 'session-keep')).toBe(true);
    expect(useAgentChatStore.getState().latestSessionId).toBe('session-keep');
    expect(mockAsyncStorageSetItem).toHaveBeenCalledWith(
      'shelly_agent_chat_dismissed_sessions',
      JSON.stringify(['session-hide']),
    );

    await useAgentChatStore.getState().refresh();
    useAgentChatStore.getState().ingestNativeEvent({
      emittedAt: baseTime + 3_000,
      snapshotJson: JSON.stringify({
        source: 'CODEX',
        sessionId: 'session-hide',
        projectName: 'hidden',
        currentStatus: 'THINKING',
        lastEventAt: baseTime + 3_000,
        sessionStartAt: baseTime,
      }),
      eventJson: JSON.stringify({
        eventId: 'event-hide-live',
        source: 'CODEX',
        sessionId: 'session-hide',
        timestamp: baseTime + 3_000,
        eventType: 'USER_PROMPT',
        derivedStatus: 'THINKING',
        lastMessage: 'still hidden',
      }),
    });

    expect(useAgentChatStore.getState().sessions.map((session) => session.codexSessionId)).toEqual(['session-keep']);
    expect(useAgentChatStore.getState().events.every((event) => event.codexSessionId === 'session-keep')).toBe(true);
  });

  it('keeps rollout filename session dismissals hidden after Scouter normalizes to UUID', async () => {
    const baseTime = 1_811_122_000_000;
    const rolloutSessionId = 'rollout-2026-06-03T11-42-51-019e8b5c-bc3f-7582-88f6-e8a26ba24d66';
    const uuidSessionId = '019e8b5c-bc3f-7582-88f6-e8a26ba24d66';
    mockGetScouterDebugInfo.mockResolvedValueOnce(JSON.stringify({
      enabled: true,
      jsonlWatcherRunning: true,
      sessions: [{
        source: 'CODEX',
        sessionId: rolloutSessionId,
        projectName: 'home',
        currentStatus: 'IDLE',
        lastEventAt: baseTime,
        sessionStartAt: baseTime,
      }],
      recentEvents: [{
        eventId: 'event-rollout',
        source: 'CODEX',
        sessionId: rolloutSessionId,
        timestamp: baseTime,
        eventType: 'USER_PROMPT',
        derivedStatus: 'THINKING',
        lastMessage: 'old id',
      }],
    }));

    await useAgentChatStore.getState().refresh();
    useAgentChatStore.getState().dismissSession(rolloutSessionId);

    expect(useAgentChatStore.getState().dismissedSessionIds).toEqual([uuidSessionId]);
    expect(useAgentChatStore.getState().sessions).toEqual([]);
    expect(useAgentChatStore.getState().events).toEqual([]);

    mockGetScouterDebugInfo.mockResolvedValueOnce(JSON.stringify({
      enabled: true,
      jsonlWatcherRunning: true,
      sessions: [{
        source: 'CODEX',
        sessionId: uuidSessionId,
        projectName: 'home',
        currentStatus: 'IDLE',
        lastEventAt: baseTime + 1_000,
        sessionStartAt: baseTime,
      }],
      recentEvents: [{
        eventId: 'event-uuid',
        source: 'CODEX',
        sessionId: uuidSessionId,
        timestamp: baseTime + 1_000,
        eventType: 'USER_PROMPT',
        derivedStatus: 'THINKING',
        lastMessage: 'new id',
      }],
    }));

    await useAgentChatStore.getState().refresh();

    expect(useAgentChatStore.getState().sessions).toEqual([]);
    expect(useAgentChatStore.getState().events).toEqual([]);
  });
});
