jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: { addListener: jest.fn(() => ({ remove: jest.fn() })) },
}));

import React from 'react';
import { StyleSheet, TextInput } from 'react-native';
import { render } from '@testing-library/react-native';
import PaneInputBar from '@/components/panes/PaneInputBar';
import { refreshRuntimeThemeColors } from '@/lib/theme';
import { colors as C } from '@/theme.config';

describe('PaneInputBar composer text color', () => {
  it('uses the live theme foreground (not the module-load seed) for typed/inserted text', () => {
    const seedText1 = C.text1;
    // Simulate applyThemePreset() swapping to a light palette after the
    // component module (and its StyleSheet) was already evaluated.
    refreshRuntimeThemeColors({
      ...C,
      bgDeep: '#F4EFE6',
      bgSurface: '#FFFFFF',
      text1: '#1A1A1A',
      text2: '#555555',
      text3: '#999999',
    });
    const screen = render(<PaneInputBar placeholder="Ask" onSubmit={() => {}} />);
    const input = screen.UNSAFE_getByType(TextInput);
    const flat = StyleSheet.flatten(input.props.style);
    expect(flat.color).toBe('#1A1A1A');
    expect(flat.color).not.toBe(seedText1);
    expect(input.props.placeholderTextColor).toBe('#999999');
  });
});

describe('PaneInputBar multiline composer', () => {
  it('wraps/auto-grows when multiline, while Enter still submits', () => {
    const screen = render(<PaneInputBar multiline onSubmit={() => {}} />);
    const input = screen.UNSAFE_getByType(TextInput);
    expect(input.props.multiline).toBe(true);
    expect(input.props.submitBehavior).toBe('submit');
    expect(StyleSheet.flatten(input.props.style).maxHeight).toBeGreaterThan(0);
  });

  it('stays single-line for masked API-key entry', () => {
    const screen = render(<PaneInputBar multiline secureEntry onSubmit={() => {}} />);
    expect(screen.UNSAFE_getByType(TextInput).props.multiline).toBe(false);
  });

  it('defaults to single-line for other panes', () => {
    const screen = render(<PaneInputBar onSubmit={() => {}} />);
    expect(screen.UNSAFE_getByType(TextInput).props.multiline).toBe(false);
  });
});
