/**
 * Background ingress phase B-1: read_logs / get_settings / read_terminal_output
 * answered without RN while the bridge heartbeat says RN is paused.
 *
 *  - routing in scripts/shelly-mcp-server.js (createDirectReadCallTool +
 *    createFileQueueCallTool's nativeRead), RN live = today's queue path;
 *  - the snapshot sections RN publishes (lib/mcp-server-bridge.ts
 *    buildSnapshotBody extras), signed and verified as for every direct read;
 *  - parity of the ports (logcat filter, settings filter, tag list, messages
 *    in McpNativeReadDecision.kt);
 *  - Phase A's enqueue-time bridge_not_live for the RN-only ops, through the
 *    whole production chain.
 */
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
const TOKEN = 'test-token';
const BRIDGE_KEY = 'ab'.repeat(32);
const INGRESS = { principal: 'p'.repeat(16), clientNameSelfReported: 'c' };
const AGENTS = [{ id: 'a1', name: 'Example', enabled: true, schedule: null, autonomous: false }];

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bg-read-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const iso = (ms: number) => new Date(ms).toISOString();
const NOW = Date.parse('2026-11-28T10:00:00.000Z');

async function writeSnapshot(extras: Record<string, unknown>, token = TOKEN) {
  const body = bridge.buildSnapshotBody(AGENTS, [], null, extras);
  fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify({ body, mac: await bridge.signSnapshot(token, body, nodeSha256) }));
}

function heartbeat(value: string | null) {
  const f = path.join(dir, 'bridge-heartbeat');
  if (value === null) fs.rmSync(f, { force: true });
  else fs.writeFileSync(f, value);
}

function make(runLogcat: jest.Mock = jest.fn(), now: () => number = () => NOW) {
  const fallback = jest.fn(async (..._a: unknown[]): Promise<unknown> => ({ ok: true, data: 'from-queue' }));
  const callTool = mcp.createDirectReadCallTool({ queueDir: dir, token: TOKEN, fallback, runLogcat, now });
  return { callTool, fallback, runLogcat };
}

const PAUSED = (tool: string) => `${tool} cannot be answered right now: Shelly is in the background and its bridge is paused (open Shelly and try again)`;

describe('routing: RN live keeps the queue path', () => {
  it.each([['live'], ['missing']])('heartbeat %s → the queue, args untouched', async (hb) => {
    heartbeat(hb === 'live' ? String(Date.now()) : null);
    await writeSnapshot({ settings: { capturedAt: iso(NOW), settings: { a: 1 }, withheldKeys: [] } });
    const { callTool, fallback, runLogcat } = make(jest.fn(), () => Date.now());
    for (const tool of ['read_logs', 'get_settings', 'read_terminal_output']) {
      expect(await callTool(tool, { x: 1 }, INGRESS)).toEqual({ ok: true, data: 'from-queue' });
      expect(fallback).toHaveBeenLastCalledWith(tool, { x: 1 }, INGRESS);
    }
    expect(runLogcat).not.toHaveBeenCalled();
  });
});

describe('get_settings while RN is paused', () => {
  beforeEach(() => heartbeat('0'));

  it('answers from the signed settings section, stale, filtered again', async () => {
    const published = bridge.redactSettingsForMcp({ theme: 'dark', groqApiKey: 'gsk_x', nested: { url: 'https://u:p@h/x' } });
    // A key the published copy should not have carried is withheld again here.
    published.settings.planted_token = 'v';
    await writeSnapshot({ settings: { capturedAt: iso(NOW - 60_000), ...published } });
    const { callTool, fallback } = make();
    const r = await callTool('get_settings', {}, INGRESS);
    expect(fallback).not.toHaveBeenCalled();
    expect(r).toEqual({
      ok: true,
      data: {
        settings: { theme: 'dark', nested: { url: 'https://<redacted>@h/x' } },
        withheldKeys: ['groqApiKey', 'planted_token'],
        stale: true,
        capturedAt: iso(NOW - 60_000),
        ageMs: 60_000,
      },
    });
  });

  it('no section, a bad MAC or no snapshot → today\'s paused-bridge error', async () => {
    const { callTool } = make();
    expect(await callTool('get_settings', {}, INGRESS)).toEqual({ ok: false, error: PAUSED('get_settings') });
    await writeSnapshot({});
    expect(await callTool('get_settings', {}, INGRESS)).toEqual({ ok: false, error: PAUSED('get_settings') });
    await writeSnapshot({ settings: { capturedAt: iso(NOW), settings: { a: 1 }, withheldKeys: [] } }, 'other-token');
    expect(await callTool('get_settings', {}, INGRESS)).toEqual({ ok: false, error: PAUSED('get_settings') });
  });
});

describe('read_logs while RN is paused', () => {
  beforeEach(() => heartbeat('0'));

  it('source app: the published tail, capped like RN, stale with capturedAt', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `2026-11-28T09:00:${String(i).padStart(2, '0')}.000Z INFO [Shelly][X] line ${i}`);
    lines.push('2026-11-28T09:01:00.000Z INFO [Shelly][X] key=sk-ant-abcdefghijklmnopqrstuvwxyz');
    await writeSnapshot({ appLog: { capturedAt: iso(NOW - 5_000), lines, truncated: false } });
    const { callTool } = make();
    const r = await callTool('read_logs', { limit: 3 }, INGRESS);
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ source: 'app', lines: 3, truncated: true, stale: true, capturedAt: iso(NOW - 5_000), ageMs: 5_000 });
    expect(r.data.text.split('\n')).toHaveLength(3);
    expect(r.data.text).not.toContain('sk-ant-');
    expect(r.data.text).toContain('line 29');
  });

  it('source app without a published copy → bridge_not_live', async () => {
    const { callTool } = make();
    await writeSnapshot({});
    expect(await callTool('read_logs', {}, INGRESS)).toEqual({ ok: false, error: PAUSED('read_logs'), code: 'bridge_not_live' });
  });

  it('bad source is refused with RN\'s message before anything is read', async () => {
    const { callTool, runLogcat } = make();
    expect(await callTool('read_logs', { source: 'kernel' }, INGRESS)).toEqual({ ok: false, error: 'source must be "app" or "logcat"' });
    expect(runLogcat).not.toHaveBeenCalled();
  });

  it('source logcat: run here with RN\'s argv, filtered and redacted', async () => {
    const out = [
      '--------- beginning of main',
      '11-28 09:00:00.000  123  123 I MCPBridge: started token=abcdef123456',
      '11-28 09:00:01.000  123  123 I ReactNativeJS: not a shelly line',
      '11-28 09:00:02.000  123  123 I ReactNativeJS: [Shelly][X] hello',
      '11-28 09:00:03.000  123  123 I OtherTag: dropped',
    ].join('\n');
    const runLogcat = jest.fn(async () => ({ exitCode: 0, stdout: out, stderr: '' }));
    const { callTool, fallback } = make(runLogcat);
    const r = await callTool('read_logs', { source: 'logcat', limit: 10 }, INGRESS);
    expect(fallback).not.toHaveBeenCalled();
    expect(runLogcat).toHaveBeenCalledWith(['-d', '-v', 'threadtime', '-t', '40', '-s', ...bridge.LOGCAT_TAGS]);
    expect(r).toEqual({
      ok: true,
      data: {
        source: 'logcat',
        lines: 2,
        truncated: false,
        text: '11-28 09:00:00.000  123  123 I MCPBridge: started token=<redacted>\n11-28 09:00:02.000  123  123 I ReactNativeJS: [Shelly][X] hello',
      },
    });
  });

  it('source logcat: exit code and spawn failures use RN\'s messages', async () => {
    const { callTool } = make(jest.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'denied password=hunter22' })));
    expect(await callTool('read_logs', { source: 'logcat' }, INGRESS)).toEqual({
      ok: false,
      error: 'logcat is not readable from the app (exit 1): denied password=<redacted>',
    });
    const { callTool: c2 } = make(jest.fn(async () => ({ spawnError: 'spawn logcat ENOENT' })));
    expect(await c2('read_logs', { source: 'logcat' }, INGRESS)).toEqual({ ok: false, error: 'logcat is not readable from the app: spawn logcat ENOENT' });
  });
});

describe('read_terminal_output while RN is paused', () => {
  beforeEach(() => heartbeat('0'));
  const terminal = {
    activeSessionId: 'session-1',
    sessions: [
      { id: 'session-1', nativeSessionId: 'session-1700000000001' },
      { id: 'shelly-2-x', nativeSessionId: 'session-1700000000002' },
    ],
  };

  it('resolves the active / logical / native id and hands the native id to the native consumer', async () => {
    await writeSnapshot({ terminal });
    const { callTool, fallback } = make();
    await callTool('read_terminal_output', {}, INGRESS);
    expect(fallback).toHaveBeenLastCalledWith('read_terminal_output', { sessionId: 'session-1700000000001', maxLines: 200 }, INGRESS, { nativeRead: true });
    await callTool('read_terminal_output', { sessionId: 'shelly-2-x', maxLines: 50 }, INGRESS);
    expect(fallback).toHaveBeenLastCalledWith('read_terminal_output', { sessionId: 'session-1700000000002', maxLines: 50 }, INGRESS, { nativeRead: true });
    await callTool('read_terminal_output', { sessionId: 'session-1700000000002' }, INGRESS);
    expect(fallback).toHaveBeenLastCalledWith('read_terminal_output', { sessionId: 'session-1700000000002', maxLines: 200 }, INGRESS, { nativeRead: true });
  });

  it('an unknown session is RN\'s error; no terminal section is the paused-bridge error', async () => {
    await writeSnapshot({ terminal });
    const { callTool, fallback } = make();
    expect(await callTool('read_terminal_output', { sessionId: 'nope' }, INGRESS)).toEqual({ ok: false, error: 'no such terminal session: nope' });
    await writeSnapshot({});
    expect(await callTool('read_terminal_output', {}, INGRESS)).toEqual({ ok: false, error: PAUSED('read_terminal_output') });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('the file queue puts a nativeRead into typed-requests/ even with a paused heartbeat; a plain read still fails fast', async () => {
    const callTool = mcp.createFileQueueCallTool(dir, BRIDGE_KEY);
    expect(await callTool('read_terminal_output', {}, INGRESS)).toEqual({ ok: false, error: PAUSED('read_terminal_output') });
    expect(fs.readdirSync(path.join(dir, 'requests'))).toEqual([]);
    const pending = callTool('read_terminal_output', { sessionId: 'session-1', maxLines: 10 }, INGRESS, { nativeRead: true });
    const typed = fs.readdirSync(path.join(dir, 'typed-requests')).filter((n: string) => n.endsWith('.json'));
    expect(typed).toHaveLength(1);
    const body = JSON.parse(fs.readFileSync(path.join(dir, 'typed-requests', typed[0]), 'utf8'));
    expect(body).toMatchObject({ tool: 'read_terminal_output', args: { sessionId: 'session-1', maxLines: 10 } });
    expect(body.mac).toBe(mcp.requestMac(BRIDGE_KEY, (({ mac: _m, ...rest }) => rest)(body)));
    fs.writeFileSync(path.join(dir, 'results', `${body.callId}.json`), JSON.stringify({ ok: true, data: 'hello' }));
    await expect(pending).resolves.toEqual({ ok: true, data: 'hello' });
    // nativeRead is ignored for any other tool.
    expect(await callTool('get_settings', {}, INGRESS, { nativeRead: true })).toEqual({ ok: false, error: PAUSED('get_settings') });
  });
});

describe('Phase A RN-only ops stay bridge_not_live at enqueue (production chain)', () => {
  it.each(['update_pipeline_config', 'update_delivery_script', 'stage_install'])('%s', async (tool) => {
    heartbeat('0');
    const chain = mcp.createRunResultCallTool({
      queueDir: dir,
      fallback: mcp.createDirectReadCallTool({ queueDir: dir, token: TOKEN, fallback: mcp.createFileQueueCallTool(dir, BRIDGE_KEY) }),
    });
    const started = Date.now();
    const r = await chain(tool, {}, INGRESS);
    expect(r).toMatchObject({ ok: false, code: 'bridge_not_live' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fs.readdirSync(path.join(dir, 'requests'))).toEqual([]);
    expect(fs.readdirSync(path.join(dir, 'typed-requests')).filter((n: string) => n.endsWith('.json'))).toEqual([]);
  });
});

describe('RN publishes the sections', () => {
  it('terminalSection keeps ids only, bounded', () => {
    const state = {
      activeSessionId: 'session-1',
      sessions: [
        { id: 'session-1', nativeSessionId: 'n1', blocks: ['secret output'], cwd: '/x' },
        { id: 'x'.repeat(200), nativeSessionId: 'n2' },
      ],
    };
    expect(bridge.terminalSection(state)).toEqual({ activeSessionId: 'session-1', sessions: [{ id: 'session-1', nativeSessionId: 'n1' }] });
  });

  it('appLogTail keeps the newest lines within the caps', () => {
    expect(bridge.appLogTail(['a', 'b', 'c', 'd'], 2, 100)).toEqual({ lines: ['c', 'd'], truncated: true });
    expect(bridge.appLogTail(['aaaa', 'bbbb'], 10, 6)).toEqual({ lines: ['bbbb'], truncated: true });
    expect(bridge.appLogTail(['a'], 10, 100)).toEqual({ lines: ['a'], truncated: false });
  });

  it('the snapshot stays under the publish cap: appLog shrinks first, then sections drop', () => {
    const big = Array.from({ length: 1000 }, (_, i) => `${'"'.repeat(60)} ${i}`);
    const body = bridge.buildSnapshotBody(AGENTS, [], null, {
      terminal: { activeSessionId: 's', sessions: [] },
      settings: { capturedAt: iso(NOW), settings: { a: 1 }, withheldKeys: [] },
      appLog: { capturedAt: iso(NOW), lines: big, truncated: false },
    });
    const file = JSON.stringify({ body, mac: 'f'.repeat(64) });
    expect(Buffer.byteLength(file)).toBeLessThanOrEqual(bridge.SNAPSHOT_PUBLISH_MAX_BYTES);
    const parsed = JSON.parse(body);
    expect(parsed.settings).toBeDefined();
    expect(parsed.terminal).toBeDefined();
    expect(parsed.appLog.truncated).toBe(true);
    expect(parsed.appLog.lines.length).toBeGreaterThan(0);
    expect(parsed.appLog.lines[parsed.appLog.lines.length - 1]).toBe(big[big.length - 1]);
    // Without extras the body is exactly what it was before phase B-1.
    expect(bridge.buildSnapshotBody(AGENTS, ['/r'])).toBe(JSON.stringify({ v: 1, agents: AGENTS, repoPaths: ['/r'] }));
    expect(bridge.SNAPSHOT_PUBLISH_MAX_BYTES).toBeLessThan(256 * 1024);
  });
});

describe('parity of the ports', () => {
  it('logcat tag list and line filter match RN', () => {
    expect(mcp.LOGCAT_TAGS).toEqual(bridge.LOGCAT_TAGS);
    const corpus = [
      '--------- beginning of crash',
      '11-28 09:00:00.000  1  2 E AndroidRuntime: FATAL EXCEPTION Bearer abcdefghijkl',
      '11-28 09:00:00.000  1  2 W TerminalSessionService: url https://user:pw@example.com/x',
      "11-28 09:00:00.000  1  2 I ReactNativeJS: '[Shelly][A] quoted', {\"apiKey\":\"v\"}",
      '11-28 09:00:00.000  1  2 I ReactNativeJS: plain console.log',
      '11-28 09:00:00.000  1  2 D Unknown: x',
      'garbage line',
      '',
      '11-28 09:00:00.000  1  2 V AgentRuntime  : padded tag GROQ_API_KEY=gsk_abcdefghijklmnopqrstuvwxyz',
    ].join('\r\n');
    expect(mcp.filterLogcatLines(corpus)).toEqual(bridge.filterLogcatLines(corpus));
    expect(mcp.filterLogcatLines(corpus)).toHaveLength(4);
  });

  it('settings filter matches RN', () => {
    expect(mcp.SETTINGS_DENYLIST_RE.source).toBe(bridge.SETTINGS_DENYLIST_RE.source);
    expect(mcp.SETTINGS_DENYLIST_RE.flags).toBe(bridge.SETTINGS_DENYLIST_RE.flags);
    let deep: Record<string, unknown> = { leaf: 'x' };
    for (let i = 0; i < 10; i++) deep = { d: deep };
    const sample = {
      theme: 'dark', fontSize: 14, n: null, list: ['a', { pass_word: 'x', ok: 'https://a:b@c' }],
      providers: { groq: { apiKey: 'k', model: 'm' } }, cookieJar: 'c', deep,
    };
    expect(mcp.redactSettingsForMcp(sample)).toEqual(bridge.redactSettingsForMcp(sample));
  });

  it('McpNativeReadDecision.kt uses RN\'s messages and default', () => {
    const kt = fs.readFileSync(path.join(__dirname, '..', 'modules', 'terminal-emulator', 'android', 'src', 'main', 'java', 'expo', 'modules', 'terminalemulator', 'McpNativeReadDecision.kt'), 'utf8');
    const ts = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-server-bridge.ts'), 'utf8');
    const disabled = /READ_TERMINAL_DISABLED = "([^"]+)"/.exec(kt)![1];
    expect(ts).toContain(`error: '${disabled}'`);
    const revoked = /REVOKED_ERROR = "([^"]+)"/.exec(kt)![1];
    expect(ts).toContain(`const REVOKED_ERROR = '${revoked}';`);
    expect(kt).toContain('DEFAULT_MAX_LINES = 200');
    expect(ts).toContain("typeof args.maxLines === 'number' ? args.maxLines : 200");
    expect(kt).toContain('const val OP_READ_TERMINAL = "read_terminal_output"');
    expect([...mcp.NATIVE_READ_TOOLS]).toEqual(['read_terminal_output']);
  });

  it('the APK asset is byte-identical to the script', () => {
    const a = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'shelly-mcp-server.js'));
    const b = fs.readFileSync(path.join(__dirname, '..', 'modules', 'terminal-emulator', 'android', 'src', 'main', 'assets', 'shelly-mcp-server.js'));
    expect(a.equals(b)).toBe(true);
  });
});
