import { tokenizeForMatch } from '@/lib/agent-text-match';

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
