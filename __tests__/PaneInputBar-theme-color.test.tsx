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

describe('PaneInputBar single-flight submit (Enter double-fire, build 2495)', () => {
  const { fireEvent, act } = require('@testing-library/react-native');

  it('submits once when Enter fires submitEditing twice + keyPress + a trailing newline', () => {
    const onSubmit = jest.fn();
    const screen = render(<PaneInputBar multiline onSubmit={onSubmit} />);
    const input = () => screen.UNSAFE_getByType(TextInput);
    fireEvent.changeText(input(), 'OK');
    // Android multiline: OnEditorActionListener runs on ENTER key-down AND
    // key-up, before React re-renders with the cleared draft.
    act(() => {
      input().props.onSubmitEditing({ nativeEvent: { text: 'OK' } });
      input().props.onSubmitEditing({ nativeEvent: { text: 'OK' } });
    });
    fireEvent(input(), 'keyPress', { nativeEvent: { key: 'Enter' } });
    fireEvent.changeText(input(), 'OK\n');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('OK');
    expect(input().props.value).toBe('');
  });

  it('treats a single committed newline as Enter: sends without leaving a stray newline', () => {
    const onSubmit = jest.fn();
    const screen = render(<PaneInputBar multiline onSubmit={onSubmit} />);
    const input = () => screen.UNSAFE_getByType(TextInput);
    fireEvent.changeText(input(), 'hello');
    fireEvent.changeText(input(), 'hello\n');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('hello');
    expect(input().props.value).toBe('');
  });

  it('keeps pasted multi-line content multi-line (no submit)', () => {
    const onSubmit = jest.fn();
    const screen = render(<PaneInputBar multiline onSubmit={onSubmit} />);
    const input = () => screen.UNSAFE_getByType(TextInput);
    fireEvent.changeText(input(), '> line one\n> line two\n');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(input().props.value).toBe('> line one\n> line two\n');
  });

  it('still allows a different message right after a send', () => {
    const onSubmit = jest.fn();
    const screen = render(<PaneInputBar multiline onSubmit={onSubmit} />);
    const input = () => screen.UNSAFE_getByType(TextInput);
    fireEvent.changeText(input(), 'first');
    act(() => input().props.onSubmitEditing());
    fireEvent.changeText(input(), 'second');
    act(() => input().props.onSubmitEditing());
    expect(onSubmit.mock.calls).toEqual([['first'], ['second']]);
  });
});
