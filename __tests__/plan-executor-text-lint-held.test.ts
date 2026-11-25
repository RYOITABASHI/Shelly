import * as path from 'path';

// Executor v68 (search parity 3a/3b): the text lint (work talk, a note to an
// editor) gets one bounded, deletion-only fix in assemble (cutArticleSelfTalk);
// a draft the review (and the editor) passed whose text lint is still there
// lands held (text-lint) instead of being saved. The landing itself is run
// end to end in plan-executor-search-parity.test.ts.
// Every text here is made up.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const executor = require(path.resolve(__dirname, '..', 'scripts', 'shelly-plan-executor.js'));

describe('cutArticleSelfTalk', () => {
  const cut = (body: string) => executor.cutArticleSelfTalk(body);

  it('returns the body untouched when there is nothing to cut', () => {
    const body = '# 記事\n\n本文です。実機では未確認です。\n\n- 項目';
    expect(cut(body)).toEqual({ text: body, cut: 0 });
    expect(cut(null)).toEqual({ text: '', cut: 0 });
  });

  it('cuts each fact-free sentence once and keeps the rest of the line', () => {
    const out = cut('# 記事\n\n最初の文。検索結果には無かった。最後の文。\n\nThe tool shipped. The research notes are thin. It works.');
    expect(out.cut).toBe(2);
    expect(out.text).toBe('# 記事\n\n最初の文。最後の文。\n\nThe tool shipped. It works.');
  });

  it('keeps a sentence with a figure or a source marker', () => {
    for (const line of ['検索結果では 42% だった。', '調査メモ [2] にある。', '手元の資料 [M1] と調査メモが一致した。']) {
      expect(cut(`# 記事\n\n${line}`)).toEqual({ text: `# 記事\n\n${line}`, cut: 0 });
    }
  });

  it('never touches a heading, a code block or a table row', () => {
    const body = [
      '# 検索結果のまとめ',
      '',
      '```',
      'echo "search results"',
      '```',
      '',
      '| 項目 | 調査メモ |',
      '| --- | --- |',
    ].join('\n');
    expect(cut(body)).toEqual({ text: body, cut: 0 });
  });

  it('drops a list item or quote left with only its markup, and keeps the markup of one that stays', () => {
    const out = cut('# 記事\n\n- 検索結果には無かった\n- 二つ目。調査メモより。\n> 出典不明\n1. 要出典\n\n続き。');
    expect(out.text).toBe('# 記事\n\n- 二つ目。\n\n続き。');
    expect(out.cut).toBe(4);
  });

  it('collapses the blank lines a cut paragraph leaves', () => {
    expect(cut('# 記事\n\n前。\n\n検索結果では不明。\n\n後。').text).toBe('# 記事\n\n前。\n\n後。');
  });

  it('never leaves a stray quote or emphasis mark', () => {
    // A 。 inside a quote ends no sentence: the whole sentence goes.
    expect(cut('前。彼は「検索結果には無い。」と述べた。後。').text).toBe('前。後。');
    // Emphasis around the cut sentence goes with it.
    expect(cut('**検索結果は無い。** 本文。').text).toBe('本文。');
    expect(cut('前文。**検索結果は無い。**後文。').text).toBe('前文。後文。');
    expect(cut('*Italic sentence.* The search results were thin.').text).toBe('*Italic sentence.*');
  });

  it('leaves a piece whose marks do not pair up (it stays flagged)', () => {
    for (const body of ['**検索結果は無い。前文。**', '前文。検索結果は無い」と。', '前文。検索結果は「無い。']) {
      expect(cut(body)).toEqual({ text: body, cut: 0 });
    }
    // A whole sentence inside a bold span goes; the span still pairs up.
    expect(cut('**前文。検索結果は無い。**').text).toBe('**前文。**');
  });

  it('never touches a table row without outer pipes or a setext heading', () => {
    for (const body of ['項目 | 調査メモ\n--- | ---\nA | B', '検索結果\n===\n\n本文。', '検索結果\n---']) {
      expect(cut(body)).toEqual({ text: body, cut: 0 });
    }
  });

  it('keeps a hard line break and CRLF on a line it edits', () => {
    expect(cut('最初。検索結果は無い。最後。  \r\n次の行。\r\n').text).toBe('最初。最後。  \r\n次の行。\r\n');
  });
});

describe('splitArticleSentences', () => {
  it.each([
    ['一。二！三？', ['一。', '二！', '三？']],
    ['A b. C d? E', ['A b.', ' C d?', ' E']],
    ['It is 3.5 points. Next.', ['It is 3.5 points.', ' Next.']],
    ['「一。二。」と言った。', ['「一。二。」と言った。']],
    ['(One. Two.) Three.', ['(One. Two.) Three.']],
  ])('%s', (text, pieces) => {
    expect(executor.splitArticleSentences(text)).toEqual(pieces);
    expect(executor.splitArticleSentences(text).join('')).toBe(text);
  });
});

describe('articleTextLintFlags / articleHeldTextLint', () => {
  const LEFT = executor.ARTICLE_SELF_TALK_LEFT_FLAG;
  const META = executor.ARTICLE_META_NOTE_LEFT_FLAG;
  const fm = (lines: string[]) => `---\ntitle: "T"\n${lines.join('\n')}\n---\n\n# T\n\nbody\n`;

  it('picks only the left-in text-lint flags', () => {
    expect(executor.articleTextLintFlags([`${LEFT}: 検索結果`, META, `${executor.ARTICLE_SELF_TALK_CUT_FLAG}: 1`, `${executor.ARTICLE_META_NOTE_CUT_FLAG}: 1`, '本文が短い: 10字'])).toEqual([`${LEFT}: 検索結果`, META]);
    expect(executor.articleTextLintFlags(null)).toEqual([]);
    expect(executor.articleTextLintFlags([1, null, LEFT])).toEqual([LEFT]);
  });

  it('holds a passed draft with a text-lint flag', () => {
    const lint = [`${LEFT}: 検索結果`, META];
    expect(executor.articleHeldTextLint(fm(['review: pass', 'material: unknown', `lint: ${JSON.stringify(lint)}`]))).toEqual(lint);
    expect(executor.articleHeldTextLint(fm(['review: pass', 'quality: pass', 'quality_score: 4', `lint: ${JSON.stringify(lint)}`]))).toEqual(lint);
  });

  it('does not hold a draft the review or the editor did not pass, or one without the flags', () => {
    const lint = JSON.stringify([`${LEFT}: 検索結果`]);
    expect(executor.articleHeldTextLint(fm(['review: unresolved', `lint: ${lint}`]))).toEqual([]);
    expect(executor.articleHeldTextLint(fm(['review: pass', 'quality: fail', `lint: ${lint}`]))).toEqual([]);
    expect(executor.articleHeldTextLint(fm(['review: pass', 'quality: unresolved', `lint: ${lint}`]))).toEqual([]);
    expect(executor.articleHeldTextLint(fm(['review: pass', 'lint: ["本文が短い: 10字"]']))).toEqual([]);
    expect(executor.articleHeldTextLint(fm(['review: pass', 'lint: not json']))).toEqual([]);
    expect(executor.articleHeldTextLint('# no frontmatter')).toEqual([]);
  });

  it('reads the first lint line only (assemble\'s own)', () => {
    const text = fm(['review: pass', 'lint: []', `lint: ${JSON.stringify([META])}`]);
    expect(executor.articleHeldTextLint(text)).toEqual([]);
  });
});

describe('assembleArticle with the work-talk lint (3a)', () => {
  const steps = [{ instruction: 'r' }, { instruction: 'w' }, { instruction: 'review', handoff: { kind: 'review', of: [0, 1], round: 1 } }];
  const local = { kind: 'assemble', parts: [[1]], stream: 'example', footer: 'F', quality: { selfTalk: true } };
  const assemble = (body: string, quality: object = local.quality) =>
    executor.assembleArticle({ ...local, quality }, { steps, results: ['r', body, 'VERDICT: PASS'], skipped: [], sources: [], today: '2026-11-25', fallbackTitle: 'F' });

  it('a cut draft is review: unresolved (no review read the cut text) and is not held', () => {
    const out = assemble('# 記事\n\n本文です。検索結果からは取得できなかった。');
    expect(out).toContain('review: unresolved');
    expect(out).toContain(`review_note: ${JSON.stringify(executor.ARTICLE_SELF_TALK_CUT_NOTE)}`);
    expect(out).not.toContain('検索結果');
    expect(executor.articleHeldTextLint(out)).toEqual([]);
  });

  it('a cut that leaves a flag behind is still held (the review passed it)', () => {
    const out = assemble('# 記事\n\n本文。検索結果は無い。\n\n検索結果では 42% だった。');
    expect(out).toContain('review: unresolved');
    expect(executor.articleHeldTextLint(out)).toEqual([`${executor.ARTICLE_SELF_TALK_LEFT_FLAG}: 検索結果`]);
  });

  it('a draft the review sent back is never held, cut or not', () => {
    const out = executor.assembleArticle(local, { steps, results: ['r', '# 記事\n\n本文。検索結果は無い。\n\n検索結果では 42% だった。', 'VERDICT: REVISE\nx'], skipped: [], sources: [], today: '2026-11-25', fallbackTitle: 'F' });
    expect(out).not.toContain(executor.ARTICLE_SELF_TALK_CUT_NOTE);
    expect(executor.articleHeldTextLint(out)).toEqual([]);
  });

  it('a typographic apostrophe does not block the cut', () => {
    expect(executor.cutArticleSelfTalk('Fine. The search results didn’t help.').text).toBe('Fine.');
  });

  it('a draft with nothing to cut keeps review: pass', () => {
    expect(assemble('# 記事\n\n本文です。')).toContain('review: pass');
  });

  it('a draft whose work talk holds a fact is held with the flag', () => {
    const out = assemble('# 記事\n\n検索結果では 42% だった。');
    expect(executor.articleHeldTextLint(out)).toEqual([`${executor.ARTICLE_SELF_TALK_LEFT_FLAG}: 検索結果`]);
  });

  it('without quality.selfTalk nothing is cut', () => {
    const body = '# 記事\n\n検索結果からは取得できなかった。';
    expect(assemble(body, {})).toContain(body);
  });
});
