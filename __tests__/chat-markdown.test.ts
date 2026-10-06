import { parseChatInline, parseChatMarkdown } from '@/lib/chat-markdown';

describe('parseChatInline', () => {
  it('parses bold, italic and inline code', () => {
    expect(parseChatInline('**Fix:** use *this* or `that`')).toEqual([
      { kind: 'bold', text: 'Fix:' },
      { kind: 'text', text: ' use ' },
      { kind: 'italic', text: 'this' },
      { kind: 'text', text: ' or ' },
      { kind: 'code', text: 'that' },
    ]);
  });

  it('parses underscore forms at word boundaries only', () => {
    expect(parseChatInline('__b__ and _i_')).toEqual([
      { kind: 'bold', text: 'b' },
      { kind: 'text', text: ' and ' },
      { kind: 'italic', text: 'i' },
    ]);
    expect(parseChatInline('snake_case_name stays')).toEqual([
      { kind: 'text', text: 'snake_case_name stays' },
    ]);
  });

  it('leaves spaced asterisks and unclosed markers verbatim', () => {
    expect(parseChatInline('a * b * c')).toEqual([{ kind: 'text', text: 'a * b * c' }]);
    expect(parseChatInline('**unclosed')).toEqual([{ kind: 'text', text: '**unclosed' }]);
  });

  it('does not parse markup inside inline code', () => {
    expect(parseChatInline('`**x**`')).toEqual([{ kind: 'code', text: '**x**' }]);
  });
});

describe('parseChatMarkdown', () => {
  it('detects headings, bullets and ordered items', () => {
    const lines = parseChatMarkdown('## Title\n- one\n  * nested\n1. first\n2) second\nplain');
    expect(lines.map((l) => l.kind)).toEqual(['heading', 'bullet', 'bullet', 'ordered', 'ordered', 'para']);
    expect(lines[2]).toMatchObject({ kind: 'bullet', indent: 1 });
    expect(lines[4]).toMatchObject({ kind: 'ordered', marker: '2)' });
  });

  it('treats "*text*" lines as italic paragraphs, not bullets', () => {
    expect(parseChatMarkdown('*note*')[0]).toEqual({
      kind: 'para',
      spans: [{ kind: 'italic', text: 'note' }],
    });
  });
});
