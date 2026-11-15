import * as nodeCrypto from 'crypto';
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
      expect(res).toEqual({ ok: true, data: { ...DEVICE, ageMs: 30_000, stale: false } });
      expect(fallback).not.toHaveBeenCalled();
    });

    it('marks an old reading stale instead of hiding its age', async () => {
      await writeSnapshot(TOKEN, bridge.buildSnapshotBody(AGENTS, [REPO], DEVICE));
      const { callTool } = makeAt(Date.parse(CAPTURED) + mcp.DEVICE_STALE_AFTER_MS + 1);
      const res = await callTool('device_status', {});
      expect(res.ok).toBe(true);
      expect(res.data.stale).toBe(true);
      expect(mcp.DEVICE_STALE_AFTER_MS).toBe(bridge.DEVICE_STALE_AFTER_MS);
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

    it('a null section (the device could not report it) is passed through as null', async () => {
      await writeSnapshot(TOKEN, bridge.buildSnapshotBody(AGENTS, [REPO], { ...DEVICE, thermal: null }));
      const { callTool } = makeAt(Date.parse(CAPTURED));
      const res = await callTool('device_status', {});
      expect(res.ok).toBe(true);
      expect(res.data.thermal).toBeNull();
    });
  });
});
