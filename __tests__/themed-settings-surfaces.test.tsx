/**
 * Settings / Local LLM catalog surfaces follow the ACTIVE theme preset
 * (2026-10-06 product-owner report: Settings → Developer → "Local LLM ·
 * llama.cpp" rendered a hardcoded black/teal palette under Case File).
 *
 * Module-level StyleSheet.create() froze the load-time (blue/dark) palette;
 * createThemedStyles() rebuilds on every theme-version bump, so after an
 * in-place palette swap the rendered styles carry the new preset's colors.
 */
import React from 'react';
import { render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { colors as C } from '@/theme.config';
import { caseFilePalette } from '@/lib/theme-presets';
import { useThemeVersionStore } from '@/store/theme-version-store';
import { createThemedStyles } from '@/lib/themed-stylesheet';
import { withAlpha } from '@/lib/theme-utils';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@expo/vector-icons/MaterialIcons', () => {
  const { Text } = require('react-native');
  const Icon = (p: { name: string; color?: string }) => <Text testID={`icon-${p.name}`} style={{ color: p.color }}>{p.name}</Text>;
  return { __esModule: true, default: Icon };
});
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import { ModalHeader } from '@/components/settings/ModalHeader';
import { LlamaCppSection } from '@/components/settings/LlamaCppSection';

const seed = { ...C };

function swapToCaseFile() {
  Object.assign(C, caseFilePalette);
  useThemeVersionStore.getState().bumpVersion();
}

afterEach(() => {
  Object.assign(C, seed);
  useThemeVersionStore.getState().bumpVersion();
});

const flat = (s: unknown) => StyleSheet.flatten(s as any) ?? {};

describe('createThemedStyles', () => {
  it('rebuilds styles after a palette swap + version bump', () => {
    const styles = createThemedStyles(() => ({ box: { backgroundColor: C.bgSurface, color: C.text1 } }));
    expect(styles.box.backgroundColor).toBe(seed.bgSurface);
    swapToCaseFile();
    expect(styles.box.backgroundColor).toBe(caseFilePalette.bgSurface);
    expect(styles.box.color).toBe(caseFilePalette.text1);
  });
});

describe('withAlpha', () => {
  it('handles live tokens safely', () => {
    expect(withAlpha('#2A2416', 0.5)).toBe('rgba(42,36,22,0.5)');
    expect(withAlpha('#abc', 1)).toBe('rgba(170,187,204,1)');
    expect(withAlpha('rgba(1,2,3,0.4)', 0.5)).toBe('rgba(1,2,3,0.4)');
  });
});

describe('settings surfaces under the Case File preset', () => {
  it('ModalHeader title + back text use the active palette', () => {
    swapToCaseFile();
    const { getByText } = render(<ModalHeader title="Local LLM" onClose={() => {}} />);
    expect(flat(getByText('Local LLM').props.style).color).toBe(caseFilePalette.accent);
    // and switching back to the seed palette follows live, no reload needed
    Object.assign(C, seed);
    useThemeVersionStore.getState().bumpVersion();
    const again = render(<ModalHeader title="Again" onClose={() => {}} />);
    expect(flat(again.getByText('Again').props.style).color).toBe(seed.accent);
  });

  it('LlamaCppSection catalog renders the Case File palette, not the hardcoded black/teal one', () => {
    swapToCaseFile();
    const { UNSAFE_root } = render(
      <LlamaCppSection
        isConnected={false}
        activeModelId={null}
        installedModelIds={new Set()}
        onSelectModel={() => {}}
        onRunCommand={async () => ({ success: false })}
        onUpdateLocalLlmUrl={() => {}}
      />,
    );
    const colors = new Set<string>();
    UNSAFE_root.findAll(() => true).forEach((n: any) => {
      const s = flat(n.props?.style);
      for (const k of ['color', 'backgroundColor', 'borderColor']) if (typeof s[k] === 'string') colors.add(s[k].toUpperCase());
    });
    // The old hardcoded dark palette must be gone…
    for (const legacy of ['#1A1A1A', '#00D4AA', '#2D2D2D', '#E8E8E8', '#0D0D0D']) {
      expect(colors.has(legacy)).toBe(false);
    }
    // …and the Case File cream surface / ink text must be present.
    expect(colors.has(caseFilePalette.bgSurface.toUpperCase())).toBe(true);
    expect(colors.has(caseFilePalette.text1.toUpperCase()) || colors.has(caseFilePalette.accent.toUpperCase())).toBe(true);
  });
});
