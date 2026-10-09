import { isRestorableBrowserUrl, normalizeBrowserInput } from '@/lib/browser-url';

const search = (q: string) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;

describe('normalizeBrowserInput', () => {
  it.each([
    ['', 'about:blank'],
    ['   ', 'about:blank'],
    ['example.com', 'https://example.com'],
    ['  github.com/RYOITABASHI/Shelly  ', 'https://github.com/RYOITABASHI/Shelly'],
    ['https://youtube.com/watch?v=x', 'https://youtube.com/watch?v=x'],
    ['http://example.org', 'http://example.org'],
    ['localhost:3000', 'http://localhost:3000'],
    ['127.0.0.1:8080/x', 'http://127.0.0.1:8080/x'],
    ['about:blank', 'about:blank'],
  ])('%j -> %s', (input, expected) => {
    expect(normalizeBrowserInput(input)).toBe(expected);
  });

  it.each([
    'how to fix config.json',
    'shelly',
    '~/hw/ry_md_test.md',
    '/sdcard/notes.md',
    './README.md',
    'ry_md_test.md',
    'javascript:alert(1)',
    'notes.md ~/hw/ry_md_test.md',
  ])('%j becomes a web search, never a fake host that fails DNS', (input) => {
    expect(normalizeBrowserInput(input)).toBe(search(input.trim()));
  });
});

describe('isRestorableBrowserUrl', () => {
  it.each([
    'https://example.com',
    'https://example.com/a/b?c=d#e',
    'http://localhost:3000/',
    'http://192.168.0.10:8080/',
    'https://www.google.com/search?q=a%20b',
  ])('accepts %s', (url) => {
    expect(isRestorableBrowserUrl(url)).toBe(true);
  });

  it.each([
    null,
    undefined,
    '',
    'about:blank',
    'file:///sdcard/notes.md',
    'javascript:alert(1)',
    'https://ry_md_test.md/?locale=ja',
    'https://notes.md%20~/hw/ry_md_test.md/?locale=ja',
    'https://notes.md ~/hw/ry_md_test.md',
    'https://shelly/',
    'https://user:pw@example.com/',
    ' https://example.com',
  ])('rejects %j', (url) => {
    expect(isRestorableBrowserUrl(url)).toBe(false);
  });
});
