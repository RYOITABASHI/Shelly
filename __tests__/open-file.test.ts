/**
 * lib/open-file.ts routing against the REAL multi-pane store (unit project:
 * the jest-expo component project can't instantiate use-multi-pane's persist
 * store, so the MarkdownPane mount/pending-load half lives in
 * __tests__/MarkdownPane-pending-open.test.tsx).
 *
 * Bug: openFile('x.md') used to call openMarkdownFile directly, which
 * returned silently when no MarkdownPane was mounted — "Open x.md" links
 * did nothing unless a Markdown pane was already open.
 */
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));
jest.mock('react-native', () => ({ ToastAndroid: { show: jest.fn(), SHORT: 0 } }));
jest.mock('@/components/panes/MarkdownPane', () => ({ openMarkdownFile: jest.fn(async () => {}) }));

import { ToastAndroid } from 'react-native';
import { openMarkdownFile } from '@/components/panes/MarkdownPane';
import { resolveSinglePaneSlot, useMultiPaneStore, type Slot } from '@/hooks/use-multi-pane';
import { usePreviewStore } from '@/store/preview-store';
import { usePaneStore } from '@/store/pane-store';
import { openFile } from '@/lib/open-file';

const ratios = { mainH: 0.5, mainV: 0.5, rightV: 0.5, leftV: 0.5, bottomH: 0.5, topH: 0.5 };

function setLayout(
  preset: 'p1' | 'p2h' | 'p4',
  slots: [Slot, Slot, Slot, Slot],
  focusedSlot: 0 | 1 | 2 | 3,
) {
  useMultiPaneStore.setState({ preset, slots, focusedSlot, ratios, maximizedSlot: null, _hasHydrated: true });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  usePreviewStore.setState({
    isOpen: false, activeTab: 'files', activeCodeFile: null, detectedUrls: [], bannerUrl: null,
  });
});
afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

describe('openFile — markdown', () => {
  it('adds and focuses a Markdown pane when none exists, then hands the path to it', async () => {
    setLayout('p1', [{ id: 'pane-ai', tab: 'ai' }, null, null, null], 0);
    await openFile('/home/out/first.md');

    const { slots, focusedSlot, preset } = useMultiPaneStore.getState();
    expect(slots[focusedSlot]?.tab).toBe('markdown');
    expect(preset).toBe('p2h');
    expect(usePaneStore.getState().focusedPaneId).toBe(slots[focusedSlot]?.id);
    expect(openMarkdownFile).toHaveBeenCalledWith('/home/out/first.md');
  });

  it('reuses an existing Markdown pane instead of adding another', async () => {
    setLayout('p2h', [{ id: 'pane-ai', tab: 'ai' }, { id: 'pane-md', tab: 'markdown' }, null, null], 0);
    await openFile('/home/out/second.md');

    const { slots, focusedSlot } = useMultiPaneStore.getState();
    expect(slots.filter((s) => s?.tab === 'markdown')).toHaveLength(1);
    expect(slots[focusedSlot]?.id).toBe('pane-md');
    expect(openMarkdownFile).toHaveBeenCalledWith('/home/out/second.md');
  });

  it('switches the visible pane to Markdown on a compact (single-pane) layout', async () => {
    // p1 preset with the markdown pane hidden behind the AI pane.
    setLayout('p1', [{ id: 'pane-ai', tab: 'ai' }, { id: 'pane-md', tab: 'markdown' }, null, null], 0);
    await openFile('/home/out/first.md');

    const { slots, focusedSlot } = useMultiPaneStore.getState();
    // MultiPaneContainer renders only resolveSinglePaneSlot() on compact.
    expect(slots[resolveSinglePaneSlot(slots, focusedSlot)]?.id).toBe('pane-md');
  });

  it('un-maximizes another pane so the Markdown pane is actually visible', async () => {
    setLayout('p2h', [{ id: 'pane-ai', tab: 'ai' }, { id: 'pane-md', tab: 'markdown' }, null, null], 0);
    useMultiPaneStore.setState({ maximizedSlot: 0 });
    await openFile('/home/out/first.md');
    expect(useMultiPaneStore.getState().maximizedSlot).toBeNull();
    expect(useMultiPaneStore.getState().focusedSlot).toBe(1);
  });

  it('repurposes a non-terminal, non-chat slot when the 4-pane grid is full', async () => {
    setLayout('p4', [
      { id: 't1', tab: 'terminal', sessionId: 's1' },
      { id: 'pane-ai', tab: 'ai' },
      { id: 'pane-browser', tab: 'browser' },
      { id: 't2', tab: 'terminal', sessionId: 's2' },
    ], 0);
    await openFile('/home/out/first.md');

    const { slots, focusedSlot } = useMultiPaneStore.getState();
    expect(slots[2]).toEqual({ id: 'pane-browser', tab: 'markdown' });
    expect(focusedSlot).toBe(2);
    expect(slots[0]?.tab).toBe('terminal');
    expect(slots[1]?.tab).toBe('ai');
    expect(slots[3]?.tab).toBe('terminal');
    expect(openMarkdownFile).toHaveBeenCalled();
  });

  it('toasts instead of silently no-oping when no pane can be shown', async () => {
    setLayout('p4', [
      { id: 't1', tab: 'terminal', sessionId: 's1' },
      { id: 't2', tab: 'terminal', sessionId: 's2' },
      { id: 't3', tab: 'terminal', sessionId: 's3' },
      { id: 't4', tab: 'terminal', sessionId: 's4' },
    ], 0);
    await openFile('/home/out/first.md');

    expect(ToastAndroid.show).toHaveBeenCalledWith(expect.stringContaining('first.md'), 0);
    expect(openMarkdownFile).not.toHaveBeenCalled();
  });
});

describe('openFile — non-markdown', () => {
  it('adds a Preview pane on the Code tab when no preview pane / focused terminal exists', async () => {
    setLayout('p1', [{ id: 'pane-ai', tab: 'ai' }, null, null, null], 0);
    usePreviewStore.setState({ detectedUrls: ['http://localhost:3000'] });
    await openFile('/home/src/app.ts');

    const { slots, focusedSlot } = useMultiPaneStore.getState();
    expect(slots[focusedSlot]?.tab).toBe('preview');
    const preview = usePreviewStore.getState();
    expect(preview.activeTab).toBe('code');
    expect(preview.activeCodeFile).toBe('/home/src/app.ts');
  });

  it('focuses an existing Preview pane', async () => {
    setLayout('p2h', [{ id: 'pane-ai', tab: 'ai' }, { id: 'pane-pv', tab: 'preview' }, null, null], 0);
    await openFile('/home/src/app.ts');
    expect(useMultiPaneStore.getState().focusedSlot).toBe(1);
    expect(useMultiPaneStore.getState().slots.filter(Boolean)).toHaveLength(2);
  });

  it('opens the inline preview in a focused terminal pane without adding a pane, on the Code tab', async () => {
    setLayout('p1', [{ id: 't1', tab: 'terminal', sessionId: 's1' }, null, null, null], 0);
    usePreviewStore.setState({ detectedUrls: ['http://localhost:3000'] });
    await openFile('/home/src/app.ts');

    expect(useMultiPaneStore.getState().slots.filter(Boolean)).toHaveLength(1);
    const preview = usePreviewStore.getState();
    expect(preview.isOpen).toBe(true);
    // openPreview() picks 'web' when a URL was detected; Code must win.
    expect(preview.activeTab).toBe('code');
  });
});
