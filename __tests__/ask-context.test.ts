import {
  buildAmbientCapabilityBlock,
  buildCapabilityGroundingBlock,
  isCapabilityQuestion,
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
