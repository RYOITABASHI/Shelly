import {
  COMPANION_CONVERSATION_KEY,
  resolveAiPaneStoreKey,
  useAIPaneStore,
} from '@/store/ai-pane-store';
import { usePaneStore } from '@/store/pane-store';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  useAIPaneStore.setState({ conversations: {}, isLoaded: true });
  usePaneStore.setState({ paneAgents: {} } as any);
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

it('deletes only the targeted message from the shared companion thread', () => {
  usePaneStore.setState({ paneAgents: { left: 'local', right: 'local' } } as any);
  const conversationKey = resolveAiPaneStoreKey('left');
  expect(conversationKey).toBe(COMPANION_CONVERSATION_KEY);

  useAIPaneStore.getState().addMessage(conversationKey, {
    id: 'keep-user', role: 'user', content: 'keep me', timestamp: 1,
  });
  useAIPaneStore.getState().addMessage(conversationKey, {
    id: 'delete-assistant', role: 'assistant', content: 'delete me', timestamp: 2,
  });
  useAIPaneStore.getState().addMessage(conversationKey, {
    id: 'keep-assistant', role: 'assistant', content: 'keep me too', timestamp: 3,
  });

  useAIPaneStore.getState().deleteMessage(conversationKey, 'delete-assistant');

  expect(useAIPaneStore.getState().getOrCreate(resolveAiPaneStoreKey('right')).messages)
    .toEqual([
      expect.objectContaining({ id: 'keep-user', content: 'keep me' }),
      expect.objectContaining({ id: 'keep-assistant', content: 'keep me too' }),
    ]);
});

it('deletes only the targeted message from a pane-private thread', () => {
  const paneId = 'provider-pane';
  usePaneStore.setState({ paneAgents: { [paneId]: 'gemini' } } as any);
  const conversationKey = resolveAiPaneStoreKey(paneId);
  expect(conversationKey).toBe(paneId);

  useAIPaneStore.getState().addMessage(conversationKey, {
    id: 'keep-user', role: 'user', content: 'private keep', timestamp: 1,
  });
  useAIPaneStore.getState().addMessage(conversationKey, {
    id: 'delete-assistant', role: 'assistant', content: 'private delete', timestamp: 2,
  });
  useAIPaneStore.getState().addMessage(conversationKey, {
    id: 'keep-system', role: 'system', content: 'private notice', timestamp: 3,
  });

  useAIPaneStore.getState().deleteMessage(conversationKey, 'delete-assistant');

  expect(useAIPaneStore.getState().getOrCreate(conversationKey).messages)
    .toEqual([
      expect.objectContaining({ id: 'keep-user', content: 'private keep' }),
      expect.objectContaining({ id: 'keep-system', content: 'private notice' }),
    ]);
  expect(useAIPaneStore.getState().conversations[COMPANION_CONVERSATION_KEY]).toBeUndefined();
});

it('clears the shared companion thread without touching a pane-private thread', () => {
  useAIPaneStore.getState().addMessage(COMPANION_CONVERSATION_KEY, {
    id: 'shared', role: 'user', content: 'shared message', timestamp: 1,
  });
  useAIPaneStore.getState().addMessage('provider-pane', {
    id: 'private', role: 'assistant', content: 'private message', timestamp: 2,
  });

  useAIPaneStore.getState().clearConversation(COMPANION_CONVERSATION_KEY);

  expect(useAIPaneStore.getState().conversations[COMPANION_CONVERSATION_KEY].messages).toEqual([]);
  expect(useAIPaneStore.getState().conversations['provider-pane'].messages)
    .toEqual([expect.objectContaining({ id: 'private' })]);
});

it('clears a pane-private thread without touching the shared companion thread', () => {
  useAIPaneStore.getState().addMessage(COMPANION_CONVERSATION_KEY, {
    id: 'shared', role: 'user', content: 'shared message', timestamp: 1,
  });
  useAIPaneStore.getState().addMessage('provider-pane', {
    id: 'private', role: 'assistant', content: 'private message', timestamp: 2,
  });

  useAIPaneStore.getState().clearConversation('provider-pane');

  expect(useAIPaneStore.getState().conversations['provider-pane'].messages).toEqual([]);
  expect(useAIPaneStore.getState().conversations[COMPANION_CONVERSATION_KEY].messages)
    .toEqual([expect.objectContaining({ id: 'shared' })]);
});

// 2026-08-24 on-device finding: clearConversation only reset `messages`,
// leaving pendingAgentSession/justRegisteredAgent pointing at a messageId
// that no longer existed. A later message got silently absorbed by the
// stale pending-draft reply handler instead of reaching the LLM, and typing
// "cancel" tried to updateMessage() the deleted bubble — a no-op, so the
// user saw no response at all and the app looked unresponsive.
it('clearConversation also drops pendingAgentSession and justRegisteredAgent (2026-08-24)', () => {
  const draft = { name: 'weather', prompt: 'check weather', rawText: 'check weather', tool: { type: 'local' as const } };
  useAIPaneStore.getState().addMessage(COMPANION_CONVERSATION_KEY, {
    id: 'draft-bubble', role: 'assistant', content: 'draft', timestamp: 1, agentDraft: draft as any,
  });
  useAIPaneStore.getState().setPendingAgentSession(COMPANION_CONVERSATION_KEY, {
    draft: draft as any,
    phase: 'await-confirm',
    attemptCounts: {},
    hasAssumptions: false,
    createdAt: Date.now(),
    messageId: 'draft-bubble',
  });
  useAIPaneStore.getState().setJustRegisteredAgent(COMPANION_CONVERSATION_KEY, {
    agentId: 'agent-1', agentName: 'weather', draftSnapshot: draft as any, messageId: 'draft-bubble', createdAt: Date.now(),
  });

  useAIPaneStore.getState().clearConversation(COMPANION_CONVERSATION_KEY);

  const conv = useAIPaneStore.getState().conversations[COMPANION_CONVERSATION_KEY];
  expect(conv.messages).toEqual([]);
  expect(conv.pendingAgentSession).toBeNull();
  expect(conv.justRegisteredAgent).toBeNull();
});

it('deleteMessage drops pendingAgentSession/justRegisteredAgent only when it targets that exact message', () => {
  const draft = { name: 'weather', prompt: 'check weather', rawText: 'check weather', tool: { type: 'local' as const } };
  useAIPaneStore.getState().addMessage(COMPANION_CONVERSATION_KEY, {
    id: 'draft-bubble', role: 'assistant', content: 'draft', timestamp: 1, agentDraft: draft as any,
  });
  useAIPaneStore.getState().addMessage(COMPANION_CONVERSATION_KEY, {
    id: 'unrelated', role: 'assistant', content: 'unrelated', timestamp: 2,
  });
  useAIPaneStore.getState().setPendingAgentSession(COMPANION_CONVERSATION_KEY, {
    draft: draft as any,
    phase: 'await-confirm',
    attemptCounts: {},
    hasAssumptions: false,
    createdAt: Date.now(),
    messageId: 'draft-bubble',
  });

  // Deleting an unrelated message must leave the pending session intact.
  useAIPaneStore.getState().deleteMessage(COMPANION_CONVERSATION_KEY, 'unrelated');
  expect(useAIPaneStore.getState().conversations[COMPANION_CONVERSATION_KEY].pendingAgentSession).not.toBeNull();

  // Deleting the draft bubble itself must drop the dangling reference.
  useAIPaneStore.getState().deleteMessage(COMPANION_CONVERSATION_KEY, 'draft-bubble');
  expect(useAIPaneStore.getState().conversations[COMPANION_CONVERSATION_KEY].pendingAgentSession).toBeNull();
});

it('updateMessage reports false on a no-op (message not found) instead of only logging', () => {
  useAIPaneStore.getState().addMessage(COMPANION_CONVERSATION_KEY, {
    id: 'exists', role: 'assistant', content: 'x', timestamp: 1,
  });
  expect(useAIPaneStore.getState().updateMessage(COMPANION_CONVERSATION_KEY, 'exists', { content: 'y' })).toBe(true);
  expect(useAIPaneStore.getState().updateMessage(COMPANION_CONVERSATION_KEY, 'does-not-exist', { content: 'y' })).toBe(false);
});
