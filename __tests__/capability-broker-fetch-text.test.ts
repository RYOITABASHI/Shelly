import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import * as zlib from 'zlib';

// Broker op http.fetch-text (2026-11-10, executor v47): the full text of an
// article's first sources. No test reaches the network: dns.lookup and
// https.request are injected. Every host and text here is made up.

const root = path.resolve(__dirname, '..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const broker = require(path.join(root, 'scripts', 'shelly-capability-broker.js'));

const PUBLIC_A = '93.184.216.34';
const PUBLIC_B = '2606:4700::6810:1';

type Lookup = (host: string, opts: unknown, cb: (err: Error | null, list?: Array<{ address: string; family: number }>) => void) => void;

/** dns.lookup stand-in: host -> addresses. */
function lookupFrom(map: Record<string, string[]>): Lookup & { asked: string[] } {
  const asked: string[] = [];
  const fn = ((host: string, _opts: unknown, cb: (err: Error | null, list?: Array<{ address: string; family: number }>) => void) => {
    asked.push(host);
    const list = map[host];
    if (!list) return cb(new Error('ENOTFOUND'));
    return cb(null, list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
  }) as Lookup & { asked: string[] };
  fn.asked = asked;
  return fn;
}

interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: Buffer | string;
  /** The peer the socket reports; default: the address the request's lookup gives. */
  peer?: string;
  /** Never answer (for the deadline). */
  hang?: boolean;
}

/** https.request stand-in: answers by `hostname + path`, records each call. */
function requestFrom(replies: Record<string, Reply>) {
  const calls: any[] = [];
  const destroyed: string[] = [];
  const request = (options: any, onResponse: (res: any) => void) => {
    const req = new EventEmitter() as any;
    req.destroy = () => {
      destroyed.push(`${options.hostname}${options.path}`);
    };
    req.end = () => {
      const key = `${options.hostname}${options.path}`;
      const reply = replies[key];
      // What the request would connect to: the address its lookup returns.
      options.lookup(options.hostname, {}, (_err: unknown, address: string) => {
        calls.push({ options, connectedTo: address });
        if (!reply) {
          setImmediate(() => req.emit('error', new Error('ECONNREFUSED')));
          return;
        }
        if (reply.hang) return;
        const res = new PassThrough() as any;
        res.statusCode = reply.status;
        res.headers = reply.headers || {};
        res.socket = { remoteAddress: reply.peer ?? address };
        const realDestroy = res.destroy.bind(res);
        res.destroy = (e?: Error) => {
          destroyed.push(key);
          return realDestroy(e);
        };
        setImmediate(() => {
          onResponse(res);
          const body = reply.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(reply.body) ? reply.body : Buffer.from(reply.body);
          // In chunks, as a socket would deliver it.
          for (let at = 0; at < body.length; at += 64 * 1024) {
            if (res.destroyed) return;
            res.write(body.subarray(at, at + 64 * 1024));
          }
          if (!res.destroyed) res.end();
        });
      });
    };
    return req;
  };
  return { request, calls, destroyed };
}

const html = (inner: string) => `<!doctype html><html><head><title>T</title><style>.x{color:red}</style><script>var secret = "SCRIPT_TEXT";</script></head>
<body><nav>Home | About | NAV_TEXT</nav><article><h1>Wash study</h1><p>Method: 40 samples were washed 50 times &amp; measured.</p>${inner}<script>alert("in article")</script></article><footer>FOOTER_TEXT</footer></body></html>`;

async function fetchWith(url: string, replies: Record<string, Reply>, dns: Record<string, string[]>, maxChars = 5000, signal?: AbortSignal) {
  const r = requestFrom(replies);
  const lookup = lookupFrom(dns);
  const out = await broker.fetchTextUrl(url, maxChars, signal, { lookup, request: r.request });
  return { out, calls: r.calls, destroyed: r.destroyed, asked: lookup.asked };
}

describe('http.fetch-text: which URLs it may ask', () => {
  it.each([
    ['https://site.example/a?b=1', true],
    ['https://site.example:443/a', true],
    ['http://site.example/a', false],
    ['ftp://site.example/a', false],
    ['https://site.example:8443/a', false],
    ['https://user:pw@site.example/a', false],
    ['https://127.0.0.1/a', false],
    ['https://2130706433/a', false],
    ['https://0x7f.0.0.1/a', false],
    ['https://[::1]/a', false],
    ['https://[::ffff:127.0.0.1]/a', false],
    ['https://localhost/a', false],
    ['https://db.localhost/a', false],
    ['https://intranet/a', false],
    ['https://site.example/a b', false],
    [`https://site.example/${'a'.repeat(600)}`, false],
    ['not a url', false],
  ])('%s -> %s', (url, ok) => {
    expect(!!broker.fetchTextUrlOk(url)).toBe(ok);
  });
});

describe('http.fetch-text: public addresses only', () => {
  it.each([
    [PUBLIC_A, true],
    ['8.8.8.8', true],
    [PUBLIC_B, true],
    ['2a00:1450:4001:80b::200e', true],
    ['0.0.0.0', false],
    ['10.1.2.3', false],
    ['100.64.0.1', false],
    ['100.127.255.254', false],
    ['127.0.0.1', false],
    ['169.254.169.254', false],
    ['172.16.0.1', false],
    ['172.31.255.255', false],
    ['192.168.1.1', false],
    ['192.0.2.1', false],
    ['198.18.0.1', false],
    ['224.0.0.1', false],
    ['255.255.255.255', false],
    ['::', false],
    ['::1', false],
    ['::ffff:127.0.0.1', false],
    ['::ffff:8.8.8.8', false],
    ['::ffff:7f00:1', false],
    ['::127.0.0.1', false],
    ['64:ff9b::a00:1', false],
    ['fc00::1', false],
    ['fd12:3456::1', false],
    ['fe80::1', false],
    ['fe80::1%eth0', false],
    ['fec0::1', false],
    ['ff02::1', false],
    ['2001:db8::1', false],
    ['2001::1', false],
    ['2002:7f00:1::', false],
    ['not-an-ip', false],
  ])('%s -> %s', (addr, ok) => {
    expect(broker.fetchTextAddressPublic(addr)).toBe(ok);
  });

  it.each([
    ['2001:0::1', 'Teredo'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'Teredo'],
    ['64:ff9b:1::1', 'local-use NAT64 /48'],
    ['64:ff9b::808:808', 'well-known NAT64'],
    ['192.0.0.1', 'IETF 192.0.0/24'],
    ['192.0.0.170', 'IETF 192.0.0/24 (NAT64 discovery)'],
  ])('regression: %s (%s) is not public', (addr) => {
    expect(broker.fetchTextAddressPublic(addr)).toBe(false);
  });

  it('M3: on a DNS64 network drops synthesized 64:ff9b:: answers when A records exist and pins a checked IPv4', async () => {
    const dns64 = lookupFrom({ 'v4.example': ['64:ff9b::5db8:d822', PUBLIC_A] });
    await expect(broker.fetchTextResolve('v4.example', dns64)).resolves.toEqual({ address: PUBLIC_A, family: 4 });
    // A synthesized answer never makes up for a private A record.
    await expect(broker.fetchTextResolve('in.example', lookupFrom({ 'in.example': ['64:ff9b::a00:1', '10.0.0.1'] }))).rejects.toThrow('non-public');
    // NAT64 answers alone (an IPv6-only network): nothing checked to connect to.
    await expect(broker.fetchTextResolve('only.example', lookupFrom({ 'only.example': ['64:ff9b::5db8:d822'] }))).rejects.toThrow('non-public');
    // The local-use /48 is not dropped: it is refused.
    await expect(broker.fetchTextResolve('lu.example', lookupFrom({ 'lu.example': ['64:ff9b:1::1', PUBLIC_A] }))).rejects.toThrow('non-public');
    // And the request connects to the A record, never the 64:ff9b address.
    const { out, calls } = await fetchWith('https://v4.example/x', {
      'v4.example/x': { status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok text' },
    }, { 'v4.example': ['64:ff9b::5db8:d822', PUBLIC_A] });
    expect(out).toMatchObject({ ok: true, text: 'ok text' });
    expect(calls[0].connectedTo).toBe(PUBLIC_A);
  });

  it('refuses a name when any of its addresses is not public, and pins the first otherwise', async () => {
    await expect(broker.fetchTextResolve('mixed.example', lookupFrom({ 'mixed.example': [PUBLIC_A, '10.0.0.1'] }))).rejects.toThrow('non-public');
    await expect(broker.fetchTextResolve('gone.example', lookupFrom({}))).rejects.toThrow('not resolved');
    await expect(broker.fetchTextResolve('ok.example', lookupFrom({ 'ok.example': [PUBLIC_B, PUBLIC_A] }))).resolves.toEqual({ address: PUBLIC_B, family: 6 });
  });
});

describe('http.fetch-text: one URL', () => {
  it('reads an HTML page as plain text, connected to the checked address with fixed headers only', async () => {
    const { out, calls } = await fetchWith('https://site.example/study', {
      'site.example/study': { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html(`<p>${'Detail sentence. '.repeat(40)}</p>`) },
    }, { 'site.example': [PUBLIC_A] });
    expect(out.ok).toBe(true);
    expect(out.text).toContain('Wash study');
    expect(out.text).toContain('Method: 40 samples were washed 50 times & measured.');
    for (const hidden of ['SCRIPT_TEXT', 'NAV_TEXT', 'FOOTER_TEXT', 'color:red', 'in article', '<p>']) expect(out.text).not.toContain(hidden);
    expect(out.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(calls).toHaveLength(1);
    const o = calls[0].options;
    expect(o.method).toBe('GET');
    expect(o.port).toBe(443);
    expect(o.servername).toBe('site.example');
    expect(o.headers).toEqual(broker.FETCH_TEXT_HEADERS);
    expect(Object.keys(o.headers).map((k: string) => k.toLowerCase())).not.toEqual(expect.arrayContaining(['cookie']));
    expect(Object.keys(o.headers).map((k: string) => k.toLowerCase())).not.toContain('authorization');
    expect(calls[0].connectedTo).toBe(PUBLIC_A);
  });

  it('decodes Shift_JIS from a meta tag and gzip a server sends anyway', async () => {
    const sjis = Buffer.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67]); // "テスト"
    const body = Buffer.concat([Buffer.from('<html><head><meta charset="shift_jis"></head><body><p>'), sjis, Buffer.from('</p></body></html>')]);
    const { out } = await fetchWith('https://jp.example/a', {
      'jp.example/a': { status: 200, headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }, body: zlib.gzipSync(body) },
    }, { 'jp.example': [PUBLIC_A] });
    expect(out.ok).toBe(true);
    expect(out.text).toBe('テスト');
  });

  it('follows a redirect only after checking the next hop again', async () => {
    const dns = { 'a.example': [PUBLIC_A], 'b.example': [PUBLIC_A], 'inside.example': ['10.0.0.5'] };
    const good = await fetchWith('https://a.example/x', {
      'a.example/x': { status: 301, headers: { location: 'https://b.example/y' } },
      'b.example/y': { status: 200, headers: { 'content-type': 'text/plain' }, body: 'plain text here' },
    }, dns);
    expect(good.out).toMatchObject({ ok: true, finalUrl: 'https://b.example/y', redirects: 1, text: 'plain text here' });

    const inside = await fetchWith('https://a.example/x', { 'a.example/x': { status: 302, headers: { location: 'https://inside.example/admin' } } }, dns);
    expect(inside.out).toMatchObject({ ok: false, reason: 'name resolves to a non-public address' });
    expect(inside.calls).toHaveLength(1);

    for (const location of ['http://b.example/y', 'https://127.0.0.1/', 'https://[::1]/', 'https://b.example:8080/', 'https://user:pw@b.example/y', 'https://user@b.example/y', 'https://localhost/']) {
      const bad = await fetchWith('https://a.example/x', { 'a.example/x': { status: 307, headers: { location } } }, dns);
      expect(bad.out).toMatchObject({ ok: false, reason: 'redirect to a refused address' });
      expect(bad.calls).toHaveLength(1);
    }

    const loop = await fetchWith('https://a.example/x', { 'a.example/x': { status: 302, headers: { location: '/x' } } }, dns);
    expect(loop.out).toMatchObject({ ok: false, reason: 'too many redirects' });
    expect(loop.calls).toHaveLength(broker.FETCH_TEXT_MAX_REDIRECTS + 1);
  });

  it('refuses a page whose peer is not the checked address (rebinding)', async () => {
    const { out } = await fetchWith('https://a.example/x', {
      'a.example/x': { status: 200, headers: { 'content-type': 'text/plain' }, body: 'x', peer: '10.0.0.9' },
    }, { 'a.example': [PUBLIC_A] });
    expect(out).toMatchObject({ ok: false, reason: 'connected to another address' });
  });

  it('refuses PDF and other types without reading the body, and failing statuses', async () => {
    const pdf = await fetchWith('https://a.example/p.pdf', { 'a.example/p.pdf': { status: 200, headers: { 'content-type': 'application/pdf' }, body: '%PDF-1.7' } }, { 'a.example': [PUBLIC_A] });
    expect(pdf.out).toMatchObject({ ok: false, reason: 'content type application/pdf' });
    expect(pdf.destroyed).toContain('a.example/p.pdf');
    const none = await fetchWith('https://a.example/n', { 'a.example/n': { status: 200, body: 'x' } }, { 'a.example': [PUBLIC_A] });
    expect(none.out).toMatchObject({ ok: false, reason: 'content type missing' });
    const missing = await fetchWith('https://a.example/m', { 'a.example/m': { status: 404, headers: { 'content-type': 'text/html' } } }, { 'a.example': [PUBLIC_A] });
    expect(missing.out).toMatchObject({ ok: false, reason: 'status 404', status: 404 });
  });

  it('keeps at most the raw cap of a big body and cuts the text to maxChars', async () => {
    const big = 'a line of text\n'.repeat(Math.ceil((3 * 1024 * 1024) / 15));
    const { out } = await fetchWith('https://a.example/big', { 'a.example/big': { status: 200, headers: { 'content-type': 'text/plain' }, body: big } }, { 'a.example': [PUBLIC_A] }, 1000);
    expect(out.ok).toBe(true);
    expect(out.bytes).toBeLessThanOrEqual(broker.FETCH_TEXT_MAX_RAW_BYTES + 64 * 1024);
    expect(out.truncated).toBe(true);
    expect(Array.from(out.text as string).length).toBeLessThanOrEqual(1000);
  });

  it('M2: a compressed stream that decodes to nothing fails at the wire cap, not the deadline', async () => {
    // gzip header, then empty non-final stored blocks: bytes on the wire, no output.
    const header = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0x03]);
    const empty = Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff]);
    const blocks = Math.ceil((broker.FETCH_TEXT_MAX_COMPRESSED_BYTES + 512 * 1024) / empty.length);
    const body = Buffer.concat([header, Buffer.alloc(blocks * empty.length)]);
    for (let k = 0; k < blocks; k += 1) empty.copy(body, header.length + k * empty.length);
    expect(zlib.gunzipSync(body.subarray(0, header.length + 100 * empty.length), { finishFlush: zlib.constants.Z_SYNC_FLUSH })).toHaveLength(0);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const { out } = await fetchWith('https://a.example/z', {
      'a.example/z': { status: 200, headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }, body },
    }, { 'a.example': [PUBLIC_A] }, 1000, controller.signal);
    clearTimeout(timer);
    expect(out).toMatchObject({ ok: false, reason: 'body too large' });
  });

  it('stops at the deadline', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    const { out } = await fetchWith('https://a.example/slow', { 'a.example/slow': { status: 200, hang: true } }, { 'a.example': [PUBLIC_A] }, 1000, controller.signal);
    expect(out).toMatchObject({ ok: false, reason: 'deadline' });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('http.fetch-text: the op', () => {
  function files(urls: unknown) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-fetch-text-'));
    const urlsFile = path.join(dir, 'urls.json');
    fs.writeFileSync(urlsFile, JSON.stringify(urls));
    return { dir, args: { 'urls-file': urlsFile, out: path.join(dir, 'out'), err: path.join(dir, 'err'), 'audit-log': path.join(dir, 'audit'), 'budget-file': path.join(dir, 'budget'), 'max-chars': '2000' } as Record<string, string> };
  }
  const audit = (f: string) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  it('is refused as a whole on a tainted run', async () => {
    const { args } = files(['https://a.example/x']);
    const fetcher = jest.fn();
    expect(await broker.runFetchText({ ...args, tainted: '1' }, 'now', Date.now(), fetcher)).toBe(40);
    expect(fetcher).not.toHaveBeenCalled();
    expect(audit(args['audit-log'])[0]).toMatchObject({ kind: 'http.fetch-text', decision: 'deny', reason: 'tainted run' });
  });

  it('refuses more than three URLs or a char limit past the cap', async () => {
    const fetcher = jest.fn();
    expect(await broker.runFetchText(files(['https://a.example/1', 'https://a.example/2', 'https://a.example/3', 'https://a.example/4']).args, 'now', Date.now(), fetcher)).toBe(44);
    expect(await broker.runFetchText({ ...files(['https://a.example/1']).args, 'max-chars': String(broker.FETCH_TEXT_MAX_CHARS + 1) }, 'now', Date.now(), fetcher)).toBe(44);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('charges the budget per URL and audits hosts, status, bytes and hash, never the text or the path', async () => {
    const { args } = files(['https://a.example/secret-path-1', 'http://plain.example/x', 'https://b.example/2']);
    const fetcher = jest.fn((url: string) => Promise.resolve(url.includes('a.example')
      ? { ok: true, status: 200, finalUrl: url, finalHost: 'a.example', bytes: 1234, sha: 'f'.repeat(64), text: 'PAGE BODY TEXT', truncated: false, redirects: 0 }
      : { ok: false, reason: 'status 404', status: 404, finalHost: 'b.example', redirects: 0 }));
    expect(await broker.runFetchText(args, 'now', Date.now(), fetcher)).toBe(0);
    expect(fetcher.mock.calls.map((c) => c[0])).toEqual(['https://a.example/secret-path-1', 'https://b.example/2']);
    expect(JSON.parse(fs.readFileSync(args.out, 'utf8'))).toEqual({ 'https://a.example/secret-path-1': { text: 'PAGE BODY TEXT', finalUrl: 'https://a.example/secret-path-1', truncated: false } });
    expect(JSON.parse(fs.readFileSync(args['budget-file'], 'utf8')).calls).toBe(2);
    const lines = audit(args['audit-log']);
    expect(lines.find((l) => l.decision === 'deny')).toMatchObject({ host: 'plain.example', reason: 'refused address' });
    expect(lines.find((l) => l.host === 'a.example')).toMatchObject({ ok: true, status: 200, bytes: 1234, sha: 'f'.repeat(64), chars: 14 });
    expect(lines.find((l) => l.host === 'b.example')).toMatchObject({ ok: false, status: 404, reason: 'status 404' });
    const raw = fs.readFileSync(args['audit-log'], 'utf8');
    expect(raw).not.toContain('PAGE BODY TEXT');
    expect(raw).not.toContain('secret-path');
  });

  it('cannot be widened by its fetcher: text cut again, a refused final address dropped', async () => {
    const { args } = files(['https://a.example/1', 'https://b.example/2']);
    const fetcher = (url: string) => Promise.resolve(url.includes('a.example')
      ? { ok: true, status: 200, finalUrl: url, finalHost: 'a.example', bytes: 1, sha: 'x', text: 'y'.repeat(5000), redirects: 0 }
      : { ok: true, status: 200, finalUrl: 'https://127.0.0.1/', finalHost: '127.0.0.1', bytes: 1, sha: 'x', text: 'inside', redirects: 0 });
    expect(await broker.runFetchText(args, 'now', Date.now(), fetcher)).toBe(0);
    const out = JSON.parse(fs.readFileSync(args.out, 'utf8'));
    expect(Object.keys(out)).toEqual(['https://a.example/1']);
    expect(out['https://a.example/1'].text).toHaveLength(2000);
  });

  it('gives up on what is not in by its deadline', async () => {
    const { args } = files(['https://a.example/1']);
    const started = Date.now();
    expect(await broker.runFetchText({ ...args, 'timeout-seconds': '0.05' }, 'now', Date.now(), () => new Promise(() => {}))).toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(JSON.parse(fs.readFileSync(args.out, 'utf8'))).toEqual({});
    expect(audit(args['audit-log'])[0]).toMatchObject({ ok: false, reason: 'deadline' });
  });
});

describe('http.fetch-text: page chrome and key sections (v54)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { JOURNAL_PAGE_HTML } = require('./fixtures/journal-page');
  const text = () => broker.trimFetchedBoilerplate(broker.htmlToText(JOURNAL_PAGE_HTML)) as string;

  it('raises the per-page cap to 60,000', () => {
    expect(broker.FETCH_TEXT_MAX_CHARS).toBe(60000);
  });

  it('drops navigation, the cookie banner, repeated short lines and the reference list', () => {
    const t = text();
    expect(t).not.toContain('Skip to main content');
    expect(t).not.toMatch(/cookies/i);
    expect(t.split('\n')).not.toContain('- Menu');
    expect(t).not.toContain('Back to top');
    expect(t).not.toContain('FIXTURE-REFERENCE');
    expect(t.split('\n').filter((l: string) => l === 'Share').length).toBeLessThanOrEqual(1);
    // The paper itself stays.
    expect(t).toContain('FIXTURE-METHODS');
    expect(t).toContain('FIXTURE-LIMITATIONS');
    expect(t).toContain('Introduction paragraph 60');
  });

  it('is conservative: a page with nothing to drop is unchanged, and an all-chrome page is left as it was', () => {
    const plain = 'A title\nA paragraph of the page.\nReferences to earlier work are in the text.';
    expect(broker.trimFetchedBoilerplate(plain)).toBe(plain);
    expect(broker.trimFetchedBoilerplate('Menu\nSearch')).toBe('Menu\nSearch');
    // A "References" link near the top does not cut the page.
    const early = `References\n${'body line\n'.repeat(20)}end`;
    expect(broker.trimFetchedBoilerplate(early)).toContain('end');
  });

  it('recognises key section headings and nothing else', () => {
    for (const h of ['Methods', '2. Methods', 'Materials and Methods', 'Results', '3.1 Results', 'Discussion', 'General discussion', 'Limitations', 'Limitations of the study', 'Conclusions', '方法', '結果', '考察', '限界', '研究の限界', '- Methods']) {
      expect([h, broker.isKeySectionHeading(h)]).toEqual([h, true]);
    }
    for (const h of ['Introduction', 'Methods for the reader who wants more detail', 'The results were clear.', 'References', '']) {
      expect([h, broker.isKeySectionHeading(h)]).toEqual([h, false]);
    }
  });

  it('a cut keeps the beginning and then Methods, Results, Discussion and Limitations, past the table of contents', () => {
    const t = text();
    expect(Array.from(t).length).toBeGreaterThan(14000);
    const { text: cut, truncated } = broker.capFetchedText(t, 12000);
    expect(truncated).toBe(true);
    expect(Array.from(cut).length).toBeLessThanOrEqual(12000);
    expect(cut.startsWith('A made-up study of practice schedules')).toBe(true);
    for (const m of ['FIXTURE-METHODS', 'FIXTURE-RESULTS', 'FIXTURE-LIMITATIONS']) expect(cut).toContain(m);
    expect(cut).toContain(broker.SECTION_CUT_MARK);
    expect(cut.indexOf('FIXTURE-METHODS')).toBeLessThan(cut.indexOf('FIXTURE-RESULTS'));
    expect(cut.indexOf('FIXTURE-RESULTS')).toBeLessThan(cut.indexOf('FIXTURE-LIMITATIONS'));
    expect(cut).toContain('Introduction paragraph 1:');
    // A plain head cut would have lost them.
    expect(Array.from(t).slice(0, 12000).join('')).not.toContain('FIXTURE-LIMITATIONS');
  });

  it('without a key heading the cut is the head, as before; within the budget nothing changes', () => {
    const t = 'line of text\n'.repeat(500);
    const r = broker.cutKeepingSections(t, 1000);
    expect(r.cut).toBe(true);
    expect(t.startsWith(r.text)).toBe(true);
    expect(broker.cutKeepingSections('short', 1000)).toEqual({ text: 'short', cut: false });
  });

  it('the whole fetch path trims and keeps the sections', async () => {
    const { out } = await fetchWith('https://a.example/paper', { 'a.example/paper': { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: JOURNAL_PAGE_HTML } }, { 'a.example': [PUBLIC_A] }, 12000);
    expect(out.ok).toBe(true);
    expect(out.truncated).toBe(true);
    expect(out.text).not.toContain('Skip to main content');
    expect(out.text).not.toContain('FIXTURE-REFERENCE');
    expect(out.text).toContain('FIXTURE-LIMITATIONS');
  });
});
