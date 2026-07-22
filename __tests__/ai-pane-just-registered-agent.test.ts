// store/ai-pane-store.ts imports @react-native-async-storage/async-storage —
// mocked exactly like __tests__/ai-pane-pending-session.test.ts does so this
// file can run in the plain "unit" ts-jest project without an RN transform.
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

import { useAIPaneStore, type JustRegisteredAgentRef } from '@/store/ai-pane-store';
import type { ParsedAgentDraft } from '@/lib/agent-nl-parser';

function baseDraft(overrides: Partial<ParsedAgentDraft> = {}): ParsedAgentDraft {
  return {
    name: 'Daily digest',
    prompt: 'Summarize today',
    schedule: '0 9 * * *',
    scheduleConfident: true,
    scheduleLabel: 'Daily at 09:00',
    action: { type: 'draft' },
    tool: { type: 'local' },
    toolLabel: 'Local LLM',
    rawText: 'Every day at 9, summarize today',
    ...overrides,
  };
}

function ref(overrides: Partial<JustRegisteredAgentRef> = {}): JustRegisteredAgentRef {
  return {
    agentId: 'agent-1',
    agentName: 'Daily digest',
    draftSnapshot: baseDraft(),
    messageId: 'msg-1',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('ai-pane-store — justRegisteredAgent (correction-window reference)', () => {
  const paneId = 'pane-test-just-registered';

  beforeEach(() => {
    mockAsyncStorageValues.clear();
    useAIPaneStore.setState({ conversations: {}, isLoaded: true });
  });

  it('a fresh pane has no justRegisteredAgent', () => {
    const conv = useAIPaneStore.getState().getOrCreate(paneId);
    expect(conv.justRegisteredAgent).toBeUndefined();
  });

  it('setJustRegisteredAgent stores the reference on the pane, readable via getOrCreate', () => {
    const r = ref();
    useAIPaneStore.getState().setJustRegisteredAgent(paneId, r);
    expect(useAIPaneStore.getState().getOrCreate(paneId).justRegisteredAgent).toEqual(r);
  });

  it('setJustRegisteredAgent(paneId, null) clears it', () => {
    useAIPaneStore.getState().setJustRegisteredAgent(paneId, ref());
    useAIPaneStore.getState().setJustRegisteredAgent(paneId, null);
    expect(useAIPaneStore.getState().getOrCreate(paneId).justRegisteredAgent).toBeNull();
  });

  it("does not disturb a DIFFERENT pane's reference", () => {
    const paneA = 'pane-a';
    const paneB = 'pane-b';
    useAIPaneStore.getState().setJustRegisteredAgent(paneA, ref({ agentId: 'a' }));
    useAIPaneStore.getState().setJustRegisteredAgent(paneB, ref({ agentId: 'b' }));
    useAIPaneStore.getState().setJustRegisteredAgent(paneA, null);
    expect(useAIPaneStore.getState().getOrCreate(paneA).justRegisteredAgent).toBeNull();
    expect(useAIPaneStore.getState().getOrCreate(paneB).justRegisteredAgent?.agentId).toBe('b');
  });

  it('does not disturb the rest of the conversation (messages, isStreaming, pendingAgentSession) when set/cleared', () => {
    useAIPaneStore.getState().addMessage(paneId, {
      id: 'm1',
      role: 'user',
      content: 'hello',
      timestamp: Date.now(),
    });
    useAIPaneStore.getState().setStreaming(paneId, true);
    useAIPaneStore.getState().setJustRegisteredAgent(paneId, ref());
    const conv = useAIPaneStore.getState().getOrCreate(paneId);
    expect(conv.messages).toHaveLength(1);
    expect(conv.isStreaming).toBe(true);
    expect(conv.justRegisteredAgent).toBeDefined();
    expect(conv.pendingAgentSession).toBeUndefined();
  });

  it('a follow-up correction can refresh the reference in place (extends the window, updates the snapshot)', () => {
    const first = ref({ createdAt: 1000 });
    useAIPaneStore.getState().setJustRegisteredAgent(paneId, first);
    const patchedDraft = baseDraft({ schedule: '0 20 * * *', scheduleLabel: 'Daily at 20:00' });
    useAIPaneStore.getState().setJustRegisteredAgent(paneId, {
      ...first,
      draftSnapshot: patchedDraft,
      createdAt: 2000,
    });
    const conv = useAIPaneStore.getState().getOrCreate(paneId);
    expect(conv.justRegisteredAgent?.createdAt).toBe(2000);
    expect(conv.justRegisteredAgent?.draftSnapshot.schedule).toBe('0 20 * * *');
  });
});
