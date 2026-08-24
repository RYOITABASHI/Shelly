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

it('keeps terminal context independent for panes sharing the companion thread', () => {
  usePaneStore.setState({ paneAgents: { left: 'local', right: 'local' } } as any);
  useAIPaneStore.getState().getOrCreate('left');
  useAIPaneStore.getState().getOrCreate('right');

  const leftKey = resolveAiPaneStoreKey('left');
  const rightKey = resolveAiPaneStoreKey('right');
  expect(leftKey).toBe(COMPANION_CONVERSATION_KEY);
  expect(rightKey).toBe(COMPANION_CONVERSATION_KEY);

  useAIPaneStore.getState().addMessage(leftKey, {
    id: 'left-message', role: 'user', content: 'from left', timestamp: 1,
  });
  useAIPaneStore.getState().addMessage(rightKey, {
    id: 'right-message', role: 'user', content: 'from right', timestamp: 2,
  });
  useAIPaneStore.getState().setTerminalContext('left', 'left terminal session');
  useAIPaneStore.getState().setTerminalContext('right', 'right terminal session');

  const conversations = useAIPaneStore.getState().conversations;
  expect(conversations[COMPANION_CONVERSATION_KEY].messages.map((message) => message.content))
    .toEqual(['from left', 'from right']);
  expect(conversations.left.terminalContext).toBe('left terminal session');
  expect(conversations.right.terminalContext).toBe('right terminal session');
  expect(conversations[COMPANION_CONVERSATION_KEY].terminalContext).toBeNull();
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

it('ghost-thread fix: drops pane-scoped conversations on load since their provider binding never survives a restart', async () => {
  // Simulates AsyncStorage still holding a pane-keyed conversation from
  // before a restart — pane-store's paneAgents (the binding that scoped it)
  // is never persisted, so this pane starts the new session unbound. Without
  // the fix, re-binding 'pane-1' to gemini again would silently resurrect
  // this old conversation.
  const staleData = {
    [COMPANION_CONVERSATION_KEY]: {
      paneId: COMPANION_CONVERSATION_KEY,
      messages: [{ id: 'companion-msg', role: 'user', content: 'still here', timestamp: 1 }],
      activeAgent: null,
      isStreaming: false,
      terminalContext: null,
    },
    'pane-1': {
      paneId: 'pane-1',
      messages: [{ id: 'gemini-msg', role: 'user', content: 'old gemini context', timestamp: 1 }],
      activeAgent: null,
      isStreaming: false,
      terminalContext: null,
    },
  };
  await AsyncStorage.setItem('shelly_ai_pane_conversations', JSON.stringify(staleData));
  useAIPaneStore.setState({ conversations: {}, isLoaded: false });

  await useAIPaneStore.getState().load();

  const { conversations } = useAIPaneStore.getState();
  expect(conversations[COMPANION_CONVERSATION_KEY].messages[0].content).toBe('still here');
  expect(conversations['pane-1']).toBeUndefined();

  // Re-binding the same pane to the same provider afterwards must start
  // from an empty thread, not resurrect the dropped one.
  usePaneStore.setState({ paneAgents: { 'pane-1': 'gemini' } } as any);
  expect(useAIPaneStore.getState().getOrCreate(resolveAiPaneStoreKey('pane-1')).messages).toEqual([]);

  // The purge must also reach disk, so a later load() doesn't resurrect it.
  const persistedRaw = await AsyncStorage.getItem('shelly_ai_pane_conversations');
  const persisted = JSON.parse(persistedRaw as string);
  expect(persisted['pane-1']).toBeUndefined();
  expect(persisted[COMPANION_CONVERSATION_KEY]).toBeDefined();
});
