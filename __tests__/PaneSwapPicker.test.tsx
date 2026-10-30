// The real hooks/use-multi-pane store cannot be imported under the jest-expo
// (component) babel preset: its object-spread-with-getters is compiled to an
// eager objectSpread that evaluates `get root()` before the store exists (the
// same reason every other component suite mocks this module). swapSlots
// itself is covered against the real store in multi-pane-swap.test.ts; this
// suite pins the picker's wiring: which cells are tappable and what a tap
// asks the store to swap.
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

const mockSwapPanes = jest.fn();
const mockState = {
  preset: 'p4',
  slots: [
    { id: 'pane-t1', tab: 'terminal', sessionId: 'term-a' },
    { id: 'pane-monitor', tab: 'monitor' },
    { id: 'pane-ai', tab: 'ai' },
    null,
  ],
  ratios: { mainH: 0.5, mainV: 0.5, rightV: 0.5, leftV: 0.5, bottomH: 0.5, topH: 0.5 },
  swapPanes: mockSwapPanes,
};

jest.mock('@/hooks/use-multi-pane', () => {
  const rect = (x: number, y: number) => ({ x, y, w: 100, h: 64 });
  return {
    PRESET_CAPACITY: { p1: 1, p2h: 2, p2v: 2, p3l: 3, p3r: 3, p3t: 3, p3b: 3, p4: 4 },
    getLayout: () => ({ slotRects: [rect(0, 0), rect(100, 0), rect(0, 64), rect(100, 64)], dividers: [] }),
    useMultiPaneStore: Object.assign((sel: (s: any) => any) => sel(mockState), {
      getState: () => mockState,
    }),
  };
});
jest.mock('@/components/multi-pane/pane-registry', () => ({
  PANE_REGISTRY: new Proxy({}, { get: () => ({ icon: 'crop-square' }) }),
  resolvePaneTitle: (tab: string) => tab.toUpperCase(),
}));
jest.mock('@/lib/i18n', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) =>
      params?.title ? `${key}:${params.title}` : key,
  }),
}));

import { PaneSwapPicker } from '@/components/multi-pane/PaneSwapPicker';

describe('PaneSwapPicker', () => {
  beforeEach(() => mockSwapPanes.mockClear());

  it('tapping a cell swaps the source pane with that pane and closes', () => {
    const onClose = jest.fn();
    const { getByTestId, getByLabelText } = render(
      <PaneSwapPicker visible sourceLeafId="pane-monitor" layoutPreset="p4" onClose={onClose} />,
    );
    expect(getByLabelText('pane.swap_cell_a11y:TERMINAL')).toBeTruthy();
    fireEvent.press(getByTestId('pane-swap-cell-0'));

    expect(mockSwapPanes).toHaveBeenCalledWith('pane-monitor', 'pane-t1');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the source cell and empty cells do not swap', () => {
    const onClose = jest.fn();
    const { getByTestId } = render(
      <PaneSwapPicker visible sourceLeafId="pane-monitor" layoutPreset="p4" onClose={onClose} />,
    );
    // Non-pressable cells bubble the press to the menu card, which only
    // stops propagation (so the backdrop does not close the picker).
    const ev = { stopPropagation: jest.fn() };
    fireEvent.press(getByTestId('pane-swap-cell-1'), ev);
    fireEvent.press(getByTestId('pane-swap-cell-3'), ev);
    expect(mockSwapPanes).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('only draws cells for the visible preset capacity', () => {
    const { queryByTestId } = render(
      <PaneSwapPicker visible sourceLeafId="pane-monitor" layoutPreset="p3l" onClose={jest.fn()} />,
    );
    expect(queryByTestId('pane-swap-cell-2')).not.toBeNull();
    expect(queryByTestId('pane-swap-cell-3')).toBeNull();
  });

  it('renders nothing for a single-pane layout or when hidden', () => {
    const a = render(
      <PaneSwapPicker visible sourceLeafId="pane-monitor" layoutPreset={null} onClose={jest.fn()} />,
    );
    expect(a.queryByTestId('pane-swap-cell-0')).toBeNull();
    const b = render(
      <PaneSwapPicker visible={false} sourceLeafId="pane-monitor" layoutPreset="p4" onClose={jest.fn()} />,
    );
    expect(b.queryByTestId('pane-swap-cell-0')).toBeNull();
  });
});
