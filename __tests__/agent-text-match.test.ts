import { tokenizeForMatch, tokenizeWithCounts } from '@/lib/agent-text-match';

describe('tokenizeForMatch', () => {
  it('emits Latin/digit word tokens (length >= 2)', () => {
    const t = tokenizeForMatch('Summarize the crypto market q1');
    expect(t.has('summarize')).toBe(true);
    expect(t.has('crypto')).toBe(true);
    expect(t.has('q1')).toBe(true);
    expect(t.has('a')).toBe(false); // single char dropped
  });

  it('emits CJK character bigrams so Japanese overlaps without word spaces', () => {
    const t = tokenizeForMatch('簡潔な箇条書き要約');
    expect(t.has('簡潔')).toBe(true);
    expect(t.has('箇条')).toBe(true);
    expect(t.has('要約')).toBe(true);
  });

  it('two similar Japanese phrases share bigrams (the reuse/recall fix)', () => {
    const a = tokenizeForMatch('私は簡潔な箇条書き要約が好み');
    const b = tokenizeForMatch('ニュースを簡潔な箇条書きで要約');
    const shared = [...a].filter((tok) => b.has(tok));
    // Before the fix these collapsed to one giant token and shared nothing.
    expect(shared).toEqual(expect.arrayContaining(['簡潔', '箇条', '条書']));
    expect(shared.length).toBeGreaterThanOrEqual(3);
  });

  it('unrelated Japanese phrases share few/no bigrams', () => {
    const a = tokenizeForMatch('天気予報を教えて');
    const b = tokenizeForMatch('株価のグラフを描画');
    const shared = [...a].filter((tok) => b.has(tok));
    expect(shared.length).toBeLessThan(3);
  });
});

// tokenizeWithCounts (2026-08-03, added for BM25-style term-frequency scoring
// in lib/agent-memory.ts): same token rules as tokenizeForMatch, but a
// Map<token, count> instead of a Set — the whole point is NOT collapsing
// repeats, since BM25's tf(t, D) needs exactly that count.
describe('tokenizeWithCounts', () => {
  it('counts repeated Latin tokens instead of collapsing them like tokenizeForMatch does', () => {
    const counts = tokenizeWithCounts('crypto crypto crypto market summary');
    expect(counts.get('crypto')).toBe(3);
    expect(counts.get('market')).toBe(1);
    expect(counts.get('summary')).toBe(1);
  });

  it('counts repeated CJK bigrams the same way', () => {
    const counts = tokenizeWithCounts('要約して要約して');
    expect(counts.get('要約')).toBe(2);
  });

  it('produces the exact same token VOCABULARY as tokenizeForMatch (only the counting differs)', () => {
    const text = 'Summarize the crypto crypto market 簡潔な要約';
    const asSet = tokenizeForMatch(text);
    const asCounts = tokenizeWithCounts(text);
    expect(new Set(asCounts.keys())).toEqual(asSet);
  });

  it('returns an empty map for text with no matchable tokens', () => {
    expect(tokenizeWithCounts('').size).toBe(0);
    expect(tokenizeWithCounts('a . , !').size).toBe(0); // single-char Latin dropped
  });
});
