import { detectPostFormatDirective } from '@/lib/post-format-directive';

describe('detectPostFormatDirective — platform-aware summary intent (B)', () => {
  it('returns the X directive (280-char cap) for X/Twitter post phrasings', () => {
    for (const t of ['X投稿用に要約して', 'これをX用に要約', 'ツイート用にまとめて', 'Twitter投稿用に要約', 'Xポスト用に要約']) {
      const d = detectPostFormatDirective(t);
      expect(d).toContain('280文字以内');
      expect(d).toContain('X(旧Twitter)');
    }
  });

  it('returns the Note directive (article) for Note post phrasings', () => {
    for (const t of ['Note投稿用に要約して', 'note記事用にまとめて', 'ノート用に要約', 'note用に要約']) {
      const d = detectPostFormatDirective(t);
      expect(d).toContain('Note(note.com)');
      expect(d).not.toContain('280文字以内');
    }
  });

  it('is a no-op for ordinary chat (no post-format intent)', () => {
    for (const t of ['STEAM×AIの最新ニュースを教えて', 'このコードをレビューして', 'まとめて', 'hello']) {
      expect(detectPostFormatDirective(t)).toBe('');
    }
  });

  it('does NOT false-trigger on words that merely END in x/note ("Linux用", "Evernote用")', () => {
    // The leading boundary means an x/note glued to a preceding letter is ignored.
    // (A standalone "OS X用" with a space before X is an accepted rare edge — "X" alone
    // is inherently ambiguous, and the user-facing intent is "X投稿用"/"X用に要約".)
    for (const t of ['Linux用にビルドして', 'Evernote用に整理', 'keynote用のメモ', 'index用のスクリプト']) {
      expect(detectPostFormatDirective(t)).toBe('');
    }
  });
});
