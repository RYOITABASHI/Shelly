const mockGetScouterDebugInfo = jest.fn();
const mockAddListener = jest.fn();

jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: {
    getScouterDebugInfo: mockGetScouterDebugInfo,
    addListener: mockAddListener,
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
    latestSessionId: null,
    loading: false,
    error: null,
    lastUpdatedAt: null,
  });
}

describe('agent chat store', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAddListener.mockReturnValue({ remove: jest.fn() });
    resetAgentChatStore();
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
});
