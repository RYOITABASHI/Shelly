jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

import {
  QUOTE_MAX_CHARS,
  chooseQuoteTarget,
  formatQuoteBlock,
  insertQuoteIntoDraft,
  normalizeSelection,
  routeQuoteToAI,
  visibleSlotsOf,
} from '@/lib/quote-to-ai';
import { COMPOSER_INSERT_TTL_MS, usePaneStore } from '@/store/pane-store';

describe('normalizeSelection', () => {
  it('converts CRLF, strips row padding and surrounding blank lines', () => {
    expect(normalizeSelection('\r\n  \nfoo   \r\n  bar\t\n\n   ')).toBe('foo\n  bar');
  });
});

describe('formatQuoteBlock', () => {
  it('returns null for empty / whitespace-only selections', () => {
    expect(formatQuoteBlock('')).toBeNull();
    expect(formatQuoteBlock('   \n \r\n')).toBeNull();
  });

  it('formats a single line as a markdown blockquote', () => {
    expect(formatQuoteBlock('  error: ENOENT   ')).toBe('>   error: ENOENT');
  });

  it('formats multi-line output as a fenced text block', () => {
    expect(formatQuoteBlock('line 1\nline 2')).toBe('```text\nline 1\nline 2\n```');
  });

  it('grows the fence past backtick runs inside the selection', () => {
    const out = formatQuoteBlock('a\n```js\nb\n```');
    expect(out).toBe('````text\na\n```js\nb\n```\n````');
  });

  it('keeps the tail of very long selections with an omission note', () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `row ${i}`);
    const raw = lines.join('\n');
    const out = formatQuoteBlock(raw, { truncationNote: (n) => `[omitted ${n}]` })!;
    const [note, open] = out.split('\n');
    expect(note).toMatch(/^\[omitted \d+\]$/);
    expect(open).toBe('```text');
    expect(out.endsWith('row 1999\n```')).toBe(true);
    const body = out.split('\n').slice(2, -1).join('\n');
    expect(body.length).toBeLessThanOrEqual(QUOTE_MAX_CHARS);
    // Cut snaps to a line start, and the note counts exactly what was dropped.
    expect(body.startsWith('row ')).toBe(true);
    expect(Number(note.match(/\d+/)![0])).toBe(raw.length - body.length);
  });

  it('uses fenced form when a single huge line is truncated', () => {
    const out = formatQuoteBlock('x'.repeat(50), { maxChars: 10 })!;
    expect(out).toBe('[… 40 earlier characters omitted]\n```text\nxxxxxxxxxx\n```');
  });
});

describe('insertQuoteIntoDraft', () => {
  it('fills an empty draft and leaves the cursor below the quote', () => {
    const r = insertQuoteIntoDraft('', '> q');
    expect(r.text).toBe('> q\n\n');
    expect(r.cursor).toBe(r.text.length);
  });

  it('appends after existing text with a blank-line separator', () => {
    const r = insertQuoteIntoDraft('why does this fail?', '> q');
    expect(r.text).toBe('why does this fail?\n\n> q\n\n');
    expect(r.cursor).toBe(r.text.length);
  });

  it('inserts at the cursor and replaces a selected range', () => {
    const r = insertQuoteIntoDraft('before AFTER', '> q', { start: 7, end: 12 });
    expect(r.text).toBe('before \n\n> q\n\n');
    const mid = insertQuoteIntoDraft('head\ntail', '> q', { start: 5, end: 5 });
    expect(mid.text).toBe('head\n\n> q\n\ntail');
    expect(mid.text.slice(mid.cursor)).toBe('tail');
  });

  it('clamps out-of-range selections', () => {
    expect(insertQuoteIntoDraft('ab', '> q', { start: 99, end: -3 }).text).toBe('ab\n\n> q\n\n');
  });
});

describe('chooseQuoteTarget / visibleSlotsOf', () => {
  const slots = [
    { id: 't1', tab: 'terminal' },
    { id: 'c1', tab: 'agent-chat' },
    { id: 'a1', tab: 'ai' },
    null,
  ];

  it('prefers the most-recently-focused composer pane', () => {
    expect(chooseQuoteTarget(slots, ['t1', 'c1', 'a1'])).toEqual({ paneId: 'c1', tab: 'agent-chat' });
  });

  it('falls back to the first AI pane, then Agent Chat', () => {
    expect(chooseQuoteTarget(slots, [])).toEqual({ paneId: 'a1', tab: 'ai' });
    expect(chooseQuoteTarget([slots[0], slots[1]], [])).toEqual({ paneId: 'c1', tab: 'agent-chat' });
    expect(chooseQuoteTarget([slots[0]], ['t1'])).toBeNull();
  });

  it('respects preset capacity and a maximized slot', () => {
    expect(visibleSlotsOf(slots, 2, null)).toEqual([slots[0], slots[1]]);
    expect(visibleSlotsOf(slots, 4, 0)).toEqual([slots[0]]);
  });
});

describe('pane-store composer insert', () => {
  beforeEach(() => {
    usePaneStore.setState({ focusedPaneId: null, focusHistory: [], pendingComposerInsert: null });
  });

  it('tracks focus history newest-first without duplicates', () => {
    const s = usePaneStore.getState();
    s.setFocusedPane('a');
    s.setFocusedPane('b');
    s.setFocusedPane('a');
    expect(usePaneStore.getState().focusHistory).toEqual(['a', 'b']);
  });

  it('only the targeted pane+tab can claim, exactly once', () => {
    usePaneStore.getState().queueComposerInsert({ paneId: 'a1', tab: 'ai', text: '> q' });
    expect(usePaneStore.getState().takeComposerInsert('other', 'ai')).toBeNull();
    expect(usePaneStore.getState().takeComposerInsert('a1', 'agent-chat')).toBeNull();
    expect(usePaneStore.getState().takeComposerInsert('a1', 'ai')?.text).toBe('> q');
    expect(usePaneStore.getState().takeComposerInsert('a1', 'ai')).toBeNull();
  });

  it('drops an expired insert', () => {
    usePaneStore.setState({
      pendingComposerInsert: { paneId: 'a1', tab: 'ai', text: '> q', createdAt: Date.now() - COMPOSER_INSERT_TTL_MS - 1 },
    });
    expect(usePaneStore.getState().takeComposerInsert('a1', 'ai')).toBeNull();
    expect(usePaneStore.getState().pendingComposerInsert).toBeNull();
  });
});

describe('routeQuoteToAI', () => {
  const makeDeps = (overrides: Partial<Parameters<typeof routeQuoteToAI>[1]> = {}) => ({
    getVisibleSlots: () => [{ id: 't1', tab: 'terminal' }, { id: 'a1', tab: 'ai' }],
    getFocusHistory: () => ['t1'],
    focusPane: jest.fn(),
    openAiPane: jest.fn(() => 'new-ai'),
    queue: jest.fn(),
    ...overrides,
  });

  it('queues the formatted quote for the visible AI pane without opening a new one', () => {
    const deps = makeDeps();
    expect(routeQuoteToAI('boom', deps)).toBe('ai');
    expect(deps.focusPane).toHaveBeenCalledWith('a1');
    expect(deps.openAiPane).not.toHaveBeenCalled();
    expect(deps.queue).toHaveBeenCalledWith({ paneId: 'a1', tab: 'ai', text: '> boom' });
  });

  it('opens an AI pane when no composer is visible', () => {
    const deps = makeDeps({ getVisibleSlots: () => [{ id: 't1', tab: 'terminal' }] });
    expect(routeQuoteToAI('boom', deps)).toBe('ai');
    expect(deps.queue).toHaveBeenCalledWith({ paneId: 'new-ai', tab: 'ai', text: '> boom' });
  });

  it('queues nothing for an empty selection or when no pane can be opened', () => {
    const empty = makeDeps();
    expect(routeQuoteToAI('  \n', empty)).toBeNull();
    expect(empty.queue).not.toHaveBeenCalled();
    const full = makeDeps({ getVisibleSlots: () => [], openAiPane: jest.fn(() => null) });
    expect(routeQuoteToAI('boom', full)).toBeNull();
    expect(full.queue).not.toHaveBeenCalled();
  });
});
