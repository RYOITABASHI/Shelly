import { detectContentType } from '@/lib/content-block-detector';

describe('detectContentType', () => {
  it('returns plain for empty or whitespace-only output', () => {
    expect(detectContentType('true', '')).toBe('plain');
    expect(detectContentType('true', '   \n\t\n')).toBe('plain');
  });

  it('returns plain for ordinary command output', () => {
    expect(detectContentType('ls', 'README.md.bak\nnode_modules\npackage.json')).toBe('plain');
    expect(detectContentType('echo hi', 'hello world')).toBe('plain');
  });

  it('detects markdown from a cat of a .md file regardless of content', () => {
    expect(detectContentType('cat docs/README.md', 'just some text')).toBe('markdown');
    expect(detectContentType('cat NOTES.MD', 'just some text')).toBe('markdown');
  });

  it('detects markdown when at least two formatting signals are present', () => {
    const output = ['# Title', '', 'Some **bold** text', '- item one', '- item two'].join('\n');
    expect(detectContentType('some-tool', output)).toBe('markdown');
  });

  it('does not treat a single markdown signal as markdown', () => {
    expect(detectContentType('some-tool', '# just a heading-looking line')).toBe('plain');
  });

  it('detects a valid JSON object or array', () => {
    expect(detectContentType('cat data.json', '{"name":"shelly","ok":true}')).toBe('json');
    expect(detectContentType('jq .', '[1, 2, 3]')).toBe('json');
  });

  it('falls through when output starts like JSON but does not parse', () => {
    expect(detectContentType('echo', '{not really json')).toBe('plain');
  });

  it('detects pipe-separated tables with a consistent column count', () => {
    const output = [
      '| name | size |',
      '|------|------|',
      '| a.ts | 12K  |',
      '| b.ts | 4K   |',
    ].join('\n');
    expect(detectContentType('du-table', output)).toBe('table');
  });

  it('does not detect a table when pipe counts differ between lines', () => {
    const output = ['| a | b |', '| c | d | e |', '| f | g |'].join('\n');
    expect(detectContentType('tool', output)).toBe('plain');
  });

  it('requires at least three non-empty lines for a table', () => {
    expect(detectContentType('tool', '| a | b |\n| c | d |')).toBe('plain');
  });

  it('detects image paths', () => {
    expect(detectContentType('ls shots', 'screenshot.png\nphoto.JPEG')).toBe('image');
  });

  it('detects diffs', () => {
    const output = ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -1 +1 @@'].join('\n');
    expect(detectContentType('git diff', output)).toBe('diff');
  });

  it('detects AI CLI action lines', () => {
    expect(detectContentType('codex', 'Read lib/foo.ts\nsome output')).toBe('cli-action');
    expect(detectContentType('codex', '● EDIT lib/foo.ts')).toBe('cli-action');
  });

  // Edge case: a markdown table is both a table and markdown-ish. Because the
  // markdown check runs first, a .md cat wins over the table heuristic, while
  // the same text from a non-.md command is classified as a table.
  it('prefers markdown over table when the command cats a .md file', () => {
    const table = ['| a | b |', '|---|---|', '| 1 | 2 |'].join('\n');
    expect(detectContentType('cat table.md', table)).toBe('markdown');
    expect(detectContentType('cat table.txt', table)).toBe('table');
  });

  // Edge case: an image filename inside a JSON document stays JSON because the
  // JSON check runs before the image heuristic.
  it('classifies JSON containing image paths as json, not image', () => {
    expect(detectContentType('cat manifest.json', '{"icon": "icon.png"}')).toBe('json');
  });
});
