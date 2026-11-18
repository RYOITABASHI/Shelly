/**
 * PR 6 (headless typed ops), the script side: run_agent requests are written
 * to typed-requests/ (drained only by the native McpTypedOpConsumer) while the
 * answer is still read from results/<callId>.json; get_run_result is answered
 * by the script itself from runs/<handle>.json (principal-scoped, long-poll,
 * output redacted then byte-capped) — the same answer PR 5's RN path gave.
 * Dummy values only.
 */
jest.mock('expo-file-system/legacy', () => require('./helpers/mcp-typed-ops-harness').fsMock);
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => require('./helpers/mcp-typed-ops-harness').nativeMock);
jest.mock('@/store/agent-store', () => require('./helpers/mcp-typed-ops-harness').agentStoreMock);
jest.mock('@/store/settings-store', () => require('./helpers/mcp-typed-ops-harness').settingsStoreMock);
jest.mock('@/store/sidebar-store', () => ({ useSidebarStore: { getState: () => ({ repoPaths: [] }), subscribe: () => () => {} } }));
jest.mock('@/store/terminal-store', () => ({ useTerminalStore: { getState: () => ({ sessions: [], activeSessionId: null }) } }));
jest.mock('@/lib/agent-user-policy-store', () => require('./helpers/mcp-typed-ops-harness').policyStoreMock);
jest.mock('@/lib/debug-logger', () => require('./helpers/mcp-typed-ops-harness').loggerMock);
jest.mock('@/lib/secure-store', () => ({ getConnectorSecret: async () => 'dummy-token' }));
jest.mock('@/hooks/use-native-exec', () => ({ execCommand: jest.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })) }));
jest.mock('react-native', () => require('./helpers/mcp-typed-ops-harness').reactNativeMock);
jest.mock('@/lib/i18n', () => ({ t: (k: string) => k, tFor: (_l: string, k: string) => k }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { redactForMcp as bridgeRedact } from '@/lib/mcp-server-bridge';
import { verifyMcpRequest, __resetMcpSeenCallIdsForTests } from '@/lib/mcp-request-auth';
import { buildRunResultResponse, parseRunTicket } from '@/lib/mcp-typed-ops';
import { nodeSha256, TEST_BRIDGE_KEY, TEST_PRINCIPAL } from './helpers/mcp-signed-request';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const server = require('../scripts/shelly-mcp-server.js');

const OTHER = 'fedcba9876543210fedcba9876543210';
const HANDLE = `mr_${'ab'.repeat(16)}`;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-direct-'));
  fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeTicket(t: Record<string, unknown>, handle = HANDLE): void {
  fs.writeFileSync(path.join(dir, 'runs', `${handle}.json`), JSON.stringify({ v: 1, handle, ...t }));
}

function ticket(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { principal: TEST_PRINCIPAL, agentId: 'agent-1', state: 'running', acceptedAt: Date.now() - 1000, startedAt: Date.now() - 500, ...over };
}

const ingress = { principal: TEST_PRINCIPAL, clientNameSelfReported: 'c' };

describe('typed-requests routing', () => {
  it('run_agent lands in typed-requests/ (never requests/), the answer is read from results/', async () => {
    const callTool = server.createFileQueueCallTool(dir, TEST_BRIDGE_KEY);
    const pending = callTool('run_agent', { agentId: 'agent-1' }, ingress);
    const typed = fs.readdirSync(path.join(dir, 'typed-requests')).filter((n: string) => n.endsWith('.json'));
    expect(typed).toHaveLength(1);
    expect(fs.readdirSync(path.join(dir, 'requests'))).toEqual([]);
    const body = JSON.parse(fs.readFileSync(path.join(dir, 'typed-requests', typed[0]), 'utf8'));
    expect(typed[0]).toBe(`${body.callId}.json`);
    // Signed exactly like a requests/ file: the RN verifier accepts it after a handoff move.
    __resetMcpSeenCallIdsForTests();
    expect((await verifyMcpRequest(body, TEST_BRIDGE_KEY, nodeSha256, { fileName: typed[0] })).ok).toBe(true);
    const answer = { ok: true, data: { runHandle: HANDLE, agentId: 'agent-1', state: 'accepted', untrusted: true } };
    fs.writeFileSync(path.join(dir, 'results', `${body.callId}.json`), JSON.stringify(answer));
    await expect(pending).resolves.toEqual(answer);
    expect(fs.existsSync(path.join(dir, 'results', `${body.callId}.json`))).toBe(false);
  });

  it('a half-written result (native creates it in place) is re-read next tick, not reported unreadable', async () => {
    const callTool = server.createFileQueueCallTool(dir, TEST_BRIDGE_KEY);
    const pending = callTool('run_agent', { agentId: 'agent-1' }, ingress);
    const name = fs.readdirSync(path.join(dir, 'typed-requests')).find((n: string) => n.endsWith('.json'))!;
    const resultFile = path.join(dir, 'results', name);
    const answer = { ok: false, error: 'x', code: 'not_attended' };
    const text = JSON.stringify(answer);
    fs.writeFileSync(resultFile, text.slice(0, 7));
    setTimeout(() => fs.writeFileSync(resultFile, text), 700);
    await expect(pending).resolves.toEqual(answer);
    expect(fs.existsSync(resultFile)).toBe(false);
  });

  it('every other queued tool still goes to requests/', async () => {
    const callTool = server.createFileQueueCallTool(dir, TEST_BRIDGE_KEY);
    const pending = callTool('read_logs', {}, ingress);
    const reqs = fs.readdirSync(path.join(dir, 'requests')).filter((n: string) => n.endsWith('.json'));
    expect(reqs).toHaveLength(1);
    expect(fs.readdirSync(path.join(dir, 'typed-requests'))).toEqual([]);
    expect(fs.readdirSync(path.join(dir, 'raw-requests'))).toEqual([]);
    const callId = reqs[0].replace(/\.json$/, '');
    fs.writeFileSync(path.join(dir, 'results', `${callId}.json`), JSON.stringify({ ok: true, data: null }));
    await expect(pending).resolves.toEqual({ ok: true, data: null });
  });

  it.each(['run_command', 'write_file'])('%s lands in raw-requests/ only (the native raw consumer decides once per callId)', async (tool) => {
    const callTool = server.createFileQueueCallTool(dir, TEST_BRIDGE_KEY);
    const pending = callTool(tool, tool === 'run_command' ? { command: 'ls' } : { path: '/x', content: 'y' }, ingress);
    const raw = fs.readdirSync(path.join(dir, 'raw-requests')).filter((n: string) => n.endsWith('.json'));
    expect(raw).toHaveLength(1);
    expect(fs.readdirSync(path.join(dir, 'requests'))).toEqual([]);
    expect(fs.readdirSync(path.join(dir, 'typed-requests'))).toEqual([]);
    const body = JSON.parse(fs.readFileSync(path.join(dir, 'raw-requests', raw[0]), 'utf8'));
    __resetMcpSeenCallIdsForTests();
    expect((await verifyMcpRequest(body, TEST_BRIDGE_KEY, nodeSha256, { fileName: raw[0] })).ok).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, 'raw-requests')).mode & 0o777).toBe(0o700);
    fs.writeFileSync(path.join(dir, 'results', `${body.callId}.json`), JSON.stringify({ ok: true, data: { stdout: '', stderr: '', exitCode: 0 } }));
    await expect(pending).resolves.toEqual({ ok: true, data: { stdout: '', stderr: '', exitCode: 0 } });
  });

  it('requestDirName routes each tool to exactly one directory', () => {
    expect(server.requestDirName('run_agent')).toBe('typed-requests');
    expect(server.requestDirName('run_command')).toBe('raw-requests');
    expect(server.requestDirName('write_file')).toBe('raw-requests');
    expect(server.requestDirName('read_terminal_output')).toBe('requests');
    expect([...server.RAW_REQUEST_TOOLS].sort()).toEqual(['run_command', 'write_file']);
  });

  it('get_run_result never touches the queue; other tools fall through', async () => {
    const fallback = jest.fn(async () => ({ ok: true, data: 'fallback' }));
    const callTool = server.createRunResultCallTool({ queueDir: dir, fallback });
    writeTicket(ticket({ state: 'succeeded', finishedAt: Date.now() }));
    const r = await callTool('get_run_result', { runHandle: HANDLE }, ingress);
    expect(r.ok).toBe(true);
    expect(fallback).not.toHaveBeenCalled();
    await expect(callTool('run_agent', { agentId: 'x' }, ingress)).resolves.toEqual({ ok: true, data: 'fallback' });
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('typed ops hidden when the flag is off (unchanged from PR 4/5)', () => {
    const names = server.availableTools({ exec: true }).map((t: { name: string }) => t.name);
    expect(names).not.toContain('run_agent');
    expect(names).not.toContain('get_run_result');
  });
});

describe('get_run_result direct read', () => {
  it('answers like the PR 5 RN path for the same ticket and output', async () => {
    const t = ticket({
      state: 'succeeded',
      finishedAt: Date.now(),
      exitCode: 0,
      runLog: { timestamp: Date.now(), status: 'success', outputPreview: 'token=abcdefgh123 done', errorMessage: '' },
      outputFile: `${HANDLE}.out`,
    });
    writeTicket(t);
    const output = 'result line\nAuthorization: Bearer abcdefghijklmnop\nOPENAI_API_KEY=sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaa\n';
    fs.writeFileSync(path.join(dir, 'runs', `${HANDLE}.out`), output);
    const r = await server.getRunResultDirect(dir, { runHandle: HANDLE, maxBytes: 4096 }, ingress);
    const expected = buildRunResultResponse(parseRunTicket({ v: 1, handle: HANDLE, ...t })!, output, 4096, bridgeRedact);
    expect(r).toEqual({ ok: true, data: expected });
    expect(r.data.result.output).not.toContain('abcdefghijklmnop');
    expect(r.data.result.output).not.toContain('sk-aaaa');
    expect(r.data.result.preview).not.toContain('abcdefgh123');
    expect(r.data.untrusted).toBe(true);
  });

  it("another principal's handle reads exactly like a missing one", async () => {
    writeTicket(ticket({ principal: OTHER, state: 'succeeded' }));
    const theirs = await server.getRunResultDirect(dir, { runHandle: HANDLE }, ingress);
    const missing = await server.getRunResultDirect(dir, { runHandle: `mr_${'cd'.repeat(16)}` }, ingress);
    expect(theirs).toEqual(missing);
    expect(theirs).toEqual({ ok: false, code: 'unknown_handle', error: 'no run with that handle for this client' });
  });

  it('a malformed or extra-key ticket is unknown_handle; bad args are invalid_params', async () => {
    writeTicket({ ...ticket(), extra: 1 });
    expect((await server.getRunResultDirect(dir, { runHandle: HANDLE }, ingress)).code).toBe('unknown_handle');
    expect((await server.getRunResultDirect(dir, { runHandle: 'nope' }, ingress)).code).toBe('invalid_params');
    expect((await server.getRunResultDirect(dir, { runHandle: HANDLE, other: 1 }, ingress)).code).toBe('invalid_params');
    expect((await server.getRunResultDirect(dir, { runHandle: HANDLE, waitMs: 'x' }, ingress)).code).toBe('invalid_params');
  });

  // McpRunAuthorization refuses at start with these; the ticket ends skipped.
  it.each(['expired', 'target_changed', 'unauthorized'])('a run skipped at start (%s) reports skipped, not unknown_handle', async (reason) => {
    const now = Date.now();
    const t = ticket({ state: 'skipped', reason, acceptedAt: now - 1000, finishedAt: now });
    delete t.startedAt; // refused before it started
    writeTicket(t);
    const r = await server.getRunResultDirect(dir, { runHandle: HANDLE }, ingress);
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ state: 'skipped', reason });
    expect(r).toEqual({ ok: true, data: buildRunResultResponse(parseRunTicket({ v: 1, handle: HANDLE, ...t })!, null, 16 * 1024, bridgeRedact) });
  });

  it('accepts every reason McpRunTickets.REASONS can write', async () => {
    const kt = fs.readFileSync(
      path.join(__dirname, '../modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/McpRunTickets.kt'),
      'utf8',
    );
    const consts = new Map([...kt.matchAll(/const val (REASON_[A-Z_]+) = "([a-z_]+)"/g)].map((m) => [m[1], m[2]]));
    const setBody = /val REASONS: Set<String> = setOf\(([^)]*)\)/.exec(kt)![1];
    const reasons = setBody.match(/REASON_[A-Z_]+/g)!.map((name) => consts.get(name));
    expect(reasons).not.toContain(undefined);
    expect(reasons.length).toBeGreaterThanOrEqual(14);
    for (const reason of reasons) {
      writeTicket(ticket({ state: 'failed', reason, finishedAt: Date.now() }));
      const r = await server.getRunResultDirect(dir, { runHandle: HANDLE }, ingress);
      expect({ reason, ok: r.ok, got: r.data?.reason }).toEqual({ reason, ok: true, got: reason });
    }
  });

  it('a symlinked ticket is not followed', async () => {
    const real = path.join(dir, 'real.json');
    fs.writeFileSync(real, JSON.stringify({ v: 1, handle: HANDLE, ...ticket({ state: 'succeeded' }) }));
    fs.symlinkSync(real, path.join(dir, 'runs', `${HANDLE}.json`));
    expect((await server.getRunResultDirect(dir, { runHandle: HANDLE }, ingress)).code).toBe('unknown_handle');
  });

  it('long-polls every 500 ms until a terminal state, then returns', async () => {
    writeTicket(ticket());
    const sleeps: number[] = [];
    let t = 1_000_000;
    const r = await server.getRunResultDirect(dir, { runHandle: HANDLE, waitMs: 20_000 }, ingress, {
      now: () => t,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        t += ms;
        if (sleeps.length === 3) writeTicket(ticket({ state: 'failed', reason: 'error', finishedAt: t, acceptedAt: t - 100, startedAt: t - 50 }));
      },
    });
    expect(sleeps).toEqual([500, 500, 500]);
    expect(r.data.state).toBe('failed');
  });

  it('stops at waitMs (capped at 20 s) with the live state', async () => {
    writeTicket(ticket());
    let t = 5_000_000;
    const sleeps: number[] = [];
    const r = await server.getRunResultDirect(dir, { runHandle: HANDLE, waitMs: 1200 }, ingress, {
      now: () => t,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        t += ms;
      },
    });
    expect(sleeps).toEqual([500, 500, 200]);
    expect(r.data.state).toBe('running');
  });

  it('a real-timer long-poll ends at waitMs and leaves no timer behind', async () => {
    writeTicket(ticket());
    const r = await server.getRunResultDirect(dir, { runHandle: HANDLE, waitMs: 600 }, ingress);
    expect(r.data.state).toBe('running');
  });

  it('applies the stale rule (accepted > 2 min → lost) without writing the ticket', async () => {
    writeTicket(ticket({ state: 'accepted', acceptedAt: Date.now() - 3 * 60_000, startedAt: undefined }));
    const before = fs.readFileSync(path.join(dir, 'runs', `${HANDLE}.json`), 'utf8');
    const r = await server.getRunResultDirect(dir, { runHandle: HANDLE }, ingress);
    expect(r.data.state).toBe('lost');
    expect(r.data.reason).toBe('stale');
    expect(fs.readFileSync(path.join(dir, 'runs', `${HANDLE}.json`), 'utf8')).toBe(before);
  });

  it('caps the output at maxBytes on a character boundary, after redaction', async () => {
    writeTicket(ticket({ state: 'succeeded', finishedAt: Date.now(), outputFile: `${HANDLE}.out` }));
    fs.writeFileSync(path.join(dir, 'runs', `${HANDLE}.out`), 'あ'.repeat(100));
    const r = await server.getRunResultDirect(dir, { runHandle: HANDLE, maxBytes: 10 }, ingress);
    expect(r.data.result.output).toBe('あああ');
    expect(r.data.result.truncated).toBe(true);
    expect(r.data.result.outputBytes).toBe(300);
  });

  it('reads at most 64 KiB of the snapshot and refuses invalid UTF-8', async () => {
    writeTicket(ticket({ state: 'succeeded', finishedAt: Date.now(), outputFile: `${HANDLE}.out` }));
    fs.writeFileSync(path.join(dir, 'runs', `${HANDLE}.out`), 'x'.repeat(70 * 1024));
    const big = await server.getRunResultDirect(dir, { runHandle: HANDLE, maxBytes: 1e9 }, ingress);
    expect(Buffer.byteLength(big.data.result.output)).toBe(64 * 1024);
    fs.writeFileSync(path.join(dir, 'runs', `${HANDLE}.out`), Buffer.from([0x61, 0xff, 0x62]));
    const bad = await server.getRunResultDirect(dir, { runHandle: HANDLE }, ingress);
    // Not UTF-8 = no output; with no run log either there is no result block (as in PR 5).
    expect(bad.data.result).toBeUndefined();
  });
});

describe('redaction port', () => {
  const corpus = [
    'plain text, nothing secret',
    'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123',
    'key sk-proj-AAAAAAAAAAAAAAAAAAAAAAAA and sk-ant-BBBBBBBBBBBBBBBBBBBBBBBB',
    'google AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA groq gsk_CCCCCCCCCCCCCCCCCCCCCCCC',
    'cerebras csk-DDDDDDDDDDDDDDDDDDDDDDDD github ghp_EEEEEEEEEEEEEEEEEEEEEEEE',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
    'https://user:pass@example.com/path?token=abc123&x=1',
    '{"password": "hunter22", "apiKey":"zzz", "name":"ok"}',
    'Authorization: Bearer abcdefghijklmnop\nCookie: a=b; c=d\nSet-Cookie: s=1',
    "secret='quoted value' pass_word=\"dq\" pwd=bare passphrase: x",
    'bot123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA end, /bot123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/send',
    'MY_AUTH_TOKEN = "abcdefghij" refresh_token=zzzzzzzzzz',
    'session_id: 42; signature=deadbeef; credential:"x"',
    'unicode 日本語 token=値 😀',
  ];
  it.each(corpus.map((c) => [c.slice(0, 40), c] as const))('%s', (_n, text) => {
    expect(server.redactForMcp(text)).toBe(bridgeRedact(text));
  });
});
