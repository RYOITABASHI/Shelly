import { isConfirmPhrase } from '@/lib/agent-confirm-phrase';

describe('isConfirmPhrase', () => {
  it('matches the listed English phrases exactly, case-insensitively', () => {
    expect(isConfirmPhrase('ok')).toBe(true);
    expect(isConfirmPhrase('OK')).toBe(true);
    expect(isConfirmPhrase('  Okay  ')).toBe(true);
    expect(isConfirmPhrase('yes')).toBe(true);
    expect(isConfirmPhrase('Yep')).toBe(true);
    expect(isConfirmPhrase('confirm')).toBe(true);
    expect(isConfirmPhrase('register')).toBe(true);
    expect(isConfirmPhrase('go ahead')).toBe(true);
    expect(isConfirmPhrase('do it')).toBe(true);
  });

  it('matches the listed Japanese phrases exactly', () => {
    expect(isConfirmPhrase('はい')).toBe(true);
    expect(isConfirmPhrase('それで')).toBe(true);
    expect(isConfirmPhrase('登録して')).toBe(true);
    expect(isConfirmPhrase('確定')).toBe(true);
    expect(isConfirmPhrase('確定して')).toBe(true);
    expect(isConfirmPhrase('  お願いします  ')).toBe(true);
  });

  it('does NOT match a longer message that merely CONTAINS a confirm word as a substring', () => {
    expect(isConfirmPhrase('yes, but change the time to 9am')).toBe(false);
    expect(isConfirmPhrase('make it snappier, ok?')).toBe(false);
    expect(isConfirmPhrase('登録してから内容を教えて')).toBe(false);
    expect(isConfirmPhrase('それでお願いしますが、時間だけ変えて')).toBe(false);
  });

  it('does NOT match an unrelated short reply', () => {
    expect(isConfirmPhrase('no')).toBe(false);
    expect(isConfirmPhrase('いいえ')).toBe(false);
    expect(isConfirmPhrase('')).toBe(false);
    expect(isConfirmPhrase('   ')).toBe(false);
  });

  it('never overlaps with a cancel phrase (mutually exclusive vocabularies)', () => {
    // Regression guard: if a word were ever added to BOTH isCancelPhrase's and
    // isConfirmPhrase's lists, dispatch()'s priority-ordered routing (cancel
    // checked first) would silently make that word un-confirmable.
    const cancelWords = ['cancel', 'never mind', 'nevermind', 'やめて', 'キャンセル', '中止'];
    for (const w of cancelWords) {
      expect(isConfirmPhrase(w)).toBe(false);
    }
  });
});
