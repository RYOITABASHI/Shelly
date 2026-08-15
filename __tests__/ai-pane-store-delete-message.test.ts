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
