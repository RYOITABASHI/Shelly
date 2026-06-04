jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

import { resolveSinglePaneSlot, useMultiPaneStore } from '@/hooks/use-multi-pane';

const ratios = {
  mainH: 0.5,
  mainV: 0.5,
  rightV: 0.5,
  leftV: 0.5,
  bottomH: 0.5,
  topH: 0.5,
};

describe('multi-pane single-pane switching', () => {
  beforeEach(() => {
    useMultiPaneStore.setState({
      preset: 'p4',
      slots: [
        { id: 'pane-terminal', tab: 'terminal', sessionId: 'term-a' },
        { id: 'pane-agent-chat', tab: 'agent-chat' },
        { id: 'pane-ai', tab: 'ai' },
        null,
      ],
      focusedSlot: 1,
      ratios,
      maximizedSlot: null,
      _hasHydrated: true,
    });
  });

  it('keeps the focused pane visible when collapsing to Single', () => {
    useMultiPaneStore.getState().setPreset('p1');

    const state = useMultiPaneStore.getState();
    expect(state.preset).toBe('p1');
    expect(state.focusedSlot).toBe(1);
    expect(resolveSinglePaneSlot(state.slots, state.focusedSlot)).toBe(1);
  });

  it('falls back to the first open pane if focused slot is empty', () => {
    const state = useMultiPaneStore.getState();

    expect(resolveSinglePaneSlot(state.slots, 3)).toBe(0);
  });
});
