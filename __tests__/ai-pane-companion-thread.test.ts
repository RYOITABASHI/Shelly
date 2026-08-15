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

it('routes a local-to-provider switch turn into the post-rebind private thread', () => {
  const paneId = 'pane-local-to-gemini';
  usePaneStore.setState({ paneAgents: { [paneId]: 'local' } } as any);
  let dispatchKey = resolveAiPaneStoreKey(paneId);
  expect(dispatchKey).toBe(COMPANION_CONVERSATION_KEY);

  usePaneStore.getState().bindAgent(paneId, 'gemini');
  dispatchKey = resolveAiPaneStoreKey(paneId);
  useAIPaneStore.getState().addMessage(dispatchKey, {
    id: 'provider-user', role: 'user', content: '@gemini reply with just the word ping', timestamp: 1,
  });
  useAIPaneStore.getState().addMessage(dispatchKey, {
    id: 'provider-assistant', role: 'assistant', content: 'ping', timestamp: 2, agent: 'gemini',
  });

  expect(dispatchKey).toBe(paneId);
  expect(useAIPaneStore.getState().getOrCreate(paneId).messages.map((message) => message.content))
    .toEqual(['@gemini reply with just the word ping', 'ping']);
  expect(useAIPaneStore.getState().conversations[COMPANION_CONVERSATION_KEY]).toBeUndefined();
});

it('routes a provider-to-local switch turn into the post-rebind companion thread', () => {
  const paneId = 'pane-gemini-to-local';
  usePaneStore.setState({ paneAgents: { [paneId]: 'gemini' } } as any);
  let dispatchKey = resolveAiPaneStoreKey(paneId);
  expect(dispatchKey).toBe(paneId);

  usePaneStore.getState().bindAgent(paneId, 'local');
  dispatchKey = resolveAiPaneStoreKey(paneId);
  useAIPaneStore.getState().addMessage(dispatchKey, {
    id: 'local-user', role: 'user', content: '@local reply with just the word pong', timestamp: 1,
  });
  useAIPaneStore.getState().addMessage(dispatchKey, {
    id: 'local-assistant', role: 'assistant', content: 'pong', timestamp: 2, agent: 'local',
  });

  expect(dispatchKey).toBe(COMPANION_CONVERSATION_KEY);
  expect(useAIPaneStore.getState().getOrCreate(COMPANION_CONVERSATION_KEY).messages.map((message) => message.content))
    .toEqual(['@local reply with just the word pong', 'pong']);
  expect(useAIPaneStore.getState().conversations[paneId]).toBeUndefined();
});
