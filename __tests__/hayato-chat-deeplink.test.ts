import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MAX_CHAT_REQUESTS,
  MAX_SLUG_TABLE,
  REPEAT_WINDOW_MS,
  appendChatRequest,
  createChatRequestQueue,
  isHayatoSchemeUrl,
  parseHayatoChatLink,
  resolveHayatoChatLink,
  sanitizeChatRequests,
  sanitizeSlugTable,
} from '@/lib/hayato-chat-link';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mcp = require('../scripts/shelly-mcp-server.js');

// hayato://chat/<slug> (D5 v1): a navigation REQUEST that Shelly validates,
// queues and shows a confirmation for. Any app can send the VIEW intent, so
// the path is display + enqueue only. Slugs here are made up on purpose; the
// owner's real slug table is device-side data, never shipped.

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const TABLE = ['alpha-line', 'demo-chat'];

describe('S2: only exactly hayato://chat/<slug> is a chat link', () => {
  it('accepts the exact shape (scheme/host case-insensitive, slug case-sensitive)', () => {
    expect(parseHayatoChatLink('hayato://chat/alpha-line')).toEqual({ kind: 'chat', slug: 'alpha-line' });
    expect(parseHayatoChatLink('HAYATO://Chat/alpha-line')).toEqual({ kind: 'chat', slug: 'alpha-line' });
    expect(parseHayatoChatLink('hayato://chat/Alpha-Line')).toEqual({ kind: 'chat', slug: 'Alpha-Line' });
  });

  it.each([
    'hayato://chat',
    'hayato://chat/',
    'hayato://chat/alpha-line/',
    'hayato://chat/alpha-line/extra',
    'hayato://chat/alpha-line?x=1',
    'hayato://chat/alpha-line#frag',
    'hayato://chat/alpha-line?',
    'hayato://chat//alpha-line',
    'hayato://chat/%61lpha-line',
    'hayato://chat/alpha line',
    'hayato://chat/alpha-line\n',
    ' hayato://chat/alpha-line',
    'hayato://other/alpha-line',
    'hayato://user@chat/alpha-line',
    'hayato://chat:80/alpha-line',
    'hayato:///chat/alpha-line',
    'hayato:chat/alpha-line',
    'hayato://agent-add-decision?reqId=1',
    'hayato://chat.evil/alpha-line',
    'shelly://chat/alpha-line',
    'https://chat/alpha-line',
    `hayato://chat/${'a'.repeat(200)}`,
    '',
    undefined,
    null,
    42,
  ])('ignores %p', (url) => {
    expect(parseHayatoChatLink(url as unknown)).toEqual({ kind: 'ignore' });
    expect(resolveHayatoChatLink(url, TABLE)).toEqual({ kind: 'ignore' });
  });

  it('isHayatoSchemeUrl only claims hayato: URIs (shelly:// is untouched)', () => {
    expect(isHayatoSchemeUrl('hayato://anything')).toBe(true);
    expect(isHayatoSchemeUrl('HAYATO:x')).toBe(true);
    expect(isHayatoSchemeUrl('shelly://browser?url=x')).toBe(false);
    expect(isHayatoSchemeUrl('https://hayato://x')).toBe(false);
    expect(isHayatoSchemeUrl(undefined)).toBe(false);
  });
});

describe('S1: slug must match the regex AND be in the device-side table', () => {
  it('queues a registered slug', () => {
    expect(resolveHayatoChatLink('hayato://chat/alpha-line', TABLE)).toEqual({ kind: 'queue', slug: 'alpha-line' });
  });

  it('is unresolved for unknown slugs and for every slug when the table is empty (the default)', () => {
    expect(resolveHayatoChatLink('hayato://chat/other-one', TABLE)).toEqual({ kind: 'unresolved' });
    for (const empty of [[], undefined, null, 'alpha-line', {}]) {
      expect(resolveHayatoChatLink('hayato://chat/alpha-line', empty)).toEqual({ kind: 'unresolved' });
    }
  });

  it('is unresolved for shape-valid but regex-invalid slugs, even if a bad table entry matches', () => {
    for (const bad of ['Alpha', 'a_b', 'a.b', 'a~b', 'a'.repeat(41), '.', '..']) {
      expect(resolveHayatoChatLink(`hayato://chat/${bad}`, [bad, ...TABLE])).toEqual({ kind: 'unresolved' });
    }
  });

  it('accepts the 40-char boundary', () => {
    const s = 'a'.repeat(40);
    expect(resolveHayatoChatLink(`hayato://chat/${s}`, [s])).toEqual({ kind: 'queue', slug: s });
  });

  it('sanitizeSlugTable keeps valid, unique slugs and caps at 32', () => {
    expect(sanitizeSlugTable(['alpha-line', 'alpha-line', 'Bad', 'a b', 5, '', 'demo-chat'])).toEqual(['alpha-line', 'demo-chat']);
    expect(sanitizeSlugTable('x')).toEqual([]);
    const many = Array.from({ length: 50 }, (_, i) => `s${i}`);
    expect(sanitizeSlugTable(many)).toHaveLength(MAX_SLUG_TABLE);
    expect(MAX_SLUG_TABLE).toBe(32);
  });
});

describe('bounded queue', () => {
  it('appends {id, slug, ts} only and drops the oldest beyond 20', () => {
    let q: ReturnType<typeof appendChatRequest> = [];
    for (let i = 0; i < 25; i++) q = appendChatRequest(q, 'alpha-line', 1000 + i, `id${i}`);
    expect(q).toHaveLength(MAX_CHAT_REQUESTS);
    expect(q[0]).toEqual({ id: 'id5', slug: 'alpha-line', ts: 1005 });
    expect(q[19]).toEqual({ id: 'id24', slug: 'alpha-line', ts: 1024 });
    expect(Object.keys(q[0]).sort()).toEqual(['id', 'slug', 'ts']);
  });

  it('sanitizeChatRequests drops malformed entries and extra keys', () => {
    const out = sanitizeChatRequests({
      entries: [
        { id: 'a1', slug: 'alpha-line', ts: 1, extra: 'x' },
        { id: 'bad id', slug: 'alpha-line', ts: 1 },
        { id: 'a2', slug: 'Bad', ts: 1 },
        { id: 'a3', slug: 'demo-chat', ts: -1 },
        { id: 'a4', slug: 'demo-chat', ts: 'x' },
        null,
        'x',
      ],
    });
    expect(out).toEqual([{ id: 'a1', slug: 'alpha-line', ts: 1 }]);
    expect(sanitizeChatRequests(null)).toEqual([]);
    expect(sanitizeChatRequests([])).toEqual([]);
  });

  function memoryQueue(start = 10_000) {
    let stored: string | null = null;
    let now = start;
    let n = 0;
    const q = createChatRequestQueue(
      { read: async () => stored, write: async (t) => { stored = t; } },
      () => `id${n++}`,
      () => now,
    );
    return { q, get: () => (stored ? JSON.parse(stored) : null), advance: (ms: number) => { now += ms; } };
  }

  it('ignores the same slug re-delivered within the window, accepts it after, and other slugs at once', async () => {
    const m = memoryQueue();
    expect(await m.q.enqueue('alpha-line')).toBe(true);
    m.advance(REPEAT_WINDOW_MS - 1);
    expect(await m.q.enqueue('alpha-line')).toBe(false);
    expect(await m.q.enqueue('demo-chat')).toBe(true);
    m.advance(REPEAT_WINDOW_MS);
    expect(await m.q.enqueue('alpha-line')).toBe(true);
    expect(m.get().entries.map((e: { slug: string }) => e.slug)).toEqual(['alpha-line', 'demo-chat', 'alpha-line']);
    expect(m.get().version).toBe(1);
  });

  it('refuses an invalid slug and survives a corrupt queue file', async () => {
    const m = memoryQueue();
    expect(await m.q.enqueue('Not Valid')).toBe(false);
    expect(m.get()).toBeNull();
    let stored: string | null = '{not json';
    const q = createChatRequestQueue({ read: async () => stored, write: async (t) => { stored = t; } }, () => 'x1', () => 5);
    expect(await q.enqueue('alpha-line')).toBe(true);
    expect(JSON.parse(stored as string).entries).toEqual([{ id: 'x1', slug: 'alpha-line', ts: 5 }]);
  });

  it('serialises concurrent enqueues (no lost entries)', async () => {
    const m = memoryQueue();
    await Promise.all(['a-1', 'a-2', 'a-3'].map((s) => m.q.enqueue(s)));
    expect(m.get().entries.map((e: { slug: string }) => e.slug)).toEqual(['a-1', 'a-2', 'a-3']);
  });
});

describe('S3: display + enqueue only (source pins)', () => {
  const link = read('lib/hayato-chat-link.ts');
  const io = read('lib/hayato-chat-requests.ts');
  const layout = read('app/_layout.tsx');

  it('the pure module imports nothing', () => {
    expect(link).not.toMatch(/^\s*import\s/m);
    expect(link).not.toMatch(/\brequire\(/);
  });

  it('the file module imports only the filesystem and the pure module', () => {
    const imports = [...io.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['@/lib/hayato-chat-link', 'expo-file-system/legacy']);
    expect(io).not.toMatch(/exec|spawn|approve|agent|Linking\.openURL|WebBrowser/i);
  });

  it('the _layout handler only resolves, toasts and enqueues', () => {
    const start = layout.indexOf('const handleHayatoChatLink');
    const end = layout.indexOf('const handleDeepLink = async');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = layout.slice(start, end);
    expect(body).toContain('resolveHayatoChatLink(');
    expect(body).toContain('hayatoChatRequestQueue.enqueue(');
    expect(body).not.toMatch(/execCommand|TerminalEmulator|Linking\.|WebBrowser|openUrl|runAgent|approve|Approval|submit|useAgentStore|useAIPaneStore|pendingExternalPrompt|Alert\.alert/);
    // The raw URL / slug never reaches a log call.
    expect(body).not.toMatch(/log(Info|Error|Warn)\([^)]*(url|slug)/);
  });

  it('the hayato branch runs before the generic shelly:// target logic', () => {
    const fn = layout.slice(layout.indexOf('const handleDeepLink = async'));
    const branch = fn.indexOf('isHayatoSchemeUrl(url)');
    expect(branch).toBeGreaterThan(0);
    expect(branch).toBeLessThan(fn.indexOf('Linking.parse(url)'));
    expect(branch).toBeLessThan(fn.indexOf('normalizeDeepLinkTarget(parsed)'));
    expect(fn.slice(branch, branch + 200)).toContain('return;');
  });

  it('native-intent sends hayato: URIs to the home route instead of an unmatched route', () => {
    const { redirectSystemPath } = require('../app/+native-intent'); // eslint-disable-line @typescript-eslint/no-require-imports
    expect(redirectSystemPath({ path: 'hayato://chat/alpha-line', initial: true })).toBe('/');
    expect(redirectSystemPath({ path: 'HAYATO://chat/alpha-line', initial: false })).toBe('/');
    expect(redirectSystemPath({ path: 'shelly://agent-chat?compose=1', initial: false })).toBe('shelly://agent-chat?compose=1');
    expect(redirectSystemPath({ path: '/ai', initial: false })).toBe('/ai');
  });
});

describe('manifest, settings and i18n', () => {
  it('app.config.ts declares a hayato VIEW filter for host chat only, without autoVerify', () => {
    const cfg = read('app.config.ts');
    const i = cfg.indexOf('scheme: "hayato"');
    expect(i).toBeGreaterThan(0);
    const block = cfg.slice(cfg.lastIndexOf('{\n        // hayato://chat', i), cfg.indexOf('category:', i) + 40);
    expect(block).toContain('action: "VIEW"');
    expect(block).toContain('host: "chat"');
    expect(block).not.toContain('autoVerify');
    expect(cfg.match(/scheme: "hayato"/g)).toHaveLength(1);
    // The shelly filter is unchanged (env.scheme, wildcard host, autoVerify).
    expect(cfg).toMatch(/autoVerify: true,\s*data: \[\s*\{\s*scheme: env\.scheme,\s*host: "\*"/);
  });

  it('the slug table is a persisted, sanitised, empty-by-default setting', () => {
    const store = read('store/settings-store.ts');
    expect(store).toMatch(/hayatoChatSlugs: \[\],/);
    expect(store).toContain('settings.hayatoChatSlugs = sanitizeSlugTable(settings.hayatoChatSlugs)');
    expect(store).toContain('updated.hayatoChatSlugs = sanitizeSlugTable(newSettings.hayatoChatSlugs)');
  });

  it('en and ja define the same hayato_chat.* keys', () => {
    const keys = (src: string) => [...src.matchAll(/'(hayato_chat\.[a-z_]+)':/g)].map((m) => m[1]).sort();
    const en = keys(read('lib/i18n/locales/en.ts'));
    expect(en.length).toBeGreaterThanOrEqual(8);
    expect(keys(read('lib/i18n/locales/ja.ts'))).toEqual(en);
  });

  it('the settings UI uses theme colors only in the new section', () => {
    const src = read('components/layout/SettingsDropdown.tsx');
    const section = src.slice(src.indexOf('const HayatoChatSlugsSection'), src.indexOf('// ─── Social Connectors'));
    expect(section.length).toBeGreaterThan(500);
    expect(section).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});

describe('S4/D6: nothing owner-specific is shipped', () => {
  // Built by join so this file does not itself contain the strings.
  const REAL = [['shelly', 'dev'], ['close' + 'paw'], ['coun' + 'cil'], ['hayato', 'os'], ['shelly', 'bridge'], ['nac' + 're']]
    .map((parts) => parts.join('-'));
  const files = [
    'app.config.ts', 'app/+native-intent.ts', 'lib/hayato-chat-link.ts', 'lib/hayato-chat-requests.ts',
    'store/settings-store.ts', '__tests__/hayato-chat-deeplink.test.ts',
  ];
  const mine = (f: string) => {
    // settings-store/app.config legitimately mention unrelated words; only the
    // slug-table lines I added are in scope for the real-slug check.
    const text = read(f);
    return f === 'app.config.ts' || f === 'store/settings-store.ts'
      ? text.split('\n').filter((l) => /hayato/i.test(l)).join('\n')
      : text;
  };

  it.each(files)('%s has no real slug values', (f) => {
    const text = mine(f);
    for (const slug of REAL) expect(text).not.toContain(slug);
  });

  it('the settings section and locale strings have none either', () => {
    const src = read('components/layout/SettingsDropdown.tsx');
    const section = src.slice(src.indexOf('const HayatoChatSlugsSection'), src.indexOf('// ─── Social Connectors'));
    const loc = (f: string) => read(f).split('\n').filter((l) => l.includes('hayato_chat.')).join('\n');
    for (const text of [section, loc('lib/i18n/locales/en.ts'), loc('lib/i18n/locales/ja.ts')]) {
      for (const slug of REAL) expect(text).not.toContain(slug);
    }
  });

  it('the default slug table is empty', () => {
    expect(resolveHayatoChatLink(`hayato://chat/${REAL[0]}`, [])).toEqual({ kind: 'unresolved' });
  });
});

describe('MCP read_chat_requests (read-only, no approval, answered by the server)', () => {
  let dir: string;
  let home: string;
  let queue: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-chatreq-')));
    home = path.join(dir, 'home');
    queue = path.join(home, '.shelly-mcp-queue');
    fs.mkdirSync(queue, { recursive: true });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const call = (args: Record<string, unknown> = {}) => {
    const fallback = jest.fn(async () => ({ ok: true, data: 'from-queue' }));
    const callTool = mcp.createDirectReadCallTool({ queueDir: queue, token: 't', fallback, runGit: jest.fn() });
    return callTool('read_chat_requests', args).then((res: unknown) => ({ res, fallback }));
  };
  const writeQueue = (text: string) => {
    fs.mkdirSync(path.join(home, '.shelly'), { recursive: true });
    fs.writeFileSync(path.join(home, '.shelly', 'chat-requests.json'), text);
  };

  it('is listed as a read-only tool with an empty schema', () => {
    const tool = mcp.TOOLS.find((t: { name: string }) => t.name === 'read_chat_requests');
    expect(tool.inputSchema).toEqual({ type: 'object', additionalProperties: false, properties: {} });
    expect(mcp.availableTools({}).map((t: { name: string }) => t.name)).toContain('read_chat_requests');
  });

  it('returns [] when there is no queue yet, without touching the app fallback', async () => {
    const { res, fallback } = await call();
    expect(res).toEqual({ ok: true, data: { requests: [], untrusted: true } });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('returns the validated entries as {id, slug, ts} and does not clear the queue', async () => {
    writeQueue(JSON.stringify({ version: 1, entries: [{ id: 'a1', slug: 'alpha-line', ts: 5, x: 'drop' }, { id: 'b2', slug: 'BAD', ts: 6 }, { id: 'c3', slug: 'demo-chat', ts: 7 }] }));
    const { res } = await call();
    expect(res).toEqual({ ok: true, data: { requests: [{ id: 'a1', slug: 'alpha-line', ts: 5 }, { id: 'c3', slug: 'demo-chat', ts: 7 }], untrusted: true } });
    expect(JSON.parse(fs.readFileSync(path.join(home, '.shelly', 'chat-requests.json'), 'utf8')).entries).toHaveLength(3);
  });

  it('caps at 20 even if the file holds more', async () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({ id: `i${i}`, slug: 'alpha-line', ts: i }));
    writeQueue(JSON.stringify({ version: 1, entries }));
    const { res } = await call();
    const requests = (res as { data: { requests: { id: string }[] } }).data.requests;
    expect(requests).toHaveLength(20);
    expect(requests[0].id).toBe('i10');
  });

  it('refuses a symlink, bad JSON, wrong shape and an oversized file', async () => {
    writeQueue('{nope');
    expect(((await call()).res as { error: string }).error).toBe('the chat request queue is not valid JSON');
    writeQueue('[]');
    expect(((await call()).res as { error: string }).error).toBe('the chat request queue is not in the expected format');
    writeQueue(' '.repeat(20 * 1024));
    expect(((await call()).res as { error: string }).error).toContain('larger than');
    fs.rmSync(path.join(home, '.shelly', 'chat-requests.json'));
    fs.writeFileSync(path.join(dir, 'real.json'), '{"entries":[]}');
    fs.symlinkSync(path.join(dir, 'real.json'), path.join(home, '.shelly', 'chat-requests.json'));
    expect(((await call()).res as { error: string }).error).toMatch(/^refused/);
  });

  it('the server asset is byte-identical to the script', () => {
    expect(read('modules/terminal-emulator/android/src/main/assets/shelly-mcp-server.js')).toBe(read('scripts/shelly-mcp-server.js'));
  });
});
