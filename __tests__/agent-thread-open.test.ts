/**
 * __tests__/agent-thread-open.test.ts — MONITOR OPEN CHAT (and the Sidebar
 * "Chat" action) focus an agent's thread: a pane already pinned to the
 * agent → an idle 'ai' pane (re-pinned, no fourth pane) → a new pane.
 * 2026-10-31 on-device: OPEN CHAT added a 4th pane next to a free AI pane.
 */
type Slot = { id: string; tab: string } | null;
const mockMp = {
  slots: [null, null, null, null] as Slot[],
  focusedSlot: 0,
  focusSlot: jest.fn((i: number) => {
    mockMp.focusedSlot = i;
  }),
  addPane: jest.fn((_tab: string): null | 'layout_full' => null),
};
jest.mock('@/hooks/use-multi-pane', () => ({ useMultiPaneStore: { getState: () => mockMp } }));
const mockSetFocusedPane = jest.fn();
jest.mock('@/store/pane-store', () => ({ usePaneStore: { getState: () => ({ setFocusedPane: mockSetFocusedPane }) } }));
jest.mock('@/lib/debug-logger', () => ({ logInfo: jest.fn() }));

import { openAgentChatThread } from '@/lib/agent-thread-open';
import { clearThreadAgent, getThreadAgentId, selectThreadAgent } from '@/lib/agent-thread-selection';

describe('openAgentChatThread', () => {
  beforeEach(() => {
    for (const id of ['t', 'ai-1', 'ai-2', 'mon']) clearThreadAgent(id);
    mockMp.slots = [{ id: 't', tab: 'terminal' }, { id: 'ai-1', tab: 'ai' }, { id: 'mon', tab: 'monitor' }, null];
    mockMp.focusedSlot = 2;
    mockMp.focusSlot.mockClear();
    mockMp.addPane.mockClear();
    mockSetFocusedPane.mockClear();
  });

  it('reuses an idle AI pane instead of adding a pane, and pins it to the agent', () => {
    expect(openAgentChatThread('digest')).toBe(true);
    expect(mockMp.addPane).not.toHaveBeenCalled();
    expect(getThreadAgentId('ai-1')).toBe('digest');
    expect(mockMp.focusSlot).toHaveBeenCalledWith(1);
    expect(mockSetFocusedPane).toHaveBeenCalledWith('ai-1');
  });

  it('prefers the pane already pinned to the agent', () => {
    mockMp.slots[3] = { id: 'ai-2', tab: 'ai' };
    selectThreadAgent('ai-2', 'digest');
    expect(openAgentChatThread('digest')).toBe(true);
    expect(getThreadAgentId('ai-1')).toBeNull();
    expect(mockMp.focusSlot).toHaveBeenCalledWith(3);
  });

  it('never takes over a pane pinned to another agent; adds a pane instead', () => {
    selectThreadAgent('ai-1', 'other');
    mockMp.addPane.mockImplementationOnce(() => {
      mockMp.slots[3] = { id: 'ai-2', tab: 'ai' };
      mockMp.focusedSlot = 3;
      return null;
    });
    expect(openAgentChatThread('digest')).toBe(true);
    expect(getThreadAgentId('ai-1')).toBe('other');
    expect(getThreadAgentId('ai-2')).toBe('digest');
  });

  it('reports false when no AI pane exists and the layout is full', () => {
    mockMp.slots = [{ id: 't', tab: 'terminal' }, { id: 'mon', tab: 'monitor' }, { id: 'b', tab: 'browser' }, { id: 'md', tab: 'markdown' }];
    mockMp.addPane.mockReturnValueOnce('layout_full');
    expect(openAgentChatThread('digest')).toBe(false);
  });
});
