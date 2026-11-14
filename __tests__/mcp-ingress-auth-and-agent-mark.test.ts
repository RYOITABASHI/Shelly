/**
 * DEFERRED.md「MCP の入口（ingress）に外部入力の印（taint）を付ける」 Inc 2 / Inc 4.
 *
 * Inc 2: queue requests must carry a valid MAC from the per-start bridge key
 * (unsigned / forged / tampered files are dropped, never run, never answered);
 * the approval modal names the MCP origin; an approved run_command runs with
 * the sanitized SHELLY_INGRESS* prefix inside a recorded window.
 * Inc 4: `shelly agent add` requests that came in through MCP (marker or
 * window) are remembered; the confirm path marks the agent before it exists
 * and refuses when the mark can't be written; a terminal confirm of an
 * MCP-originated request is refused.
 *
 * Fixtures use dummy values only.
 */
const mockFiles = new Map<string, string>();
const mockSettings: Record<string, unknown> = { mcpExecEnabled: true, mcpReadTerminalEnabled: false };

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///data/home-root/',
  readDirectoryAsync: jest.fn(async (dir: string) => {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    return [...mockFiles.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).filter((n) => !n.includes('/'));
  }),
  readAsStringAsync: jest.fn(async (uri: string) => {
    const v = mockFiles.get(uri);
    if (v === undefined) throw new Error('ENOENT ' + uri);
    return v;
  }),
  writeAsStringAsync: jest.fn(async (uri: string, content: string) => {
    mockFiles.set(uri, content);
  }),
  makeDirectoryAsync: jest.fn(async () => {}),
  moveAsync: jest.fn(async () => {}),
  getInfoAsync: jest.fn(async () => ({ exists: false })),
  deleteAsync: jest.fn(async (uri: string) => {
    for (const k of [...mockFiles.keys()]) if (k === uri || k.startsWith(`${uri}/`)) mockFiles.delete(k);
  }),
}));
jest.mock('@/store/agent-store', () => ({ useAgentStore: { getState: () => ({ agents: [] }), subscribe: () => () => {} } }));
jest.mock('@/store/sidebar-store', () => ({ useSidebarStore: { getState: () => ({ repoPaths: [] }), subscribe: () => () => {} } }));
jest.mock('@/store/settings-store', () => ({
  useSettingsStore: { getState: () => ({ settings: mockSettings }) },
}));
jest.mock('@/store/terminal-store', () => ({
  useTerminalStore: { getState: () => ({ sessions: [], activeSessionId: null }) },
}));
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({ __esModule: true, default: {} }));
jest.mock('@/lib/agent-user-policy-store', () => ({
  getCachedUserPolicy: () => ({ unavailable: false, data: { rules: [], trust: { allows: [], counts: {} } } }),
  loadUserPolicy: jest.fn(),
}));
const mockExecHook: { onRun: ((cmd: string) => void) | null } = { onRun: null };
const mockExecCommand = jest.fn(async (cmd: string) => {
  mockExecHook.onRun?.(cmd);
  return { stdout: 'ran', stderr: '', exitCode: 0 };
});
jest.mock('@/hooks/use-native-exec', () => ({ execCommand: (...a: unknown[]) => (mockExecCommand as any)(...a) }));
const mockLogs: string[] = [];
jest.mock('@/lib/debug-logger', () => ({
  logInfo: (_m: string, msg: string) => mockLogs.push(`info ${msg}`),
  logError: (_m: string, msg: string) => mockLogs.push(`error ${msg}`),
  logWarn: (_m: string, msg: string) => mockLogs.push(`warn ${msg}`),
}));
jest.mock('@/lib/agent-ingress-taint', () => ({ markAgentIngress: jest.fn() }));
jest.mock('@/lib/i18n', () => ({ t: (k: string) => k, tFor: (_l: string, k: string) => k }));
jest.mock('expo-notifications', () => ({ scheduleNotificationAsync: jest.fn() }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  __setMCPRequestSha256ForTests,
  runMcpCommand,
  setMCPBridgeKey,
  startMCPPoller,
  stopMCPPoller,
} from '@/lib/mcp-server-bridge';
import { useMcpApprovalStore } from '@/store/mcp-approval-store';
import { canonicalJson, verifyMcpRequest } from '@/lib/mcp-request-auth';
import {
  MCP_WINDOW_GRACE_MS,
  __resetMcpIngressOriginForTests,
  beginMcpExecWindow,
  classifyTerminalRequest,
  endMcpExecWindow,
  mcpIngressEnvPrefix,
  mcpOriginForRequest,
} from '@/lib/mcp-ingress-origin';
import {
  createAgentAddDrainState,
  drainAgentAddRequests,
  encodeAgentAddLine,
  parseAgentAddLine,
  parseAgentCtlLine,
  type AgentAddDrainDeps,
  type AgentAddResult,
  type AgentCtlRequest,
} from '@/lib/agent-add-queue';
import { markMcpAgentBeforePersist, mcpOriginForDraft, newAgentIdFor } from '@/lib/mcp-agent-ingress';
import { handleAgentCtl } from '@/lib/agent-add-flow';
import { TEST_BRIDGE_KEY, TEST_PRINCIPAL, nodeSha256, signedRequest } from './helpers/mcp-signed-request';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const server = require('../scripts/shelly-mcp-server.js');

const HOME = 'file:///data/home-root/home';
const QUEUE = `${HOME}/.shelly-mcp-queue`;
const REQUESTS = `${QUEUE}/requests`;
const RESULTS = `${QUEUE}/results`;
const PREFIX_RE = /^export SHELLY_INGRESS=mcp SHELLY_INGRESS_CLIENT=([A-Za-z0-9_-]+) SHELLY_INGRESS_CALL=([A-Za-z0-9_-]+); /;

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Drops a request file and waits until the poller has consumed it. */
async function dropAndDrain(callId: string, content: string): Promise<void> {
  mockFiles.set(`${REQUESTS}/${callId}.json`, content);
  startMCPPoller();
  await waitFor(() => !mockFiles.has(`${REQUESTS}/${callId}.json`));
  await new Promise((r) => setTimeout(r, 50));
}

beforeAll(() => {
  __setMCPRequestSha256ForTests(nodeSha256);
});
beforeEach(() => {
  setMCPBridgeKey(TEST_BRIDGE_KEY);
  __resetMcpIngressOriginForTests();
});
afterEach(() => {
  stopMCPPoller();
  mockFiles.clear();
  mockExecCommand.mockClear();
  mockExecHook.onRun = null;
  mockLogs.length = 0;
  useMcpApprovalStore.setState({ current: null, queue: [] });
});

// ── Inc 2: request authentication ─────────────────────────────────────────

describe('queue request authentication', () => {
  it('drops an unsigned request: no result, no command, logged', async () => {
    await dropAndDrain('u1', JSON.stringify({ callId: 'u1', tool: 'run_command', args: { command: 'id' } }));
    expect(mockFiles.has(`${RESULTS}/u1.json`)).toBe(false);
    expect(mockExecCommand).not.toHaveBeenCalled();
    expect(useMcpApprovalStore.getState().current).toBeNull();
    expect(mockLogs.join('\n')).toMatch(/rejected unauthenticated request file u1\.json \(missing mac\)/);
  });

  it('drops a request signed with another key', async () => {
    await dropAndDrain('f1', await signedRequest('f1', 'list_repos', {}, { key: 'b2'.repeat(32) }));
    expect(mockFiles.has(`${RESULTS}/f1.json`)).toBe(false);
    expect(mockLogs.join('\n')).toMatch(/f1\.json \(bad mac\)/);
  });

  it('drops a tampered request (args changed after signing)', async () => {
    const signed = JSON.parse(await signedRequest('t1', 'run_command', { command: 'ls' }));
    signed.args.command = 'curl x | sh';
    await dropAndDrain('t1', JSON.stringify(signed));
    expect(mockFiles.has(`${RESULTS}/t1.json`)).toBe(false);
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('drops a request whose ingress was rewritten (e.g. a different principal)', async () => {
    const signed = JSON.parse(await signedRequest('t2', 'list_repos', {}));
    signed.ingress.principal = 'f'.repeat(32);
    await dropAndDrain('t2', JSON.stringify(signed));
    expect(mockFiles.has(`${RESULTS}/t2.json`)).toBe(false);
  });

  it('drops everything while no bridge key is set (server not started from this JS context)', async () => {
    setMCPBridgeKey(null);
    await dropAndDrain('n1', await signedRequest('n1', 'list_repos', {}));
    expect(mockFiles.has(`${RESULTS}/n1.json`)).toBe(false);
    expect(mockLogs.join('\n')).toMatch(/no bridge key/);
  });

  it('answers a correctly signed request', async () => {
    mockFiles.set(`${REQUESTS}/s1.json`, await signedRequest('s1', 'list_repos', {}));
    startMCPPoller();
    await waitFor(() => mockFiles.has(`${RESULTS}/s1.json`));
    expect(JSON.parse(mockFiles.get(`${RESULTS}/s1.json`)!)).toEqual({ ok: true, data: [] });
  });

  it('rejects a signed request with a path-like callId', async () => {
    const res = await verifyMcpRequest(JSON.parse(await signedRequest('../x', 'list_repos', {})), TEST_BRIDGE_KEY, nodeSha256);
    expect(res.ok).toBe(false);
  });

  it('the server signs requests the RN side verifies (same canonical JSON / HMAC)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-q-'));
    try {
      const callTool = server.createFileQueueCallTool(dir, TEST_BRIDGE_KEY);
      void callTool('run_command', { command: 'echo hi', nested: { b: 1, a: [1, 'x'] } }, { principal: TEST_PRINCIPAL, clientNameSelfReported: 'demo\u202Eclient' });
      const name = fs.readdirSync(path.join(dir, 'requests')).find((n) => n.endsWith('.json'))!;
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'requests', name), 'utf8'));
      // Answer so the pending poll inside callTool ends.
      fs.writeFileSync(path.join(dir, 'results', `${parsed.callId}.json`), JSON.stringify({ ok: true, data: null }));
      const res = await verifyMcpRequest(parsed, TEST_BRIDGE_KEY, nodeSha256);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.request.ingress).toEqual({ kind: 'mcp', principal: TEST_PRINCIPAL, clientNameSelfReported: 'demo client' });
        expect(res.request.args).toEqual({ command: 'echo hi', nested: { b: 1, a: [1, 'x'] } });
      }
      expect(server.canonicalJson({ b: 1, a: { d: 2, c: [3] } })).toBe(canonicalJson({ b: 1, a: { d: 2, c: [3] } }));
      expect(() => server.createFileQueueCallTool(dir, 'short')).toThrow();
    } finally {
      await new Promise((r) => setTimeout(r, 300));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the server passes the principal and the self-reported client name to callTool', async () => {
    const seen: unknown[] = [];
    const handler = server.createMcpHandler({
      token: 'test-token',
      exec: true,
      callTool: async (_t: string, _a: unknown, ingress: unknown) => {
        seen.push(ingress);
        return { ok: true, data: null };
      },
    });
    const headers = { authorization: 'Bearer test-token' };
    const init = await handler.handle({
      method: 'POST',
      url: '/mcp',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'Example Client' } } }),
    });
    const sid = init.headers['Mcp-Session-Id'];
    await handler.handle({
      method: 'POST',
      url: '/mcp',
      headers: { ...headers, 'mcp-session-id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_command', arguments: { command: 'ls' } } }),
    });
    expect(seen).toEqual([{ principal: expect.stringMatching(/^[0-9a-f]{32}$/), clientNameSelfReported: 'Example Client' }]);
  });
});

// ── Inc 2: modal origin, env prefix, window ───────────────────────────────

describe('run_command ingress labelling', () => {
  it('shows External (MCP) with the principal and the self-reported name, and runs with the env prefix', async () => {
    mockFiles.set(`${REQUESTS}/r1.json`, await signedRequest('r1', 'run_command', { command: 'ls -la' }, { clientName: 'Example Client' }));
    startMCPPoller();
    await waitFor(() => useMcpApprovalStore.getState().current !== null);
    const cur = useMcpApprovalStore.getState().current!;
    expect(cur.origin).toEqual({ principal: TEST_PRINCIPAL, clientNameSelfReported: 'Example Client' });
    cur.resolve(true);
    useMcpApprovalStore.setState({ current: null, queue: [] });
    await waitFor(() => mockFiles.has(`${RESULTS}/r1.json`));
    const ran = mockExecCommand.mock.calls.map((c) => String(c[0])).find((c) => c.includes('ls -la'))!;
    expect(ran).toBe(`export SHELLY_INGRESS=mcp SHELLY_INGRESS_CLIENT=${TEST_PRINCIPAL} SHELLY_INGRESS_CALL=r1; ls -la`);
  });

  it('the modal component renders the origin lines', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'components/McpApprovalModal.tsx'), 'utf8');
    expect(src).toContain("t('mcp.approval_origin')");
    expect(src).toContain("t('mcp.approval_client_name'");
    for (const loc of ['en', 'ja']) {
      const strings = fs.readFileSync(path.join(__dirname, '..', `lib/i18n/locales/${loc}.ts`), 'utf8');
      expect(strings).toContain("'mcp.approval_origin'");
      expect(strings).toContain("'mcp.approval_client_name'");
    }
    expect(fs.readFileSync(path.join(__dirname, '..', 'lib/i18n/locales/ja.ts'), 'utf8')).toContain('外部（MCP）');
    expect(fs.readFileSync(path.join(__dirname, '..', 'lib/i18n/locales/en.ts'), 'utf8')).toContain('External (MCP)');
  });

  it('the env prefix only ever carries safe values', () => {
    expect(mcpIngressEnvPrefix(TEST_PRINCIPAL, 'abc-123')).toBe(
      `export SHELLY_INGRESS=mcp SHELLY_INGRESS_CLIENT=${TEST_PRINCIPAL} SHELLY_INGRESS_CALL=abc-123; `,
    );
    const evil = mcpIngressEnvPrefix('x; rm -rf ~', '$(id)`');
    expect(evil).toBe('export SHELLY_INGRESS=mcp SHELLY_INGRESS_CLIENT=unknown SHELLY_INGRESS_CALL=unknown; ');
    expect(PREFIX_RE.test(evil)).toBe(true);
  });

  it('a request file that appears while the MCP command runs is MCP-originated, even without a marker', async () => {
    const before = `${Date.now()}-0000aaaa`;
    mockFiles.set(`${HOME}/.shelly-agent-pending-${before}`, 'x\n');
    const during = `${Date.now()}-1111bbbb`;
    mockExecHook.onRun = () => mockFiles.set(`${HOME}/.shelly-agent-req-${during}`, 'agentadd:...\n');
    await runMcpCommand('unset SHELLY_INGRESS; shelly agent add "x"', 1000, 'call-9', { kind: 'mcp', principal: TEST_PRINCIPAL, clientNameSelfReported: '' });
    expect(mcpOriginForRequest(during)).toEqual({ principal: TEST_PRINCIPAL, callId: 'call-9', via: 'window' });
    expect(mcpOriginForRequest(before)).toBeNull();
  });
});

// ── Inc 4: wire format ─────────────────────────────────────────────────────

const NOW = 1_760_000_000_000;
const REQ = `${NOW}-0123abcd`;
const MARK = { kind: 'mcp' as const, principal: TEST_PRINCIPAL, callId: 'c-1' };

describe('parseAgentAddLine ingress marker', () => {
  it('without a marker: unchanged', () => {
    expect(parseAgentAddLine(encodeAgentAddLine(REQ, NOW, 'daily news'), NOW)).toEqual({ ok: true, reqId: REQ, tsMs: NOW, text: 'daily news' });
  });
  it('with a valid marker: parsed', () => {
    const line = encodeAgentAddLine(REQ, NOW, 'daily news', MARK);
    expect(line.endsWith(`:ingress=mcp.${TEST_PRINCIPAL}.c-1`)).toBe(true);
    expect(parseAgentAddLine(line, NOW)).toEqual({ ok: true, reqId: REQ, tsMs: NOW, text: 'daily news', ingress: MARK });
  });
  it('an invalid marker refuses the whole line', () => {
    for (const bad of ['ingress=mcp', 'ingress=mcp.a', 'ingress=web.a.b', 'ingress=mcp.a b.c', `ingress=mcp.${'a'.repeat(65)}.c`, 'ingress=mcp.a.b.c']) {
      expect(parseAgentAddLine(`agentadd:${REQ}:${NOW}:x:${bad}`, NOW)).toMatchObject({ ok: false, reason: 'malformed' });
    }
    expect(parseAgentAddLine(`agentadd:${REQ}:${NOW}:x:other`, NOW)).toMatchObject({ ok: false, reason: 'malformed' });
  });
  it('the native background parser accepts the same marker', () => {
    const kt = fs.readFileSync(path.join(__dirname, '..', 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/AgentAddHandoff.kt'), 'utf8');
    expect(kt).toContain('Regex("^ingress=mcp\\\\.[A-Za-z0-9_-]{1,64}\\\\.[A-Za-z0-9_-]{1,64}$")');
    expect(kt).toMatch(/raw\.size == 4 && raw\[3\]\.startsWith\("ingress="\)/);
  });
  it('agentctl lines accept the marker too', () => {
    expect(parseAgentCtlLine(`agentctl:${REQ}:${NOW}:confirm:${REQ}:abcdef01:ingress=mcp.${TEST_PRINCIPAL}.c-1`, NOW)).toEqual({
      ctlId: REQ,
      op: 'confirm',
      reqId: REQ,
      hashPrefix: 'abcdef01',
      ingress: MARK,
    });
    expect(parseAgentCtlLine(`agentctl:${REQ}:${NOW}:confirm:${REQ}:abcdef01:ingress=bad`, NOW)).toBeNull();
    expect(parseAgentCtlLine(`agentctl:${REQ}:${NOW}:reject:${REQ}`, NOW)).toEqual({ ctlId: REQ, op: 'reject', reqId: REQ });
  });
});

describe('MCP window detection', () => {
  it('times inside [start, end + grace] count; later ones do not', () => {
    beginMcpExecWindow('w1', TEST_PRINCIPAL, 1000);
    expect(classifyTerminalRequest('r-a', null, [1500])).toEqual({ principal: TEST_PRINCIPAL, callId: 'w1', via: 'window' });
    endMcpExecWindow('w1', 2000);
    expect(classifyTerminalRequest('r-b', null, [2000 + MCP_WINDOW_GRACE_MS])).not.toBeNull();
    expect(classifyTerminalRequest('r-c', null, [2001 + MCP_WINDOW_GRACE_MS])).toBeNull();
    expect(classifyTerminalRequest('r-d', null, [999])).toBeNull();
  });
  it('a marker counts without any window, and is remembered by request id', () => {
    expect(classifyTerminalRequest('r-m', MARK, [0])).toEqual({ principal: TEST_PRINCIPAL, callId: 'c-1', via: 'marker' });
    expect(mcpOriginForRequest('r-m')?.via).toBe('marker');
  });
});

describe('drain records the MCP origin', () => {
  function deps(files: Record<string, string>, extra: Partial<AgentAddDrainDeps> = {}) {
    const results: Record<string, AgentAddResult> = {};
    const ctlResults: Record<string, AgentAddResult> = {};
    const handed: string[] = [];
    const ctls: AgentCtlRequest[] = [];
    const d: AgentAddDrainDeps = {
      isActive: () => true,
      canAcceptPrompt: () => true,
      listHome: async () => Object.keys(files),
      move: async (from, to) => {
        if (!(from in files)) return false;
        files[to] = files[from];
        delete files[from];
        return true;
      },
      read: async (n) => files[n] ?? null,
      remove: async (n) => {
        delete files[n];
      },
      writeResult: async (id, r) => {
        results[id] = r;
      },
      handOff: (_p, id) => {
        handed.push(id);
        return true;
      },
      handleCtl: async (ctl) => {
        ctls.push(ctl);
        return { ok: true, code: 'sent', message: 'ok' };
      },
      writeCtlResult: async (id, r) => {
        ctlResults[id] = r;
      },
      now: () => NOW + 1000,
      ...extra,
    };
    return { d, results, ctlResults, handed, ctls };
  }

  it('a marked request is handed off and remembered as MCP-originated', async () => {
    const files = { [`.shelly-agent-req-${REQ}`]: `${encodeAgentAddLine(REQ, NOW, 'daily news', MARK)}\n` };
    const { d, handed } = deps(files);
    expect(await drainAgentAddRequests(d, createAgentAddDrainState())).toBe(1);
    expect(handed).toEqual([REQ]);
    expect(mcpOriginForRequest(REQ)).toEqual({ principal: TEST_PRINCIPAL, callId: 'c-1', via: 'marker' });
  });

  it('an unmarked request seen during an MCP window is MCP-originated; outside it is not', async () => {
    beginMcpExecWindow('w2', TEST_PRINCIPAL, NOW + 500);
    const files = { [`.shelly-agent-req-${REQ}`]: `${encodeAgentAddLine(REQ, NOW, 'daily news')}\n` };
    const { d } = deps(files);
    await drainAgentAddRequests(d, createAgentAddDrainState());
    expect(mcpOriginForRequest(REQ)?.via).toBe('window');

    __resetMcpIngressOriginForTests();
    const other = `${NOW}-89abcdef`;
    const files2 = { [`.shelly-agent-req-${other}`]: `${encodeAgentAddLine(other, NOW, 'weekly digest')}\n` };
    await drainAgentAddRequests(deps(files2).d, createAgentAddDrainState());
    expect(mcpOriginForRequest(other)).toBeNull();
  });

  it('a control request from MCP carries mcpOrigin into handleCtl', async () => {
    const ctlId = `${NOW}-0badc0de`;
    const files = { [`.shelly-agent-ctl-${ctlId}`]: `agentctl:${ctlId}:${NOW}:confirm:${REQ}:abcdef01:ingress=mcp.${TEST_PRINCIPAL}.c-1\n` };
    const { d, ctls } = deps(files);
    await drainAgentAddRequests(d, createAgentAddDrainState());
    expect(ctls).toHaveLength(1);
    expect(ctls[0].mcpOrigin).toEqual({ principal: TEST_PRINCIPAL, callId: 'c-1', via: 'marker' });
  });
});

// ── Inc 4: terminal confirm refused ───────────────────────────────────────

describe('shelly agent confirm of an MCP-originated request', () => {
  it('is refused when the target request came in through MCP (marker or window), with a logged reason', async () => {
    classifyTerminalRequest(REQ, MARK, []);
    const r = await handleAgentCtl({ ctlId: `${NOW}-11111111`, op: 'confirm', reqId: REQ, hashPrefix: 'abcdef01' });
    expect(r).toMatchObject({ ok: false, code: 'invalid' });
    expect(r.message).toContain('came in through MCP');
    expect(mockLogs.join('\n')).toMatch(/confirm .* refused: the agent request came in through MCP \(via marker\)/);

    __resetMcpIngressOriginForTests();
    beginMcpExecWindow('w3', TEST_PRINCIPAL, NOW);
    classifyTerminalRequest(REQ, null, [NOW + 10]);
    expect((await handleAgentCtl({ ctlId: `${NOW}-22222222`, op: 'confirm', reqId: REQ, hashPrefix: 'abcdef01' })).ok).toBe(false);
  });

  it('is refused when the control request itself came in through MCP', async () => {
    const r = await handleAgentCtl({
      ctlId: `${NOW}-33333333`,
      op: 'confirm',
      reqId: REQ,
      hashPrefix: 'abcdef01',
      mcpOrigin: { principal: TEST_PRINCIPAL, callId: 'c-2', via: 'window' },
    });
    expect(r.ok).toBe(false);
    expect(mockLogs.join('\n')).toMatch(/the control request came in through MCP/);
  });
});

// ── Inc 4: marking on confirm ─────────────────────────────────────────────

describe('markMcpAgentBeforePersist', () => {
  const okStatus = { status: 'ok' as const, overflow: false, entries: [] };

  it('does nothing for a draft with no MCP origin', async () => {
    const mark = jest.fn();
    expect(await markMcpAgentBeforePersist({ origin: null, existingAgentIds: [], mark })).toEqual({ ok: true, marked: false });
    expect(mark).not.toHaveBeenCalled();
  });

  it('marks a pre-chosen id for a new agent, before it exists', async () => {
    const mark = jest.fn(async () => ({ ok: true, status: okStatus }));
    const res = await markMcpAgentBeforePersist({
      origin: { principal: TEST_PRINCIPAL, callId: 'c-1' },
      existingAgentIds: [`agent-${(NOW).toString(36)}`],
      now: NOW,
      mark,
    });
    const expected = `agent-${(NOW + 1).toString(36)}`;
    expect(res).toEqual({ ok: true, marked: true, agentId: expected, presetId: expected });
    expect(mark).toHaveBeenCalledWith(expected, 'mcp', TEST_PRINCIPAL);
  });

  it('marks the edit target', async () => {
    const mark = jest.fn(async () => ({ ok: true, status: okStatus }));
    const res = await markMcpAgentBeforePersist({ origin: { principal: TEST_PRINCIPAL, callId: 'c-1' }, editingAgentId: 'agent-abc', existingAgentIds: [], mark });
    expect(res).toEqual({ ok: true, marked: true, agentId: 'agent-abc' });
    expect(mark).toHaveBeenCalledWith('agent-abc', 'mcp', TEST_PRINCIPAL);
  });

  it('ok:false (or a throw) refuses the registration', async () => {
    const failing = jest.fn(async () => ({ ok: false, status: { status: 'unavailable' as const, overflow: false, entries: [] } }));
    const res = await markMcpAgentBeforePersist({ origin: { principal: TEST_PRINCIPAL, callId: 'c-1' }, existingAgentIds: [], mark: failing });
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ reason: expect.stringContaining('unavailable') });
    const throwing = jest.fn(async () => {
      throw new Error('boom');
    });
    expect((await markMcpAgentBeforePersist({ origin: { principal: TEST_PRINCIPAL, callId: 'c-1' }, existingAgentIds: [], mark: throwing })).ok).toBe(false);
  });

  it('draft origin: the stamp or the remembered request id', () => {
    expect(mcpOriginForDraft({ mcpIngress: { principal: TEST_PRINCIPAL, callId: 'c-1' } })).toEqual({ principal: TEST_PRINCIPAL, callId: 'c-1' });
    expect(mcpOriginForDraft({ mcpIngress: { principal: 'bad value!', callId: 'c-1' } })).toEqual({ principal: 'unknown', callId: 'c-1' });
    expect(mcpOriginForDraft({ terminalRequestId: REQ })).toBeNull();
    classifyTerminalRequest(REQ, MARK, []);
    expect(mcpOriginForDraft({ terminalRequestId: REQ })).toEqual({ principal: TEST_PRINCIPAL, callId: 'c-1' });
    expect(mcpOriginForDraft(null, undefined)).toBeNull();
  });

  it('newAgentIdFor never returns a used id', () => {
    const used = [`agent-${NOW.toString(36)}`, `agent-${(NOW + 1).toString(36)}`];
    expect(newAgentIdFor(used, NOW)).toBe(`agent-${(NOW + 2).toString(36)}`);
  });

  it('the confirm path marks before persisting, refuses on failure and creates under the marked id', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'hooks/use-ai-pane-dispatch.ts'), 'utf8');
    const markAt = src.indexOf('const mcpMark = await markMcpAgentBeforePersist(');
    const persistAt = src.indexOf('const persisted = await persistAgentDraft(');
    expect(markAt).toBeGreaterThan(0);
    expect(markAt).toBeLessThan(persistAt);
    const between = src.slice(markAt, persistAt);
    expect(between).toMatch(/if \('reason' in mcpMark\) \{[\s\S]*?agentCardState: 'cancelled'[\s\S]*?return;\s*\}/);
    expect(src.slice(persistAt, persistAt + 400)).toContain('{ id: mcpMark.presetId }');
    const mgr = fs.readFileSync(path.join(__dirname, '..', 'lib/agent-manager.ts'), 'utf8');
    expect(mgr).toContain("throw new Error('createAgent: the pre-chosen agent id is invalid or already used')");
    expect(mgr).toContain('id: params.id ?? `agent-${Date.now().toString(36)}`');
  });
});

describe('generated shim copies SHELLY_INGRESS into the request line', () => {
  const kt = fs.readFileSync(path.join(__dirname, '..', 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt'), 'utf8');
  it('bumps the shim and BASHRC_VERSION', () => {
    expect(Number(kt.match(/# SHELLY_HELPER_SHIM v(\d+)/)![1])).toBeGreaterThanOrEqual(27);
    expect(Number(kt.match(/private const val BASHRC_VERSION = (\d+)/)![1])).toBeGreaterThanOrEqual(292);
  });
  it('appends the sanitized marker only when SHELLY_INGRESS is set', () => {
    expect(kt).toContain("sb.appendLine(\"    fs.writeFileSync(f + '.tmp', line + agentIngressSuffix() + '\\\\n', { mode: 0o600 });\")");
    expect(kt).toContain("if (!process.env.SHELLY_INGRESS) return '';");
  });
});
