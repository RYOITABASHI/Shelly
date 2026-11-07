/**
 * scripts/shelly-save-draft.js: Markdown to the allow-listed HTML, and the queue
 * file ClosePawDrafts.kt reads. Article text is treated as hostile throughout.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const draft = require('../scripts/shelly-save-draft.js');

const root = path.join(__dirname, '..');
const png = Buffer.from('89504e470d0a1a0a0000', 'hex');

function tempHome(destinations?: unknown): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-save-draft-'));
  if (destinations !== undefined) {
    fs.mkdirSync(path.join(home, '.shelly/agents'), { recursive: true });
    fs.writeFileSync(path.join(home, '.shelly/agents/draft-destinations.json'), JSON.stringify(destinations));
  }
  return home;
}

const body = 'A paragraph long enough to be read back.';

const IMAGE_HOST = 'images.example.com';
const substackOptions = { platform: 'substack', imageHosts: [IMAGE_HOST] };

/** A document with no text at all is refused later; a bad tag never may occur. */
function expectSafe(html: string, platform = 'note'): void {
  expect([null, 'html-no-text']).toContain(draft.htmlRejection(html, platform, [IMAGE_HOST]));
}

describe('asset', () => {
  it('the APK asset is the script', () => {
    const asset = fs.readFileSync(path.join(root, 'modules/terminal-emulator/android/src/main/assets/shelly-save-draft.js'), 'utf8');
    expect(asset).toBe(fs.readFileSync(path.join(root, 'scripts/shelly-save-draft.js'), 'utf8'));
  });
});

describe('markdownToHtml', () => {
  it('renders the supported blocks', () => {
    const html = draft.markdownToHtml([
      '# One', '##### Five', '', 'Para with **b**, *i*, `c<d` and [a link](https://example.com/x?a=1&b=2).', '',
      '- first', '- second', '  wrapped', '', '1. one', '2) two', '', '> quoted', '', '```', '<raw>', '```', '', '---', '',
      `![alt text](https://${IMAGE_HOST}/i.png "A caption")`,
    ].join('\n'), substackOptions);
    expect(html).toContain('<h1>One</h1>');
    expect(html).toContain('<h4>Five</h4>');
    expect(html).toContain('<strong>b</strong>');
    expect(html).toContain('<em>i</em>');
    expect(html).toContain('<code>c&lt;d</code>');
    expect(html).toContain('<a href="https://example.com/x?a=1&amp;b=2">a link</a>');
    expect(html).toContain('<ul><li>first</li><li>second wrapped</li></ul>');
    expect(html).toContain('<ol><li>one</li><li>two</li></ol>');
    expect(html).toContain('<blockquote><p>quoted</p></blockquote>');
    expect(html).toContain('<pre><code>&lt;raw&gt;</code></pre>');
    expect(html).toContain('<hr>');
    expect(html).toContain(`<figure><img src="https://${IMAGE_HOST}/i.png" alt="alt text"><figcaption>A caption</figcaption></figure>`);
    expect(draft.htmlRejection(html, 'substack', [IMAGE_HOST])).toBeNull();
  });

  it('keeps snake_case and a two-space hard break', () => {
    expect(draft.markdownToHtml('a_b_c')).toBe('<p>a_b_c</p>');
    expect(draft.markdownToHtml('one  \ntwo')).toBe('<p>one<br>\ntwo</p>');
  });

  it.each([
    ['<script>alert(1)</script>'],
    ['<img src=x onerror=alert(1)>'],
    ['<!-- comment -->'],
    ['<a href="javascript:alert(1)">x</a>'],
    ['```\n</code></pre><script>x</script>\n```'],
    ['`</code><script>`'],
    ['# <h1 onclick=x>'],
    ['- <li onclick=x>'],
    ['> <iframe src=x>'],
    ['**<b onmouseover=x>**'],
    ['[<script>](https://example.com)'],
    ['![<script>](https://images.example.com/i.png)'],
    ['![" onerror="x](https://images.example.com/i.png)'],
    ['[a](https://example.com/"onmouseover="x)'],
    ['![a](https://images.example.com/x "<script>")'],
    ['![a\u3000b\u00a0c\u200bd\u202ee](https://images.example.com/x.png)'],
  ])('escapes hostile source %#', (source) => {
    for (const [platform, options] of [['note', {}], ['substack', substackOptions]] as const) {
      const html = draft.markdownToHtml(source, options);
      expectSafe(html, platform);
      expect(html).not.toMatch(/<(?:script|iframe|!--)/i);
      expect(html).not.toMatch(/<[a-z0-9]+\s[^>]*\bon[a-z]+="/i);
    }
  });

  it.each([
    ['[x](https://user:pw@example.com/)'],
    ['[x](https://example.com:8443/)'],
    ['[x](https://127.0.0.1/)'],
    ['[x](https://localhost/)'],
    ["[x](https://example.com/it's)"],
    ['[x](https://example.com/\u65e5\u672c)'],
    ['[x](https://note.com/notes/new)'],
    ['[x](https://note.com/user/n/n1abc?ref=1)'],
    ['[x](https://www.note.com/user/n/n1abc)'],
    ['[x](https://substack.com/)'],
    ['[x](https://pub.substack.com/publish/post/1)'],
    ['[x](https://pub.substack.com/p/a#f)'],
  ])('a link ClosePaw refuses keeps its text %#', (source) => {
    const { html, droppedLinks } = draft.renderMarkdown(source);
    expect(html).toBe('<p>x</p>');
    expect(droppedLinks).toBe(1);
  });

  it.each([
    ['[x](https://note.com/user/n/n1abc)', 'https://note.com/user/n/n1abc'],
    ['[x](https://pub.substack.com/p/a-b/)', 'https://pub.substack.com/p/a-b/'],
    ['[x](https://Example.COM/Path?A=1&B=2#F)', 'https://example.com/Path?A=1&amp;B=2#F'],
    ['[x](https://example.com/&#63;)', 'https://example.com/&amp;#63;'],
  ])('keeps a plain article link and an ordinary URL %#', (source, href) => {
    const html = draft.markdownToHtml(source);
    expect(html).toBe(`<p><a href="${href}">x</a></p>`);
    expect(draft.htmlRejection(html)).toBeNull();
  });

  it('never emits img on note, and counts what it dropped', () => {
    const rendered = draft.renderMarkdown(`Text ![seen](https://${IMAGE_HOST}/a.png)\n\n![alone](https://${IMAGE_HOST}/b.png)`, { imageHosts: [IMAGE_HOST] });
    expect(rendered.html).toBe('<p>Text seen</p>\n<p>alone</p>');
    expect(rendered.droppedImages).toBe(2);
    expect(rendered.usedHosts).toEqual([]);
  });

  it('keeps img on Substack only from a listed host, and reports the host', () => {
    const rendered = draft.renderMarkdown(`![a](https://${IMAGE_HOST}/a.png)\n\n![b](https://other.example.com/b.png)\n\n![c](https://note.com/c.png)`, substackOptions);
    expect(rendered.html).toBe(`<figure><img src="https://${IMAGE_HOST}/a.png" alt="a"></figure>\n<p>b</p>\n<p>c</p>`);
    expect(rendered.usedHosts).toEqual([IMAGE_HOST]);
    expect(rendered.droppedImages).toBe(2);
  });

  it('cleans alt text to what ClosePaw accepts, and keeps a tag under its limit', () => {
    const clean = draft.markdownToHtml(`![a\u3000b\u00a0c\u200bd\u202ee\u2028f](https://${IMAGE_HOST}/x.png)`, substackOptions);
    expect(clean).toContain('alt="a b c d e f"');
    const long = draft.markdownToHtml(`![${'"'.repeat(900)}](https://${IMAGE_HOST}/x.png)`, substackOptions);
    expect(draft.htmlRejection(long, 'substack', [IMAGE_HOST])).toBe('html-no-text');
  });

  it.each([
    ['[x](javascript:alert(1))'],
    ['[x](http://example.com)'],
    ['[x](data:text/html,hi)'],
    ['[x](//example.com)'],
    ['[x](https://exa\\mple.com)'],
    ['![x](data:image/png;base64,AAAA)'],
    ['![x](file:///etc/passwd)'],
  ])('keeps only the text of a non-https target %#', (source) => {
    const html = draft.markdownToHtml(source);
    expect(html).not.toMatch(/<a |<img /);
    expect(html).toContain('x');
    expect(draft.htmlRejection(html)).toBeNull();
  });

  it('drops control characters and stays linear on pathological input', () => {
    expect(draft.markdownToHtml('a\u0000b\u001bc')).toBe('<p>abc</p>');
    const started = Date.now();
    for (const ch of ['[', '*', '_', '`', '>', '!', '\\']) {
      expectSafe(draft.markdownToHtml(ch.repeat(200000)));
    }
    expect(Date.now() - started).toBeLessThan(15000);
  });

  it('every emitted document passes the allow-list (seeded fuzz)', () => {
    const atoms = ['<', '>', '&', '"', "'", '`', '*', '_', '[', ']', '(', ')', '!', '#', '-', '\n', '\n\n', ' ', '  \n',
      'https://a.example.com/', `https://${IMAGE_HOST}/i.png`, 'https://note.com/u/n/n1', '](', '![', '[x](',
      'javascript:', '<!--', '-->', '<b>', 'text', '```\n', '> ', '- ', '1. ', '=', '\\', '\u3000', '\u200b', '\u202e'];
    let seed = 12345;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 3000; round += 1) {
      let source = 'word ';
      for (let i = 0; i < 40; i += 1) source += atoms[next(atoms.length)];
      expectSafe(draft.markdownToHtml(source));
      expectSafe(draft.markdownToHtml(source, substackOptions), 'substack');
    }
  });
});

describe('verdicts of the real ArticleHtmlPolicy.kt', () => {
  // Generated by compiling ClosePaw's file at 8d094985 and running this corpus through
  // it. To refresh: the same run against the new commit, then review the diff.
  const cases: {
    kind: 'raw' | 'render' | 'host';
    platform: string;
    hosts: string[];
    input: string;
    verdict: string;
    samples: number;
  }[] = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/closepaw-html-policy-cases.json'), 'utf8'));

  it('the fixture covers every refusal', () => {
    expect(cases.length).toBeGreaterThan(500);
    for (const verdict of ['ok', 'html-no-text', 'html-unreadable-tag', 'html-tag-not-allowed', 'html-link-not-allowed', 'html-image-not-allowed']) {
      expect(cases.filter((c) => c.verdict === verdict).length).toBeGreaterThan(0);
    }
  });

  it('the port agrees on every raw document', () => {
    for (const c of cases.filter((x) => x.kind === 'raw')) {
      expect([c.input, draft.htmlRejection(c.input, c.platform, c.hosts) ?? 'ok']).toEqual([c.input, c.verdict]);
      if (c.verdict === 'ok') expect([c.input, draft.hasReadBackSample(c.input)]).toEqual([c.input, c.samples > 0]);
    }
  });

  it('the real policy accepted every rendered document', () => {
    for (const c of cases.filter((x) => x.kind === 'render')) {
      expect(['ok', 'html-no-text']).toContain(c.verdict);
      const html = draft.markdownToHtml(c.input, { platform: c.platform, imageHosts: c.hosts });
      expect([c.input, draft.htmlRejection(html, c.platform, c.hosts) ?? 'ok']).toEqual([c.input, c.verdict]);
    }
  });

  it('the port agrees on image hosts', () => {
    for (const c of cases.filter((x) => x.kind === 'host')) {
      expect([c.input, draft.isAllowableImageHost(c.input)]).toEqual([c.input, c.verdict === 'ok']);
    }
  });
});

describe('buildRequest', () => {
  it('writes the wire shape', () => {
    const request = JSON.parse(draft.buildRequest({ title: ' Title\n', markdown: body, images: [] }).text);
    expect(Object.keys(request)).toEqual(['version', 'title', 'html']);
    expect(request).toMatchObject({ version: 1, title: 'Title', html: `<p>${body}</p>` });
  });

  it('adds image_hosts only for hosts the article used', () => {
    const markdown = `${body}\n\n![a](https://${IMAGE_HOST}/a.png)`;
    const used = JSON.parse(draft.buildRequest({ title: 'T', markdown, platform: 'substack', imageHosts: [IMAGE_HOST, 'unused.example.com'] }).text);
    expect(used.image_hosts).toEqual([IMAGE_HOST]);
    const none = JSON.parse(draft.buildRequest({ title: 'T', markdown: body, platform: 'substack', imageHosts: [IMAGE_HOST] }).text);
    expect(Object.keys(none)).not.toContain('image_hosts');
  });

  it('enforces the caps', () => {
    expect(() => draft.buildRequest({ title: 'x'.repeat(draft.MAX_TITLE_CHARS + 1), markdown: body, images: [] })).toThrow('longer than 300');
    expect(() => draft.buildRequest({ title: 'a\nb', markdown: body, images: [] })).toThrow('one line');
    expect(() => draft.buildRequest({ title: ' ', markdown: body, images: [] })).toThrow('empty');
    expect(() => draft.buildRequest({ title: 'T', markdown: 'x'.repeat(draft.MAX_HTML_CHARS), images: [] })).toThrow('characters of HTML');
    const huge = [{ name: 'a.png', mime: 'image/png', base64: 'x'.repeat(draft.MAX_FILE_BYTES) }];
    expect(() => draft.buildRequest({ title: 'T', markdown: body, images: huge })).toThrow('larger than');
  });

  it('refuses text ClosePaw could not read back', () => {
    expect(() => draft.buildRequest({ title: 'T', markdown: 'a & b', images: [] })).toThrow('no plain text run');
    expect(() => draft.buildRequest({ title: 'T', markdown: '   ', images: [] })).toThrow('html-no-text');
  });
});

describe('images', () => {
  it('detects the type from the bytes and cleans the name', () => {
    expect(draft.imageMime(png)).toBe('image/png');
    expect(draft.imageMime(Buffer.from('ffd8ff00', 'hex'))).toBe('image/jpeg');
    expect(draft.imageMime(Buffer.from('GIF89a'))).toBe('image/gif');
    expect(draft.imageMime(Buffer.from('RIFF0000WEBP'))).toBe('image/webp');
    expect(draft.imageMime(Buffer.from('<svg>'))).toBeNull();
    expect(draft.imageName('/x/../a b.png', 0)).toBe('a-b.png');
    expect(draft.imageName('/x/日本語', 1)).toBe('image-2');
  });

  it('refuses a fifth image, a non-image and an empty file', () => {
    const home = tempHome();
    const file = path.join(home, 'a.png');
    fs.writeFileSync(file, png);
    expect(draft.loadImages([file])[0]).toEqual({ name: 'a.png', mime: 'image/png', base64: png.toString('base64') });
    expect(() => draft.loadImages([file, file, file, file, file])).toThrow('at most 4');
    fs.writeFileSync(file, '<svg>');
    expect(() => draft.loadImages([file])).toThrow('not a JPEG');
    fs.writeFileSync(file, '');
    expect(() => draft.loadImages([file])).toThrow('empty');
  });
});

describe('Substack destinations', () => {
  it('reads the allowed lists from the device file only', () => {
    expect(draft.loadDestinations(tempHome())).toEqual({ subdomains: [], imageHosts: [] });
    expect(draft.loadDestinations(tempHome({ version: 1, substack_subdomains: ['one'], image_hosts: [IMAGE_HOST] })))
      .toEqual({ subdomains: ['one'], imageHosts: [IMAGE_HOST] });
    expect(() => draft.loadDestinations(tempHome({ version: 2, substack_subdomains: [] }))).toThrow('unsupported');
    expect(() => draft.loadDestinations(tempHome({ version: 1, substack_subdomains: [], extra: 1 }))).toThrow('unsupported');
    expect(() => draft.loadDestinations(tempHome({ version: 1, substack_subdomains: ['a.evil.com'] }))).toThrow('list of subdomains');
  });

  it.each([['note.com'], ['x.substack.com'], ['localhost'], ['127.0.0.1'], ['EXAMPLE.com']])('refuses the image host %s', (host) => {
    expect(() => draft.loadDestinations(tempHome({ version: 1, image_hosts: [host] }))).toThrow('image_hosts');
  });

  it('refuses a ninth image host', () => {
    const hosts = Array.from({ length: draft.MAX_IMAGE_HOSTS + 1 }, (_, i) => `h${i}.example.com`);
    expect(() => draft.loadDestinations(tempHome({ version: 1, image_hosts: hosts }))).toThrow('image_hosts');
  });

  it('a selector only names an entry', () => {
    expect(draft.checkSubdomain(null, ['one'])).toBeNull();
    expect(draft.checkSubdomain('two', ['one', 'two'])).toBe('two');
    expect(() => draft.checkSubdomain('three', ['one', 'two'])).toThrow('is not in');
    expect(() => draft.checkSubdomain(null, ['one', 'two'])).toThrow('--substack');
    expect(() => draft.checkSubdomain(null, [])).toThrow('--substack');
  });
});

describe('queueDraft', () => {
  const article = { title: 'Title', markdown: body };

  it('writes one 0600 file: a meta line, then the request', () => {
    const home = tempHome();
    const { reqId } = draft.queueDraft({ home, platform: 'note', ...article, now: 1760000000000 });
    expect(reqId).toMatch(/^1760000000000-[0-9a-f]{8}$/);
    const text = fs.readFileSync(path.join(home, draft.QUEUE_PREFIX + reqId), 'utf8');
    const lineEnd = text.indexOf('\n');
    expect(JSON.parse(text.slice(0, lineEnd))).toEqual({ version: 1, reqId, platform: 'note' });
    expect(JSON.parse(text.slice(lineEnd + 1)).html).toBe(`<p>${body}</p>`);
    expect(fs.readdirSync(home)).toEqual([draft.QUEUE_PREFIX + reqId]);
  });

  it('a queued Substack item holds a selector at most, never a new destination', () => {
    const home = tempHome({ version: 1, substack_subdomains: ['one', 'two'] });
    const { reqId } = draft.queueDraft({ home, platform: 'substack', substack: 'two', ...article });
    expect(fs.readFileSync(path.join(home, draft.QUEUE_PREFIX + reqId), 'utf8').split('\n')[0]).toContain('"substack":"two"');
    expect(() => draft.queueDraft({ home, platform: 'substack', substack: 'evil', ...article })).toThrow('is not in');
    const single = tempHome({ version: 1, substack_subdomains: ['one'] });
    const { reqId: id } = draft.queueDraft({ home: single, platform: 'substack', ...article });
    expect(fs.readFileSync(path.join(single, draft.QUEUE_PREFIX + id), 'utf8').split('\n')[0]).not.toContain('substack":');
  });

  it('refuses a wrong platform pairing, Substack images and a full queue', () => {
    const home = tempHome({ version: 1, substack_subdomains: ['one'] });
    expect(() => draft.queueDraft({ home, platform: 'x', ...article })).toThrow('--platform');
    expect(() => draft.queueDraft({ home, platform: 'note', substack: 'one', ...article })).toThrow('substack only');
    expect(() => draft.queueDraft({ home, platform: 'substack', imagePaths: ['a.png'], ...article })).toThrow('--image is for note');
    for (let i = 0; i < draft.MAX_QUEUED; i += 1) draft.queueDraft({ home, platform: 'note', ...article, now: 1760000000000 + i });
    expect(() => draft.queueDraft({ home, platform: 'note', ...article })).toThrow('already waiting');
  });
});

describe('parseArgs', () => {
  const base = ['--platform', 'note', '--title-file', 't', '--markdown-file', 'm'];

  it('takes the flags and repeats --image', () => {
    expect(draft.parseArgs([...base, '--image', 'a', '--image', 'b'])).toEqual({
      platform: 'note', titleFile: 't', markdownFile: 'm', imagePaths: ['a', 'b'],
    });
    expect(draft.parseArgs(['--help'])).toEqual({ help: true });
  });

  it('refuses anything else', () => {
    expect(() => draft.parseArgs(['--platform', 'note'])).toThrow('required');
    expect(() => draft.parseArgs([...base, '--subdomain', 'x'])).toThrow('unknown option');
    expect(() => draft.parseArgs([...base, '--platform', 'note'])).toThrow('twice');
    expect(() => draft.parseArgs([...base, '--image'])).toThrow('needs a value');
  });
});
