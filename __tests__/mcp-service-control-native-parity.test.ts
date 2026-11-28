/**
 * Background ingress, phase A: service_control and request_pipeline_refire
 * are drained natively (McpTypedOpConsumer + ServiceControlDecision.kt).
 *
 * The ladder fixture (fixtures/mcp-service-control-ladder-cases.json) is the
 * contract between the two implementations: this file drives the REAL RN
 * ladder (lib/mcp-server-bridge.ts serviceControlTool / pipelineRefireTool)
 * with every case and checks the outcome, code, message and first audit line;
 * the JVM test ServiceControlDecisionTest runs the Kotlin decision on the same
 * file. "handoff" on the native side is RN's dialog here (native hands the
 * request to RN only while RN is live, and RN asks).
 *
 * Also: the script routes both ops to typed-requests/, answers RN-only tools
 * at once with `bridge_not_live` when the heartbeat says RN is paused, and RN
 * runs a service_control / request_pipeline_refire from requests/ only with
 * the native consumer's single-use handoff token. Dummy values only.
 */
const mockServiceControl = jest.fn();
const mockRequestPipelineRefire = jest.fn();
jest.mock('expo-file-system/legacy', () => require('./helpers/mcp-typed-ops-harness').fsMock);
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({ __esModule: true, default: {
  ...require('./helpers/mcp-typed-ops-harness').nativeMock.default,
  serviceControl: (...a: unknown[]) => mockServiceControl(...a),
  requestPipelineRefire: (...a: unknown[]) => mockRequestPipelineRefire(...a),
} }));
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
import { __setMCPRequestSha256ForTests, setMCPBridgeKey, startMCPPoller, stopMCPPoller } from '@/lib/mcp-server-bridge';
import {
  SERVICE_CONTROL_ACTIONS, SERVICE_FAILURE_CODES, SERVICE_IDS, SERVICE_RESULT_CODES, SERVICE_STATES,
  serviceControlRuleBind, serviceControlRuleTarget,
} from '@/lib/mcp-service-control';
import {
  PIPELINE_REFIRE_ACCEPT_CODES, PIPELINE_REFIRE_NATIVE_REFUSALS, pipelineRefireRuleBind, pipelineRefireRuleTarget,
} from '@/lib/mcp-pipeline-refire';
import { useMcpApprovalStore } from '@/store/mcp-approval-store';
import { nodeSha256, TEST_BRIDGE_KEY, TEST_PRINCIPAL } from './helpers/mcp-signed-request';
import { callTool, h, resetHarness, waitFor } from './helpers/mcp-typed-ops-harness';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const server = require('../scripts/shelly-mcp-server.js');

type Facts = { exec: boolean; typedOps: boolean; halted: boolean; rule: null | 'current' | 'stale'; approveAll: boolean; rnLive: boolean; ageMs: number };
type Expect =
  | { outcome: 'refuse'; code: string; message: string; audit: [string, boolean] }
  | { outcome: 'execute'; audit: [string, boolean] }
  | { outcome: 'handoff' };
type Case = { name: string; tool: string; args: Record<string, unknown>; facts: Facts; expect: Expect };
type BindCase = { tool: string; args: Record<string, string>; target: string; bind: string };

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mcp-service-control-ladder-cases.json'), 'utf8')) as {
  principal: string; binds: BindCase[]; ladder: Case[];
};
const KT_DIR = path.join(__dirname, '..', 'modules', 'terminal-emulator', 'android', 'src', 'main', 'java', 'expo', 'modules', 'terminalemulator');
const kt = (name: string) => fs.readFileSync(path.join(KT_DIR, name), 'utf8');

const current = () => useMcpApprovalStore.getState().current;

describe('fixture binds (TS side; ServiceControlDecisionTest checks the Kotlin port)', () => {
  it('uses the shared test principal', () => {
    expect(fixture.principal).toBe(TEST_PRINCIPAL);
  });

  it.each(fixture.binds.map((b) => [b.target, b] as const))('%s', async (_t, b) => {
    if (b.tool === 'service_control') {
      const args = b.args as { action: 'start'; serviceId: 'article-delivery' };
      expect(serviceControlRuleTarget(args)).toBe(b.target);
      expect(await serviceControlRuleBind(args, nodeSha256)).toBe(b.bind);
    } else {
      const args = b.args as { pipelineId: string };
      expect(pipelineRefireRuleTarget(args)).toBe(b.target);
      expect(await pipelineRefireRuleBind(args, nodeSha256)).toBe(b.bind);
    }
  });
});

describe('the RN ladder gives the fixture outcome for every case', () => {
  beforeEach(() => {
    resetHarness();
    mockServiceControl.mockReset();
    mockRequestPipelineRefire.mockReset();
    __setMCPRequestSha256ForTests(nodeSha256);
    setMCPBridgeKey(TEST_BRIDGE_KEY);
    startMCPPoller();
  });

  afterEach(() => {
    stopMCPPoller();
    useMcpApprovalStore.getState().denyAll();
    __setMCPRequestSha256ForTests(null);
  });

  it.each(fixture.ladder.map((c) => [c.name, c] as const))('%s', async (_n, c) => {
    const f = c.facts;
    h.settings.mcpExecEnabled = f.exec;
    h.settings.mcpTypedOpsEnabled = f.typedOps;
    h.settings.approveAllWithoutAsking = f.approveAll;
    h.halted = f.halted;
    h.appState.currentState = f.rnLive ? 'active' : 'background';
    const b = fixture.binds.find((x) => x.tool === c.tool && JSON.stringify(x.args) === JSON.stringify(c.args));
    // Unchecked arguments have no target: a rule can never be reached for them.
    if (f.rule !== null && b !== undefined) {
      const bind = f.rule === 'current' ? b!.bind : require('crypto').createHash('sha256').update(`stale:${b!.target}`).digest('hex');
      h.rules.push({ id: 'r_00000000000000c1', principal: TEST_PRINCIPAL, op: c.tool, target: b!.target, bind, label: 'x', createdAt: 1 });
    }
    mockServiceControl.mockImplementation(async (action: string, serviceId: string) => ({
      code: action === 'status' ? 'status' : action === 'start' ? 'started' : 'stopped', serviceId, state: action === 'stop' ? 'stopped' : 'running',
      pid: action === 'stop' ? null : 4242, startedAt: action === 'stop' ? null : 1_764_000_000_000, lastHeartbeatAt: null, supervised: action !== 'stop', exitCode: null, exitedAt: null,
    }));
    mockRequestPipelineRefire.mockResolvedValue({ code: 'accepted', requestId: 'rq-1795555200867-0a1b2c3d' });
    const receivedAt = new Date(Date.now() - f.ageMs).toISOString();
    const pending = callTool(c.tool, c.args, { receivedAt });
    const native = c.tool === 'service_control' ? mockServiceControl : mockRequestPipelineRefire;

    if (c.expect.outcome === 'handoff') {
      await waitFor(() => current() !== null);
      expect(native).not.toHaveBeenCalled();
      useMcpApprovalStore.getState().respond(current()!.id, 'deny');
      expect(await pending).toMatchObject({ ok: false, code: 'denied' });
      return;
    }
    const r = await pending;
    expect(current()).toBeNull();
    const first = h.audits[0]?.json;
    const firstLine = first ? [first.code, 'action' in first || 'pipelineId' in first] : null;
    if (c.expect.outcome === 'refuse') {
      expect(r).toEqual({ ok: false, error: c.expect.message, code: c.expect.code });
      expect(native).not.toHaveBeenCalled();
      expect(firstLine).toEqual(c.expect.audit);
      expect(h.audits).toHaveLength(1);
    } else {
      expect(r?.ok).toBe(true);
      expect(native).toHaveBeenCalledTimes(1);
      expect(firstLine).toEqual(c.expect.audit);
    }
  });
});

describe('the Kotlin decision names the same lists and messages as the TS sources', () => {
  const src = kt('ServiceControlDecision.kt');
  const listOf = (name: string) => {
    const m = new RegExp(`val ${name}: (?:List|Set)<String> = (?:listOf|setOf)\\(([^)]*)\\)`, 's').exec(src);
    expect(m).not.toBeNull();
    return [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  };

  it('lists', () => {
    expect(listOf('ACTIONS')).toEqual([...SERVICE_CONTROL_ACTIONS]);
    expect(listOf('SERVICE_IDS')).toEqual([...SERVICE_IDS]);
    expect(listOf('SERVICE_STATES').sort()).toEqual([...SERVICE_STATES].sort());
    expect(listOf('SERVICE_RESULT_CODES').sort()).toEqual([...SERVICE_RESULT_CODES].sort());
    expect(listOf('SERVICE_FAILURE_CODES').sort()).toEqual([...SERVICE_FAILURE_CODES].sort());
    expect(listOf('REFIRE_ACCEPT_CODES').sort()).toEqual([...PIPELINE_REFIRE_ACCEPT_CODES].sort());
    expect(listOf('REFIRE_NATIVE_REFUSALS').sort()).toEqual([...PIPELINE_REFIRE_NATIVE_REFUSALS].sort());
  });

  it('messages RN uses after the ladder (execute, native errors) appear verbatim in both', () => {
    const bridge = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-server-bridge.ts'), 'utf8');
    for (const m of [
      'cancelled: pending MCP requests were revoked',
      'the request expired before it could run',
      'could not control the service',
      'could not read the service state',
      'could not request the re-run',
      'could not read the re-run request outcome',
      'the always-allow rule no longer applies (removed, or the rules became unreadable); call service_control again',
      'the always-allow rule no longer applies (removed, or the rules became unreadable); call request_pipeline_refire again',
    ]) {
      expect(bridge).toContain(m);
      expect(src).toContain(`"${m}"`);
    }
    expect(src).toContain('"shelly-service-control-bind-v2:"');
    expect(src).toContain('"shelly-pipeline-refire-bind-v1:"');
  });

  it('the exec setting is the server switch AND the Keystore mirror RN writes (missing = off)', () => {
    const consumer = kt('McpTypedOpConsumer.kt');
    expect(consumer).toContain('McpServerSupervisor.execWanted() && (McpAutostartStore.read(app)?.exec == true)');
    const supervisor = kt('McpServerSupervisor.kt');
    expect(supervisor).toContain('private fun consumerWanted(d: Desired): Boolean = d.typedOps || d.exec');
    // RN mirrors mcpExecEnabled with every change and on start (lib/mcp-autostart-mirror.ts).
    const mirror = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-autostart-mirror.ts'), 'utf8');
    expect(mirror).toContain('native.setMCPAutostartMirror(true, state.exec, state.readTerminal, state.diagnostics, state.typedOps, state.token)');
  });
});

describe('RN runs these ops from requests/ only with the native handoff token', () => {
  beforeEach(() => {
    resetHarness();
    h.settings.mcpExecEnabled = true;
    mockServiceControl.mockReset();
    mockRequestPipelineRefire.mockReset();
    __setMCPRequestSha256ForTests(nodeSha256);
    setMCPBridgeKey(TEST_BRIDGE_KEY);
    startMCPPoller();
  });

  afterEach(() => {
    stopMCPPoller();
    useMcpApprovalStore.getState().denyAll();
    __setMCPRequestSha256ForTests(null);
  });

  it.each([
    ['service_control', { action: 'status', serviceId: 'article-delivery' }],
    ['request_pipeline_refire', { pipelineId: 'devja' }],
  ] as const)('%s: no token or a forged one is dropped unanswered; a valid one is asked', async (tool, args) => {
    h.settings.approveAllWithoutAsking = true;
    for (const handoff of ['none', 'forged'] as const) {
      expect(await callTool(tool, args, { handoff })).toBeNull();
    }
    expect(mockServiceControl).not.toHaveBeenCalled();
    expect(mockRequestPipelineRefire).not.toHaveBeenCalled();
    expect(h.logs.filter((l) => l.includes('no valid handoff token'))).toHaveLength(2);
    h.settings.approveAllWithoutAsking = false;
    const pending = callTool(tool, args, { handoff: 'valid' });
    await waitFor(() => current() !== null);
    useMcpApprovalStore.getState().respond(current()!.id, 'deny');
    expect(await pending).toMatchObject({ ok: false, code: 'denied' });
  });
});

describe('script routing', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-svc-route-'));
    for (const d of ['requests', 'typed-requests', 'raw-requests', 'results']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ingress = { principal: TEST_PRINCIPAL, clientNameSelfReported: 'c' };

  it.each([
    ['service_control', { action: 'status', serviceId: 'article-delivery' }],
    ['request_pipeline_refire', { pipelineId: 'devja' }],
  ] as const)('%s goes to typed-requests/ (even with a paused heartbeat) and reads its answer from results/', async (tool, args) => {
    expect(server.requestDirName(tool)).toBe('typed-requests');
    expect(server.TYPED_REQUEST_TOOLS.has(tool)).toBe(true);
    fs.writeFileSync(path.join(dir, 'bridge-heartbeat'), '0');
    const callTool2 = server.createFileQueueCallTool(dir, TEST_BRIDGE_KEY);
    const pending = callTool2(tool, args, ingress);
    const typed = fs.readdirSync(path.join(dir, 'typed-requests')).filter((n: string) => n.endsWith('.json'));
    expect(typed).toHaveLength(1);
    expect(fs.readdirSync(path.join(dir, 'requests'))).toEqual([]);
    const body = JSON.parse(fs.readFileSync(path.join(dir, 'typed-requests', typed[0]), 'utf8'));
    expect(body).toMatchObject({ tool, args, ingress: { kind: 'mcp', principal: TEST_PRINCIPAL } });
    expect(body.mac).toBe(server.requestMac(TEST_BRIDGE_KEY, (({ mac: _m, ...rest }) => rest)(body)));
    const answer = { ok: false, error: 'x', code: 'not_attended' };
    fs.writeFileSync(path.join(dir, 'results', `${body.callId}.json`), JSON.stringify(answer));
    await expect(pending).resolves.toEqual(answer);
  });

  it.each(['0', String(Date.now() - 10_000)])('an RN-only tool is answered bridge_not_live at once when the heartbeat is %s', async (hb) => {
    fs.writeFileSync(path.join(dir, 'bridge-heartbeat'), hb);
    const callTool2 = server.createFileQueueCallTool(dir, TEST_BRIDGE_KEY);
    // No current tool is RN-only (stage_install is native-drained now); a future one gets this.
    for (const tool of ['some_rn_only_tool']) {
      const started = Date.now();
      const r = await callTool2(tool, {}, ingress);
      expect(r).toMatchObject({ ok: false, code: 'bridge_not_live' });
      expect(r.error).toContain(`${tool} cannot be answered right now`);
      expect(Date.now() - started).toBeLessThan(1_000);
    }
    expect(fs.readdirSync(path.join(dir, 'requests'))).toEqual([]);
  });

  it('a live heartbeat (or none yet) still enqueues the RN-only tool', async () => {
    const callTool2 = server.createFileQueueCallTool(dir, TEST_BRIDGE_KEY);
    for (const hb of [String(Date.now()), null]) {
      if (hb === null) fs.rmSync(path.join(dir, 'bridge-heartbeat'), { force: true });
      else fs.writeFileSync(path.join(dir, 'bridge-heartbeat'), hb);
      const pending = callTool2('some_rn_only_tool', {}, ingress);
      const reqs = fs.readdirSync(path.join(dir, 'requests')).filter((n: string) => n.endsWith('.json'));
      expect(reqs).toHaveLength(1);
      fs.writeFileSync(path.join(dir, 'results', reqs[0]), JSON.stringify({ ok: true, data: null }));
      await expect(pending).resolves.toEqual({ ok: true, data: null });
      fs.rmSync(path.join(dir, 'requests', reqs[0]), { force: true });
    }
  });

  it('reads keep their own paused-bridge answer (no code)', async () => {
    fs.writeFileSync(path.join(dir, 'bridge-heartbeat'), '0');
    const callTool2 = server.createFileQueueCallTool(dir, TEST_BRIDGE_KEY);
    const r = await callTool2('read_logs', {}, ingress);
    expect(r.ok).toBe(false);
    expect(r.code).toBeUndefined();
  });

  it('the APK asset is byte-identical to the script', () => {
    const a = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'shelly-mcp-server.js'));
    const b = fs.readFileSync(path.join(__dirname, '..', 'modules', 'terminal-emulator', 'android', 'src', 'main', 'assets', 'shelly-mcp-server.js'));
    expect(a.equals(b)).toBe(true);
  });
});
