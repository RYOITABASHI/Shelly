import fs from 'fs';
import path from 'path';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  addAiPaneThreadSwitchNotice,
  carryForwardOnThreadSwitch,
  COMPANION_CONVERSATION_KEY,
  resolveAiPaneStoreKey,
  useAIPaneStore,
} from '@/store/ai-pane-store';
import { usePaneStore } from '@/store/pane-store';
import en from '@/lib/i18n/locales/en';
import ja from '@/lib/i18n/locales/ja';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

function translator(dict: Record<string, string>) {
  return (key: string, vars?: Record<string, string>) =>
    (dict[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) => vars?.[name] ?? `{{${name}}}`);
}

beforeEach(() => {
  jest.clearAllMocks();
  useAIPaneStore.setState({ conversations: {}, isLoaded: true });
  usePaneStore.setState({ paneAgents: {} } as any);
});

describe('thread-switch notice wording (2026-10-09 clipped-notice fix)', () => {
  it('Local -> Groq with carry-forward names Groq in a short, complete notice (en + ja)', () => {
    for (const [dict, expected] of [
      [en, 'Switched to Groq — I brought our conversation along.'],
      [ja, 'Groqに切り替えました。ここまでの話も持ってきました。'],
    ] as const) {
      useAIPaneStore.setState({ conversations: {} });
      const paneId = 'pane-notice';
      usePaneStore.setState({ paneAgents: { [paneId]: 'local' } } as any);
      const companionKey = resolveAiPaneStoreKey(paneId);
      useAIPaneStore.getState().addMessage(companionKey, { id: 'u1', role: 'user', content: 'hi', timestamp: 1 });

      usePaneStore.getState().bindAgent(paneId, 'groq');
      const groqKey = resolveAiPaneStoreKey(paneId);
      addAiPaneThreadSwitchNotice(companionKey, groqKey, translator(dict));

      const notice = useAIPaneStore.getState().getOrCreate(groqKey).messages.find((m) => m.role === 'system');
      expect(notice?.content).toBe(expected);
    }
  });

  it('switching back to the companion thread names the local model', () => {
    const paneId = 'pane-back';
    usePaneStore.setState({ paneAgents: { [paneId]: 'groq' } } as any);
    const groqKey = resolveAiPaneStoreKey(paneId);
    usePaneStore.getState().bindAgent(paneId, 'local');
    addAiPaneThreadSwitchNotice(groqKey, COMPANION_CONVERSATION_KEY, translator(en));
    const notice = useAIPaneStore.getState().getOrCreate(COMPANION_CONVERSATION_KEY).messages[0];
    expect(notice.content).toBe('Switched to Local.');
  });

  it('agent threads keep the agent-name wording', () => {
    addAiPaneThreadSwitchNotice(COMPANION_CONVERSATION_KEY, 'agent:a1', translator(en), 'Research Bot');
    expect(useAIPaneStore.getState().getOrCreate('agent:a1').messages[0].content)
      .toBe("You're now talking to Research Bot.");
  });

  it('system notice row can wrap: no numberOfLines, no synthetic italic, centered via textAlign', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'components', 'panes', 'AIPane.tsx'), 'utf8');
    const row = src.match(/bubbleStyles\.systemText[^\n]*/)?.[0] ?? '';
    expect(row).not.toMatch(/numberOfLines|ellipsizeMode/);
    const block = src.match(/systemText: \{[\s\S]*?\n {2}\},/)?.[0] ?? '';
    expect(block).toContain("textAlign: 'center'");
    expect(block).not.toMatch(/fontStyle|numberOfLines|height:/);
  });
});

describe('clear conversation (trash icon) — 2026-10-09 resurrection fix', () => {
  it('clears exactly the resolved key for companion, provider and agent threads', () => {
    usePaneStore.setState({ paneAgents: { p: 'groq' } } as any);
    const store = useAIPaneStore.getState();
    for (const key of [COMPANION_CONVERSATION_KEY, 'p', 'agent:x']) {
      store.addMessage(key, { id: `${key}-m`, role: 'user', content: key, timestamp: 1 });
    }
    store.clearConversation(resolveAiPaneStoreKey('p'));
    const convs = useAIPaneStore.getState().conversations;
    expect(convs.p.messages).toEqual([]);
    expect(convs[COMPANION_CONVERSATION_KEY].messages).toHaveLength(1);
    expect(convs['agent:x'].messages).toHaveLength(1);
  });

  it('persists immediately instead of waiting on the 2s debounce', () => {
    jest.useFakeTimers();
    try {
      useAIPaneStore.getState().addMessage(COMPANION_CONVERSATION_KEY, { id: 'm', role: 'user', content: 'old', timestamp: 1 });
      (AsyncStorage.setItem as jest.Mock).mockClear();
      useAIPaneStore.getState().clearConversation(COMPANION_CONVERSATION_KEY);
      expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
      const written = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1]);
      expect(written[COMPANION_CONVERSATION_KEY].messages).toEqual([]);
      // and the pending debounced save from addMessage was cancelled, not re-run with stale data
      jest.advanceTimersByTime(5000);
      expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('clearing the provider thread is not undone by the next companion -> provider carry-forward', () => {
    const paneId = 'pane-clear-1';
    usePaneStore.setState({ paneAgents: { [paneId]: 'local' } } as any);
    useAIPaneStore.getState().addMessage(COMPANION_CONVERSATION_KEY, { id: 'old-u', role: 'user', content: 'old q', timestamp: 1 });
    useAIPaneStore.getState().addMessage(COMPANION_CONVERSATION_KEY, { id: 'old-a', role: 'assistant', content: 'old a', timestamp: 2 });

    usePaneStore.getState().bindAgent(paneId, 'groq');
    expect(carryForwardOnThreadSwitch(COMPANION_CONVERSATION_KEY, paneId)).toBe(true);
    useAIPaneStore.getState().clearConversation(paneId);

    // round trip back to Local and over to Groq again
    expect(carryForwardOnThreadSwitch(paneId, COMPANION_CONVERSATION_KEY)).toBe(false);
    expect(carryForwardOnThreadSwitch(COMPANION_CONVERSATION_KEY, paneId)).toBe(false);
    expect(useAIPaneStore.getState().conversations[paneId].messages).toEqual([]);

    // genuinely new companion messages still carry
    useAIPaneStore.getState().addMessage(COMPANION_CONVERSATION_KEY, { id: 'new-u', role: 'user', content: 'new q', timestamp: Date.now() + 1000 });
    expect(carryForwardOnThreadSwitch(COMPANION_CONVERSATION_KEY, paneId)).toBe(true);
    expect(useAIPaneStore.getState().conversations[paneId].messages.map((m) => m.content)).toEqual(['new q']);
  });

  it('clearing the companion thread is not undone by carried copies sitting in a provider thread', () => {
    const paneId = 'pane-clear-2';
    usePaneStore.setState({ paneAgents: { [paneId]: 'local' } } as any);
    useAIPaneStore.getState().addMessage(COMPANION_CONVERSATION_KEY, { id: 'old-u', role: 'user', content: 'old q', timestamp: 1 });
    usePaneStore.getState().bindAgent(paneId, 'groq');
    carryForwardOnThreadSwitch(COMPANION_CONVERSATION_KEY, paneId);

    usePaneStore.getState().bindAgent(paneId, 'local');
    useAIPaneStore.getState().clearConversation(COMPANION_CONVERSATION_KEY);
    addAiPaneThreadSwitchNotice(paneId, COMPANION_CONVERSATION_KEY, translator(en));

    const companion = useAIPaneStore.getState().conversations[COMPANION_CONVERSATION_KEY].messages;
    expect(companion.map((m) => m.content)).toEqual(['Switched to Local.']);
  });
});
