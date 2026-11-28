/**
 * read_residency (scripts/shelly-mcp-server.js): the residency ledger
 * ResidencyLedger.kt writes under ~/.shelly/services/<id>/, read by the MCP
 * server itself (no approval, no app fallback, nothing written or run), with
 * the seq / prev chain verified in node and the Keystore MACs reported
 * unverified. Lines are built here in ResidencyLedgerCore.canonical's exact
 * key order.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mcp = require('../scripts/shelly-mcp-server.js');

const ROOT = path.resolve(__dirname, '..');
const BOOT = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';

type Fields = { at: number; pid?: number | null; startTicks?: number | null; alive?: boolean; reason?: string; bootId?: string | null; health?: string };

/** ResidencyLedgerCore.canonical + signed, with a fake MAC (the real one is Keystore-only). */
function line(svc: string, seq: number, prev: string, f: Fields): string {
  const pid = f.pid === undefined ? 4242 : f.pid;
  const startTicks = f.startTicks === undefined ? 777 : f.startTicks;
  const canonical = `{"v":1,"seq":${seq},"at":${f.at},"elapsedRealtime":${f.at - 1_764_000_000_000},"bootId":${f.bootId === null ? 'null' : JSON.stringify(f.bootId ?? BOOT)},`
    + `"svc":"${svc}","pid":${pid === null ? 'null' : pid},"startTicks":${startTicks === null ? 'null' : startTicks},"startedAt":1764299000000,`
    + `"alive":${f.alive ?? true},"heartbeatAt":null,"health":${f.health ?? 'null'},"versionCode":2801,"reason":"${f.reason ?? 'tick'}","code":null,"prev":"${prev}"}`;
  const mac = crypto.createHash('sha256').update(`k:${canonical}`).digest('hex');
  return `${canonical.slice(0, -1)},"mac":"${mac}"}`;
}

function chain(svc: string, items: Fields[], firstSeq = 1, prev0 = ''): string[] {
  const out: string[] = [];
  let prev = prev0;
  items.forEach((f, i) => {
    const l = line(svc, firstSeq + i, prev, f);
    out.push(l);
    prev = crypto.createHash('sha256').update(l).digest('hex');
  });
  return out;
}

describe('read_residency', () => {
  let dir: string;
  let home: string;
  let queue: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-residency-')));
    home = path.join(dir, 'home');
    queue = path.join(home, '.shelly-mcp-queue');
    fs.mkdirSync(queue, { recursive: true });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const svcDir = (svc: string) => path.join(home, '.shelly', 'services', svc);
  const write = (svc: string, name: string, lines: string[]) => {
    fs.mkdirSync(svcDir(svc), { recursive: true });
    fs.writeFileSync(path.join(svcDir(svc), name), lines.map((l) => `${l}\n`).join(''));
  };
  const call = async (args: Record<string, unknown>) => {
    const fallback = jest.fn(async () => ({ ok: true, data: 'from-queue' }));
    const runGit = jest.fn();
    // /proc/self/fd where it exists; elsewhere (a Windows dev box) the opened
    // path stands in for it, so the rest of the open checks still run.
    let opened = '';
    const logIo = {
      beforeOpen: (file: string) => { opened = file; },
      readFdPath: (fd: number) => (fs.existsSync('/proc/self/fd') ? fs.readlinkSync(`/proc/self/fd/${fd}`) : opened),
    };
    const callTool = mcp.createDirectReadCallTool({ queueDir: queue, token: 't', fallback, runGit, logIo });
    const res = await callTool('read_residency', args, { principal: 'p' });
    expect(fallback).not.toHaveBeenCalled();
    expect(runGit).not.toHaveBeenCalled();
    return res;
  };

  it('is a read-only, always-listed tool with a closed schema and no approval', () => {
    const tool = mcp.TOOLS.find((t: { name: string }) => t.name === 'read_residency');
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(Object.keys(tool.inputSchema.properties)).toEqual(['serviceId', 'sinceMs', 'limit']);
    expect(tool.inputSchema.properties.serviceId.enum).toEqual(['article-delivery', 'council-facade']);
    expect(tool.inputSchema.required).toEqual(['serviceId']);
    expect(mcp.availableTools({}).map((t: { name: string }) => t.name)).toContain('read_residency');
    expect(mcp.APPROVAL_TOOLS.has('read_residency')).toBe(false);
    expect(mcp.TYPED_OP_TOOLS.has('read_residency')).toBe(false);
    expect(mcp.TYPED_REQUEST_TOOLS.has('read_residency')).toBe(false);
  });

  it('the server script and its APK asset stay byte-identical', () => {
    expect(fs.readFileSync(path.join(ROOT, 'modules/terminal-emulator/android/src/main/assets/shelly-mcp-server.js'), 'utf8'))
      .toBe(fs.readFileSync(path.join(ROOT, 'scripts/shelly-mcp-server.js'), 'utf8'));
  });

  it('rejects an unknown service and bad arguments', async () => {
    expect(await call({ serviceId: '../agents' })).toEqual({ ok: false, error: 'serviceId must be article-delivery or council-facade' });
    expect((await call({ serviceId: 'council-facade', sinceMs: -1 })).ok).toBe(false);
    expect((await call({ serviceId: 'council-facade', sinceMs: 'x' })).ok).toBe(false);
  });

  it('a missing ledger is an empty, intact answer', async () => {
    const res = await call({ serviceId: 'council-facade' });
    expect(res.ok).toBe(true);
    expect(res.data.entries).toEqual([]);
    expect(res.data.verification).toMatchObject({ lines: 0, chainOk: true, mac: 'unverified' });
    expect(res.data.untrusted).toBe(true);
  });

  it('returns both generations oldest first and verifies the chain across the rotation', async () => {
    const lines = chain('council-facade', Array.from({ length: 6 }, (_, i) => ({ at: 1_764_300_000_000 + i * 600_000, health: '{"ok":true,"cliSeatKinds":["codex","claude"],"ms":9}' })));
    write('council-facade', 'residency.jsonl.1', lines.slice(0, 4));
    write('council-facade', 'residency.jsonl', lines.slice(4));
    const res = await call({ serviceId: 'council-facade' });
    expect(res.ok).toBe(true);
    expect(res.data.entries.map((e: { seq: number }) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(res.data.entries[0].health).toEqual({ ok: true, cliSeatKinds: ['codex', 'claude'], ms: 9 });
    expect(res.data.files.map((f: { name: string }) => f.name)).toEqual(['residency.jsonl.1', 'residency.jsonl']);
    expect(res.data.verification).toMatchObject({ lines: 6, firstSeq: 1, lastSeq: 6, chainOk: true, brokenAtSeq: null, unparsed: 0, mac: 'unverified' });
  });

  it('reports the first break: an edited line, a dropped line, garbage', async () => {
    const lines = chain('article-delivery', Array.from({ length: 5 }, (_, i) => ({ at: 1_764_300_000_000 + i * 600_000 })));
    const edited = [...lines];
    edited[2] = edited[2].replace('"pid":4242', '"pid":4243');
    write('article-delivery', 'residency.jsonl', edited);
    expect((await call({ serviceId: 'article-delivery' })).data.verification).toMatchObject({ chainOk: false, brokenAtSeq: 4 });

    write('article-delivery', 'residency.jsonl', lines.filter((_, i) => i !== 1));
    expect((await call({ serviceId: 'article-delivery' })).data.verification).toMatchObject({ chainOk: false, brokenAtSeq: 3 });

    write('article-delivery', 'residency.jsonl', [lines[0], 'not json', ...lines.slice(1)]);
    const res = await call({ serviceId: 'article-delivery' });
    expect(res.data.verification).toMatchObject({ chainOk: false, brokenAtSeq: 2, unparsed: 1 });
    expect(res.data.entries).toHaveLength(5);
  });

  it('a window that starts mid-chain (older lines rotated away) is still ok', async () => {
    const lines = chain('article-delivery', Array.from({ length: 5 }, (_, i) => ({ at: 1_764_300_000_000 + i * 600_000 })));
    write('article-delivery', 'residency.jsonl', lines.slice(2));
    expect((await call({ serviceId: 'article-delivery' })).data.verification).toMatchObject({ chainOk: true, firstSeq: 3 });
  });

  it('sinceMs keeps the oldest `limit` matching lines; without it the newest are kept', async () => {
    const t0 = 1_764_300_000_000;
    const lines = chain('council-facade', Array.from({ length: 10 }, (_, i) => ({ at: t0 + i * 600_000 })));
    write('council-facade', 'residency.jsonl', lines);
    const since = await call({ serviceId: 'council-facade', sinceMs: t0 + 3 * 600_000, limit: 2 });
    expect(since.data.entries.map((e: { seq: number }) => e.seq)).toEqual([4, 5]);
    expect(since.data).toMatchObject({ matching: 7, returned: 2, truncated: true });
    const newest = await call({ serviceId: 'council-facade', limit: 3 });
    expect(newest.data.entries.map((e: { seq: number }) => e.seq)).toEqual([8, 9, 10]);
    const capped = await call({ serviceId: 'council-facade', limit: 999_999 });
    expect(capped.data.returned).toBe(10);
    expect(mcp.RESIDENCY_MAX_LIMIT).toBe(2000);
  });

  it('projects lines to the ledger fields only and drops lines out of shape', () => {
    const [good] = chain('council-facade', [{ at: 1_764_300_000_000 }]);
    const p = mcp.projectResidencyLine(Buffer.from(good));
    expect(Object.keys(p)).toEqual(['seq', 'at', 'elapsedRealtime', 'bootId', 'svc', 'pid', 'startTicks', 'startedAt', 'alive', 'heartbeatAt', 'health', 'versionCode', 'reason', 'code', 'prev', 'mac']);
    expect(mcp.projectResidencyLine(Buffer.from(good.replace('"svc":"council-facade"', '"svc":"other"')))).toBeNull();
    expect(mcp.projectResidencyLine(Buffer.from(good.replace('"reason":"tick"', '"reason":"rm -rf"')))).toBeNull();
    expect(mcp.projectResidencyLine(Buffer.from(good.replace('"v":1', '"v":2')))).toBeNull();
    expect(mcp.projectResidencyLine(Buffer.from(good.replace(/"mac":"[0-9a-f]+"/, '"mac":"x"')))).toBeNull();
  });

  it('refuses a symlinked ledger file', async () => {
    fs.mkdirSync(svcDir('council-facade'), { recursive: true });
    const target = path.join(dir, 'elsewhere.jsonl');
    fs.writeFileSync(target, '');
    try {
      fs.symlinkSync(target, path.join(svcDir('council-facade'), 'residency.jsonl'));
    } catch {
      return; // no symlink permission (Windows without developer mode)
    }
    const res = await call({ serviceId: 'council-facade' });
    expect(res.ok).toBe(false);
  });

  it('reads and writes nothing else: no exec, no write calls in the implementation', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/shelly-mcp-server.js'), 'utf8');
    const start = src.indexOf('// ── read_residency ──');
    const end = src.indexOf('// ── list_drafts / read_draft ──');
    const body = src.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(body).not.toMatch(/writeFile|appendFile|openSync\([^)]*['"]w|spawn|execFile|execSync|unlink|rename/);
  });
});
