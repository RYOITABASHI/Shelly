import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  addAiPaneThreadSwitchNotice,
  COMPANION_CONVERSATION_KEY,
  resolveAiPaneStoreKey,
  useAIPaneStore,
} from '@/store/ai-pane-store';
import { usePaneStore } from '@/store/pane-store';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

beforeEach(() => {
  jest.clearAllMocks();
  useAIPaneStore.setState({ conversations: {}, isLoaded: true });
  usePaneStore.setState({ paneAgents: {} } as any);
});

it('shares one persistent conversation across local Shelly panes', () => {
  usePaneStore.setState({ paneAgents: { left: 'local', right: 'local' } } as any);
  const leftKey = resolveAiPaneStoreKey('left');
  const rightKey = resolveAiPaneStoreKey('right');

  expect(leftKey).toBe(COMPANION_CONVERSATION_KEY);
  expect(rightKey).toBe(COMPANION_CONVERSATION_KEY);
  useAIPaneStore.getState().addMessage(leftKey, {
    id: 'shared-message', role: 'user', content: 'hello Shelly', timestamp: 1,
  });
  expect(useAIPaneStore.getState().getOrCreate(rightKey).messages[0].content).toBe('hello Shelly');
  expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(
    expect.anything(),
    expect.stringContaining('"left"'),
  );
});

it('keeps explicitly bound provider panes independent', () => {
  usePaneStore.setState({ paneAgents: { left: 'gemini', right: 'codex' } } as any);
  const leftKey = resolveAiPaneStoreKey('left');
  const rightKey = resolveAiPaneStoreKey('right');

  expect(leftKey).toBe('left');
  expect(rightKey).toBe('right');
  useAIPaneStore.getState().addMessage(leftKey, {
    id: 'gemini-message', role: 'user', content: 'gemini only', timestamp: 1,
  });
  expect(useAIPaneStore.getState().getOrCreate(rightKey).messages).toEqual([]);
});

it('switches a rebound pane to its private thread and posts the switch notice there', () => {
  const paneId = 'pane-rebound';
  const companionKey = resolveAiPaneStoreKey(paneId);
  expect(companionKey).toBe(COMPANION_CONVERSATION_KEY);

  usePaneStore.getState().bindAgent(paneId, 'gemini');
  const providerKey = resolveAiPaneStoreKey(paneId);
  addAiPaneThreadSwitchNotice(companionKey, providerKey, (key) => key);

  expect(usePaneStore.getState().paneAgents[paneId]).toBe('gemini');
  expect(providerKey).toBe(paneId);
  expect(useAIPaneStore.getState().getOrCreate(providerKey).messages).toEqual([
    expect.objectContaining({ role: 'system', content: 'chat.switched_to_pane_thread' }),
  ]);
  expect(useAIPaneStore.getState().conversations[COMPANION_CONVERSATION_KEY]).toBeUndefined();
});
