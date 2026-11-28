const mockRequestPipelineRefire = jest.fn();
jest.mock('expo-file-system/legacy', () => require('./helpers/mcp-typed-ops-harness').fsMock);
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({ __esModule: true, default: {
  ...require('./helpers/mcp-typed-ops-harness').nativeMock.default,
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
jest.mock('@/lib/i18n', () => ({ t: (k: string, p?: Record<string, string>) => (p ? `${k}:${p.pipeline}` : k), tFor: (_l: string, k: string) => k }));

import * as fs from 'fs';
import * as path from 'path';
import {
  __setMCPRequestSha256ForTests, revokePendingMCPRequests, setMCPBridgeKey, startMCPPoller, stopMCPPoller,
} from '@/lib/mcp-server-bridge';
import {
  parsePipelineRefireResult, PIPELINE_REFIRE_TARGET_RE, pipelineRefireRuleBind, validatePipelineRefireArgs,
} from '@/lib/mcp-pipeline-refire';
import { isValidAlwaysAllowTarget, normalizeTarget } from '@/lib/mcp-always-allow';
import { useMcpApprovalStore } from '@/store/mcp-approval-store';
import { nodeSha256, TEST_BRIDGE_KEY, TEST_PRINCIPAL } from './helpers/mcp-signed-request';
import { callTool, h, OTHER_PRINCIPAL, resetHarness, waitFor } from './helpers/mcp-typed-ops-harness';

// Search parity item 4: MCP request_pipeline_refire (lib/mcp-pipeline-refire.ts,
// lib/mcp-server-bridge.ts pipelineRefireTool). The caller names a pipeline id
// only; native (TerminalEmulatorModule.requestPipelineRefire → RunRecovery)
// decides on STOP-ALL, the opt-in and today's run on every call.

const tool = 'request_pipeline_refire';
const ARGS = { pipelineId: 'devja' } as const;
const TARGET = 'pipeline:devja';
const REQUEST_ID = 'rq-1795555200867-0a1b2c3d';
const current = () => useMcpApprovalStore.getState().current;
const accepted = (over: Record<string, unknown> = {}) => ({ code: 'accepted', requestId: REQUEST_ID, ...over });

beforeEach(() => {
  resetHarness();
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

function audits() {
  return h.audits.map(({ agentId, json }) => {
    expect(agentId).toBeNull();
    expect(json).toMatchObject({ kind: 'mcp_pipeline_refire', event: 'mcp_pipeline_refire', principal: TEST_PRINCIPAL });
    return [json.code, json.pipelineId ?? null, json.requestId ?? null];
  });
}

async function approve(decision: 'once' | 'deny' | 'always' = 'once') {
  const pending = callTool(tool, ARGS);
  await waitFor(() => current() !== null);
  expect(current()).toMatchObject({ kind: tool, summary: 'mcp.approval_pipeline_refire' });
  expect(current()?.detail).toBe('mcp.approval_pipeline_refire_detail:devja');
  expect(current()?.alwaysAllowable).toEqual({ op: tool, targetLabel: 're-run devja' });
  expect(mockRequestPipelineRefire).not.toHaveBeenCalled();
  useMcpApprovalStore.getState().respond(current()!.id, decision);
  return pending;
}

const bind = () => pipelineRefireRuleBind(ARGS, nodeSha256);
async function addRule(over: Record<string, unknown> = {}) {
  const rule = { id: 'r_00000000000000b1', principal: TEST_PRINCIPAL, op: tool, target: TARGET, bind: await bind(), label: 're-run devja', createdAt: 1, ...over };
  h.rules.push(rule as never);
  return rule;
}

describe('arguments: the pipeline id only (strict)', () => {
  it.each([
    [{}],
    [{ pipelineId: 'devja', prompt: 'write about X instead' }],
    [{ pipelineId: 'devja', topic: 'X' }],
    [{ pipelineId: 'devja', at: '2026-11-25T09:00:00Z' }],
    [{ pipelineId: 'Dev JA' }],
    [{ pipelineId: '../devja' }],
    [{ pipelineId: 'x'.repeat(33) }],
    [{ pipelineId: 42 }],
    [{ agentId: 'agent-devja01' }],
  ])('refuses %j before asking, and audits no unchecked field', async (args) => {
    expect(await callTool(tool, args)).toMatchObject({ ok: false, code: 'invalid_params' });
    expect(current()).toBeNull();
    expect(mockRequestPipelineRefire).not.toHaveBeenCalled();
    expect(audits()).toEqual([['invalid_params', null, null]]);
  });

  it('validatePipelineRefireArgs is strict and normalizeTarget names one pipeline', () => {
    expect(validatePipelineRefireArgs({ pipelineId: 'devja' })).toEqual({ ok: true, args: { pipelineId: 'devja' } });
    expect(validatePipelineRefireArgs({ pipelineId: 'devja', note: '' })).toMatchObject({ ok: false, code: 'invalid_params' });
    expect(validatePipelineRefireArgs(['devja'])).toMatchObject({ ok: false });
    expect(normalizeTarget(tool, ARGS)).toBe(TARGET);
    expect(normalizeTarget(tool, { pipelineId: 'devja', extra: 1 })).toBeNull();
    expect(isValidAlwaysAllowTarget(tool, TARGET)).toBe(true);
    expect(isValidAlwaysAllowTarget(tool, 'agent:devja')).toBe(false);
  });
});

describe('refusals before asking', () => {
  it('refuses when typed operations are off (exec/write does not list or allow it)', async () => {
    h.settings.mcpTypedOpsEnabled = false;
    h.settings.mcpExecEnabled = true;
    expect(await callTool(tool, ARGS)).toMatchObject({ ok: false, code: 'disabled' });
    expect(current()).toBeNull();
    expect(mockRequestPipelineRefire).not.toHaveBeenCalled();
    expect(audits()).toEqual([['disabled', 'devja', null]]);
  });

  it('refuses under STOP-ALL without asking, even with a rule', async () => {
    await addRule();
    h.halted = true;
    expect(await callTool(tool, ARGS)).toMatchObject({ ok: false, code: 'halted' });
    expect(current()).toBeNull();
    expect(mockRequestPipelineRefire).not.toHaveBeenCalled();
    expect(audits()).toEqual([['halted', 'devja', null]]);
  });

  it('drops an expired request without asking', async () => {
    expect(await callTool(tool, ARGS, { receivedAt: new Date(Date.now() - 101_000).toISOString() })).toMatchObject({ ok: false, code: 'timeout' });
    expect(current()).toBeNull();
    expect(mockRequestPipelineRefire).not.toHaveBeenCalled();
  });
});

describe('after the tap', () => {
  it('asks native, returns the request id, and audits the acceptance', async () => {
    mockRequestPipelineRefire.mockResolvedValueOnce(accepted());
    expect(await approve()).toEqual({ ok: true, data: { pipelineId: 'devja', code: 'accepted', requestId: REQUEST_ID } });
    expect(mockRequestPipelineRefire).toHaveBeenCalledWith('devja', TEST_PRINCIPAL);
    expect(audits()).toEqual([['approval_requested', 'devja', null], ['accepted', 'devja', REQUEST_ID]]);
  });

  it('a duplicate is a success (one re-fire), with the earlier request id', async () => {
    mockRequestPipelineRefire.mockResolvedValueOnce({ code: 'duplicate', requestId: REQUEST_ID });
    expect(await approve()).toMatchObject({ ok: true, data: { code: 'duplicate', requestId: REQUEST_ID } });
  });

  it.each(['not_opted_in', 'unknown_pipeline', 'no_run_today', 'run_active', 'delivered', 'not_recoverable', 'daily_limit', 'halted'])(
    'passes native\'s refusal %s on as an error code, audited',
    async (code) => {
      mockRequestPipelineRefire.mockResolvedValueOnce({ code, requestId: null });
      expect(await approve()).toMatchObject({ ok: false, code });
      expect(audits().at(-1)).toEqual([code, 'devja', null]);
    },
  );

  it('refuses an unknown or malformed native answer', async () => {
    for (const raw of [{ code: 'started' }, { code: 'accepted', requestId: 'free text' }, null, 'accepted']) {
      expect(parsePipelineRefireResult(raw)).toBeNull();
    }
    mockRequestPipelineRefire.mockResolvedValueOnce({ code: 'launched' });
    expect(await approve()).toMatchObject({ ok: false, code: 'native_error' });
  });

  it('maps a native exception to native_error', async () => {
    mockRequestPipelineRefire.mockRejectedValueOnce(new Error('boom'));
    expect(await approve()).toMatchObject({ ok: false, code: 'native_error' });
  });

  it('honors a denial and a revoke without calling native', async () => {
    expect(await approve('deny')).toMatchObject({ ok: false, code: 'denied' });
    const pending = callTool(tool, ARGS);
    await waitFor(() => current() !== null);
    await revokePendingMCPRequests();
    expect(await pending).toBeNull();
    expect(mockRequestPipelineRefire).not.toHaveBeenCalled();
  });
});

describe('approval ladder (as service_control)', () => {
  it('a matching always-allow rule runs without a dialog, in the background too; native still decides', async () => {
    await addRule();
    h.appState.currentState = 'background';
    mockRequestPipelineRefire.mockResolvedValueOnce({ code: 'daily_limit', requestId: null });
    // The rule skips only the tap: native's refusal stands.
    expect(await callTool(tool, ARGS)).toMatchObject({ ok: false, code: 'daily_limit' });
    expect(current()).toBeNull();
    expect(audits()).toEqual([['always_allowed', 'devja', null], ['daily_limit', 'devja', null]]);
  });

  it('a rule names one pipeline: another pipeline\'s rule or another client\'s does not match', async () => {
    await addRule({ target: 'pipeline:vintage-ja', bind: await pipelineRefireRuleBind({ pipelineId: 'vintage-ja' }, nodeSha256) });
    await addRule({ id: 'r_00000000000000b2', principal: OTHER_PRINCIPAL });
    h.appState.currentState = 'background';
    expect(await callTool(tool, ARGS)).toMatchObject({ ok: false, code: 'not_attended' });
    expect(mockRequestPipelineRefire).not.toHaveBeenCalled();
  });

  it('"always allow" saves a rule bound to this pipeline; the next call runs without a dialog', async () => {
    mockRequestPipelineRefire.mockResolvedValue(accepted());
    expect(await approve('always')).toMatchObject({ ok: true });
    expect(h.rules[0]).toMatchObject({ principal: TEST_PRINCIPAL, op: tool, target: TARGET, bind: await bind(), label: 're-run devja' });
    h.audits = [];
    expect(await callTool(tool, ARGS)).toMatchObject({ ok: true });
    expect(current()).toBeNull();
    expect(audits()).toEqual([['always_allowed', 'devja', null], ['accepted', 'devja', REQUEST_ID]]);
  });

  it('a rule that cannot be saved runs once and shows a toast', async () => {
    h.addAnswer = { ok: false, code: 'full' };
    mockRequestPipelineRefire.mockResolvedValueOnce(accepted());
    expect(await approve('always')).toMatchObject({ ok: true });
    expect(h.toasts).toEqual(['mcp.always_allow_not_saved_refire']);
  });

  it('approveAllWithoutAsking answers once without a dialog and writes no rule', async () => {
    h.settings.approveAllWithoutAsking = true;
    h.appState.currentState = 'background';
    mockRequestPipelineRefire.mockResolvedValueOnce(accepted());
    expect(await callTool(tool, ARGS)).toMatchObject({ ok: true });
    expect(h.rules).toEqual([]);
    expect(audits()).toEqual([['auto_approved', 'devja', null], ['accepted', 'devja', REQUEST_ID]]);
  });

  it('STOP-ALL turned on after the rule matched still stops it before native', async () => {
    await addRule();
    h.onMatch = () => {
      h.halted = true;
    };
    expect(await callTool(tool, ARGS)).toMatchObject({ ok: false, code: 'halted' });
    expect(mockRequestPipelineRefire).not.toHaveBeenCalled();
  });

  it('in the background with no rule and the switch off: not_attended at once', async () => {
    h.appState.currentState = 'background';
    expect(await callTool(tool, ARGS)).toMatchObject({ ok: false, code: 'not_attended' });
    expect(useMcpApprovalStore.getState().queue).toEqual([]);
    expect(audits()).toEqual([['not_attended', 'devja', null]]);
  });
});

describe('native source contract', () => {
  const dir = path.join(__dirname, '../modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator');
  const read = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n');

  it('the always-allow target pattern is the same on both sides', () => {
    const store = read('McpAlwaysAllowStore.kt');
    expect(store).toContain(`"request_pipeline_refire" to Regex("${PIPELINE_REFIRE_TARGET_RE.source}")`);
  });

  it('the module checks STOP-ALL, then the opt-in (read only), then asks the recovery script', () => {
    // The module and the headless typed-op drain both run McpPipelineRefire.request.
    const module = read('TerminalEmulatorModule.kt');
    const fn = module.slice(module.indexOf('AsyncFunction("requestPipelineRefire") Coroutine'));
    expect(fn.slice(0, fn.indexOf('\n        }\n'))).toContain('McpPipelineRefire.request(requireReactContext(), pipelineId, principal)');
    const shared = read('McpPipelineRefire.kt');
    const body = shared.slice(shared.indexOf('fun request('));
    const halted = body.indexOf('StopAllSwitches.halted(context)');
    const optIn = body.indexOf('WebSearchOptInStore.optedInAgentForPipeline(');
    const script = body.indexOf('RunRecovery.requestRefire(');
    expect(halted).toBeGreaterThan(0);
    expect(optIn).toBeGreaterThan(halted);
    expect(script).toBeGreaterThan(optIn);
    // Read only: the refire path never turns an opt-in on or off.
    expect(body).not.toMatch(/setFromSettings|enable\(|disable\(/);
    const store = read('WebSearchOptInStore.kt');
    const helper = store.slice(store.indexOf('fun optedInAgentForPipeline('), store.indexOf('fun setFromSettings('));
    expect(helper).toContain('stateOf(entry, c) == "on"');
    expect(helper).not.toMatch(/audit\(|write\(|enable\(/);
  });

  it('the audit line keeps closed fields only', () => {
    const writer = read('IngressAuditWriter.kt');
    expect(writer).toContain('setOf("kind", "event", "principal", "pipelineId", "code", "requestId").containsAll(keys)');
    expect(writer).toContain('json.contains("\\"$PIPELINE_REFIRE_KIND\\"")) buildPipelineRefireLineFromJson(now, json)');
  });
});
