jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

const mockRemoveSession = jest.fn();
const mockDestroySession = jest.fn(() => Promise.resolve());
const mockReleaseThreadSlot = jest.fn();

jest.mock('@/store/terminal-store', () => ({
  useTerminalStore: {
    getState: () => ({
      sessions: [
        { id: 'term-a', nativeSessionId: 'native-a' },
        { id: 'term-b', nativeSessionId: 'native-b' },
      ],
      removeSession: mockRemoveSession,
      addSession: jest.fn(() => 'term-new'),
    }),
  },
}));
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: { destroySession: mockDestroySession },
}));
jest.mock('@/lib/agent-thread-selection', () => {
  const actual = jest.requireActual('@/lib/agent-thread-selection');
  return { ...actual, releaseThreadSlot: (...a: unknown[]) => mockReleaseThreadSlot(...a) };
});

import {
  getSwappableSlotIndices,
  useMultiPaneStore,
  type Slot,
  type SlotIndex,
} from '@/hooks/use-multi-pane';
import { useAIPaneStore } from '@/store/ai-pane-store';

const ratios = { mainH: 0.3, mainV: 0.6, rightV: 0.5, leftV: 0.5, bottomH: 0.5, topH: 0.5 };

const FOUR: [Slot, Slot, Slot, Slot] = [
  { id: 'pane-t1', tab: 'terminal', sessionId: 'term-a' },
  { id: 'pane-monitor', tab: 'monitor' },
  { id: 'pane-ai', tab: 'ai' },
  { id: 'pane-t2', tab: 'terminal', sessionId: 'term-b' },
];

function reset(focusedSlot: SlotIndex = 0, maximizedSlot: SlotIndex | null = null) {
  useMultiPaneStore.setState({
    preset: 'p4',
    slots: FOUR.map((s) => (s ? { ...s } : s)) as [Slot, Slot, Slot, Slot],
    focusedSlot,
    ratios: { ...ratios },
    maximizedSlot,
    _hasHydrated: true,
  });
}

describe('swapSlots', () => {
  let clearConversation: jest.SpyInstance;
  beforeEach(() => {
    mockRemoveSession.mockClear();
    mockDestroySession.mockClear();
    mockReleaseThreadSlot.mockClear();
    clearConversation = jest.spyOn(useAIPaneStore.getState(), 'clearConversation');
    reset();
  });
  afterEach(() => clearConversation.mockRestore());

  const pairs: [SlotIndex, SlotIndex][] = [];
  for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) pairs.push([a as SlotIndex, b as SlotIndex]);

  it.each(pairs)('exchanges full contents of slots %i and %i without any cleanup', (a, b) => {
    const before = useMultiPaneStore.getState().slots;
    useMultiPaneStore.getState().swapSlots(a, b);
    const s = useMultiPaneStore.getState();

    expect(s.slots[a]).toEqual(before[b]);
    expect(s.slots[b]).toEqual(before[a]);
    // Same object identity: id/tab/sessionId travel together untouched.
    expect(s.slots[a]).toBe(before[b]);
    for (let i = 0; i < 4; i++) {
      if (i !== a && i !== b) expect(s.slots[i]).toBe(before[i]);
    }
    expect(s.preset).toBe('p4');
    expect(s.ratios).toEqual(ratios);
    expect(mockRemoveSession).not.toHaveBeenCalled();
    expect(mockDestroySession).not.toHaveBeenCalled();
    expect(mockReleaseThreadSlot).not.toHaveBeenCalled();
    expect(clearConversation).not.toHaveBeenCalled();
  });

  it.each(pairs)('swapping %i and %i twice restores the original layout', (a, b) => {
    const before = useMultiPaneStore.getState().slots;
    useMultiPaneStore.getState().swapSlots(a, b);
    useMultiPaneStore.getState().swapSlots(b, a);
    expect(useMultiPaneStore.getState().slots).toEqual(before);
  });

  it('is a no-op for a === b', () => {
    const before = useMultiPaneStore.getState();
    useMultiPaneStore.getState().swapSlots(2, 2);
    const after = useMultiPaneStore.getState();
    expect(after.slots).toBe(before.slots);
    expect(after.focusedSlot).toBe(before.focusedSlot);
  });

  it('is a no-op when either slot is empty', () => {
    useMultiPaneStore.setState({
      preset: 'p3l',
      slots: [FOUR[0], FOUR[1], FOUR[2], null],
    });
    const before = useMultiPaneStore.getState().slots;
    useMultiPaneStore.getState().swapSlots(1, 3);
    expect(useMultiPaneStore.getState().slots).toBe(before);
  });

  it('focus follows the focused pane content', () => {
    reset(1);
    useMultiPaneStore.getState().swapSlots(1, 3);
    let s = useMultiPaneStore.getState();
    expect(s.focusedSlot).toBe(3);
    expect(s.slots[s.focusedSlot]?.id).toBe('pane-monitor');

    // Focus on the other side of the swap moves too.
    useMultiPaneStore.getState().swapSlots(0, 3);
    s = useMultiPaneStore.getState();
    expect(s.focusedSlot).toBe(0);
    expect(s.slots[0]?.id).toBe('pane-monitor');

    // Focus on an uninvolved slot stays put.
    useMultiPaneStore.getState().swapSlots(1, 2);
    expect(useMultiPaneStore.getState().focusedSlot).toBe(0);
  });

  it('maximize follows the maximized pane content', () => {
    reset(0, 2);
    useMultiPaneStore.getState().swapSlots(2, 0);
    const s = useMultiPaneStore.getState();
    expect(s.maximizedSlot).toBe(0);
    expect(s.slots[s.maximizedSlot!]?.id).toBe('pane-ai');

    reset(0, null);
    useMultiPaneStore.getState().swapSlots(1, 2);
    expect(useMultiPaneStore.getState().maximizedSlot).toBeNull();
  });

  it('swapPanes resolves leaf ids and ignores unknown ids', () => {
    useMultiPaneStore.getState().swapPanes('pane-monitor', 'pane-t1');
    let s = useMultiPaneStore.getState();
    expect(s.slots[0]?.id).toBe('pane-monitor');
    expect(s.slots[1]?.id).toBe('pane-t1');
    expect(s.slots[1]?.sessionId).toBe('term-a');

    const before = s.slots;
    useMultiPaneStore.getState().swapPanes('pane-monitor', 'pane-nope');
    s = useMultiPaneStore.getState();
    expect(s.slots).toBe(before);
  });

  it('survives a persist round-trip', () => {
    reset(1, null);
    useMultiPaneStore.getState().swapSlots(1, 3);
    const opts = useMultiPaneStore.persist.getOptions();
    const persisted = JSON.parse(JSON.stringify(opts.partialize!(useMultiPaneStore.getState())));
    const restored = opts.migrate!(persisted, 2) as any;
    expect(restored.slots).toEqual(useMultiPaneStore.getState().slots);
    expect(restored.focusedSlot).toBe(3);
    expect(restored.preset).toBe('p4');
    expect(restored.ratios).toEqual(ratios);
  });
});

describe('getSwappableSlotIndices', () => {
  it('returns nothing when only one pane is on screen', () => {
    expect(getSwappableSlotIndices(FOUR, null)).toEqual([]);
    expect(getSwappableSlotIndices(FOUR, 'p1')).toEqual([]);
    expect(getSwappableSlotIndices([FOUR[0], null, null, null], 'p2h')).toEqual([]);
  });

  it('only includes filled slots within the visible preset capacity', () => {
    expect(getSwappableSlotIndices(FOUR, 'p2h')).toEqual([0, 1]);
    expect(getSwappableSlotIndices(FOUR, 'p3l')).toEqual([0, 1, 2]);
    expect(getSwappableSlotIndices(FOUR, 'p4')).toEqual([0, 1, 2, 3]);
    expect(getSwappableSlotIndices([FOUR[0], FOUR[1], null, FOUR[3]], 'p4')).toEqual([0, 1, 3]);
  });
});
