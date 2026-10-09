/**
 * Root fix (2026-10-09): useTheme() (hooks/use-theme) and lib/theme-engine's
 * useTheme() must return the LIVE preset palette — not a module-load copy
 * of the dark seed — and must hand out a new colors identity when the
 * preset changes so memoized consumers recompute.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: { addListener: jest.fn(() => ({ remove: jest.fn() })) },
}));

import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { act, render } from '@testing-library/react-native';
import { useTheme } from '@/hooks/use-theme';
import { useTheme as useEngineTheme } from '@/lib/theme-engine';
import { applyThemePreset, caseFilePalette, themePresets } from '@/lib/theme-presets';
import { colors as C } from '@/theme.config';
import { MarkdownRenderer } from '@/components/preview/renderers/MarkdownRenderer';
import { createThemedStyles } from '@/lib/themed-stylesheet';

const seed = { ...C };

afterEach(() => {
  act(() => applyThemePreset('blue'));
  Object.assign(C, seed);
});

function colorOf(screen: ReturnType<typeof render>, testID: string, key: 'color' | 'backgroundColor' = 'color') {
  return StyleSheet.flatten(screen.getByTestId(testID).props.style)?.[key];
}

/** Mirrors the common consumer pattern: styles memoized on `colors`. */
function MemoProbe() {
  const { colors } = useTheme();
  const styles = useMemo(
    () => ({ text: { color: colors.foreground }, box: { backgroundColor: colors.background } }),
    [colors],
  );
  return (
    <View testID="box" style={styles.box}>
      <Text testID="text" style={styles.text}>probe</Text>
    </View>
  );
}

function EngineProbe() {
  const theme = useEngineTheme();
  const styles = useMemo(() => ({ text: { color: theme.colors.foreground } }), [theme]);
  return <Text testID="engine" style={styles.text}>engine</Text>;
}

const moduleStyles = createThemedStyles(() => ({ t: { color: C.text1 } }));
function ThemedStylesProbe() {
  useTheme();
  return <Text testID="themed" style={moduleStyles.t}>themed</Text>;
}

describe('live theme palette', () => {
  it('maps preset tokens to useTheme() keys for the default preset and Case File', () => {
    act(() => applyThemePreset('blue'));
    const screen = render(<MemoProbe />);
    expect(colorOf(screen, 'text')).toBe(themePresets.blue.colors.text1);
    expect(colorOf(screen, 'box', 'backgroundColor')).toBe(themePresets.blue.colors.bgDeep);
    screen.unmount();

    act(() => applyThemePreset('case-file'));
    const cf = render(<MemoProbe />);
    expect(colorOf(cf, 'text')).toBe(caseFilePalette.text1);
    expect(colorOf(cf, 'box', 'backgroundColor')).toBe(caseFilePalette.bgDeep);
  });

  it('updates memoized useTheme() consumers when the preset switches at runtime (no remount)', () => {
    act(() => applyThemePreset('blue'));
    const screen = render(<MemoProbe />);
    const before = colorOf(screen, 'text');
    expect(before).toBe(themePresets.blue.colors.text1);

    act(() => applyThemePreset('case-file'));
    expect(colorOf(screen, 'text')).toBe(caseFilePalette.text1);
    expect(colorOf(screen, 'box', 'backgroundColor')).toBe(caseFilePalette.bgDeep);
    expect(colorOf(screen, 'text')).not.toBe(before);

    act(() => applyThemePreset('blue'));
    expect(colorOf(screen, 'text')).toBe(themePresets.blue.colors.text1);
  });

  it('lib/theme-engine useTheme() (Shelly Default) follows the app preset', () => {
    act(() => applyThemePreset('blue'));
    const screen = render(<EngineProbe />);
    expect(colorOf(screen, 'engine')).toBe(themePresets.blue.colors.text1);
    act(() => applyThemePreset('case-file'));
    expect(colorOf(screen, 'engine')).toBe(caseFilePalette.text1);
  });

  it('createThemedStyles module styles rebuild on a runtime preset switch', () => {
    act(() => applyThemePreset('blue'));
    const screen = render(<ThemedStylesProbe />);
    expect(colorOf(screen, 'themed')).toBe(themePresets.blue.colors.text1);
    act(() => applyThemePreset('case-file'));
    expect(colorOf(screen, 'themed')).toBe(caseFilePalette.text1);
  });

  it('MarkdownRenderer body ink follows a runtime switch to Case File', () => {
    act(() => applyThemePreset('blue'));
    const screen = render(<MarkdownRenderer content={'Body paragraph text.'} />);
    const ink = () => StyleSheet.flatten(screen.getByText('Body paragraph text.', { exact: false }).props.style)?.color;
    expect(ink()).toBe(themePresets.blue.colors.text1);
    act(() => applyThemePreset('case-file'));
    expect(ink()).toBe(caseFilePalette.text1);
  });
});
