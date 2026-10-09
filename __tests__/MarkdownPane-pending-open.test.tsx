/**
 * openMarkdownFile() called while no MarkdownPane is mounted (lib/open-file.ts
 * just added the pane; it renders on the next frame) must queue the path and
 * load it on mount. Previously it returned silently and the content was lost.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: { addListener: jest.fn(() => ({ remove: jest.fn() })) },
}));
jest.mock('@/hooks/use-native-exec', () => ({
  execCommand: jest.fn(async (cmd: string) => ({
    exitCode: 0,
    stdout: `# Report\n\nBody for ${cmd.includes('second') ? 'second' : 'first'} file.\n`,
    stderr: '',
  })),
}));
jest.mock('@/components/multi-pane/PaneSlot', () => {
  const R = require('react');
  return { MultiPaneContext: R.createContext(null), PaneIdContext: R.createContext(null) };
});
jest.mock('@/components/panes/PaneInputBar', () => ({ __esModule: true, default: () => null }));

import React from 'react';
import { act, render, waitFor } from '@testing-library/react-native';
import MarkdownPane, {
  getPendingMarkdownPath,
  isMarkdownPaneMounted,
  openMarkdownFile,
} from '@/components/panes/MarkdownPane';

describe('MarkdownPane pending open', () => {
  it('queues a path opened before mount and renders it once the pane mounts', async () => {
    expect(isMarkdownPaneMounted()).toBe(false);
    await openMarkdownFile('/home/out/first.md');
    expect(getPendingMarkdownPath()).toBe('/home/out/first.md');

    const screen = render(<MarkdownPane />);
    await waitFor(() => expect(screen.getByText('Body for first file.', { exact: false })).toBeTruthy());
    expect(getPendingMarkdownPath()).toBeNull();
    screen.unmount();
    expect(isMarkdownPaneMounted()).toBe(false);
  });

  it('loads directly into an already-mounted pane', async () => {
    const screen = render(<MarkdownPane />);
    await act(async () => {
      await openMarkdownFile('/home/out/second.md');
    });
    expect(screen.getByText('Body for second file.', { exact: false })).toBeTruthy();
    expect(getPendingMarkdownPath()).toBeNull();
    screen.unmount();
  });
});
