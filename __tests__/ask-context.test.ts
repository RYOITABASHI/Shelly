import {
  buildAmbientCapabilityBlock,
  buildCapabilityGroundingBlock,
  isCapabilityQuestion,
  extractStatus,
  stripStatusTag,
} from '@/lib/ask-context';

describe('isCapabilityQuestion', () => {
  it('matches common English and Japanese capability phrasing', () => {
    expect(isCapabilityQuestion('what can you do?')).toBe(true);
    expect(isCapabilityQuestion('how do I schedule an agent?')).toBe(true);
    expect(isCapabilityQuestion('Shellyは何ができるの？')).toBe(true);
    expect(isCapabilityQuestion('SSH接続できますか？')).toBe(true);
  });

  it('matches kanji 出来る as well as hiragana できる', () => {
    expect(isCapabilityQuestion('何が出来る？')).toBe(true);
    expect(isCapabilityQuestion('何が出来るの？')).toBe(true);
    expect(isCapabilityQuestion('SSH接続出来ますか？')).toBe(true);
    expect(isCapabilityQuestion('これ出来るの？')).toBe(true);
  });

  it('does not match ordinary messages', () => {
    expect(isCapabilityQuestion('fix the null pointer in foo.ts')).toBe(false);
    expect(isCapabilityQuestion('このエラーを直して')).toBe(false);
    expect(isCapabilityQuestion(undefined)).toBe(false);
  });
});

describe('capability grounding blocks', () => {
  it('keeps the ambient catalog names-only and shorter than the full catalog', () => {
    const ambient = buildAmbientCapabilityBlock();
    const full = buildCapabilityGroundingBlock();

    expect(ambient).toContain('<SHELLY_FEATURES>');
    expect(ambient.length).toBeLessThan(full.length);
    expect(ambient).not.toMatch(/- .+: .+/);
    expect(full).toMatch(/- .+: .+/);
  });

  it('uses a neutral ambient primer and a question-specific upgrade primer', () => {
    expect(buildAmbientCapabilityBlock()).not.toContain("The user's message looks like a question");
    expect(buildCapabilityGroundingBlock()).toContain("The user's message looks like a question");
  });
});

// 2026-07-23: on-device test (local Qwen model, via the new @agent
// capability-question route) found the answer bubble leaking a literal
// "[NOT_AVAILABLE]" line to the user — the original regex was anchored
// exactly to end-of-string with no tolerance for the kind of trailing
// decoration (bold markdown, a closing "。", the tag repeated once) a local
// model actually produces. These cases reproduce that failure class.
describe('extractStatus / stripStatusTag — trailing status tag robustness', () => {
  it('strips a clean trailing tag (the common case)', () => {
    const text = 'Shellyには実装されていません。\n[NOT_AVAILABLE]';
    expect(extractStatus(text)).toBe('NOT_AVAILABLE');
    expect(stripStatusTag(text)).toBe('Shellyには実装されていません。');
  });

  it('strips a tag followed by trailing punctuation (the on-device repro)', () => {
    const text = '...GitHub issue を作成することをお勧めします\n[NOT_AVAILABLE]。';
    expect(extractStatus(text)).toBe('NOT_AVAILABLE');
    expect(stripStatusTag(text)).toBe('...GitHub issue を作成することをお勧めします');
  });

  it('strips a tag wrapped in markdown emphasis', () => {
    const text = 'Available today.\n**[AVAILABLE]**';
    expect(extractStatus(text)).toBe('AVAILABLE');
    expect(stripStatusTag(text)).toBe('Available today.');
  });

  it('strips a tag the model echoed twice at the very end', () => {
    const text = 'On the roadmap.\n[PLANNED]\n[PLANNED]';
    expect(extractStatus(text)).toBe('PLANNED');
    expect(stripStatusTag(text)).toBe('On the roadmap.');
  });

  it('does not strip an unrelated mid-sentence occurrence of a status word', () => {
    const text = 'This mentions AVAILABLE bandwidth in a normal sentence and ends with [PLANNED].';
    expect(extractStatus(text)).toBe('PLANNED');
    expect(stripStatusTag(text)).toBe('This mentions AVAILABLE bandwidth in a normal sentence and ends with');
  });

  it('returns null / unchanged text when no tag is present', () => {
    const text = 'No tag here at all.';
    expect(extractStatus(text)).toBeNull();
    expect(stripStatusTag(text)).toBe('No tag here at all.');
  });
});
