import {
  X_ARTICLES_DRAFT_URL,
  X_ARTICLE_TITLE_MAX,
  xArticlesPublishUrl,
  textToDraftJsContentState,
  buildArticleDraftBody,
  parseArticleDraftResponse,
} from '@/lib/x-articles';

describe('endpoint constants', () => {
  it('draft URL matches the documented Articles endpoint', () => {
    expect(X_ARTICLES_DRAFT_URL).toBe('https://api.x.com/2/articles/draft');
  });

  it('publish URL embeds and encodes the article id', () => {
    expect(xArticlesPublishUrl('1234567890')).toBe('https://api.x.com/2/articles/1234567890/publish');
    expect(xArticlesPublishUrl('a/b?c')).toBe('https://api.x.com/2/articles/a%2Fb%3Fc/publish');
  });
});

describe('textToDraftJsContentState — block splitting', () => {
  it('turns a single paragraph into one unstyled block', () => {
    const cs = textToDraftJsContentState('Hello world.');
    expect(cs.blocks).toHaveLength(1);
    expect(cs.blocks[0]).toEqual({
      key: 'block-0',
      text: 'Hello world.',
      type: 'unstyled',
      depth: 0,
      inlineStyleRanges: [],
      entityRanges: [],
      data: {},
    });
    expect(cs.entityMap).toEqual({});
  });

  it('splits on blank lines into one block per paragraph', () => {
    const cs = textToDraftJsContentState('First para.\n\nSecond para.\n\n\nThird para.');
    expect(cs.blocks.map((b) => b.text)).toEqual(['First para.', 'Second para.', 'Third para.']);
    expect(cs.blocks.map((b) => b.key)).toEqual(['block-0', 'block-1', 'block-2']);
    expect(cs.blocks.every((b) => b.type === 'unstyled')).toBe(true);
  });

  it('joins single newlines inside a paragraph with a space', () => {
    const cs = textToDraftJsContentState('line one\nline two\n\nnext para');
    expect(cs.blocks.map((b) => b.text)).toEqual(['line one line two', 'next para']);
  });

  it('normalizes CRLF input', () => {
    const cs = textToDraftJsContentState('one\r\n\r\ntwo');
    expect(cs.blocks.map((b) => b.text)).toEqual(['one', 'two']);
  });

  it('returns exactly one empty block for empty / whitespace-only input', () => {
    for (const input of ['', '   ', '\n\n', '\t\n  \n']) {
      const cs = textToDraftJsContentState(input);
      expect(cs.blocks).toHaveLength(1);
      expect(cs.blocks[0].text).toBe('');
      expect(cs.blocks[0].type).toBe('unstyled');
      expect(cs.entityMap).toEqual({});
    }
  });
});

describe('textToDraftJsContentState — markdown structure (documented scope)', () => {
  it('converts # / ## headings and strips the marker', () => {
    const cs = textToDraftJsContentState('# Title\n\nBody text.\n\n## Section');
    expect(cs.blocks.map((b) => [b.type, b.text])).toEqual([
      ['header-one', 'Title'],
      ['unstyled', 'Body text.'],
      ['header-two', 'Section'],
    ]);
  });

  it('converts list markers into list-item blocks, one block per line', () => {
    const cs = textToDraftJsContentState('- alpha\n- beta\n\n1. first\n2) second');
    expect(cs.blocks.map((b) => [b.type, b.text])).toEqual([
      ['unordered-list-item', 'alpha'],
      ['unordered-list-item', 'beta'],
      ['ordered-list-item', 'first'],
      ['ordered-list-item', 'second'],
    ]);
  });

  it('keeps a heading separate from prose that follows it without a blank line', () => {
    const cs = textToDraftJsContentState('# Heading\nprose after heading');
    expect(cs.blocks.map((b) => [b.type, b.text])).toEqual([
      ['header-one', 'Heading'],
      ['unstyled', 'prose after heading'],
    ]);
  });

  it('leaves inline styling markers as literal text (out of scope)', () => {
    const cs = textToDraftJsContentState('**bold** and `code`');
    expect(cs.blocks[0].text).toBe('**bold** and `code`');
    expect(cs.blocks[0].inlineStyleRanges).toEqual([]);
  });
});

describe('textToDraftJsContentState — LINK entities', () => {
  it('creates an entity + entityRange for a URL, with the correct offset/length', () => {
    const text = 'See https://example.com/a for details';
    const cs = textToDraftJsContentState(text);
    expect(cs.blocks[0].entityRanges).toEqual([
      { offset: text.indexOf('https://'), length: 'https://example.com/a'.length, key: 0 },
    ]);
    expect(cs.entityMap).toEqual({
      '0': { type: 'LINK', mutability: 'MUTABLE', data: { url: 'https://example.com/a' } },
    });
    const range = cs.blocks[0].entityRanges[0];
    expect(cs.blocks[0].text.slice(range.offset, range.offset + range.length)).toBe(
      'https://example.com/a',
    );
  });

  it('numbers entity keys continuously across multiple blocks', () => {
    const cs = textToDraftJsContentState(
      'first https://a.example/1\n\nsecond https://b.example/2 and https://c.example/3',
    );
    expect(cs.blocks[0].entityRanges.map((r) => r.key)).toEqual([0]);
    expect(cs.blocks[1].entityRanges.map((r) => r.key)).toEqual([1, 2]);
    expect(Object.keys(cs.entityMap)).toEqual(['0', '1', '2']);
    expect(Object.values(cs.entityMap).map((e) => e.data.url)).toEqual([
      'https://a.example/1',
      'https://b.example/2',
      'https://c.example/3',
    ]);
  });

  it('trims trailing sentence punctuation off the link', () => {
    const cs = textToDraftJsContentState('出典: https://example.com/記事。');
    expect(cs.entityMap['0'].data.url).toBe('https://example.com/記事');
    const range = cs.blocks[0].entityRanges[0];
    expect(cs.blocks[0].text.slice(range.offset, range.offset + range.length)).toBe(
      'https://example.com/記事',
    );
  });

  it('detects http:// as well as https://, and links inside list items', () => {
    const cs = textToDraftJsContentState('- source http://example.org/x');
    expect(cs.blocks[0].type).toBe('unordered-list-item');
    expect(cs.entityMap['0'].data.url).toBe('http://example.org/x');
  });

  it('produces no entities when there is no URL', () => {
    const cs = textToDraftJsContentState('no links here');
    expect(cs.blocks[0].entityRanges).toEqual([]);
    expect(cs.entityMap).toEqual({});
  });
});

describe('textToDraftJsContentState — determinism (no Date.now()/Math.random())', () => {
  it('returns byte-identical output for the same input across calls', () => {
    const input = '# Title\n\nBody with https://example.com/a link.\n\n- item https://example.com/b';
    const a = JSON.stringify(textToDraftJsContentState(input));
    const b = JSON.stringify(textToDraftJsContentState(input));
    const c = JSON.stringify(textToDraftJsContentState(input));
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('uses sequential block keys only (never random ids)', () => {
    const cs = textToDraftJsContentState('a\n\nb\n\nc\n\nd');
    expect(cs.blocks.map((b) => b.key)).toEqual(['block-0', 'block-1', 'block-2', 'block-3']);
  });
});

describe('buildArticleDraftBody', () => {
  it('produces { title, content_state } JSON', () => {
    const contentState = textToDraftJsContentState('Body.');
    const body = buildArticleDraftBody({ title: 'My Article', contentState });
    const parsed = JSON.parse(body);
    expect(parsed).toEqual({ title: 'My Article', content_state: contentState });
    expect(typeof body).toBe('string');
  });

  it('truncates an over-long title to the safety limit', () => {
    const body = buildArticleDraftBody({
      title: 'x'.repeat(500),
      contentState: textToDraftJsContentState('Body.'),
    });
    const parsed = JSON.parse(body);
    expect(parsed.title).toHaveLength(X_ARTICLE_TITLE_MAX);
    expect(X_ARTICLE_TITLE_MAX).toBeLessThanOrEqual(100);
  });

  it('trims surrounding whitespace and tolerates an empty title', () => {
    expect(JSON.parse(buildArticleDraftBody({ title: '  spaced  ', contentState: textToDraftJsContentState('b') })).title)
      .toBe('spaced');
    expect(JSON.parse(buildArticleDraftBody({ title: '', contentState: textToDraftJsContentState('b') })).title)
      .toBe('');
  });
});

describe('parseArticleDraftResponse — defensive, fail-closed', () => {
  it('reads the id from a { data: { id } } envelope', () => {
    expect(parseArticleDraftResponse(JSON.stringify({ data: { id: '1901234567890' } }))).toEqual({
      articleId: '1901234567890',
    });
  });

  it('reads a bare top-level id', () => {
    expect(parseArticleDraftResponse(JSON.stringify({ id: 'abc' }))).toEqual({ articleId: 'abc' });
  });

  it('accepts article_id / articleId spellings, nested or top-level', () => {
    expect(parseArticleDraftResponse(JSON.stringify({ data: { article_id: 'a1' } }))).toEqual({ articleId: 'a1' });
    expect(parseArticleDraftResponse(JSON.stringify({ articleId: 'a2' }))).toEqual({ articleId: 'a2' });
    expect(parseArticleDraftResponse(JSON.stringify({ data: { articleId: 'a3' } }))).toEqual({ articleId: 'a3' });
  });

  it('accepts a numeric id (permissive encoder upstream)', () => {
    expect(parseArticleDraftResponse(JSON.stringify({ data: { id: 12345 } }))).toEqual({ articleId: '12345' });
  });

  it('returns null on invalid JSON', () => {
    expect(parseArticleDraftResponse('not json')).toBeNull();
    expect(parseArticleDraftResponse('')).toBeNull();
  });

  it('returns null when no id-ish key is present', () => {
    expect(parseArticleDraftResponse(JSON.stringify({ data: { title: 'x' } }))).toBeNull();
    expect(parseArticleDraftResponse(JSON.stringify({ errors: [{ message: 'nope' }] }))).toBeNull();
  });

  it('returns null for non-object JSON and for empty/blank ids', () => {
    expect(parseArticleDraftResponse('[]')).toBeNull();
    expect(parseArticleDraftResponse('"str"')).toBeNull();
    expect(parseArticleDraftResponse('42')).toBeNull();
    expect(parseArticleDraftResponse('null')).toBeNull();
    expect(parseArticleDraftResponse(JSON.stringify({ data: { id: '   ' } }))).toBeNull();
  });
});
