const mockServiceControl = jest.fn();
jest.mock('expo-file-system/legacy', () => require('./helpers/mcp-typed-ops-harness').fsMock);
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({ __esModule: true, default: {
  ...require('./helpers/mcp-typed-ops-harness').nativeMock.default,
  serviceControl: (...a: unknown[]) => mockServiceControl(...a),
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
jest.mock('@/lib/i18n', () => ({ t: (k: string, p?: Record<string, string>) => (p ? `${k}:${p.action}:${p.service}` : k), tFor: (_l: string, k: string) => k }));

import {
  __setMCPApprovalTimeoutForTests, __setMCPRequestSha256ForTests, revokePendingMCPRequests, setMCPBridgeKey,
  startMCPPoller, stopMCPPoller,
} from '@/lib/mcp-server-bridge';
import { serviceControlRuleBind } from '@/lib/mcp-service-control';
import { execCommand } from '@/hooks/use-native-exec';
import { useMcpApprovalStore } from '@/store/mcp-approval-store';
import { nodeSha256, TEST_BRIDGE_KEY, TEST_PRINCIPAL } from './helpers/mcp-signed-request';
import { callTool, h, OTHER_PRINCIPAL, resetHarness, waitFor } from './helpers/mcp-typed-ops-harness';

const tool = 'service_control';
const current = () => useMcpApprovalStore.getState().current;
const exec = jest.mocked(execCommand);

const nativeStatus = (over: Record<string, unknown> = {}) => ({
  code: 'status', serviceId: 'article-delivery', state: 'running', pid: 6293,
  startedAt: 1_764_000_000_000, lastHeartbeatAt: 1_764_000_100_000, supervised: true, exitCode: null, exitedAt: null,
  ...over,
});

beforeEach(() => {
  resetHarness();
  h.settings.mcpExecEnabled = true;
  mockServiceControl.mockReset();
  exec.mockClear();
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
    expect(json).toMatchObject({ kind: 'mcp_service_control', event: 'mcp_service_control', principal: TEST_PRINCIPAL });
    return [json.code, json.action ?? null, json.serviceId ?? null];
  });
}

async function approve(args: Record<string, unknown>, decision: 'once' | 'deny' | 'always' = 'once') {
  const pending = callTool(tool, args);
  await waitFor(() => current() !== null);
  expect(current()).toMatchObject({ kind: tool, summary: 'mcp.approval_service_control' });
  expect(current()?.detail).toBe(`mcp.approval_service_control_detail:${args.action}:${args.serviceId}`);
  expect(current()?.alwaysAllowable).toEqual({ op: 'service_control', targetLabel: `${args.action} ${args.serviceId}` });
  expect(mockServiceControl).not.toHaveBeenCalled();
  useMcpApprovalStore.getState().respond(current()!.id, decision);
  return pending;
}

it('refuses when exec/write is disabled', async () => {
  h.settings.mcpExecEnabled = false;
  expect(await callTool(tool, { action: 'status', serviceId: 'article-delivery' })).toMatchObject({ ok: false, code: 'disabled' });
  expect(current()).toBeNull();
  expect(mockServiceControl).not.toHaveBeenCalled();
  expect(audits()).toEqual([['disabled', 'status', 'article-delivery']]);
});

it.each([
  [{ action: 'start' }],
  [{ action: 'restart', serviceId: 'article-delivery' }],
  [{ action: 'start', serviceId: 'article-delivery', command: 'node evil.js' }],
  [{ action: 'start', serviceId: '../../bin/sh' }],
])('refuses %j before asking, and audits no unchecked field', async (args) => {
  expect(await callTool(tool, args)).toMatchObject({ ok: false, code: 'invalid_params' });
  expect(current()).toBeNull();
  expect(mockServiceControl).not.toHaveBeenCalled();
  expect(audits()).toEqual([['invalid_params', null, null]]);
});

it('refuses a start under STOP-ALL without asking', async () => {
  h.halted = true;
  expect(await callTool(tool, { action: 'start', serviceId: 'article-delivery' })).toMatchObject({ ok: false, code: 'halted' });
  expect(current()).toBeNull();
  expect(mockServiceControl).not.toHaveBeenCalled();
  expect(audits()).toEqual([['halted', 'start', 'article-delivery']]);
});

it('still lets status and stop through under STOP-ALL (after the tap)', async () => {
  h.halted = true;
  mockServiceControl.mockResolvedValueOnce(nativeStatus({ code: 'not_running', state: 'stopped', pid: null, startedAt: null, supervised: false }));
  expect(await approve({ action: 'stop', serviceId: 'article-delivery' })).toMatchObject({ ok: true, data: { code: 'not_running', state: 'stopped' } });
  expect(mockServiceControl).toHaveBeenCalledWith('stop', 'article-delivery', TEST_PRINCIPAL);
});

it('honors a denial without calling native', async () => {
  expect(await approve({ action: 'start', serviceId: 'article-delivery' }, 'deny')).toMatchObject({ ok: false, code: 'denied' });
  expect(mockServiceControl).not.toHaveBeenCalled();
  expect(audits()).toEqual([['approval_requested', 'start', 'article-delivery'], ['denied', 'start', 'article-delivery']]);
});

it('drops an expired request without asking', async () => {
  expect(await callTool(tool, { action: 'start', serviceId: 'article-delivery' }, { receivedAt: new Date(Date.now() - 101_000).toISOString() }))
    .toMatchObject({ ok: false, code: 'timeout' });
  expect(current()).toBeNull();
  expect(mockServiceControl).not.toHaveBeenCalled();
});

it('revokes during approval without calling native', async () => {
  const pending = callTool(tool, { action: 'start', serviceId: 'article-delivery' });
  await waitFor(() => current() !== null);
  await revokePendingMCPRequests();
  expect(await pending).toBeNull();
  expect(mockServiceControl).not.toHaveBeenCalled();
});

it('returns status after the tap and audits it', async () => {
  mockServiceControl.mockResolvedValueOnce(nativeStatus());
  expect(await approve({ action: 'status', serviceId: 'article-delivery' })).toEqual({
    ok: true,
    data: {
      action: 'status', code: 'status', serviceId: 'article-delivery', state: 'running', pid: 6293,
      startedAt: 1_764_000_000_000, lastHeartbeatAt: 1_764_000_100_000, supervised: true,
    },
  });
  expect(mockServiceControl).toHaveBeenCalledWith('status', 'article-delivery', TEST_PRINCIPAL);
  expect(audits()).toEqual([['approval_requested', 'status', 'article-delivery'], ['status', 'status', 'article-delivery']]);
});

it('reports a dead service through status', async () => {
  mockServiceControl.mockResolvedValueOnce(nativeStatus({ state: 'dead', pid: null, supervised: false, exitCode: 137, exitedAt: 1_764_000_300_000 }));
  expect(await approve({ action: 'status', serviceId: 'article-delivery' })).toMatchObject({
    ok: true, data: { state: 'dead', pid: null, exitCode: 137, exitedAt: 1_764_000_300_000 },
  });
});

it('leaves the start outcome line to native', async () => {
  mockServiceControl.mockResolvedValueOnce(nativeStatus({ code: 'started', state: 'starting', lastHeartbeatAt: null }));
  expect(await approve({ action: 'start', serviceId: 'article-delivery' })).toMatchObject({ ok: true, data: { code: 'started', state: 'starting' } });
  expect(audits()).toEqual([['approval_requested', 'start', 'article-delivery']]);
  expect(exec).not.toHaveBeenCalled();
});

it('returns already_running as success (idempotent start)', async () => {
  mockServiceControl.mockResolvedValueOnce(nativeStatus({ code: 'already_running', supervised: false }));
  expect(await approve({ action: 'start', serviceId: 'article-delivery' })).toMatchObject({ ok: true, data: { code: 'already_running', pid: 6293 } });
});

it('returns a native failure as an error that carries the status', async () => {
  mockServiceControl.mockResolvedValueOnce(nativeStatus({ code: 'launch_failed', state: 'dead', pid: null, exitCode: 127 }));
  const r = await approve({ action: 'start', serviceId: 'article-delivery' });
  expect(r).toMatchObject({ ok: false, code: 'launch_failed' });
  expect((r as { error: string }).error).toContain('"state":"dead"');
});

it('answers not_configured for the shape-only facade entry', async () => {
  mockServiceControl.mockResolvedValueOnce(nativeStatus({ code: 'not_configured', serviceId: 'council-facade', state: 'not_configured', pid: null, startedAt: null, lastHeartbeatAt: null, supervised: false }));
  expect(await approve({ action: 'start', serviceId: 'council-facade' })).toMatchObject({ ok: false, code: 'not_configured' });
});

it('refuses a malformed native answer', async () => {
  mockServiceControl.mockResolvedValueOnce(nativeStatus({ serviceId: 'council-facade' }));
  expect(await approve({ action: 'status', serviceId: 'article-delivery' })).toMatchObject({ ok: false, code: 'native_error' });
  expect(audits().at(-1)).toEqual(['native_error', 'status', 'article-delivery']);
});

it('maps a native exception to native_error', async () => {
  mockServiceControl.mockRejectedValueOnce(new Error('boom'));
  expect(await approve({ action: 'stop', serviceId: 'article-delivery' })).toMatchObject({ ok: false, code: 'native_error' });
});

// ── S2: the approval ladder (rule → switch → not_attended → dialog) ─────────

const START = { action: 'start', serviceId: 'article-delivery' } as const;
const START_TARGET = 'service:article-delivery:start';

type Args = { action: 'start' | 'status' | 'stop'; serviceId: 'article-delivery' | 'council-facade' };
const bindFor = (args: Args) => serviceControlRuleBind(args, nodeSha256);

async function addRule(over: Record<string, unknown> = {}) {
  const rule = {
    id: 'r_00000000000000a1', principal: TEST_PRINCIPAL, op: 'service_control', target: START_TARGET,
    bind: await bindFor(START), label: 'start article-delivery', createdAt: 1, ...over,
  };
  h.rules.push(rule as never);
  return rule;
}

const started = () => nativeStatus({ code: 'started', state: 'starting', lastHeartbeatAt: null });

describe('approval ladder', () => {
  it('a matching always-allow rule runs without a dialog', async () => {
    await addRule();
    mockServiceControl.mockResolvedValueOnce(started());
    expect(await callTool(tool, START)).toMatchObject({ ok: true, data: { code: 'started' } });
    expect(current()).toBeNull();
    expect(mockServiceControl).toHaveBeenCalledWith('start', 'article-delivery', TEST_PRINCIPAL);
    expect(audits()).toEqual([['always_allowed', 'start', 'article-delivery']]);
    expect(h.logs.some((l) => l.includes(`always-allow rule r_00000000000000a1 matched service_control ${START_TARGET}`))).toBe(true);
  });

  it('a rule works in the background too (nobody needs to tap)', async () => {
    await addRule();
    h.appState.currentState = 'background';
    mockServiceControl.mockResolvedValueOnce(started());
    expect(await callTool(tool, START)).toMatchObject({ ok: true });
    expect(current()).toBeNull();
  });

  it('a rule names one service and one action: a status rule never covers start', async () => {
    await addRule({ target: 'service:article-delivery:status', bind: await bindFor({ action: 'status', serviceId: 'article-delivery' }) });
    const pending = callTool(tool, START);
    await waitFor(() => current() !== null);
    expect(mockServiceControl).not.toHaveBeenCalled();
    useMcpApprovalStore.getState().respond(current()!.id, 'deny');
    expect(await pending).toMatchObject({ ok: false, code: 'denied' });
  });

  it('a rule of another client or with another binding does not match', async () => {
    await addRule({ principal: OTHER_PRINCIPAL });
    await addRule({ id: 'r_00000000000000a2', bind: 'f'.repeat(64) });
    const pending = callTool(tool, START);
    await waitFor(() => current() !== null);
    useMcpApprovalStore.getState().respond(current()!.id, 'deny');
    expect(await pending).toMatchObject({ ok: false, code: 'denied' });
    expect(mockServiceControl).not.toHaveBeenCalled();
  });

  it('a rule removed between the match and the native call does not run the action', async () => {
    await addRule();
    // The 2nd native match is the execution-time re-check: the rule is revoked
    // right then (the match itself still answers true; the listing then fails).
    let n = 0;
    h.onMatch = () => {
      n += 1;
      if (n === 2) h.rules = [];
    };
    expect(await callTool(tool, START)).toMatchObject({ ok: false, code: 'target_changed' });
    expect(mockServiceControl).not.toHaveBeenCalled();
    expect(audits()).toEqual([['always_allowed', 'start', 'article-delivery'], ['target_changed', 'start', 'article-delivery']]);
  });

  it('approveAllWithoutAsking answers once without a dialog and writes no rule', async () => {
    h.settings.approveAllWithoutAsking = true;
    h.appState.currentState = 'background';
    mockServiceControl.mockResolvedValueOnce(nativeStatus());
    expect(await callTool(tool, { action: 'status', serviceId: 'article-delivery' })).toMatchObject({ ok: true, data: { code: 'status' } });
    expect(current()).toBeNull();
    expect(h.rules).toEqual([]);
    expect(h.addCalls).toBe(0);
    expect(audits()).toEqual([['auto_approved', 'status', 'article-delivery'], ['status', 'status', 'article-delivery']]);
    expect(h.logs.some((l) => l.includes('auto-approved once (approveAllWithoutAsking'))).toBe(true);
  });

  it('in the background with no rule and the switch off: not_attended at once, no dialog queued', async () => {
    h.appState.currentState = 'background';
    expect(await callTool(tool, START)).toMatchObject({ ok: false, code: 'not_attended' });
    expect(current()).toBeNull();
    expect(useMcpApprovalStore.getState().queue).toEqual([]);
    expect(mockServiceControl).not.toHaveBeenCalled();
    expect(audits()).toEqual([['not_attended', 'start', 'article-delivery']]);
  });

  it('"always allow" on the dialog saves a rule; the next call runs without a dialog', async () => {
    mockServiceControl.mockResolvedValue(started());
    expect(await approve(START, 'always')).toMatchObject({ ok: true, data: { code: 'started' } });
    expect(h.rules).toHaveLength(1);
    expect(h.rules[0]).toMatchObject({
      principal: TEST_PRINCIPAL, op: 'service_control', target: START_TARGET, bind: await bindFor(START), label: 'start article-delivery',
    });
    expect(h.rules[0].actionPolicyPin).toBeUndefined();
    expect(audits()).toEqual([['approval_requested', 'start', 'article-delivery'], ['always_allow_saved', 'start', 'article-delivery']]);

    h.audits = [];
    expect(await callTool(tool, START)).toMatchObject({ ok: true });
    expect(current()).toBeNull();
    expect(mockServiceControl).toHaveBeenCalledTimes(2);
    expect(audits()).toEqual([['always_allowed', 'start', 'article-delivery']]);
  });

  it('a rule that cannot be saved runs once and shows a toast', async () => {
    h.addAnswer = { ok: false, code: 'full' };
    mockServiceControl.mockResolvedValueOnce(nativeStatus({ code: 'stopped', state: 'stopped', pid: null, supervised: false }));
    expect(await approve({ action: 'stop', serviceId: 'article-delivery' }, 'always')).toMatchObject({ ok: true, data: { code: 'stopped' } });
    expect(h.rules).toEqual([]);
    expect(h.toasts).toEqual(['mcp.always_allow_not_saved_service']);
    expect(audits()).toEqual([['approval_requested', 'stop', 'article-delivery'], ['always_allow_not_saved', 'stop', 'article-delivery']]);
  });

  it('a dialog timeout keeps the existing denied code and wording', async () => {
    __setMCPApprovalTimeoutForTests(30);
    try {
      expect(await callTool(tool, START)).toMatchObject({ ok: false, code: 'denied', error: 'denied by user (or timed out waiting for a response)' });
      expect(mockServiceControl).not.toHaveBeenCalled();
    } finally {
      __setMCPApprovalTimeoutForTests(null);
    }
  });

  it('STOP-ALL refuses a start even with a matching rule and the switch on', async () => {
    await addRule();
    h.settings.approveAllWithoutAsking = true;
    h.halted = true;
    expect(await callTool(tool, START)).toMatchObject({ ok: false, code: 'halted' });
    expect(current()).toBeNull();
    expect(mockServiceControl).not.toHaveBeenCalled();
    expect(audits()).toEqual([['halted', 'start', 'article-delivery']]);
  });

  it('STOP-ALL turned on after the rule matched still refuses before the native call', async () => {
    await addRule();
    h.onMatch = () => {
      h.halted = true;
    };
    expect(await callTool(tool, START)).toMatchObject({ ok: false, code: 'halted' });
    expect(mockServiceControl).not.toHaveBeenCalled();
    expect(audits()).toEqual([['always_allowed', 'start', 'article-delivery'], ['halted', 'start', 'article-delivery']]);
  });

  it('STOP-ALL turned on while the switch answers still refuses before the native call', async () => {
    h.settings.approveAllWithoutAsking = true;
    const getSwitch = jest.spyOn(require('@/modules/terminal-emulator/src/TerminalEmulatorModule').default, 'getApproveAllWithoutAsking')
      .mockImplementation(async () => {
        h.halted = true;
        return true;
      });
    try {
      expect(await callTool(tool, START)).toMatchObject({ ok: false, code: 'halted' });
      expect(mockServiceControl).not.toHaveBeenCalled();
      expect(audits()).toEqual([['auto_approved', 'start', 'article-delivery'], ['halted', 'start', 'article-delivery']]);
    } finally {
      getSwitch.mockRestore();
    }
  });

  // The execution-time rule re-check awaits native twice (match, then list):
  // STOP-ALL / the exec setting flipped during either await must still stop
  // the call, so both re-checks sit after the re-match, right before native.
  it.each(['match', 'list'] as const)('STOP-ALL turned on during the execution-time rule re-check (%s) refuses before the native call', async (during) => {
    await addRule();
    const native = require('@/modules/terminal-emulator/src/TerminalEmulatorModule').default;
    let matches = 0;
    let lists = 0;
    h.onMatch = () => {
      matches += 1;
      if (during === 'match' && matches === 2) h.halted = true;
    };
    const realList = native.mcpAlwaysAllowList;
    const list = jest.spyOn(native, 'mcpAlwaysAllowList').mockImplementation(async () => {
      lists += 1;
      const out = await realList();
      if (during === 'list' && lists === 2) h.halted = true;
      return out;
    });
    try {
      expect(await callTool(tool, START)).toMatchObject({ ok: false, code: 'halted' });
      expect(matches).toBe(2);
      expect(lists).toBe(2);
      expect(mockServiceControl).not.toHaveBeenCalled();
      expect(audits()).toEqual([['always_allowed', 'start', 'article-delivery'], ['halted', 'start', 'article-delivery']]);
    } finally {
      list.mockRestore();
    }
  });

  it.each(['match', 'list'] as const)('exec turned off during the execution-time rule re-check (%s) is refused as disabled', async (during) => {
    await addRule();
    const native = require('@/modules/terminal-emulator/src/TerminalEmulatorModule').default;
    let matches = 0;
    let lists = 0;
    h.onMatch = () => {
      matches += 1;
      if (during === 'match' && matches === 2) h.settings.mcpExecEnabled = false;
    };
    const realList = native.mcpAlwaysAllowList;
    const list = jest.spyOn(native, 'mcpAlwaysAllowList').mockImplementation(async () => {
      lists += 1;
      const out = await realList();
      if (during === 'list' && lists === 2) h.settings.mcpExecEnabled = false;
      return out;
    });
    try {
      expect(await callTool(tool, START)).toMatchObject({ ok: false, code: 'disabled' });
      expect(mockServiceControl).not.toHaveBeenCalled();
      expect(audits()).toEqual([['always_allowed', 'start', 'article-delivery'], ['disabled', 'start', 'article-delivery']]);
    } finally {
      list.mockRestore();
    }
  });

  it('Shelly going to the background while the approval request is audited: not_attended, no dialog queued', async () => {
    const native = require('@/modules/terminal-emulator/src/TerminalEmulatorModule').default;
    const realAudit = native.appendMcpIngressAudit;
    const audit = jest.spyOn(native, 'appendMcpIngressAudit').mockImplementation(async (agentId: unknown, json: unknown) => {
      const ok = await realAudit(agentId, json);
      if (JSON.parse(json as string).code === 'approval_requested') h.appState.currentState = 'background';
      return ok;
    });
    try {
      expect(await callTool(tool, START)).toMatchObject({ ok: false, code: 'not_attended' });
      expect(current()).toBeNull();
      expect(useMcpApprovalStore.getState().queue).toEqual([]);
      expect(mockServiceControl).not.toHaveBeenCalled();
      expect(audits()).toEqual([['approval_requested', 'start', 'article-delivery'], ['not_attended', 'start', 'article-delivery']]);
    } finally {
      audit.mockRestore();
    }
  });

  it('the refusal classes come first: exec off is refused even with a rule and the switch on', async () => {
    await addRule();
    h.settings.approveAllWithoutAsking = true;
    h.settings.mcpExecEnabled = false;
    expect(await callTool(tool, START)).toMatchObject({ ok: false, code: 'disabled' });
    expect(mockServiceControl).not.toHaveBeenCalled();
    expect(audits()).toEqual([['disabled', 'start', 'article-delivery']]);
  });
});
