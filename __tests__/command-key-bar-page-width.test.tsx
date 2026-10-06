/**
 * CommandKeyBar paging width (2026-10-06 Fold6 feedback).
 *
 * Each key-set page must be exactly as wide as the horizontal ScrollView's
 * viewport (pagingEnabled snaps by viewport width). It used to be sized from
 * the whole bar container, which also holds the attach/mic buttons and the
 * dots column, so the last key of every set ("Enter") was cut off on the
 * right edge.
 */
import React from 'react';
import { ScrollView } from 'react-native';
import { render, fireEvent, screen } from '@testing-library/react-native';

jest.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({
    colors: { accent: '#0af', foreground: '#eee', muted: '#999', border: '#333' },
  }),
}));

jest.mock('@/store/settings-store', () => {
  const state = { settings: { uiFont: 'unknown-preset', hapticFeedback: false, showVimKeyBar: false } };
  return {
    useSettingsStore: Object.assign((selector: (s: any) => any) => selector(state), {
      getState: () => state,
    }),
  };
});

jest.mock('@/hooks/use-pane-voice', () => ({
  usePaneVoice: () => ({
    startRecording: jest.fn(),
    stopRecording: jest.fn(),
    isRecording: false,
    isTranscribing: false,
  }),
}));

jest.mock('@/lib/theme-presets', () => ({ themePresets: {} }));

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
}));

jest.mock('expo-clipboard', () => ({ getStringAsync: jest.fn(async () => '') }));

import { CommandKeyBar } from '@/components/terminal/CommandKeyBar';

function flatWidth(style: unknown): number | undefined {
  const arr = Array.isArray(style) ? style.flat(Infinity) : [style];
  let width: number | undefined;
  for (const s of arr) {
    if (s && typeof s === 'object' && typeof (s as any).width === 'number') width = (s as any).width;
  }
  return width;
}

describe('CommandKeyBar page width', () => {
  it('sizes each key-set page to the scroller viewport, not the whole bar', () => {
    render(
      <CommandKeyBar
        sendKey={jest.fn()}
        sendText={jest.fn()}
        onAttach={jest.fn()}
        onVoice={jest.fn()}
      />,
    );

    const scroll = screen.UNSAFE_getByType(ScrollView);
    // The viewport wrapper is the ScrollView's parent; it owns onLayout.
    const viewport = scroll.parent!;
    fireEvent(viewport, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 512, height: 52 } } });
    // The whole bar is wider (attach + mic + dots column). Its layout must
    // NOT drive the page width — that was the original clipping bug.
    fireEvent(screen.root, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 600, height: 52 } } });

    // The "Enter" key (last key of the default set) lives inside a page whose
    // width must now equal the measured viewport width.
    const enterKey = screen.getAllByLabelText('Enter')[0];
    let node: any = enterKey;
    let pageWidth: number | undefined;
    while (node && node !== scroll) {
      const w = flatWidth(node.props?.style);
      if (w !== undefined) {
        pageWidth = w;
        break;
      }
      node = node.parent;
    }
    expect(pageWidth).toBe(512);
  });
});
