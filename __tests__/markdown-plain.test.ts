import { markdownToPlainPreview } from '@/lib/markdown-plain';

describe('markdownToPlainPreview', () => {
  it('strips heading markers and collapses whitespace', () => {
    expect(markdownToPlainPreview('# Title\n\n### 1. Item\n\nBody')).toBe('Title 1. Item Body');
  });
  it('strips bold/italic/strike/code but keeps snake_case and math', () => {
    expect(markdownToPlainPreview('**bold** _it_ ~~x~~ `c` my_var 2*3')).toBe('bold it x c my_var 2*3');
  });
  it('keeps link text, drops URLs, bullets, quotes, rules, fences', () => {
    expect(markdownToPlainPreview('> quote\n- [a](http://b)\n---\n```js\nx()\n```')).toBe('quote a x()');
  });
  it('returns empty for empty input', () => {
    expect(markdownToPlainPreview('')).toBe('');
  });
});
