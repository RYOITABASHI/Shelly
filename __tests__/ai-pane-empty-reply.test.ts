jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

import AsyncStorage from '@react-native-async-storage/async-storage';
import { isEmptyPlainAssistantMessage } from '@/lib/ai-pane-empty-reply';
import { COMPANION_CONVERSATION_KEY, useAIPaneStore } from '@/store/ai-pane-store';

describe('isEmptyPlainAssistantMessage', () => {
  const base = { id: 'a', role: 'assistant' as const, content: '', timestamp: 1 };

  it('matches a text-only assistant message with no visible text', () => {
    expect(isEmptyPlainAssistantMessage(base)).toBe(true);
    expect(isEmptyPlainAssistantMessage({ ...base, content: '  \n', agent: 'local', isStreaming: false })).toBe(true);
  });

  it('treats streamingText as visible text', () => {
    expect(isEmptyPlainAssistantMessage({ ...base, isStreaming: true, streamingText: 'partial' })).toBe(false);
  });

  it('never matches user messages, non-empty replies, or payload-carrying messages', () => {
    expect(isEmptyPlainAssistantMessage({ ...base, role: 'user' })).toBe(false);
    expect(isEmptyPlainAssistantMessage({ ...base, content: 'hi' })).toBe(false);
    expect(isEmptyPlainAssistantMessage({ ...base, scheduleReadinessCard: true })).toBe(false);
    expect(isEmptyPlainAssistantMessage({ ...base, agentCardState: 'pending' })).toBe(false);
    expect(isEmptyPlainAssistantMessage(undefined)).toBe(false);
  });
});

describe('ai-pane-store never restores empty assistant bubbles', () => {
  it('drops empty text-only assistant messages persisted by an older build on load', async () => {
    await AsyncStorage.setItem('shelly_ai_pane_conversations', JSON.stringify({
      [COMPANION_CONVERSATION_KEY]: {
        paneId: COMPANION_CONVERSATION_KEY,
        messages: [
          { id: 'u1', role: 'user', content: 'hi', timestamp: 1 },
          { id: 'a1', role: 'assistant', content: '', timestamp: 2, agent: 'local', isStreaming: true },
          { id: 'u2', role: 'user', content: 'hello?', timestamp: 3 },
          { id: 'a2', role: 'assistant', content: 'Hello!', timestamp: 4, agent: 'local' },
        ],
        isStreaming: false,
        terminalContext: null,
      },
    }));
    await useAIPaneStore.getState().load();
    const ids = useAIPaneStore.getState().conversations[COMPANION_CONVERSATION_KEY].messages.map((m) => m.id);
    expect(ids).toEqual(['u1', 'u2', 'a2']);
  });
});
