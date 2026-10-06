jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));
// quote-to-ai-dispatch pulls in the multi-pane store / pane focus / i18n;
// only waitForComposerClaim (pure pane-store wiring) is exercised here.
jest.mock('@/hooks/use-multi-pane', () => ({ PRESET_CAPACITY: {}, useMultiPaneStore: { getState: jest.fn() } }));
jest.mock('@/lib/pane-focus', () => ({ focusPaneByTab: jest.fn() }));
jest.mock('@/lib/i18n', () => ({ t: (key: string) => key }));

import {
  QUOTE_CLAIM_TIMEOUT_MS,
  QUOTE_MAX_CHARS,
  chooseQuoteTarget,
  formatQuoteBlock,
  insertQuoteIntoDraft,
  normalizeSelection,
  routeQuoteToAI,
  visibleSlotsOf,
  type RouteQuoteDeps,
} from '@/lib/quote-to-ai';
import { waitForComposerClaim } from '@/lib/quote-to-ai-dispatch';
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

  it.each([
    ['trail "\\n\\n" (after has no newline)', 'tail', '> q\n\ntail'],
    ['trail "\\n" (after starts with one newline)', '\ntail', '> q\n\ntail'],
    ['trail "" (after starts with a blank line)', '\n\ntail', '> q\n\ntail'],
    ['after starts with three newlines', '\n\n\ntail', '> q\n\n\ntail'],
  ])('puts the cursor right past the blank-line separator: %s', (_label, after, expected) => {
    const r = insertQuoteIntoDraft(after, '> q', { start: 0, end: 0 });
    expect(r.text).toBe(expected);
    // Cursor = quote end + exactly two newlines, regardless of how many of
    // them came from `trail` vs. the existing text after the cursor.
    expect(r.text.slice(0, r.cursor)).toBe('> q\n\n');
    expect(r.cursor).toBeLessThanOrEqual(r.text.length);
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

  it('skips blocked panes (secure API-key entry / Agent Chat without a session)', () => {
    // Agent Chat was focused last but has no session → AI pane instead.
    expect(chooseQuoteTarget(slots, ['c1'], (id) => id === 'c1')).toEqual({ paneId: 'a1', tab: 'ai' });
    // AI pane is in masked API-key entry → Agent Chat.
    expect(chooseQuoteTarget(slots, ['a1'], (id) => id === 'a1')).toEqual({ paneId: 'c1', tab: 'agent-chat' });
    expect(chooseQuoteTarget(slots, [], () => true)).toBeNull();
  });

  it('respects preset capacity and a maximized slot', () => {
    expect(visibleSlotsOf(slots, 2, null)).toEqual([slots[0], slots[1]]);
    expect(visibleSlotsOf(slots, 4, 0)).toEqual([slots[0]]);
  });
});

describe('pane-store composer insert', () => {
  beforeEach(() => {
    usePaneStore.setState({
      focusedPaneId: null,
      focusHistory: [],
      pendingComposerInsert: null,
      composerQuoteBlocked: {},
      lastClaimedInsertId: null,
    });
  });

  it('tracks focus history newest-first without duplicates', () => {
    const s = usePaneStore.getState();
    s.setFocusedPane('a');
    s.setFocusedPane('b');
    s.setFocusedPane('a');
    expect(usePaneStore.getState().focusHistory).toEqual(['a', 'b']);
  });

  it('only the targeted pane+tab can claim, exactly once, and records the claim', () => {
    const id = usePaneStore.getState().queueComposerInsert({ paneId: 'a1', tab: 'ai', text: '> q' });
    expect(usePaneStore.getState().takeComposerInsert('other', 'ai')).toBeNull();
    expect(usePaneStore.getState().takeComposerInsert('a1', 'agent-chat')).toBeNull();
    expect(usePaneStore.getState().lastClaimedInsertId).toBeNull();
    expect(usePaneStore.getState().takeComposerInsert('a1', 'ai')?.text).toBe('> q');
    expect(usePaneStore.getState().lastClaimedInsertId).toBe(id);
    expect(usePaneStore.getState().takeComposerInsert('a1', 'ai')).toBeNull();
  });

  it('a blocked pane (secure entry / no session) cannot claim', () => {
    const s = usePaneStore.getState();
    s.setComposerQuoteBlocked('a1', true);
    s.queueComposerInsert({ paneId: 'a1', tab: 'ai', text: '> secret?' });
    expect(usePaneStore.getState().takeComposerInsert('a1', 'ai')).toBeNull();
    expect(usePaneStore.getState().pendingComposerInsert).not.toBeNull();
    usePaneStore.getState().setComposerQuoteBlocked('a1', false);
    expect(usePaneStore.getState().composerQuoteBlocked).toEqual({});
    expect(usePaneStore.getState().takeComposerInsert('a1', 'ai')?.text).toBe('> secret?');
  });

  it('drops an expired insert', () => {
    usePaneStore.setState({
      pendingComposerInsert: { id: 99, paneId: 'a1', tab: 'ai', text: '> q', createdAt: Date.now() - COMPOSER_INSERT_TTL_MS - 1 },
    });
    expect(usePaneStore.getState().takeComposerInsert('a1', 'ai')).toBeNull();
    expect(usePaneStore.getState().pendingComposerInsert).toBeNull();
  });

  it('queueing replaces a stale/expired entry with a fresh one', () => {
    usePaneStore.setState({
      pendingComposerInsert: { id: 99, paneId: 'gone', tab: 'ai', text: 'old', createdAt: 0 },
    });
    const id = usePaneStore.getState().queueComposerInsert({ paneId: 'a1', tab: 'ai', text: 'new' });
    const pending = usePaneStore.getState().pendingComposerInsert!;
    expect(pending.id).toBe(id);
    expect(pending.text).toBe('new');
    expect(Date.now() - pending.createdAt).toBeLessThan(1000);
  });

  it('releasing (closing) the target pane drops its pending quote and block flag', () => {
    const s = usePaneStore.getState();
    s.setComposerQuoteBlocked('c1', true);
    s.queueComposerInsert({ paneId: 'a1', tab: 'ai', text: '> q' });
    usePaneStore.getState().releaseComposerPane('c1');
    expect(usePaneStore.getState().pendingComposerInsert).not.toBeNull(); // other pane: kept
    expect(usePaneStore.getState().composerQuoteBlocked).toEqual({});
    usePaneStore.getState().releaseComposerPane('a1');
    expect(usePaneStore.getState().pendingComposerInsert).toBeNull();
  });

  it('cancelComposerInsert only drops the matching id', () => {
    const first = usePaneStore.getState().queueComposerInsert({ paneId: 'a1', tab: 'ai', text: '1' });
    const second = usePaneStore.getState().queueComposerInsert({ paneId: 'a1', tab: 'ai', text: '2' });
    usePaneStore.getState().cancelComposerInsert(first);
    expect(usePaneStore.getState().pendingComposerInsert?.id).toBe(second);
    usePaneStore.getState().cancelComposerInsert(second);
    expect(usePaneStore.getState().pendingComposerInsert).toBeNull();
  });

  it('waitForComposerClaim resolves true on claim and false on timeout', async () => {
    jest.useFakeTimers();
    try {
      const id = usePaneStore.getState().queueComposerInsert({ paneId: 'a1', tab: 'ai', text: '> q' });
      const claimed = waitForComposerClaim(id, 500);
      usePaneStore.getState().takeComposerInsert('a1', 'ai');
      await expect(claimed).resolves.toBe(true);

      const id2 = usePaneStore.getState().queueComposerInsert({ paneId: 'a1', tab: 'ai', text: '> q2' });
      const timedOut = waitForComposerClaim(id2, 500);
      jest.advanceTimersByTime(501);
      await expect(timedOut).resolves.toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('routeQuoteToAI', () => {
  const makeDeps = (overrides: Partial<RouteQuoteDeps> = {}) => {
    const deps = {
      getVisibleSlots: () => [{ id: 't1', tab: 'terminal' }, { id: 'a1', tab: 'ai' }],
      getFocusHistory: () => ['t1'],
      isBlocked: () => false,
      focusPane: jest.fn(),
      openAiPane: jest.fn((): string | null => 'new-ai'),
      queue: jest.fn(() => 7),
      waitForClaim: jest.fn(async () => true),
      cancel: jest.fn(),
      ...overrides,
    };
    return deps;
  };

  it('queues the formatted quote for the visible AI pane and resolves after the claim', async () => {
    const deps = makeDeps();
    await expect(routeQuoteToAI('boom', deps)).resolves.toBe('ai');
    expect(deps.focusPane).toHaveBeenCalledWith('a1');
    expect(deps.openAiPane).not.toHaveBeenCalled();
    expect(deps.queue).toHaveBeenCalledWith({ paneId: 'a1', tab: 'ai', text: '> boom' });
    expect(deps.waitForClaim).toHaveBeenCalledWith(7, QUOTE_CLAIM_TIMEOUT_MS);
    expect(deps.cancel).not.toHaveBeenCalled();
  });

  it('opens an AI pane when no composer is visible', async () => {
    const deps = makeDeps({ getVisibleSlots: () => [{ id: 't1', tab: 'terminal' }] });
    await expect(routeQuoteToAI('boom', deps)).resolves.toBe('ai');
    expect(deps.queue).toHaveBeenCalledWith({ paneId: 'new-ai', tab: 'ai', text: '> boom' });
  });

  it('never queues into a blocked AI pane (masked API-key entry)', async () => {
    const deps = makeDeps({
      getVisibleSlots: () => [{ id: 'a1', tab: 'ai' }],
      isBlocked: (id) => id === 'a1',
      openAiPane: jest.fn(() => 'a1'), // focusPaneByTab returns the same blocked pane
    });
    await expect(routeQuoteToAI('boom', deps)).resolves.toBeNull();
    expect(deps.queue).not.toHaveBeenCalled();
  });

  it('reports failure and drops the entry when the composer never claims', async () => {
    const deps = makeDeps({ waitForClaim: jest.fn(async () => false) });
    await expect(routeQuoteToAI('boom', deps)).resolves.toBeNull();
    expect(deps.cancel).toHaveBeenCalledWith(7);
  });

  it('queues nothing for an empty selection or when no pane can be opened', async () => {
    const empty = makeDeps();
    await expect(routeQuoteToAI('  \n', empty)).resolves.toBeNull();
    expect(empty.queue).not.toHaveBeenCalled();
    const full = makeDeps({ getVisibleSlots: () => [], openAiPane: jest.fn(() => null) });
    await expect(routeQuoteToAI('boom', full)).resolves.toBeNull();
    expect(full.queue).not.toHaveBeenCalled();
  });
});
