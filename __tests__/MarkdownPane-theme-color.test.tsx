jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: { addListener: jest.fn(() => ({ remove: jest.fn() })) },
}));
jest.mock('@/hooks/use-native-exec', () => ({
  execCommand: jest.fn(async () => ({
    exitCode: 0,
    stdout: '# On-Device AI News Briefing\n\nBody paragraph text.\n\n- **Label:** list item\n\n### 1. Item\n',
    stderr: '',
  })),
}));
jest.mock('@/components/multi-pane/PaneSlot', () => {
  const R = require('react');
  return { MultiPaneContext: R.createContext(null), PaneIdContext: R.createContext(null) };
});
jest.mock('@/components/panes/PaneInputBar', () => ({ __esModule: true, default: () => null }));

import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { act, render } from '@testing-library/react-native';
import MarkdownPane, { openMarkdownFile } from '@/components/panes/MarkdownPane';
import { colors as C } from '@/theme.config';
import { caseFilePalette } from '@/lib/theme-presets';

const seed = { ...C };

afterAll(() => {
  Object.assign(C, seed);
});

function colorOf(screen: ReturnType<typeof render>, text: string): string | undefined {
  const node = screen.getByText(text, { exact: false });
  return StyleSheet.flatten(node.props.style)?.color;
}

describe('MarkdownPane on the Case File (light) preset', () => {
  it('renders body/list/bold text in the dark foreground ink, not the dark-theme #ECEDEE', async () => {
    // applyThemePreset('case-file') mutates theme.config colors in place.
    Object.assign(C, caseFilePalette);
    const screen = render(<MarkdownPane />);
    await act(async () => {
      await openMarkdownFile('/tmp/brief.md');
    });
    expect(colorOf(screen, 'Body paragraph text.')).toBe(caseFilePalette.text1);
    expect(colorOf(screen, 'list item')).toBe(caseFilePalette.text1);
    expect(colorOf(screen, 'Label:')).toBe(caseFilePalette.text1);
    for (const t of screen.UNSAFE_getAllByType(Text)) {
      const color = StyleSheet.flatten(t.props.style)?.color;
      expect(color).not.toBe('#ECEDEE');
      expect(color).not.toBe('#FFFFFF');
    }
  });
});
