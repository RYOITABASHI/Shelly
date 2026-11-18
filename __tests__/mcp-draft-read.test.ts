import * as nodeCrypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mcp = require('../scripts/shelly-mcp-server.js');

// list_drafts / read_draft: answered by the MCP server process itself, from the
// output folders named in ~/.shelly/agents/article-pipelines.json, so they work
// while Shelly (RN) is asleep in the background.

const TOKEN = 'test-token';

let dir: string;
let home: string;
let queue: string;
let vault: string;

function snapshotBody() {
  return JSON.stringify({ v: 1, agents: [{ id: 'a1' }], repoPaths: [] });
}
function writeSnapshot(token = TOKEN) {
  const body = snapshotBody();
  fs.writeFileSync(path.join(queue, 'snapshot.json'), JSON.stringify({ body, mac: mcp.snapshotMac(token, body) }));
}
function writeConfig(pipelines: unknown[], extra: Record<string, unknown> = {}) {
  fs.writeFileSync(path.join(home, '.shelly', 'agents', 'article-pipelines.json'), JSON.stringify({ version: 1, pipelines, ...extra }));
}
function pipeline(id: string, folder: string) {
  return { id, outputFolder: folder };
}
function draft(series: string, name: string, content: string, mtimeSec?: number) {
  const file = path.join(vault, series, name);
  fs.writeFileSync(file, content);
  if (mtimeSec !== undefined) fs.utimesSync(file, mtimeSec, mtimeSec);
  return file;
}
// The executor's draft frontmatter (assembleArticle): title, date, saved_at
// and review make a file a draft. `lines` replace those keys or add others.
const IDENTITY: Record<string, string> = {
  title: 'title: "A draft"',
  date: 'date: 2026-11-18',
  saved_at: 'saved_at: 2026-11-18T06:00:00.000Z',
  review: 'review: pass',
};
function fm(lines: string[], body = 'Body text.\n') {
  const keys = new Set(lines.map((l) => l.split(':')[0]));
  const base = Object.entries(IDENTITY).filter(([k]) => !keys.has(k)).map(([, v]) => v);
  return raw([...lines, ...base], body);
}
function raw(lines: string[], body = 'Body text.\n') {
  return `---\n${lines.join('\n')}\n---\n\n${body}`;
}
function make(logIo?: { readFdPath: (fd: number) => string | null; beforeOpen: (file: string) => void }) {
  const fallback = jest.fn(async () => ({ ok: true, data: 'from-queue' }));
  const callTool = mcp.createDirectReadCallTool({ queueDir: queue, token: TOKEN, fallback, runGit: jest.fn(), ...(logIo ? { logIo } : {}) });
  return { callTool, fallback };
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-drafts-')));
  home = path.join(dir, 'home');
  queue = path.join(home, '.shelly-mcp-queue');
  vault = path.join(home, 'vault', 'Drafts');
  fs.mkdirSync(queue, { recursive: true });
  fs.mkdirSync(path.join(home, '.shelly', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'Steam'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'Dev'), { recursive: true });
  writeConfig([pipeline('steam', path.join(vault, 'Steam')), pipeline('dev', `${path.join(vault, 'Dev')}/`)]);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('list_drafts', () => {
  it('answers from the server itself, with a verified snapshot (RN in the background) and without one, never through the queue', async () => {
    draft('Steam', '2026-11-18-steam.md', fm(['title: "Steam one"', 'date: 2026-11-18', 'review: pass']), 1_000);
    const { callTool, fallback } = make();
    writeSnapshot();
    const withSnap = await callTool('list_drafts', {});
    expect(withSnap.ok).toBe(true);
    fs.rmSync(path.join(queue, 'snapshot.json'));
    const withoutSnap = await callTool('list_drafts', {});
    expect(withoutSnap).toEqual(withSnap);
    writeSnapshot('old-token');
    expect(await callTool('list_drafts', {})).toEqual(withSnap);
    expect(fallback).not.toHaveBeenCalled();
    expect(withSnap.data.untrusted).toBe(true);
  });

  it('lists every series newest first with bytes, modified time and the projected frontmatter', async () => {
    const a = fm([
      'title: "Old \\"quoted\\" title"',
      'stream: "steam"',
      'date: 2026-11-16',
      'saved_at: 2026-11-16T06:01:02.345Z',
      'review: unresolved',
      'review_note: "free text the tool does not return"',
      'material: ok',
      'quality: fail',
      'quality_score: 3.2',
      'quality_note: "editor prose"',
      'lint: []',
    ]);
    draft('Steam', '2026-11-16-steam.md', a, 1_000);
    draft('Dev', '2026-11-17-dev.md', fm(['title: Plain title', 'date: 2026-11-17', 'review: pass', 'quality: pass', 'quality_score: 4']), 2_000);
    const res = await make().callTool('list_drafts', {});
    expect(res.ok).toBe(true);
    expect(res.data.series).toEqual([
      { series: 'Steam', pipelineId: 'steam', drafts: 1 },
      { series: 'Dev', pipelineId: 'dev', drafts: 1 },
    ]);
    expect(res.data.truncated).toBe(false);
    expect(res.data.skipped).toBe(0);
    expect(res.data.drafts).toEqual([
      {
        series: 'Dev',
        file: '2026-11-17-dev.md',
        bytes: Buffer.byteLength(fm(['title: Plain title', 'date: 2026-11-17', 'review: pass', 'quality: pass', 'quality_score: 4'])),
        modifiedAt: new Date(2_000_000).toISOString(),
        frontmatter: { title: 'Plain title', date: '2026-11-17', review: 'pass', quality: 'pass', quality_score: 4, saved_at: '2026-11-18T06:00:00.000Z' },
      },
      {
        series: 'Steam',
        file: '2026-11-16-steam.md',
        bytes: Buffer.byteLength(a),
        modifiedAt: new Date(1_000_000).toISOString(),
        frontmatter: { title: 'Old "quoted" title', date: '2026-11-16', review: 'unresolved', quality: 'fail', quality_score: 3.2, saved_at: '2026-11-16T06:01:02.345Z' },
      },
    ]);
    // Fields outside the six are never returned.
    expect(JSON.stringify(res.data)).not.toMatch(/free text|editor prose|material|lint/);
  });

  it('skips _-files, hidden files, non-.md files, folders, links and hard links', async () => {
    draft('Steam', 'real.md', fm(['title: ok']), 1_000);
    draft('Steam', '_queue.md', '- [ ] topic\n');
    draft('Steam', '.hidden.md', fm(['title: hidden']));
    draft('Steam', 'notes.txt', 'x');
    fs.mkdirSync(path.join(vault, 'Steam', 'sub.md'));
    const outside = path.join(dir, 'outside.md');
    fs.writeFileSync(outside, fm(['title: outside']));
    fs.symlinkSync(outside, path.join(vault, 'Steam', 'link.md'));
    const twin = path.join(dir, 'twin.md');
    fs.writeFileSync(twin, fm(['title: twin']));
    fs.linkSync(twin, path.join(vault, 'Steam', 'hard.md'));
    const res = await make().callTool('list_drafts', { series: 'Steam' });
    expect(res.data.drafts.map((d: { file: string }) => d.file)).toEqual(['real.md']);
    expect(res.data.skipped).toBe(3); // sub.md, link.md, hard.md (_queue.md and .hidden.md are never looked at)
    expect(res.data.series).toEqual([{ series: 'Steam', pipelineId: 'steam', drafts: 1 }]);
  });

  it('series filter and limit', async () => {
    for (let i = 0; i < 5; i++) draft('Dev', `d${i}.md`, fm([`title: d${i}`]), 1_000 + i);
    draft('Steam', 's.md', fm(['title: s']), 5_000);
    const { callTool } = make();
    const two = await callTool('list_drafts', { limit: 2 });
    expect(two.data.drafts.map((d: { file: string }) => d.file)).toEqual(['s.md', 'd4.md']);
    expect(two.data.truncated).toBe(true);
    const dev = await callTool('list_drafts', { series: 'Dev', limit: 1e9 });
    expect(dev.data.drafts).toHaveLength(5);
    expect(dev.data.series.map((s: { series: string }) => s.series)).toEqual(['Dev']);
    expect((await callTool('list_drafts', { series: 'Nope' })).error).toBe('no article pipeline saves to a folder named Nope');
    for (const series of ['../x', '.hidden', 'a/b', '', 5]) {
      expect((await callTool('list_drafts', { series })).error).toBe('series must be an output folder name from list_drafts');
    }
  });

  it('a missing folder is reported per series, not as a failure', async () => {
    writeConfig([pipeline('steam', path.join(vault, 'Steam')), pipeline('new', path.join(vault, 'NotYet'))]);
    draft('Steam', 'a.md', fm(['title: a']));
    const res = await make().callTool('list_drafts', {});
    expect(res.ok).toBe(true);
    expect(res.data.series).toEqual([
      { series: 'Steam', pipelineId: 'steam', drafts: 1 },
      { series: 'NotYet', pipelineId: 'new', drafts: 0, missing: true },
    ]);
  });

  it('refuses a configured folder that is a link or sits below one, and two pipelines with one folder name', async () => {
    fs.symlinkSync(path.join(vault, 'Steam'), path.join(vault, 'Alias'));
    fs.mkdirSync(path.join(home, 'elsewhere', 'Inner'), { recursive: true });
    fs.symlinkSync(path.join(home, 'elsewhere'), path.join(vault, 'Parent'));
    fs.mkdirSync(path.join(home, 'other', 'Steam'), { recursive: true });
    writeConfig([
      pipeline('alias', path.join(vault, 'Alias')),
      pipeline('inner', path.join(vault, 'Parent', 'Inner')),
      pipeline('steam', path.join(vault, 'Steam')),
      pipeline('steam2', path.join(home, 'other', 'Steam')),
    ]);
    draft('Steam', 'a.md', fm(['title: a']));
    const res = await make().callTool('list_drafts', {});
    expect(res.data.series).toEqual([
      { series: 'Alias', pipelineId: 'alias', drafts: 0, error: 'refused: the folder or one of its parents is a link' },
      { series: 'Inner', pipelineId: 'inner', drafts: 0, error: 'refused: the folder or one of its parents is a link' },
      { series: 'Steam', pipelineId: 'steam', drafts: 1 },
      { series: 'Steam', pipelineId: 'steam2', drafts: 0, error: 'refused: another pipeline uses the same folder name' },
    ]);
    expect(res.data.drafts.map((d: { file: string }) => d.file)).toEqual(['a.md']);
  });

  it('refuses system, hidden and unplain folders', () => {
    const real = fs.realpathSync(home);
    const r = (folder: string) => mcp.resolveDraftFolder(folder, home, real);
    expect(r('/proc/self')).toEqual({ error: 'a system folder' });
    expect(r('/dev')).toEqual({ error: 'a system folder' });
    expect(r(`${home}/.shelly/agents`).error).toBe('not an absolute path of plain folder names');
    expect(r('relative/Drafts').error).toBe('not an absolute path of plain folder names');
    expect(r('/a/../b').error).toBe('not an absolute path of plain folder names');
    expect(r('/a/b c').error).toBe('not an absolute path of plain folder names');
    expect(r(home)).toEqual({ error: 'a storage or home root itself' });
    expect(r('/sdcard')).toEqual({ error: 'a storage or home root itself' });
    // A folder in the home is fine; its real path must stay in the home.
    fs.mkdirSync(path.join(home, 'agent-output', 'Garden'), { recursive: true });
    expect(r(path.join(home, 'agent-output', 'Garden'))).toEqual({ real: path.join(real, 'agent-output', 'Garden') });
    fs.mkdirSync(path.join(home, '.secret'), { recursive: true });
    fs.symlinkSync(path.join(home, '.secret'), path.join(home, 'agent-output', 'Hidden'));
    expect(r(path.join(home, 'agent-output', 'Hidden')).error).toBe('the folder or one of its parents is a link');
  });

  it('config problems are plain errors', async () => {
    const { callTool } = make();
    fs.rmSync(path.join(home, '.shelly', 'agents', 'article-pipelines.json'));
    expect((await callTool('list_drafts', {})).error).toContain('no article pipelines configured');
    fs.writeFileSync(path.join(home, '.shelly', 'agents', 'article-pipelines.json'), '{not json');
    expect((await callTool('list_drafts', {})).error).toBe('article-pipelines.json is not valid JSON');
    const bad = async (file: unknown) => {
      fs.writeFileSync(path.join(home, '.shelly', 'agents', 'article-pipelines.json'), JSON.stringify(file));
      return (await callTool('list_drafts', {})).error;
    };
    const ok = pipeline('steam', path.join(vault, 'Steam'));
    expect(await bad({ version: 1 })).toBe('article-pipelines.json: pipelines is not a list of at most 16');
    expect(await bad({ version: 2, pipelines: [ok] })).toBe('article-pipelines.json: version is not 1');
    expect(await bad({ pipelines: [ok] })).toBe('article-pipelines.json: version is not 1');
    expect(await bad([ok])).toBe('article-pipelines.json is not an object');
    expect(await bad({ version: 1, pipelines: Array.from({ length: 17 }, (_, i) => pipeline(`p${i}`, path.join(vault, `S${i}`))) }))
      .toBe('article-pipelines.json: pipelines is not a list of at most 16');
    for (const id of [undefined, 'Steam', 'digest', 'a_b', 'x'.repeat(33)]) {
      expect(await bad({ version: 1, pipelines: [{ id, outputFolder: path.join(vault, 'Steam') }] })).toBe('article-pipelines.json: pipelines[0] has no valid, unique id');
    }
    expect(await bad({ version: 1, pipelines: [ok, pipeline('steam', path.join(vault, 'Dev'))] })).toBe('article-pipelines.json: pipelines[1] has no valid, unique id');
    for (const outputFolder of [undefined, 5, 'relative/Steam', `${vault}/../Steam`, `${vault}/a b`]) {
      expect(await bad({ version: 1, pipelines: [{ id: 'steam', outputFolder }] })).toBe('article-pipelines.json: pipelines[0].outputFolder is not an absolute path of plain folder names');
    }
    fs.rmSync(path.join(home, '.shelly', 'agents', 'article-pipelines.json'));
    const target = path.join(dir, 'planted.json');
    fs.writeFileSync(target, JSON.stringify({ version: 1, pipelines: [pipeline('x', path.join(vault, 'Steam'))] }));
    fs.symlinkSync(target, path.join(home, '.shelly', 'agents', 'article-pipelines.json'));
    expect((await callTool('list_drafts', {})).error).toMatch(/^refused/);
  });

  it('nothing is read when /proc/self/fd does not confirm the file (or is missing)', async () => {
    draft('Steam', 'a.md', fm(['title: a']));
    // The config is opened first (same check): let it through, then lie about the draft.
    const io = {
      beforeOpen: () => {},
      readFdPath: (fd: number) => {
        const real = fs.readlinkSync(`/proc/self/fd/${fd}`);
        return real.endsWith('.md') ? '/elsewhere/a.md' : real;
      },
    };
    const lied = await make(io).callTool('list_drafts', {});
    expect(lied.data.drafts).toEqual([]);
    expect(lied.data.skipped).toBe(1);
    // Answered like a missing name (no existence signal), and nothing read.
    expect(await make(io).callTool('read_draft', { series: 'Steam', file: 'a.md' })).toEqual({ ok: false, error: 'no draft a.md in Steam' });
    const noProc = { beforeOpen: () => {}, readFdPath: () => null };
    expect((await make(noProc).callTool('list_drafts', {})).error).toMatch(/no \/proc\/self\/fd/);
  });
});

describe('read_draft', () => {
  it('returns the whole draft (secrets redacted), from the server itself', async () => {
    const text = fm(['title: "T"'], 'Intro.\nkey sk-ant-abcdefghijklmnopqrstuvwxyz0123 here\n日本語の本文。\n');
    draft('Steam', 'a.md', text, 3_000);
    const { callTool, fallback } = make();
    const res = await callTool('read_draft', { series: 'Steam', file: 'a.md' });
    expect(fallback).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({
      series: 'Steam',
      file: 'a.md',
      bytes: Buffer.byteLength(text),
      modifiedAt: new Date(3_000_000).toISOString(),
      truncated: false,
      omittedLines: 0,
      text: mcp.redactForMcp(text),
      untrusted: true,
    });
    expect(res.data.text).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(res.data.text).toContain('日本語の本文。');
  });

  it('caps the text: 32 KiB by default, 64 KiB at most, 256 B at least, never splitting a character', async () => {
    const head = fm([], '');
    const para = 'あ'.repeat(1_000); // 3,000 bytes per line
    const big = head + Array(30).fill(para).join('\n'); // + ~90,000 bytes
    draft('Steam', 'big.md', big);
    const { callTool } = make();
    const def = await callTool('read_draft', { series: 'Steam', file: 'big.md' });
    expect(def.data.truncated).toBe(true);
    expect(def.data.bytes).toBe(Buffer.byteLength(big));
    // Whole characters only (a Japanese run is not a token: nothing extra is dropped).
    expect(Buffer.byteLength(def.data.text)).toBeGreaterThan(32_768 - 3);
    expect(Buffer.byteLength(def.data.text)).toBeLessThanOrEqual(32_768);
    expect(big.startsWith(def.data.text)).toBe(true);
    const max = await callTool('read_draft', { series: 'Steam', file: 'big.md', maxBytes: 1e9 });
    expect(Buffer.byteLength(max.data.text)).toBeLessThanOrEqual(mcp.DRAFT_READ_MAX_BYTES);
    expect(Buffer.byteLength(max.data.text)).toBeGreaterThan(mcp.DRAFT_READ_MAX_BYTES - 3);
    const min = await callTool('read_draft', { series: 'Steam', file: 'big.md', maxBytes: 1 });
    expect(Buffer.byteLength(min.data.text)).toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(min.data.text)).toBeGreaterThan(200);
    const small = fm([], 'short\n');
    draft('Steam', 'small.md', small);
    expect((await callTool('read_draft', { series: 'Steam', file: 'small.md', maxBytes: 256 })).data).toMatchObject({ text: small, truncated: false });
  });

  it('refuses traversal and anything the folder does not list as a plain draft', async () => {
    draft('Steam', 'a.md', fm(['title: a']));
    fs.writeFileSync(path.join(home, 'vault', 'secret.md'), fm([], 'SECRET'));
    fs.symlinkSync(path.join(home, 'vault', 'secret.md'), path.join(vault, 'Steam', 'link.md'));
    const twin = path.join(dir, 'twin.md');
    fs.writeFileSync(twin, fm([], 'TWIN'));
    fs.linkSync(twin, path.join(vault, 'Steam', 'hard.md'));
    const { callTool } = make();
    const bad = 'file must be a draft file name from list_drafts';
    for (const file of ['../secret.md', '../../home/.shelly/agents/article-pipelines.json', 'Steam/a.md', '/etc/passwd', '.hidden.md', '_queue.md', 'a.txt', 'a.md\u0000', '..', '', 'x'.repeat(300) + '.md', 5]) {
      expect((await callTool('read_draft', { series: 'Steam', file })).error).toBe(bad);
    }
    for (const series of ['..', '../Steam', 'Steam/..', '.']) {
      expect((await callTool('read_draft', { series, file: 'a.md' })).error).toBe('series must be an output folder name from list_drafts');
    }
    expect((await callTool('read_draft', { series: 'Other', file: 'a.md' })).error).toBe('no article pipeline saves to a folder named Other');
    expect((await callTool('read_draft', { series: 'Steam', file: 'none.md' })).error).toBe('no draft none.md in Steam');
    expect((await callTool('read_draft', { series: 'Dev', file: 'a.md' })).error).toBe('no draft a.md in Dev');
    // A link, a hard link or a folder named like a draft answers exactly like a missing name.
    fs.mkdirSync(path.join(vault, 'Steam', 'dir.md'));
    for (const file of ['link.md', 'hard.md', 'dir.md']) {
      expect(await callTool('read_draft', { series: 'Steam', file })).toEqual({ ok: false, error: `no draft ${file} in Steam` });
    }
    const results = await Promise.all(['link.md', 'hard.md'].map((file) => callTool('read_draft', { series: 'Steam', file })));
    expect(JSON.stringify(results)).not.toMatch(/SECRET|TWIN/);
  });

  it('a FIFO named like a draft cannot block the server', async () => {
    const { execFileSync } = await import('child_process');
    execFileSync('mkfifo', [path.join(vault, 'Steam', 'pipe.md')]);
    const { callTool } = make();
    expect(await callTool('read_draft', { series: 'Steam', file: 'pipe.md' })).toEqual({ ok: false, error: 'no draft pipe.md in Steam' });
    const list = await callTool('list_drafts', {});
    expect(list.ok).toBe(true);
    expect(list.data.skipped).toBe(1);
  });

  it('refuses a draft that is not UTF-8', async () => {
    fs.writeFileSync(path.join(vault, 'Steam', 'bin.md'), Buffer.concat([Buffer.from(fm([], '')), Buffer.from([0xff, 0xfe, 0x00, 0x41])]));
    expect((await make().callTool('read_draft', { series: 'Steam', file: 'bin.md' })).error).toBe('the draft is not valid UTF-8');
  });
});

describe('only the executor\'s drafts, from a pinned folder (Codex round 1)', () => {
  it('other notes in the folder are neither listed nor read', async () => {
    draft('Steam', 'draft.md', fm([]), 2_000);
    draft('Steam', 'plain-note.md', '# A note\n\nprivate thoughts\n', 3_000);
    draft('Steam', 'other-fm.md', raw(['title: "note"', 'tags: [x]'], 'private thoughts\n'), 3_000);
    draft('Steam', 'no-saved-at.md', raw(['title: "t"', 'date: 2026-11-18', 'review: pass'], 'private thoughts\n'), 3_000);
    draft('Steam', 'odd-review.md', fm(['review: approved'], 'private thoughts\n'), 3_000);
    const { callTool } = make();
    const list = await callTool('list_drafts', {});
    expect(list.data.drafts.map((d: { file: string }) => d.file)).toEqual(['draft.md']);
    expect(list.data.series[0]).toEqual({ series: 'Steam', pipelineId: 'steam', drafts: 1 });
    expect(list.data.skipped).toBe(4);
    for (const file of ['plain-note.md', 'other-fm.md', 'no-saved-at.md', 'odd-review.md']) {
      const res = await callTool('read_draft', { series: 'Steam', file });
      expect(res).toEqual({ ok: false, error: `no draft ${file} in Steam` });
    }
    expect(JSON.stringify(list)).not.toContain('private thoughts');
  });

  it('a folder neither on shared storage nor in the home folder is refused', async () => {
    fs.mkdirSync(path.join(dir, 'outside', 'Steam'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'outside', 'Steam', 'a.md'), fm([]));
    writeConfig([pipeline('steam', path.join(dir, 'outside', 'Steam'))]);
    const { callTool } = make();
    expect((await callTool('list_drafts', {})).data.series).toEqual([
      { series: 'Steam', pipelineId: 'steam', drafts: 0, error: 'refused: neither on shared storage nor in the home folder' },
    ]);
    expect((await callTool('read_draft', { series: 'Steam', file: 'a.md' })).error).toBe('refused: neither on shared storage nor in the home folder');
  });

  const realFd = (fd: number) => fs.readlinkSync(`/proc/self/fd/${fd}`);

  it('the folder moving during the listing leaks no names, counts or contents', async () => {
    draft('Steam', 'a.md', fm([], 'BODY'));
    const steam = path.join(vault, 'Steam');
    let dirChecks = 0;
    const io = {
      beforeOpen: () => {},
      readFdPath: (fd: number) => {
        const where = realFd(fd);
        if (where !== steam) return where;
        dirChecks += 1;
        return dirChecks === 1 ? where : `${steam}-moved`;
      },
    };
    const res = await make(io).callTool('list_drafts', {});
    expect(res.data.series[0]).toEqual({ series: 'Steam', pipelineId: 'steam', drafts: 0, error: 'refused: the folder moved while it was listed' });
    expect(res.data.drafts).toEqual([]);
    expect(res.data.skipped).toBe(0);
    dirChecks = 0;
    expect((await make(io).callTool('read_draft', { series: 'Steam', file: 'a.md' })).error).toBe('refused: the folder moved while it was read');
  });

  it('a parent swapped for a link after the path check is caught on the pinned folder', async () => {
    draft('Steam', 'a.md', fm([], 'GOOD'));
    const evil = path.join(home, 'evil', 'Steam');
    fs.mkdirSync(evil, { recursive: true });
    fs.writeFileSync(path.join(evil, 'a.md'), fm([], 'EVIL'));
    const steam = path.join(vault, 'Steam');
    const swap = () => {
      fs.renameSync(vault, `${vault}-orig`);
      fs.symlinkSync(path.join(home, 'evil'), vault);
    };
    const io = { readFdPath: realFd, beforeOpen: (p: string) => { if (p === steam) swap(); } };
    const list = await make(io).callTool('list_drafts', { series: 'Steam' });
    expect(list.data.series[0].error).toBe('refused: cannot confirm the folder is where it is configured');
    expect(JSON.stringify(list)).not.toContain('a.md');
    fs.rmSync(vault);
    fs.renameSync(`${vault}-orig`, vault);
    const read = await make(io).callTool('read_draft', { series: 'Steam', file: 'a.md' });
    expect(read.error).toBe('refused: cannot confirm the folder is where it is configured');
    expect(JSON.stringify(read)).not.toMatch(/EVIL|GOOD/);
  });

  it('the folder itself swapped for a link after the path check is not opened', async () => {
    draft('Steam', 'a.md', fm([], 'GOOD'));
    const evil = path.join(home, 'evil');
    fs.mkdirSync(evil);
    fs.writeFileSync(path.join(evil, 'a.md'), fm([], 'EVIL'));
    const steam = path.join(vault, 'Steam');
    const io = {
      readFdPath: realFd,
      beforeOpen: (p: string) => {
        if (p !== steam) return;
        fs.renameSync(steam, `${steam}-orig`);
        fs.symlinkSync(evil, steam);
      },
    };
    const read = await make(io).callTool('read_draft', { series: 'Steam', file: 'a.md' });
    expect(read.error).toBe('refused: cannot open the folder');
    expect(JSON.stringify(read)).not.toContain('EVIL');
  });

  it('a secret crossing the cap is never emitted in part', async () => {
    const secret = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789';
    const head = fm([], '');
    // The secret starts 10 bytes before the 512-byte cap.
    const body = `${'x '.repeat((512 - Buffer.byteLength(head) - 10) / 2)}${secret} tail\n`;
    draft('Steam', 'cross.md', head + body);
    const res = await make().callTool('read_draft', { series: 'Steam', file: 'cross.md', maxBytes: 512 });
    expect(res.data.truncated).toBe(true);
    expect(Buffer.byteLength(res.data.text)).toBeLessThanOrEqual(512);
    expect(res.data.text).not.toMatch(/sk-a|abcdef/);
    expect(res.data.text.endsWith('x ')).toBe(true);
  });

  it('redactDraftText: whole lines redacted, an ASCII run cut by the cap dropped, long lines not shown', () => {
    const r = mcp.redactDraftText;
    expect(r('hello world', 100)).toEqual({ text: 'hello world', cut: false, omittedLines: 0 });
    expect(r('hello world', 8)).toEqual({ text: 'hello ', cut: true, omittedLines: 0 });
    expect(r('hello world', 6)).toEqual({ text: 'hello ', cut: true, omittedLines: 0 });
    expect(r('日本語の本文', 9)).toEqual({ text: '日本語', cut: true, omittedLines: 0 });
    expect(r('a\nb\nc', 3)).toEqual({ text: 'a\nb', cut: true, omittedLines: 0 });
    const key = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789';
    // Redacted before the cut: at most part of the marker, never of the key.
    const out = r(`a ${key} b`, 20).text;
    expect(out.startsWith('a <redacted')).toBe(true);
    expect(out).not.toMatch(/sk-ant|abcdef/);
    // A line over 4 KiB is replaced by a marker, never redacted or shown.
    const long = `x ${'p'.repeat(5_000)}`;
    expect(r(`top\n${long}\nend`, 1_000)).toEqual({ text: 'top\n[a line of 5002 bytes is not shown]\nend', cut: false, omittedLines: 1 });
  });

  it('URL userinfo is redacted before a token rule can split it', () => {
    // A token rule matching inside the userinfo used to come first.
    const line = `see https://me:sk-proj-${'A'.repeat(24)}tail@host.example/x`;
    const out = mcp.redactDraftText(line, 1_000).text;
    expect(out).toBe('see https://<redacted>@host.example/x');
  });

  it('a secret folded onto the next line is redacted, also right at the cap', () => {
    const tok = 'Zq9'.repeat(12);
    for (const [first, second] of [
      ['Authorization: Bearer', `  ${tok}`],
      ['password:', `  ${tok}`],
      ['"api_token":', `"${tok}"`],
    ]) {
      const text = `${'w '.repeat(100)}\n${first}\n${second}\nafter\n`;
      // Whole text, and cut right after the first line of the pair.
      const capAt = Buffer.byteLength(`${'w '.repeat(100)}\n${first}\n`) + 3;
      for (const cap of [10_000, capAt]) {
        const out = mcp.redactDraftText(text, cap).text;
        expect(out).not.toContain('Zq9');
      }
    }
  });

  it('a quoted secret that does not close on its line is redacted from its quote and ends the answer', () => {
    const r = mcp.redactDraftText;
    expect(r('x = {"api_token": "abc\ndef"}\nmore', 10_000)).toEqual({ text: 'x = {"api_token": "<redacted>', cut: true, omittedLines: 0 });
    expect(r('token:\n"abc\nstill secret"\nx', 10_000)).toEqual({ text: 'token:\n<redacted>', cut: true, omittedLines: 0 });
    const single = r("password: 'abc\ndef'\nmore", 10_000);
    expect(single.cut).toBe(true);
    expect(single.text).not.toMatch(/abc|def|more/);
    // Closed on the line: nothing stops.
    expect(r('session: "abc" fine\nnext', 10_000)).toEqual({ text: 'session: <redacted> fine\nnext', cut: false, omittedLines: 0 });
    expect(mcp.draftUnclosedQuoteAt('a "b" c', false)).toBe(-1);
  });

  it('folded values: whole next line after name + separator, one word after an auth scheme, a separator on the next line', () => {
    const r = (t: string) => mcp.redactDraftText(t, 10_000).text;
    expect(r('password:\nmy secret phrase here\nnext')).toBe('password:\n<redacted>\nnext');
    expect(r('Authorization: Bearer\n  ZZZtoken1234567 trailing words\nafter')).toBe('Authorization: <redacted>\n  <redacted> trailing words\nafter');
    expect(r('api_key\n= sk_live_abcdef123 more\nok')).toBe('api_key\n= <redacted>\nok');
    expect(r('api_key\n:\n  sk_live_abcdef123\nok')).toBe('api_key\n:\n<redacted>\nok');
    expect(r('Cookie:\n a=b; c=d\nx')).not.toMatch(/a=b|c=d/);
    // Conservative on prose: a line ending like `name:` hides the next line.
    expect(r('The key:\nThis is a normal paragraph.')).toBe('The key:\n<redacted>');
    // A bare name followed by an ordinary line changes nothing.
    expect(r('Session keys\nare rotated daily.')).toBe('Session keys\nare rotated daily.');
  });

  it('a frontmatter close at the end of the 8 KiB head counts only when the file ends there', async () => {
    const p = mcp.projectDraftFrontmatter;
    const head = fm([], '').replace(/\n\n$/, '');
    expect(head.endsWith('\n---')).toBe(true);
    expect(p(head, false).title).toBeNull();
    expect(p(head, true).title).toBe('A draft');
    expect(p(`${head}\n`, false).title).toBe('A draft');
    // A file whose head ends in `\n---` but goes on on that line (`---more`) is not a draft.
    const pad = 8 * 1024 - Buffer.byteLength(head);
    const lines = [IDENTITY.title, IDENTITY.date, IDENTITY.saved_at, IDENTITY.review, `x: ${'y'.repeat(pad - 1)}`];
    const fake = `---\n${lines.join('\n')}`;
    const filler = 8 * 1024 - Buffer.byteLength(`${fake}\n---`);
    const tricky = `---\n${lines.slice(0, 4).join('\n')}\nx: ${'y'.repeat(pad - 1 + filler)}\n---more and more\nprivate\n`;
    expect(Buffer.byteLength(tricky.slice(0, tricky.indexOf('more')))).toBe(8 * 1024);
    draft('Steam', 'tricky.md', tricky);
    const { callTool } = make();
    expect((await callTool('list_drafts', {})).data.drafts).toEqual([]);
    expect(await callTool('read_draft', { series: 'Steam', file: 'tricky.md' })).toEqual({ ok: false, error: 'no draft tricky.md in Steam' });
  });

  it('state carries across omitted and value lines (Codex round 6)', () => {
    const r = (t: string) => mcp.redactDraftText(t, 100_000);
    // An omitted line that opens a quoted secret ends the answer.
    for (const t of [`password: "${'x'.repeat(5_000)}\nCANARY"\nafter`, `password:\n"${'x'.repeat(5_000)}\nCANARY"\nafter`]) {
      const res = r(t);
      expect(res.cut).toBe(true);
      expect(res.text).not.toMatch(/CANARY|after/);
      expect(res.omittedLines).toBe(1);
    }
    // A value line is classified again by how it ends.
    expect(r('Bearer\nsynthetic-token password:\nCANARY\nok').text).toBe('Bearer\n<redacted> password:\n<redacted>\nok');
    expect(r('api_key\n= v1 token:\nCANARY').text).not.toContain('CANARY');
    // An omitted line that ends in `name:` hides the next line too.
    expect(r(`${'y '.repeat(2_100)}token:\nCANARY\nok`).text).not.toContain('CANARY');
  });

  it('an omitted line around a pending value ends the answer; whole-line values check their quotes (Codex round 7)', () => {
    const r = (t: string, n = 100_000) => mcp.redactDraftText(t, n);
    for (const t of [
      `api_key\n= ${'x'.repeat(5_000)}\nCANARY`,
      `api_key\n=${' '.repeat(5_000)}\nCANARY`,
      `api_key\n= "${'x'.repeat(5_000)}\nCANARY"`,
      `password:\n${'x'.repeat(5_000)}\nCANARY`,
      `${'w '.repeat(2_600)}password:\nCANARY`,
      // An oversized blank line while a value or a separator is pending.
      `password:\n${' '.repeat(5_000)}\nCANARY`,
      `api_key\n${' '.repeat(5_000)}\n= CANARY`,
    ]) {
      const res = r(t);
      expect(res.cut).toBe(true);
      expect(res.text).not.toContain('CANARY');
    }
    const quoted = r('password:\nfoo "secret": "abc\nCANARY"\nmore');
    expect(quoted).toEqual({ text: 'password:\n<redacted>', cut: true, omittedLines: 0 });
    // Plain long lines (and long blank ones) are just markers; the answer goes on.
    expect(r(`normal\n${'z '.repeat(3_000)}\nok`)).toEqual({ text: 'normal\n[a line of 6000 bytes is not shown]\nok', cut: false, omittedLines: 1 });
    expect(r(`a\n${' '.repeat(5_000)}\nok`)).toEqual({ text: 'a\n[a line of 5000 bytes is not shown]\nok', cut: false, omittedLines: 1 });
    // A marker cut by the cap is not counted.
    expect(r(`${' '.repeat(5_000)}\nok`, 10).omittedLines).toBe(0);
  });

  it('list_drafts titles redact URL userinfo first too', () => {
    const t = mcp.projectDraftFrontmatter(fm([`title: "see https://me:sk-proj-${'A'.repeat(24)}tail@host.example/x"`])).title;
    expect(t).toBe('see https://<redacted>@host.example/x');
  });

  it('redaction work is bounded: a hostile answer-sized draft is redacted quickly', () => {
    // Long identifiers full of secret-name words and no assignment (the named-secret rule backtracks).
    const hostile = Array(16).fill(`${'tokenkey'.repeat(500)}`).join('\n'); // 16 lines of 4,000 bytes
    const t0 = Date.now();
    mcp.redactDraftText(hostile, mcp.DRAFT_READ_MAX_BYTES);
    // A secret-name run followed by a long run of blank lines (whitespace rules).
    mcp.redactDraftText(`${'token'.repeat(800)}${'\n'.repeat(60_000)}=x`, mcp.DRAFT_READ_MAX_BYTES);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('an oversized or non-UTF-8 file that is not a draft answers like a missing name', async () => {
    draft('Steam', 'big-note.md', `# note\n${'x'.repeat(mcp.DRAFT_FILE_MAX_BYTES)}`);
    fs.writeFileSync(path.join(vault, 'Steam', 'bin-note.md'), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    const { callTool } = make();
    for (const file of ['big-note.md', 'bin-note.md']) {
      expect(await callTool('read_draft', { series: 'Steam', file })).toEqual({ ok: false, error: `no draft ${file} in Steam` });
    }
  });

  it('read_draft refuses a draft over 1 MiB', async () => {
    draft('Steam', 'huge.md', fm([], 'x'.repeat(mcp.DRAFT_FILE_MAX_BYTES)));
    expect((await make().callTool('read_draft', { series: 'Steam', file: 'huge.md' })).error).toBe(`refused: the draft is larger than ${mcp.DRAFT_FILE_MAX_BYTES} bytes`);
  });

  it('a folder over the open cap keeps the newest drafts and says it is truncated', async () => {
    // 1,001 drafts; the alphabetically last one is the newest (an alphabetical cap would drop it).
    for (let i = 0; i < 1_001; i++) draft('Dev', `n${String(i).padStart(4, '0')}.md`, fm([]), i === 1_000 ? 900_000 : 1_000 + i);
    const res = await make().callTool('list_drafts', { series: 'Dev', limit: 1 });
    expect(res.data.drafts.map((d: { file: string }) => d.file)).toEqual(['n1000.md']);
    expect(res.data.truncated).toBe(true);
    expect(res.data.skipped).toBe(1);
    expect(res.data.series[0].drafts).toBe(1_000);
  });
});

describe('projectDraftFrontmatter', () => {
  const p = mcp.projectDraftFrontmatter;
  const none = { title: null, date: null, review: null, quality: null, quality_score: null, saved_at: null };

  it('no frontmatter block → all null', () => {
    expect(p('# Title\n\ntext')).toEqual(none);
    expect(p('---\ntitle: never closed\n')).toEqual(none);
    expect(p(undefined)).toEqual(none);
  });

  it('first occurrence wins; values outside their forms are null', () => {
    expect(p(fm([
      'title: "first"',
      'title: "second"',
      'date: tomorrow',
      'review: <b>pass</b>',
      'quality: PASS',
      'quality_score: 4; rm -rf',
      'saved_at: 2026-11-18 morning',
    ]))).toEqual({ ...none, title: 'first' });
  });

  it('title: JSON-unquoted, control and direction characters out, redacted, capped at 200 characters, dropped over 300', () => {
    expect(p(fm(['title: "a\\u0007b\\u202ec sk-ant-abcdefghijklmnopqrstuvwxyz0123"'])).title).toBe(`a b c ${mcp.redactForMcp('sk-ant-abcdefghijklmnopqrstuvwxyz0123')}`);
    expect(p(fm(['title: "broken'])).title).toBeNull();
    expect(Array.from(p(fm([`title: ${'字'.repeat(300)}`])).title as string)).toHaveLength(200);
    expect(p(fm([`title: ${'字'.repeat(301)}`])).title).toBeNull();
    // A long hostile title is dropped before any redaction runs (list_drafts reads up to 1000 heads).
    const hostile = fm([`title: "${'token'.repeat(1_500)}"`]);
    const t0 = Date.now();
    for (let i = 0; i < 100; i++) expect(p(hostile).title).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('accepts the executor\'s own frontmatter (CRLF and a BOM too)', () => {
    const head = '﻿---\r\ntitle: "T"\r\ndate: 2026-11-19\r\nsaved_at: 2026-11-19T07:00:00Z\r\nreview: pass\r\nquality: unresolved\r\n---\r\n\r\nbody';
    expect(p(head)).toEqual({ title: 'T', date: '2026-11-19', review: 'pass', quality: 'unresolved', quality_score: null, saved_at: '2026-11-19T07:00:00Z' });
  });
});

describe('tool definitions', () => {
  const byName = Object.fromEntries(mcp.TOOLS.map((t: { name: string }) => [t.name, t]));

  it('strict read-only schemas, listed with no switch, and no write tool added', () => {
    expect(byName.list_drafts.inputSchema.additionalProperties).toBe(false);
    expect(Object.keys(byName.list_drafts.inputSchema.properties)).toEqual(['series', 'limit']);
    expect(byName.read_draft.inputSchema.additionalProperties).toBe(false);
    expect(Object.keys(byName.read_draft.inputSchema.properties)).toEqual(['series', 'file', 'maxBytes']);
    expect(byName.read_draft.inputSchema.required).toEqual(['series', 'file']);
    const names = mcp.availableTools({}).map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_drafts', 'read_draft']));
    expect(mcp.APPROVAL_TOOLS.has('list_drafts') || mcp.APPROVAL_TOOLS.has('read_draft')).toBe(false);
  });

  it('the folder rule matches the pipeline file\'s', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agent-pipeline-presets.ts'), 'utf8');
    const m = /const ARTICLE_FOLDER_RE = (\/.*\/);/.exec(src);
    expect(m && m[1]).toBe(String(mcp.DRAFT_FOLDER_RE));
  });

  it('the APK asset copy of the server is byte-identical', () => {
    const a = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'shelly-mcp-server.js'));
    const b = fs.readFileSync(path.join(__dirname, '..', 'modules', 'terminal-emulator', 'android', 'src', 'main', 'assets', 'shelly-mcp-server.js'));
    expect(nodeCrypto.createHash('sha256').update(a).digest('hex')).toBe(nodeCrypto.createHash('sha256').update(b).digest('hex'));
  });
});
