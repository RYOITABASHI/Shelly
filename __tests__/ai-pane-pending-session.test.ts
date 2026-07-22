// store/ai-pane-store.ts imports @react-native-async-storage/async-storage —
// mocked exactly like __tests__/agent-chat-store.test.ts does so this file
// can run in the plain "unit" ts-jest project without an RN transform.
const mockAsyncStorageValues = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn((key: string) => Promise.resolve(mockAsyncStorageValues.get(key) ?? null)),
    setItem: jest.fn((key: string, value: string) => {
      mockAsyncStorageValues.set(key, value);
      return Promise.resolve();
    }),
  },
}));

import { useAIPaneStore, type PendingAgentSession } from '@/store/ai-pane-store';
import type { ParsedAgentDraft } from '@/lib/agent-nl-parser';

function baseDraft(overrides: Partial<ParsedAgentDraft> = {}): ParsedAgentDraft {
  return {
    name: 'Daily digest',
    prompt: 'Summarize today',
    schedule: '0 8 * * *',
    scheduleConfident: true,
    scheduleLabel: 'Daily at 08:00',
    action: { type: 'draft' },
    tool: { type: 'local' },
    toolLabel: 'Local LLM',
    rawText: 'Every day at 8, summarize today',
    ...overrides,
  };
}

function session(overrides: Partial<PendingAgentSession> = {}): PendingAgentSession {
  return {
    draft: baseDraft(),
    phase: 'await-confirm',
    attemptCounts: {},
    hasAssumptions: false,
    createdAt: Date.now(),
    messageId: 'msg-1',
    ...overrides,
  };
}

describe('ai-pane-store — pendingAgentSession (Phase A, session-scoped confirm state)', () => {
  const paneId = 'pane-test-pending';

  beforeEach(() => {
    mockAsyncStorageValues.clear();
    useAIPaneStore.setState({ conversations: {}, isLoaded: true });
  });

  it('a fresh pane has no pendingAgentSession', () => {
    const conv = useAIPaneStore.getState().getOrCreate(paneId);
    expect(conv.pendingAgentSession).toBeUndefined();
  });

  it('setPendingAgentSession stores the session on the pane, readable via getOrCreate', () => {
    const s = session();
    useAIPaneStore.getState().setPendingAgentSession(paneId, s);
    expect(useAIPaneStore.getState().getOrCreate(paneId).pendingAgentSession).toEqual(s);
  });

  it('setPendingAgentSession(paneId, null) clears it', () => {
    useAIPaneStore.getState().setPendingAgentSession(paneId, session());
    useAIPaneStore.getState().setPendingAgentSession(paneId, null);
    expect(useAIPaneStore.getState().getOrCreate(paneId).pendingAgentSession).toBeNull();
  });

  it('does not disturb a DIFFERENT pane\'s pending session', () => {
    const paneA = 'pane-a';
    const paneB = 'pane-b';
    useAIPaneStore.getState().setPendingAgentSession(paneA, session({ messageId: 'a' }));
    useAIPaneStore.getState().setPendingAgentSession(paneB, session({ messageId: 'b' }));
    useAIPaneStore.getState().setPendingAgentSession(paneA, null);
    expect(useAIPaneStore.getState().getOrCreate(paneA).pendingAgentSession).toBeNull();
    expect(useAIPaneStore.getState().getOrCreate(paneB).pendingAgentSession?.messageId).toBe('b');
  });

  it('does not disturb the rest of the conversation (messages, isStreaming) when set/cleared', () => {
    useAIPaneStore.getState().addMessage(paneId, {
      id: 'm1',
      role: 'user',
      content: 'hello',
      timestamp: Date.now(),
    });
    useAIPaneStore.getState().setStreaming(paneId, true);
    useAIPaneStore.getState().setPendingAgentSession(paneId, session());
    const conv = useAIPaneStore.getState().getOrCreate(paneId);
    expect(conv.messages).toHaveLength(1);
    expect(conv.isStreaming).toBe(true);
    expect(conv.pendingAgentSession).toBeDefined();
  });

  it('carries hasAssumptions through unchanged (snapshot, not re-derived)', () => {
    useAIPaneStore.getState().setPendingAgentSession(paneId, session({ hasAssumptions: true }));
    expect(useAIPaneStore.getState().getOrCreate(paneId).pendingAgentSession?.hasAssumptions).toBe(true);
  });
});
