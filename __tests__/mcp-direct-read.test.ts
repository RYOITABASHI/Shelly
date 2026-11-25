import * as nodeCrypto from 'crypto';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mcp = require('../scripts/shelly-mcp-server.js');

jest.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///data/test/' }));
jest.mock('@/store/agent-store', () => ({ useAgentStore: { getState: () => ({ agents: [] }), subscribe: () => () => {} } }));
jest.mock('@/store/sidebar-store', () => ({ useSidebarStore: { getState: () => ({ repoPaths: [] }), subscribe: () => () => {} } }));
jest.mock('@/store/settings-store', () => ({ useSettingsStore: { getState: () => ({ settings: {} }) } }));
jest.mock('@/store/terminal-store', () => ({ useTerminalStore: { getState: () => ({ sessions: [] }) } }));
jest.mock('@/store/mcp-approval-store', () => ({ useMcpApprovalStore: { getState: () => ({}) } }));
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({}));
jest.mock('@/hooks/use-native-exec', () => ({ execCommand: jest.fn() }));
jest.mock('@/lib/command-safety', () => ({ checkCommandSafety: jest.fn() }));
jest.mock('@/lib/debug-logger', () => ({ logError: jest.fn(), logInfo: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const bridge = require('../lib/mcp-server-bridge');

const nodeSha256 = async (d: Uint8Array) => new Uint8Array(nodeCrypto.createHash('sha256').update(d).digest());
const sign = (token: string, body: string): Promise<string> => bridge.signSnapshot(token, body, nodeSha256);

const TOKEN = 'test-token';
const AGENTS = [{ id: 'a1', name: 'Example', enabled: true, schedule: null, autonomous: false }];
const REPO = '/home/example/repo';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-direct-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function writeSnapshot(token: string, body = bridge.buildSnapshotBody(AGENTS, [REPO])) {
  fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify({ body, mac: await sign(token, body) }));
}

function make(runGit: jest.Mock = jest.fn(async (): Promise<unknown> => ({ ok: true, data: 'On branch main\n' }))) {
  const fallback = jest.fn(async () => ({ ok: true, data: 'from-queue' }));
  const callTool = mcp.createDirectReadCallTool({ queueDir: dir, token: TOKEN, fallback, runGit });
  return { callTool, fallback, runGit };
}

describe('MCP direct reads', () => {
  it('RN and the server agree on the snapshot MAC', async () => {
    const body = bridge.buildSnapshotBody(AGENTS, [REPO]);
    expect(await sign(TOKEN, body)).toBe(mcp.snapshotMac(TOKEN, body));
    const long = 'x'.repeat(5000);
    expect(await sign(long, long)).toBe(mcp.snapshotMac(long, long));
  });

  it('answers list_agents / list_repos from a verified snapshot without the queue', async () => {
    await writeSnapshot(TOKEN);
    const { callTool, fallback } = make();
    expect(await callTool('list_agents', {})).toEqual({ ok: true, data: AGENTS });
    expect(await callTool('list_repos', {})).toEqual({ ok: true, data: [REPO] });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('runs git_status itself, only for a repo in the snapshot', async () => {
    await writeSnapshot(TOKEN);
    const { callTool, fallback, runGit } = make();
    expect(await callTool('git_status', { path: REPO })).toEqual({ ok: true, data: 'On branch main\n' });
    expect(runGit).toHaveBeenCalledWith(REPO);
    const refused = await callTool('git_status', { path: '/elsewhere' });
    expect(refused.ok).toBe(false);
    expect(runGit).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('falls back to the queue when git cannot be spawned here', async () => {
    await writeSnapshot(TOKEN);
    const { callTool, fallback } = make(jest.fn(async () => ({ spawnFailed: true })));
    expect(await callTool('git_status', { path: REPO })).toEqual({ ok: true, data: 'from-queue' });
    expect(fallback).toHaveBeenCalledWith('git_status', { path: REPO }, undefined);
  });

  it('ignores a missing, forged, old-token or malformed snapshot and uses the queue', async () => {
    const { callTool, fallback } = make();
    expect(await callTool('list_repos', {})).toEqual({ ok: true, data: 'from-queue' });

    await writeSnapshot('old-token');
    expect(await callTool('list_repos', {})).toEqual({ ok: true, data: 'from-queue' });

    const forged = bridge.buildSnapshotBody(AGENTS, ['/forged']);
    fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify({ body: forged, mac: '00'.repeat(32) }));
    expect(await callTool('list_repos', {})).toEqual({ ok: true, data: 'from-queue' });

    fs.writeFileSync(path.join(dir, 'snapshot.json'), 'not json');
    expect(await callTool('list_repos', {})).toEqual({ ok: true, data: 'from-queue' });

    const wrongShape = JSON.stringify({ v: 2, agents: [], repoPaths: [] });
    fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify({ body: wrongShape, mac: await sign(TOKEN, wrongShape) }));
    expect(await callTool('list_repos', {})).toEqual({ ok: true, data: 'from-queue' });
    expect(fallback).toHaveBeenCalledTimes(5);
  });

  it('never answers terminal, diagnostics, exec or write tools directly', async () => {
    await writeSnapshot(TOKEN);
    const { callTool, fallback } = make();
    const queued = ['read_terminal_output', 'read_logs', 'get_settings', 'run_command', 'write_file'];
    for (const tool of queued) {
      await callTool(tool, {});
    }
    expect(fallback.mock.calls.map((c) => (c as unknown[])[0])).toEqual(queued);
  });

  it('refuses repo config keys that could make git status run a program', () => {
    for (const key of ['filter.x.clean', 'core.worktree', 'core.fsmonitor', 'core.hooksPath', 'include.path', 'includeIf.gitdir:/x.path', 'submodule.a.url', 'status.submoduleSummary', 'diff.x.textconv']) {
      expect(mcp.GIT_REFUSED_CONFIG.test(key)).toBe(true);
    }
    for (const key of ['core.bare', 'core.repositoryformatversion', 'remote.origin.url', 'branch.main.remote', 'user.name']) {
      expect(mcp.GIT_REFUSED_CONFIG.test(key)).toBe(false);
    }
  });

  describe('device_status from the signed snapshot', () => {
    const CAPTURED = '2026-11-15T10:00:00.000Z';
    const DEVICE = {
      capturedAt: CAPTURED,
      battery: { level: 55, charging: false, plugged: 'none', status: 'discharging' },
      thermal: { status: 'light' },
      memory: { availBytes: 1, totalBytes: 2, lowMemory: false },
      storage: { volume: 'app-internal', freeBytes: 3, totalBytes: 4 },
      app: { versionName: '1.0.0', versionCode: 1 },
      uptime: { deviceMs: 10, appProcessMs: 5 },
    };
    const makeAt = (nowMs: number) => {
      const fallback = jest.fn(async () => ({ ok: true, data: 'from-queue' }));
      const callTool = mcp.createDirectReadCallTool({ queueDir: dir, token: TOKEN, fallback, now: () => nowMs });
      return { callTool, fallback };
    };

    it('answers with capturedAt, ageMs and stale, without the queue', async () => {
      await writeSnapshot(TOKEN, bridge.buildSnapshotBody(AGENTS, [REPO], DEVICE));
      const { callTool, fallback } = makeAt(Date.parse(CAPTURED) + 30_000);
      const res = await callTool('device_status', {});
      expect(res).toEqual({ ok: true, data: { ...DEVICE, ageMs: 30_000, stale: false, bundle: null, payloads: expect.any(Object) } });
      expect(fallback).not.toHaveBeenCalled();
    });

    const STALE_AGE = bridge.DEVICE_STALE_AFTER_MS + 1;
    const STALE_NOW = Date.parse(CAPTURED) + STALE_AGE;

    it('returns the successful live refresh for an old reading', async () => {
      await writeSnapshot(TOKEN, bridge.buildSnapshotBody(AGENTS, [REPO], DEVICE));
      fs.writeFileSync(path.join(dir, 'bridge-heartbeat'), String(STALE_NOW));
      const { callTool, fallback } = makeAt(STALE_NOW);
      const ingress = { principal: 'test-client' };
      expect(await callTool('device_status', {}, ingress)).toEqual({ ok: true, data: 'from-queue' });
      expect(fallback).toHaveBeenCalledTimes(1);
      expect(fallback).toHaveBeenCalledWith('device_status', {}, ingress, { timeoutMs: 8_000 });
      expect(mcp.DEVICE_STALE_AFTER_MS).toBe(bridge.DEVICE_STALE_AFTER_MS);
    });

    it.each([false, true])('returns the stale reading if refresh fails (throws: %s)', async (throws) => {
      await writeSnapshot(TOKEN, bridge.buildSnapshotBody(AGENTS, [REPO], DEVICE));
      const { callTool, fallback } = makeAt(STALE_NOW);
      fallback.mockImplementationOnce(async () => {
        if (throws) throw new Error('bridge unavailable');
        return { ok: false, data: '', error: 'bridge unavailable' };
      });
      expect(await callTool('device_status', {})).toEqual({
        ok: true,
        data: { ...DEVICE, ageMs: STALE_AGE, stale: true, live: false, refreshError: 'bridge unavailable', bundle: null, payloads: expect.any(Object) },
      });
      expect(fallback).toHaveBeenCalledTimes(1);
    });

    it('returns the stale reading without refreshing when the heartbeat is stale', async () => {
      await writeSnapshot(TOKEN, bridge.buildSnapshotBody(AGENTS, [REPO], DEVICE));
      fs.writeFileSync(path.join(dir, 'bridge-heartbeat'), String(STALE_NOW - 2_000));
      const { callTool, fallback } = makeAt(STALE_NOW);
      expect(await callTool('device_status', {})).toEqual({
        ok: true,
        data: { ...DEVICE, ageMs: STALE_AGE, stale: true, live: false, refreshError: 'bridge not live', bundle: null, payloads: expect.any(Object) },
      });
      expect(fallback).not.toHaveBeenCalled();
    });

    it('refuses a snapshot with a bad MAC (falls back to the queue, never serves the forged reading)', async () => {
      const forged = bridge.buildSnapshotBody(AGENTS, [REPO], { ...DEVICE, battery: { level: 1 } });
      fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify({ body: forged, mac: 'ab'.repeat(32) }));
      const { callTool, fallback } = makeAt(Date.parse(CAPTURED));
      expect(await callTool('device_status', {})).toEqual({ ok: true, data: 'from-queue' });
      expect(fallback).toHaveBeenCalledWith('device_status', {}, undefined);
      // Same for a snapshot signed with another token.
      await writeSnapshot('old-token', bridge.buildSnapshotBody(AGENTS, [REPO], DEVICE));
      expect(await callTool('device_status', {})).toEqual({ ok: true, data: 'from-queue' });
    });

    it('degrades to a clear error (no crash) when the device section is missing or malformed', async () => {
      const { callTool, fallback } = makeAt(Date.parse(CAPTURED));
      for (const device of [undefined, null, 'x', { battery: {} }, { capturedAt: 'not a date' }, { ...DEVICE, battery: 'full' }, { ...DEVICE, memory: [1, 2] },
        { ...DEVICE, capturedAt: '2099-01-01T00:00:00.000Z' }]) {
        const body = JSON.stringify(device === undefined ? { v: 1, agents: AGENTS, repoPaths: [REPO] } : { v: 1, agents: AGENTS, repoPaths: [REPO], device });
        await writeSnapshot(TOKEN, body);
        const res = await callTool('device_status', {});
        expect(res.ok).toBe(false);
        expect(res.error).toContain('device status unavailable');
        // The rest of the snapshot is still served.
        expect(await callTool('list_repos', {})).toEqual({ ok: true, data: [REPO] });
      }
      expect(fallback).not.toHaveBeenCalled();
    });

    describe('payload provenance', () => {
      let home: string;
      let libDir: string;
      let queue: string;
      const sha = (b: string) => nodeCrypto.createHash('sha256').update(b).digest('hex');
      const makeP = (nowMs: number) => {
        const fallback = jest.fn(async () => ({ ok: true, data: { live: true } }));
        const callTool = mcp.createDirectReadCallTool({ queueDir: queue, token: TOKEN, fallback, now: () => nowMs, homeDir: home, libDir });
        return { callTool, fallback };
      };
      const snap = async (device: unknown) => {
        const body = bridge.buildSnapshotBody(AGENTS, [REPO], device);
        fs.writeFileSync(path.join(queue, 'snapshot.json'), JSON.stringify({ body, mac: await sign(TOKEN, body) }));
      };
      beforeEach(() => {
        home = path.join(dir, 'phome');
        libDir = path.join(home, 'termux-libs');
        queue = path.join(home, '.shelly-mcp-queue');
        fs.mkdirSync(path.join(home, '.shelly'), { recursive: true });
        fs.mkdirSync(libDir, { recursive: true });
        fs.mkdirSync(queue, { recursive: true });
      });

      it('attaches hashes, marker vc, app info, libs and the bundle fingerprint to a snapshot answer', async () => {
        fs.writeFileSync(path.join(home, '.shelly-mcp-server.js'), 'old script');
        fs.writeFileSync(path.join(libDir, '.extract_version'), 'vc=3061|cli=abc|x=y');
        fs.writeFileSync(path.join(libDir, 'codex_tui'), '12345');
        fs.writeFileSync(path.join(home, '.shelly', 'app-info.json'), JSON.stringify({ versionCode: 3061, versionName: '5.9', writtenAtMs: 0, secret: 'no' }));
        const bundle = { schema: 1, source: 'ci', gitSha: 'abc', runId: 1, runNumber: 2 };
        await snap({ ...DEVICE, bundle });
        const res = await makeP(Date.parse(CAPTURED) + 1000).callTool('device_status', {});
        expect(res.ok).toBe(true);
        expect(res.data.bundle).toEqual(bundle);
        const p = res.data.payloads;
        expect(p.mcpServerScript.onDiskSha256).toBe(sha('old script'));
        expect(p.mcpServerScript.runningSha256).toBe(nodeCrypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'shelly-mcp-server.js'))).digest('hex'));
        expect(p.mcpServerScript.match).toBe(false);
        expect(p.extractMarker).toEqual({ vc: 3061, present: true });
        expect(p.appInfo).toEqual({ versionCode: 3061, versionName: '5.9', writtenAt: '1970-01-01T00:00:00.000Z' });
        expect(p.libs.codex_tui).toEqual({ present: true, symlink: false, size: 5, mtime: expect.any(String) });
        expect(p.libs.codex_exec).toEqual({ present: false, size: null, mtime: null });
        expect(JSON.stringify(p)).not.toContain(home);
      });

      it('matches when the installed script is the running one, accepts a bare-number marker, reports symlinks', () => {
        const running = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'shelly-mcp-server.js'));
        fs.writeFileSync(path.join(home, '.shelly-mcp-server.js'), running);
        fs.writeFileSync(path.join(libDir, '.extract_version'), '42');
        fs.symlinkSync('/nonexistent', path.join(libDir, 'codex_exec'));
        const p = mcp.payloadProvenance({ homeDir: home, libDir });
        expect(p.mcpServerScript.match).toBe(true);
        expect(p.extractMarker).toEqual({ vc: 42, present: true });
        // A dangling link: present, a symlink, its target, the link's own mtime.
        expect(p.libs.codex_exec).toEqual({ present: true, symlink: true, target: '/nonexistent', size: null, mtime: expect.any(String) });
      });

      it('reports a lib symlink that resolves: target and the link\'s own mtime, never the target\'s size (P2-4 i)', () => {
        const real = path.join(dir, 'real-codex');
        fs.writeFileSync(real, 'x'.repeat(100));
        fs.symlinkSync(real, path.join(libDir, 'codex_tui'));
        const linkMtimeMs = fs.lstatSync(path.join(libDir, 'codex_tui')).mtimeMs;
        const p = mcp.payloadProvenance({ homeDir: home, libDir });
        expect(p.libs.codex_tui).toEqual({ present: true, symlink: true, target: real, size: null, mtime: new Date(linkMtimeMs).toISOString() });
        // A control character in the target is not echoed.
        fs.symlinkSync('/tmp/a\nb', path.join(libDir, 'codex_exec'));
        expect(mcp.payloadProvenance({ homeDir: home, libDir }).libs.codex_exec).toEqual({ present: true, symlink: true, target: null, size: null, mtime: expect.any(String) });
      });

      it('the running hash is captured once at startup, not re-read when the file is replaced (P2-4 ii)', () => {
        const runHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-running-'));
        const script = path.join(runHome, '.shelly-mcp-server.js');
        const original = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'shelly-mcp-server.js'));
        fs.writeFileSync(script, original);
        // Plain node (no jest transform): load the server from its installed
        // path, then replace that file the way HomeInitializer does (rename).
        const code = [
          'const fs = require("fs");',
          `const script = ${JSON.stringify(script)};`,
          'const m = require(script);',
          'fs.writeFileSync(script + ".tmp", "// replaced after start\\n");',
          'fs.renameSync(script + ".tmp", script);',
          `const p = m.payloadProvenance({ homeDir: ${JSON.stringify(runHome)}, libDir: ${JSON.stringify(path.join(runHome, 'nope'))} });`,
          'process.stdout.write(JSON.stringify(p.mcpServerScript));',
        ].join('\n');
        const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
        try {
          expect(r.status).toBe(0);
          const s = JSON.parse(r.stdout);
          expect(s.runningSha256).toBe(nodeCrypto.createHash('sha256').update(original).digest('hex'));
          expect(s.onDiskSha256).toBe(sha('// replaced after start\n'));
          expect(s.match).toBe(false);
        } finally {
          fs.rmSync(runHome, { recursive: true, force: true });
        }
      });

      it('captures the running hash at the top of the script and never reads __filename again (P2-4 ii)', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'shelly-mcp-server.js'), 'utf8');
        expect(src.match(/readFileSync\(__filename\)/g)).toHaveLength(1);
        const capture = src.indexOf('const RUNNING_SCRIPT_SHA256 = (() => {');
        expect(capture).toBeGreaterThan(0);
        expect(capture).toBeLessThan(src.indexOf("const RESULT_POLL_MS"));
        expect(src).not.toMatch(/RUNNING_SCRIPT_SHA256 = (?!\(\(\) => \{)/);
      });

      it('garbage and missing files give nulls without throwing', () => {
        fs.writeFileSync(path.join(libDir, '.extract_version'), 'garbage|vc=1');
        fs.writeFileSync(path.join(home, '.shelly', 'app-info.json'), '{not json');
        fs.mkdirSync(path.join(home, '.shelly-mcp-server.js'));
        const p = mcp.payloadProvenance({ homeDir: home, libDir });
        expect(p.mcpServerScript.onDiskSha256).toBeNull();
        expect(p.mcpServerScript.match).toBeNull();
        expect(p.extractMarker).toEqual({ vc: null, present: true });
        expect(p.appInfo).toBeNull();
        fs.writeFileSync(path.join(home, '.shelly', 'app-info.json'), JSON.stringify({ versionCode: '1', versionName: 5, writtenAtMs: 'x' }));
        expect(mcp.payloadProvenance({ homeDir: home, libDir }).appInfo).toEqual({ versionCode: null, versionName: null, writtenAt: null });
        expect(mcp.payloadProvenance({ homeDir: path.join(dir, 'nope'), libDir: path.join(dir, 'nope') }).extractMarker).toEqual({ vc: null, present: false });
        expect(() => mcp.payloadProvenance({})).not.toThrow();
      });

      it('bundle is null when the snapshot has none; stale and live answers carry payloads; errors do not', async () => {
        await snap(DEVICE);
        const { callTool } = makeP(Date.parse(CAPTURED) + 1000);
        const res = await callTool('device_status', {});
        expect(res.data.bundle).toBeNull();
        expect(res.data.payloads).toBeDefined();

        fs.writeFileSync(path.join(queue, 'bridge-heartbeat'), String(STALE_NOW - 2_000));
        const stale = await makeP(STALE_NOW).callTool('device_status', {});
        expect(stale.data.live).toBe(false);
        expect(stale.data.payloads).toBeDefined();

        fs.writeFileSync(path.join(queue, 'bridge-heartbeat'), String(STALE_NOW));
        const live = await makeP(STALE_NOW).callTool('device_status', {});
        expect(live.data.live).toBe(true);
        expect(live.data.payloads).toBeDefined();

        await snap({ capturedAt: 'bad' });
        const err = await makeP(STALE_NOW).callTool('device_status', {});
        expect(err.ok).toBe(false);
        expect(err.payloads).toBeUndefined();
        expect(err.data).toBeUndefined();
      });
    });

    it('a null section (the device could not report it) is passed through as null', async () => {
      await writeSnapshot(TOKEN, bridge.buildSnapshotBody(AGENTS, [REPO], { ...DEVICE, thermal: null }));
      const { callTool } = makeAt(Date.parse(CAPTURED));
      const res = await callTool('device_status', {});
      expect(res.ok).toBe(true);
      expect(res.data.thermal).toBeNull();
    });
  });

  describe('read_agent_audit / read_article_history (fixed files under $HOME/.shelly/agents/logs)', () => {
    // $HOME = the queue dir's parent, as MCPBridge.kt lays it out.
    let home: string;
    let queue: string;
    let logs: string;
    beforeEach(() => {
      home = path.join(dir, 'home');
      queue = path.join(home, '.shelly-mcp-queue');
      logs = path.join(home, '.shelly', 'agents', 'logs');
      fs.mkdirSync(queue, { recursive: true });
      fs.mkdirSync(path.join(logs, 'a1'), { recursive: true });
    });

    async function signHere(token = TOKEN, body = bridge.buildSnapshotBody(AGENTS, [REPO])) {
      fs.writeFileSync(path.join(queue, 'snapshot.json'), JSON.stringify({ body, mac: await sign(token, body) }));
    }
    function makeHere(logIo?: { readFdPath: (fd: number) => string | null; beforeOpen: (file: string) => void }) {
      const fallback = jest.fn(async () => ({ ok: true, data: 'from-queue' }));
      const callTool = mcp.createDirectReadCallTool({ queueDir: queue, token: TOKEN, fallback, runGit: jest.fn(), ...(logIo ? { logIo } : {}) });
      return { callTool, fallback };
    }
    const auditFile = () => path.join(logs, 'a1', 'plan-executor-audit.jsonl');
    const line = (i: number) => JSON.stringify({ ts: i, event: 'step_done', stepIndex: i });

    it('returns the newest audit lines of a registered agent, without the queue', async () => {
      await signHere();
      fs.writeFileSync(auditFile(), `${[1, 2, 3].map(line).join('\n')}\n`);
      const { callTool, fallback } = makeHere();
      const res = await callTool('read_agent_audit', { agentId: 'a1', limit: 2 });
      expect(res).toEqual({ ok: true, data: { agentId: 'a1', lines: 2, truncated: true, text: `${line(2)}\n${line(3)}`, untrusted: true } });
      const all = await callTool('read_agent_audit', { agentId: 'a1' });
      expect(all.data.lines).toBe(3);
      expect(all.data.truncated).toBe(false);
      expect(fallback).not.toHaveBeenCalled();
    });

    it('projects audit lines: free-form fields dropped and named, allowlisted strings redacted', async () => {
      await signHere();
      fs.writeFileSync(auditFile(), [
        JSON.stringify({ event: 'x', note: 'key sk-ant-abcdefghijklmnopqrstuvwxyz0123' }),
        JSON.stringify({ kind: 'k', target: 'https://h/?token=abcdefghijk123', error: 'prose with sk-ant-abcdefghijklmnopqrstuvwxyz9999' }),
        'not json at all',
      ].join('\n'));
      const res = await makeHere().callTool('read_agent_audit', { agentId: 'a1' });
      expect(res.ok).toBe(true);
      expect(res.data.text).not.toContain('abcdefghijklmnopqrstuvwxyz');
      expect(res.data.text).not.toContain('abcdefghijk123');
      expect(res.data.text.split('\n').map((l: string) => JSON.parse(l))).toEqual([
        { event: 'x', omittedCount: 1 },
        { kind: 'k', target: 'https://h/?token=<redacted>', omittedCount: 1 },
        { unparsed: true },
      ]);
    });

    describe('projectAuditLine', () => {
      const p = (o: unknown) => mcp.projectAuditLine(JSON.stringify(o));
      it('keeps the executor\'s structural fields (draft_write_failed / draft_saved / article_config_mismatch / after_draft_hook)', () => {
        expect(p({ ts: '2026-11-18T00:00:00Z', kind: 'draft_write_failed', agentId: 'a1', code: 'broker-refused', target: '/v/x.md', swallowed: true, stepIndex: 3 }))
          .toEqual({ ts: '2026-11-18T00:00:00Z', kind: 'draft_write_failed', agentId: 'a1', code: 'broker-refused', target: '/v/x.md', swallowed: true, stepIndex: 3 });
        expect(p({ kind: 'draft_saved', folder: '/v/drafts', file: 'a.md', bytes: 1234 })).toEqual({ kind: 'draft_saved', folder: '/v/drafts', file: 'a.md', bytes: 1234 });
        expect(p({ kind: 'article_config_mismatch', problems: ['voice.optional differs', 'x'.repeat(500)] }))
          .toEqual({ kind: 'article_config_mismatch', problems: ['voice.optional differs', 'x'.repeat(200)] });
        expect(p({ kind: 'after_draft_hook', status: 'ok', draftPresent: true })).toEqual({ kind: 'after_draft_hook', status: 'ok', draftPresent: true });
      });
      it('reason only as a code; problems only as strings; objects, nulls and prose dropped', () => {
        expect(p({ reason: 'stale-lock' })).toEqual({ reason: 'stale-lock' });
        expect(p({ reason: 'The file at /home/x had sk-ant-abcdefghijklmnopqrstuvwxyz0123' })).toEqual({ omittedCount: 1 });
        expect(p({ problems: ['a', 1] })).toEqual({ omittedCount: 1 });
        expect(p({ detail: { secret: 'S' }, preview: 'S', n: null, list: ['S'], bytes: 1e3 })).toEqual({ bytes: 1000, omittedCount: 4 });
        // Numbers and booleans only under allowlisted keys; unknown key names are never returned.
        expect(p({ 'sk-ant-abcdefghijklmnopqrstuvwxyz0123': 1, secretCount: 5, leaked: true, ok: false })).toEqual({ ok: false, omittedCount: 3 });
        expect(p({ omitted: 'forged', omittedCount: 99, unparsed: false })).toEqual({ omittedCount: 3 });
        expect(p({ exitCode: 1, attempts: 2, halted: false, score: 4.5, minScore: 3.5, overall: 4, unattended: true, recorded: true, restarts: 0, stepsRun: 3, lines: 9, count: 1, attempt: 1, schemaVersion: 2 }))
          .toEqual({ exitCode: 1, attempts: 2, halted: false, score: 4.5, minScore: 3.5, overall: 4, unattended: true, recorded: true, restarts: 0, stepsRun: 3, lines: 9, count: 1, attempt: 1, schemaVersion: 2 });
        expect(p({ exitCode: 'prose' })).toEqual({ omittedCount: 1 });
        expect(mcp.projectAuditLine('[1,2]')).toEqual({ unparsed: true });
        expect(mcp.projectAuditLine('{"a":')).toEqual({ unparsed: true });
        expect(p({ status: 'y'.repeat(300) }).status).toHaveLength(200);
      });
    });

    describe('the opened descriptor must be where the checks looked (/proc/self/fd)', () => {
      const hasProc = fs.existsSync('/proc/self/fd');
      (process.platform === 'win32' ? it.skip : it)('a FIFO swapped in after the lstat is refused promptly (O_NONBLOCK open, fstat check)', async () => {
        await signHere();
        fs.writeFileSync(auditFile(), `${line(1)}\n`);
        const { callTool } = makeHere({
          readFdPath: (fd: number) => fs.readlinkSync(`/proc/self/fd/${fd}`),
          beforeOpen: (file: string) => {
            fs.unlinkSync(file);
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            expect(require('child_process').spawnSync('mkfifo', [file]).status).toBe(0);
          },
        });
        const t0 = Date.now();
        const res = await callTool('read_agent_audit', { agentId: 'a1' });
        expect(Date.now() - t0).toBeLessThan(2000);
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/^refused/);
      });
      (hasProc ? it : it.skip)('a parent directory swapped for a symlink to an outside dir between the checks and the open is refused', async () => {
        await signHere();
        fs.writeFileSync(auditFile(), `${line(1)}\n`);
        const moved = path.join(dir, 'moved-out');
        const { callTool } = makeHere({
          readFdPath: (fd: number) => fs.readlinkSync(`/proc/self/fd/${fd}`),
          beforeOpen: () => {
            // Same directory, same file (dev + ino still match), now outside the log tree.
            fs.renameSync(path.join(logs, 'a1'), moved);
            fs.symlinkSync(moved, path.join(logs, 'a1'));
          },
        });
        const res = await callTool('read_agent_audit', { agentId: 'a1' });
        expect(res).toEqual({ ok: false, error: 'refused: the opened file is not inside the log directory' });
      });
      it('a mismatching or unreadable /proc link, or no /proc at all, is refused', async () => {
        await signHere();
        fs.writeFileSync(auditFile(), `${line(1)}\n`);
        const noop = () => {};
        expect((await makeHere({ readFdPath: () => '/elsewhere/plan-executor-audit.jsonl', beforeOpen: noop }).callTool('read_agent_audit', { agentId: 'a1' })).error)
          .toBe('refused: the opened file is not inside the log directory');
        expect((await makeHere({ readFdPath: () => { throw new Error('EACCES'); }, beforeOpen: noop }).callTool('read_agent_audit', { agentId: 'a1' })).error)
          .toBe('refused: cannot confirm where the opened file is');
        // No /proc/self/fd: refused, never inode-only.
        expect((await makeHere({ readFdPath: () => null, beforeOpen: noop }).callTool('read_agent_audit', { agentId: 'a1' })).error)
          .toBe('refused: cannot confirm where the opened file is (no /proc/self/fd)');
        // The default reader accepts the real file (the expected path is built from realpath(home)).
        expect((await makeHere().callTool('read_agent_audit', { agentId: 'a1' })).data.text).toBe(line(1));
      });
    });

    it('refuses an agent id not in the snapshot, and traversal / malformed ids, without reading', async () => {
      await signHere();
      fs.mkdirSync(path.join(logs, 'other'), { recursive: true });
      fs.writeFileSync(path.join(logs, 'other', 'plan-executor-audit.jsonl'), 'SECRET-OTHER\n');
      const { callTool, fallback } = makeHere();
      for (const agentId of ['other', '../a1', 'a1/..', '..', 'a1/../other', '', 'a.1', 'x'.repeat(129)]) {
        const res = await callTool('read_agent_audit', { agentId });
        expect(res.ok).toBe(false);
        expect(JSON.stringify(res)).not.toContain('SECRET-OTHER');
      }
      expect((await callTool('read_agent_audit', { agentId: 7 })).ok).toBe(false);
      expect((await callTool('read_agent_audit', {})).ok).toBe(false);
      expect(fallback).not.toHaveBeenCalled();
    });

    it('a missing audit file or log directory is a clear error', async () => {
      await signHere();
      const { callTool } = makeHere();
      const res = await callTool('read_agent_audit', { agentId: 'a1' });
      expect(res).toEqual({ ok: false, error: expect.stringContaining('no audit log for agent a1') });
      fs.rmSync(path.join(home, '.shelly'), { recursive: true });
      expect((await callTool('read_agent_audit', { agentId: 'a1' })).error).toContain('no audit log');
    });

    it('refuses a symlinked or hard-linked audit file and a symlinked log directory', async () => {
      await signHere();
      const target = path.join(dir, 'outside.txt');
      fs.writeFileSync(target, 'OUTSIDE-CONTENT\n');
      const { callTool } = makeHere();
      fs.symlinkSync(target, auditFile());
      let res = await callTool('read_agent_audit', { agentId: 'a1' });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/^refused/);
      fs.unlinkSync(auditFile());
      fs.linkSync(target, auditFile());
      res = await callTool('read_agent_audit', { agentId: 'a1' });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/^refused/);
      fs.unlinkSync(auditFile());
      // logs/a1 -> a directory elsewhere that holds a file of the right name
      const elsewhere = path.join(dir, 'elsewhere');
      fs.mkdirSync(elsewhere);
      fs.writeFileSync(path.join(elsewhere, 'plan-executor-audit.jsonl'), 'OUTSIDE-CONTENT\n');
      fs.rmdirSync(path.join(logs, 'a1'));
      fs.symlinkSync(elsewhere, path.join(logs, 'a1'));
      res = await callTool('read_agent_audit', { agentId: 'a1' });
      expect(res.ok).toBe(false);
      expect(JSON.stringify(res)).not.toContain('OUTSIDE-CONTENT');
    });

    it('caps lines (max 500) and bytes (max 64 KiB, newest kept)', async () => {
      await signHere();
      const many = Array.from({ length: 800 }, (_, i) => line(i));
      fs.writeFileSync(auditFile(), `${many.join('\n')}\n`);
      const { callTool } = makeHere();
      const def = await callTool('read_agent_audit', { agentId: 'a1' });
      expect(def.data.lines).toBe(mcp.AUDIT_DEFAULT_LIMIT);
      const max = await callTool('read_agent_audit', { agentId: 'a1', limit: 10_000, maxBytes: 10_000_000 });
      expect(max.data.lines).toBe(mcp.AUDIT_MAX_LIMIT);
      expect(max.data.text.split('\n').pop()).toBe(line(799));
      const small = await callTool('read_agent_audit', { agentId: 'a1', limit: 500, maxBytes: 300 });
      expect(Buffer.byteLength(small.data.text)).toBeLessThanOrEqual(300);
      expect(small.data.truncated).toBe(true);
      expect(small.data.text.split('\n').pop()).toBe(line(799));
    });

    it('reads only the last 256 KiB of a large audit file and drops the cut first line', async () => {
      await signHere();
      // The 256 KiB window starts in the middle of the short line QQQQQQ: a
      // whole-file read would return QQQQQQ, a tail read without the
      // fragment drop would return QQQQ. Blank lines are skipped.
      const tail = `QQQQ${'\n'.repeat(mcp.AUDIT_TAIL_READ_BYTES - 4 - line(1).length - 1)}${line(1)}\n`;
      fs.writeFileSync(auditFile(), `${'P'.repeat(1000)}\nQQ${tail}`);
      const res = await makeHere().callTool('read_agent_audit', { agentId: 'a1', limit: 500 });
      expect(res.data.text).toBe(line(1));
      expect(res.data.lines).toBe(1);
      expect(res.data.truncated).toBe(true);
    });

    it('returns the article history projected to {version, entries:[{title, url, date}]}', async () => {
      await signHere();
      const history = {
        version: 1,
        access_token: 'TOPLEVEL-SECRET-1',
        entries: [
          { title: 'A study', url: 'https://user:pw@example.org/x?sig=SIGNED-SECRET-2&token=abc123456789#frag', date: '2026-11-01', access_token: 'ENTRY-SECRET-3', extra: { k: 'EXTRA-4' } },
          { title: 'Plain', url: 'http://Example.com/a/b', date: 'yesterday' },
          { title: 7, url: 'ftp://x/y', date: '2026-01-01' },
          'not an entry',
          { title: 'Key sk-ant-abcdefghijklmnopqrstuvwxyz0123 in title', url: 'javascript:alert(1)' },
        ],
      };
      fs.writeFileSync(path.join(logs, 'article-history-science-1.json'), JSON.stringify(history));
      const { callTool, fallback } = makeHere();
      const res = await callTool('read_article_history', { stream: 'science-1' });
      expect(res.ok).toBe(true);
      expect(res.data.stream).toBe('science-1');
      expect(res.data.untrusted).toBe(true);
      expect(res.data.history.version).toBe(1);
      expect(res.data.history.entries.slice(0, 3)).toEqual([
        { title: 'A study', url: 'https://example.org/x', date: '2026-11-01' },
        { title: 'Plain', url: 'http://Example.com/a/b', date: '' },
        { title: '', url: '', date: '2026-01-01' },
      ]);
      expect(res.data.history.entries).toHaveLength(4);
      expect(res.data.history.entries[3].url).toBe('');
      expect(res.data.history.entries[3].title).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
      const text = JSON.stringify(res);
      for (const secret of ['TOPLEVEL-SECRET-1', 'SIGNED-SECRET-2', 'abc123456789', 'ENTRY-SECRET-3', 'EXTRA-4', 'pw@', 'frag']) expect(text).not.toContain(secret);
      expect(fallback).not.toHaveBeenCalled();
    });

    it('history URLs: credentials never survive (tab in userinfo, several @, @ in the path), printable ASCII only', () => {
      const u = (url: string) => mcp.projectArticleHistory({ entries: [{ url }] }).entries[0].url;
      expect(u('https://us\ter:pw@evil.example/x')).toBe('');
      expect(u('https://user:pw\t@host.example/x')).toBe('');
      expect(u('https://a@b:c@host.example/p')).toBe('https://host.example/p');
      expect(u('https://u:p@x@host.example:8443/p@q?x=1#y')).toBe('https://host.example:8443/p@q');
      expect(u('https://host.example/a@b/c')).toBe('https://host.example/a@b/c');
      expect(u('https://host.example/caf\u00e9')).toBe('');
      expect(u('https://host.example/a b')).toBe('');
      expect(u('https://[::1]/x')).toBe('');
      expect(u('https://host.example:123456/x')).toBe('');
      expect(u('https://user:pw@/x')).toBe('');
      expect(u('HTTPS://Host.Example/P')).toBe('https://Host.Example/P');
      expect(u('ftp://host.example/x')).toBe('');
    });

    it('article history: at most 30 entries (the newest); other shapes are a plain error', () => {
      const many = { version: 1, entries: Array.from({ length: 40 }, (_, i) => ({ title: `t${i}`, url: '', date: '' })) };
      const out = mcp.projectArticleHistory(many);
      expect(out.entries).toHaveLength(30);
      expect(out.entries[29].title).toBe('t39');
      expect(mcp.projectArticleHistory({ version: 1 })).toBeNull();
      expect(mcp.projectArticleHistory([])).toBeNull();
      expect(mcp.projectArticleHistory({ entries: 'x' })).toBeNull();
      expect(mcp.projectArticleHistory({ entries: [] })).toEqual({ version: null, entries: [] });
    });

    it('article history: bad stream, missing, symlinked, oversized and non-JSON files are refused', async () => {
      await signHere();
      const { callTool } = makeHere();
      for (const stream of ['../x', 'A', 'a/b', '', 'a'.repeat(41), 'a.b', 'x\n']) {
        expect((await callTool('read_article_history', { stream })).error).toContain('stream must match');
      }
      expect((await callTool('read_article_history', { stream: 'none' })).error).toContain('no article history for stream none');
      const target = path.join(dir, 'outside.json');
      fs.writeFileSync(target, '{"secret":"OUTSIDE"}');
      fs.symlinkSync(target, path.join(logs, 'article-history-link.json'));
      expect((await callTool('read_article_history', { stream: 'link' })).error).toMatch(/^refused/);
      fs.writeFileSync(path.join(logs, 'article-history-big.json'), JSON.stringify({ x: 'y'.repeat(mcp.ARTICLE_HISTORY_READ_MAX_BYTES) }));
      expect((await callTool('read_article_history', { stream: 'big' })).error).toContain('larger than');
      fs.writeFileSync(path.join(logs, 'article-history-bad.json'), '{not json');
      expect((await callTool('read_article_history', { stream: 'bad' })).error).toContain('not valid JSON');
      fs.writeFileSync(path.join(logs, 'article-history-shape.json'), '{"secret":"S"}');
      expect((await callTool('read_article_history', { stream: 'shape' })).error).toBe('the article history is not in the expected format');
    });

    it('both fall back to the queue when there is no verified snapshot', async () => {
      fs.writeFileSync(auditFile(), `${line(1)}\n`);
      const { callTool, fallback } = makeHere();
      expect(await callTool('read_agent_audit', { agentId: 'a1' })).toEqual({ ok: true, data: 'from-queue' });
      await signHere('old-token');
      expect(await callTool('read_article_history', { stream: 's' })).toEqual({ ok: true, data: 'from-queue' });
      expect(fallback.mock.calls.map((c) => (c as unknown[]).slice(0, 2))).toEqual([
        ['read_agent_audit', { agentId: 'a1' }],
        ['read_article_history', { stream: 's' }],
      ]);
    });
  });
});


describe('MCP queue reads', () => {
  const NOW = 1_800_000_000_000;
  const makeQueue = () => mcp.createFileQueueCallTool(dir, 'ab'.repeat(32));
  const heartbeat = (value: string) => fs.writeFileSync(path.join(dir, 'bridge-heartbeat'), value);

  afterEach(() => jest.useRealTimers());

  it('matches the native heartbeat boundaries and distinguishes missing files', () => {
    expect(mcp.rnLiveFromHeartbeat(dir, NOW)).toBeNull();
    for (const stamp of [String(NOW - 2_000), String(NOW + 1_001), '0', '1e12', '+1800000000000', '0001800000000000', '']) {
      heartbeat(stamp);
      expect(mcp.rnLiveFromHeartbeat(dir, NOW)).toBe(false);
    }
    for (const stamp of [String(NOW - 1_999), String(NOW).padEnd(64, ' '), ` ${NOW}
`, String(NOW + 1_000)]) {
      heartbeat(stamp);
      expect(mcp.rnLiveFromHeartbeat(dir, NOW)).toBe(true);
    }
  });

  const invalidHeartbeatKinds = ['symlink', 'oversized file'];
  if (process.platform !== 'win32') invalidHeartbeatKinds.push('FIFO');
  it.each(invalidHeartbeatKinds)('fails fast for an invalid heartbeat (%s)', async (kind) => {
    jest.useFakeTimers({ now: NOW });
    if (kind === 'symlink') {
      const target = path.join(dir, 'heartbeat-target');
      fs.writeFileSync(target, String(NOW));
      fs.symlinkSync(target, path.join(dir, 'bridge-heartbeat'));
    } else if (kind === 'FIFO') {
      expect(spawnSync('mkfifo', [path.join(dir, 'bridge-heartbeat')]).status).toBe(0);
    } else {
      heartbeat(String(NOW).padEnd(65, ' '));
    }
    expect(mcp.rnLiveFromHeartbeat(dir, NOW)).toBe(false);
    const result = makeQueue()('get_settings', {}, undefined);
    expect(fs.readdirSync(path.join(dir, 'requests'))).toEqual([]);
    expect(await result).toEqual({ ok: false, error: expect.stringContaining('background') });
  });

  it('rejects a heartbeat that grows beyond the limit after fstat', () => {
    heartbeat(String(NOW).padEnd(64, ' '));
    const realFstat = fs.fstatSync;
    const stat = jest.spyOn(jest.requireActual<typeof fs>('fs'), 'fstatSync').mockImplementation((fd) => {
      const result = realFstat(fd);
      fs.appendFileSync(path.join(dir, 'bridge-heartbeat'), ' ');
      return result;
    });
    try {
      expect(mcp.rnLiveFromHeartbeat(dir, NOW)).toBe(false);
      expect(stat).toHaveBeenCalledTimes(1);
    } finally {
      stat.mockRestore();
    }
  });

  it.each(['get_settings', 'read_logs', 'read_terminal_output', 'list_agents', 'device_status'])(
    'fails fast for %s without writing a request when the heartbeat is stale',
    async (tool) => {
      jest.useFakeTimers({ now: NOW });
      heartbeat(String(NOW - 2_000));
      const result = makeQueue()(tool, {}, undefined);
      expect(fs.readdirSync(path.join(dir, 'requests'))).toEqual([]);
      expect(await result).toEqual({ ok: false, error: expect.stringContaining('background') });
    },
  );

  it.each([undefined, 125])('enqueues without a heartbeat and times out (override: %s)', async (override) => {
    jest.useFakeTimers({ now: NOW });
    const timeout = override ?? 10_000;
    const result = makeQueue()('get_settings', {}, undefined, { timeoutMs: override });
    expect(fs.readdirSync(path.join(dir, 'requests'))).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(timeout);
    expect(await result).toEqual({
      ok: false,
      error: expect.stringContaining(`timed out after ${timeout}ms waiting for the app to answer get_settings`),
    });
  });

  it('settles a queued read at 10s despite a wall-clock rollback', async () => {
    jest.useFakeTimers({ now: NOW });
    heartbeat(String(NOW));
    const settled = jest.fn();
    void makeQueue()('get_settings', {}, undefined).then(settled);
    expect(fs.readdirSync(path.join(dir, 'requests'))).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(5_000);
    jest.setSystemTime(Date.now() - 30_000);
    await jest.advanceTimersByTimeAsync(4_999);
    expect(settled).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledWith({
      ok: false,
      error: expect.stringContaining('timed out after 10000ms waiting for the app to answer get_settings'),
    });
  });

  const fifoTest = process.platform === 'win32' ? it.skip : it;
  fifoTest('settles promptly with an error when the result is a FIFO', () => {
    const child = spawnSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const fs = require('fs');
      const path = require('path');
      const { execFileSync } = require('child_process');
      const { createFileQueueCallTool } = require(process.argv[1]);
      const dir = process.argv[2];
      const callTool = createFileQueueCallTool(dir, 'ab'.repeat(32));
      const result = callTool('get_settings', {}, undefined, { timeoutMs: 500 });
      const [request] = fs.readdirSync(path.join(dir, 'requests'));
      execFileSync('mkfifo', [path.join(dir, 'results', request)], { stdio: 'inherit' });
      result.then(value => assert.deepEqual(value, { ok: false, error: 'unreadable result: not a regular file' }));
    `, require.resolve('../scripts/shelly-mcp-server.js'), dir], { stdio: 'inherit', timeout: 2000 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
  });

  it('settles on the first poll when the result is a symlink', async () => {
    jest.useFakeTimers({ now: NOW });
    const settled = jest.fn();
    void makeQueue()('get_settings', {}, undefined, { timeoutMs: 10_000 }).then(settled);
    const [request] = fs.readdirSync(path.join(dir, 'requests'));
    const target = path.join(dir, 'target.json');
    fs.writeFileSync(target, JSON.stringify({ ok: true }));
    fs.symlinkSync(target, path.join(dir, 'results', request));

    await jest.advanceTimersByTimeAsync(250);
    expect(settled).toHaveBeenCalledWith({
      ok: false,
      error: expect.stringMatching(/^unreadable result: .*ELOOP/),
    });
  });

  it('settles on the first poll without reading an oversized result body', async () => {
    jest.useFakeTimers({ now: NOW });
    const settled = jest.fn();
    void makeQueue()('get_settings', {}, undefined).then(settled);
    const [request] = fs.readdirSync(path.join(dir, 'requests'));
    const resultPath = path.join(dir, 'results', request);
    fs.writeFileSync(resultPath, '');
    fs.truncateSync(resultPath, mcp.RESULT_MAX_BYTES + 1);
    const read = jest.spyOn(jest.requireActual<typeof fs>('fs'), 'readSync');
    try {
      // Advance the poll synchronously so unrelated async reads cannot hit the spy.
      jest.advanceTimersByTime(250);
      expect(read).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(settled).toHaveBeenCalledWith({
        ok: false,
        error: `unreadable result: larger than ${mcp.RESULT_MAX_BYTES} bytes`,
      });
    } finally {
      read.mockRestore();
    }
  });

  it('reports a persistently malformed result at the deadline', async () => {
    jest.useFakeTimers({ now: NOW });
    const settled = jest.fn();
    void makeQueue()('get_settings', {}, undefined, { timeoutMs: 500 }).then(settled);
    const [request] = fs.readdirSync(path.join(dir, 'requests'));
    fs.writeFileSync(path.join(dir, 'results', request), '{');

    await jest.advanceTimersByTimeAsync(499);
    expect(settled).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledWith({
      ok: false,
      error: expect.stringMatching(/^unreadable result: .+/),
    });
  });

  it.each<[number, object]>([
    [100, { ok: true, data: 'from-queue' }],
    [126, { ok: false, error: expect.stringContaining('timed out after 125ms') }],
  ])('checks the deadline when a result is written at %dms', async (elapsed, expected) => {
    jest.useFakeTimers({ now: NOW });
    const now = jest.spyOn(performance, 'now').mockReturnValue(0);
    try {
      const content = { ok: true, data: 'from-queue' };
      const result = makeQueue()('get_settings', {}, undefined, { timeoutMs: 125 });
      const [request] = fs.readdirSync(path.join(dir, 'requests'));
      const resultPath = path.join(dir, 'results', request);
      now.mockReturnValue(elapsed);
      fs.writeFileSync(resultPath, JSON.stringify(content));
      // Model a poll dispatched at the file's arrival, even if the timer ran late.
      await jest.advanceTimersByTimeAsync(125);
      expect(await result).toEqual(expected);
      expect(fs.existsSync(resultPath)).toBe(elapsed >= 125);
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    ['run_command', 'raw-requests'],
    ['write_file', 'raw-requests'],
    ['run_agent', 'typed-requests'],
  ])('enqueues %s despite a stale heartbeat and waits 100s', async (tool, requestDir) => {
    jest.useFakeTimers({ now: NOW });
    heartbeat(String(NOW - 2_000));
    const settled = jest.fn();
    void makeQueue()(tool, {}, undefined).then(settled);
    expect(fs.readdirSync(path.join(dir, requestDir))).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(99_750);
    expect(settled).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(250);
    expect(settled).toHaveBeenCalledWith({
      ok: false,
      error: 'timed out waiting for the app to answer (is Shelly running?)',
    });
  });
});
