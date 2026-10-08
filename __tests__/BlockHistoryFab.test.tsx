/**
 * components/terminal/BlockHistoryFab.tsx — the floating Block History button
 * over the Terminal pane must stay out of the way of terminal text:
 * idle = faded but tappable, active (scroll/tap) = opaque then fades back
 * after 3s, hidden (native text selection) = opacity 0 + no touches.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { render, fireEvent, act } from '@testing-library/react-native';

let mockReduceMotion = false;
jest.mock('react-native-reanimated', () => {
  const mock = require('react-native-reanimated/mock');
  return {
    ...mock,
    __esModule: true,
    default: mock.default ?? mock,
    useReducedMotion: () => mockReduceMotion,
    // The stock mock evaluates the worklet once at render time, but the
    // component writes the shared value in an effect (after render). Return
    // a live view instead so assertions read the current shared value, like
    // the UI thread would, without depending on incidental re-renders.
    useAnimatedStyle: (cb: () => Record<string, unknown>) =>
      new Proxy(
        {},
        {
          get: (_t, k) => cb()[k as string],
          ownKeys: () => Reflect.ownKeys(cb()),
          getOwnPropertyDescriptor: (_t, k) => ({
            value: cb()[k as string],
            enumerable: true,
            configurable: true,
          }),
        },
      ),
  };
});

jest.mock('@expo/vector-icons/MaterialIcons', () => {
  const { Text } = require('react-native');
  return { __esModule: true, default: (p: { name: string }) => <Text>{p.name}</Text> };
});

import {
  BlockHistoryFab,
  BLOCK_HISTORY_FAB_IDLE_DELAY_MS,
  BLOCK_HISTORY_FAB_IDLE_OPACITY,
} from '@/components/terminal/BlockHistoryFab';

function opacityOf(node: { props: { style: unknown } }): number | undefined {
  return (StyleSheet.flatten(node.props.style as never) as { opacity?: number }).opacity;
}

function renderFab(props: Partial<React.ComponentProps<typeof BlockHistoryFab>> = {}) {
  const onPress = jest.fn();
  const utils = render(
    <BlockHistoryFab onPress={onPress} wakeKey={0} hidden={false} {...props} />,
  );
  const rerenderWith = (next: Partial<React.ComponentProps<typeof BlockHistoryFab>>) =>
    utils.rerender(<BlockHistoryFab onPress={onPress} wakeKey={0} hidden={false} {...props} {...next} />);
  return { ...utils, onPress, rerenderWith };
}

describe('BlockHistoryFab', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockReduceMotion = false;
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts idle: faded but still tappable', () => {
    const { getByTestId } = renderFab();
    const fab = getByTestId('block-history-fab');
    expect(opacityOf(fab)).toBe(BLOCK_HISTORY_FAB_IDLE_OPACITY);
    expect(fab.props.pointerEvents).toBe('box-none');
  });

  it('a single tap while faded both performs the action and wakes the button', () => {
    const { getByTestId, onPress } = renderFab();
    fireEvent.press(getByTestId('block-history-fab-button'));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(opacityOf(getByTestId('block-history-fab'))).toBe(1);
  });

  it('wakes on activity, then fades back to idle after ~3s of no interaction', () => {
    const { getByTestId, rerenderWith } = renderFab();
    rerenderWith({ wakeKey: 1 });
    expect(opacityOf(getByTestId('block-history-fab'))).toBe(1);

    act(() => {
      jest.advanceTimersByTime(BLOCK_HISTORY_FAB_IDLE_DELAY_MS - 100);
    });
    expect(opacityOf(getByTestId('block-history-fab'))).toBe(1);

    // Further activity restarts the idle countdown.
    rerenderWith({ wakeKey: 2 });
    act(() => {
      jest.advanceTimersByTime(BLOCK_HISTORY_FAB_IDLE_DELAY_MS - 100);
    });
    expect(opacityOf(getByTestId('block-history-fab'))).toBe(1);

    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(opacityOf(getByTestId('block-history-fab'))).toBe(BLOCK_HISTORY_FAB_IDLE_OPACITY);
  });

  it('is fully hidden and untouchable while a text selection is active', () => {
    const { getByTestId, rerenderWith, onPress } = renderFab();
    rerenderWith({ wakeKey: 1, hidden: true });
    const fab = getByTestId('block-history-fab');
    expect(opacityOf(fab)).toBe(0);
    expect(fab.props.pointerEvents).toBe('none');
    fireEvent.press(getByTestId('block-history-fab-button'));
    expect(onPress).not.toHaveBeenCalled();

    // Selection ends → back to the visible states.
    rerenderWith({ wakeKey: 1, hidden: false });
    expect(opacityOf(getByTestId('block-history-fab'))).toBe(1);
    act(() => {
      jest.advanceTimersByTime(BLOCK_HISTORY_FAB_IDLE_DELAY_MS);
    });
    expect(opacityOf(getByTestId('block-history-fab'))).toBe(BLOCK_HISTORY_FAB_IDLE_OPACITY);
  });

  it('applies the same states instantly under reduced motion', () => {
    mockReduceMotion = true;
    const { getByTestId, rerenderWith } = renderFab();
    expect(opacityOf(getByTestId('block-history-fab'))).toBe(BLOCK_HISTORY_FAB_IDLE_OPACITY);
    rerenderWith({ wakeKey: 1 });
    expect(opacityOf(getByTestId('block-history-fab'))).toBe(1);
    act(() => {
      jest.advanceTimersByTime(BLOCK_HISTORY_FAB_IDLE_DELAY_MS);
    });
    expect(opacityOf(getByTestId('block-history-fab'))).toBe(BLOCK_HISTORY_FAB_IDLE_OPACITY);
  });
});
