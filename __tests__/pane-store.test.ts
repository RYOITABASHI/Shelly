jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

import { getAgentColor, usePaneStore } from '@/store/pane-store';

describe('pane agent state', () => {
  beforeEach(() => {
    usePaneStore.setState({
      focusedPaneId: null,
      maximizedPaneId: null,
      paneAgents: {},
    });
  });

  it('binds and unbinds agents per pane without touching focus state', () => {
    usePaneStore.getState().setFocusedPane('pane-a');
    usePaneStore.getState().bindAgent('pane-a', 'codex');
    usePaneStore.getState().bindAgent('pane-b', 'local');

    expect(usePaneStore.getState().focusedPaneId).toBe('pane-a');
    expect(usePaneStore.getState().paneAgents).toEqual({
      'pane-a': 'codex',
      'pane-b': 'local',
    });

    usePaneStore.getState().unbindAgent('pane-a');

    expect(usePaneStore.getState().paneAgents).toEqual({ 'pane-b': 'local' });
    expect(usePaneStore.getState().focusedPaneId).toBe('pane-a');
  });

  it('maps known and unknown agents to stable pane colors', () => {
    expect(getAgentColor({ main: 'codex' }, 'main')).toBe('#10A37F');
    expect(getAgentColor({ main: 'not-installed' }, 'main')).toBe('#333333');
    expect(getAgentColor({}, 'main')).toBe('#333333');
  });
});
