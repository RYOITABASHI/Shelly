/**
 * run_agent / get_run_result through the real RN bridge with signed request
 * files (plan "typed MCP operations", PR 5): the "always allow" tap writes
 * exactly one rule and launches exactly once; a timeout racing a tap launches
 * nothing and writes nothing; a token revoke (denyAll) during the dialog
 * writes no rule; a repeated requestId returns the same handle with one
 * launch; the per-client busy limit; get_run_result principal scoping,
 * long-poll, output truncation + redaction; live tickets cancelled on revoke.
 *
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

import {
  __setMCPApprovalTimeoutForTests,
  __setMCPRandomBytesForTests,
  __setMCPRequestSha256ForTests,
  revokePendingMCPRequests,
  setMCPBridgeKey,
  startMCPPoller,
  stopMCPPoller,
} from '@/lib/mcp-server-bridge';
import { __forgetMcpCallIdsOnlyForTests, __resetMcpSeenCallIdsForTests, mcpHandoffToken, verifyMcpRequest } from '@/lib/mcp-request-auth';
import { useMcpApprovalStore } from '@/store/mcp-approval-store';
import { TEST_BRIDGE_KEY, TEST_PRINCIPAL, nodeSha256, signedRequest } from './helpers/mcp-signed-request';
import { addAgent, callTool, h, HANDOFFS, OTHER_PRINCIPAL, REQUESTS, RESULTS, resetHarness, waitFor } from './helpers/mcp-typed-ops-harness';

// Each poller round trip takes ~0.5 s; leave headroom when suites run in parallel.
jest.setTimeout(30_000);

let counter = 0;

beforeAll(() => {
  __setMCPRequestSha256ForTests(nodeSha256);
  __setMCPRandomBytesForTests((n) => {
    counter += 1;
    const b = new Uint8Array(n);
    b[n - 1] = counter & 0xff;
    b[n - 2] = (counter >> 8) & 0xff;
    return b;
  });
});
afterAll(() => {
  __setMCPRandomBytesForTests(null);
  __setMCPRequestSha256ForTests(null);
  __setMCPApprovalTimeoutForTests(null);
});
beforeEach(() => {
  resetHarness();
  setMCPBridgeKey(TEST_BRIDGE_KEY);
  __resetMcpSeenCallIdsForTests();
  __setMCPApprovalTimeoutForTests(null);
  useMcpApprovalStore.setState({ current: null, queue: [] });
  startMCPPoller();
});
afterEach(() => {
  stopMCPPoller();
  useMcpApprovalStore.getState().denyAll();
});

/** Starts a call that will wait on the dialog; resolves once the dialog is shown. */
async function startWithDialog(args: Record<string, unknown>, principal?: string) {
  const pending = callTool('run_agent', args, { principal });
  await waitFor(() => useMcpApprovalStore.getState().current !== null);
  return { pending, request: useMcpApprovalStore.getState().current! };
}

describe('the dialog and the "always allow" tap', () => {
  it('run_agent offers "always allow" (three buttons) with the agent name as the scope', async () => {
    addAgent('a1', { name: 'Morning digest' });
    const { pending, request } = await startWithDialog({ agentId: 'a1' });
    expect(request.kind).toBe('run_agent');
    expect(request.alwaysAllowable).toEqual({ op: 'run_agent', targetLabel: 'Morning digest' });
    expect(request.origin?.principal).toBe(TEST_PRINCIPAL);
    useMcpApprovalStore.getState().respond(request.id, 'once');
    expect(await pending).toMatchObject({ ok: true, data: { agentId: 'a1', state: 'accepted' } });
    expect(h.addCalls).toBe(0);
    expect(h.launches).toHaveLength(1);
  });

  it("'always' writes exactly one rule and launches exactly once; the next call needs no dialog", async () => {
    addAgent('a1');
    const { pending, request } = await startWithDialog({ agentId: 'a1' });
    useMcpApprovalStore.getState().respond(request.id, 'always');
    const r = await pending;
    expect(r).toMatchObject({ ok: true });
    expect(h.addCalls).toBe(1);
    expect(h.rules).toHaveLength(1);
    expect(h.rules[0]).toMatchObject({ principal: TEST_PRINCIPAL, op: 'run_agent', target: 'agent:a1', label: 'Agent a1' });
    expect(h.rules[0].bind).toMatch(/^[0-9a-f]{64}$/);
    expect(h.launches).toHaveLength(1);
    // Second call: rule matches, no dialog even in the background.
    h.appState.currentState = 'background';
    h.tickets.clear();
    const second = await callTool('run_agent', { agentId: 'a1' });
    expect(second).toMatchObject({ ok: true });
    expect(useMcpApprovalStore.getState().current).toBeNull();
    expect(h.launches).toHaveLength(2);
    expect(h.addCalls).toBe(1);
  });

  it('new action consent pins the verified policy; a policy edit requires another approval', async () => {
    addAgent('a1', { action: { type: 'draft' } });
    const { pending, request } = await startWithDialog({ agentId: 'a1' });
    useMcpApprovalStore.getState().respond(request.id, 'always');
    expect(await pending).toMatchObject({ ok: true });
    expect(h.rules[0].actionPolicyPin).toBe('absent');
    h.tickets.clear();
    h.launches = [];
    h.policyPin = 'd'.repeat(64);
    h.appState.currentState = 'background';
    expect(await callTool('run_agent', { agentId: 'a1' })).toMatchObject({ ok: false, code: 'not_attended' });
    expect(h.launches).toHaveLength(0);
    h.appState.currentState = 'active';
    const fresh = await startWithDialog({ agentId: 'a1' });
    useMcpApprovalStore.getState().respond(fresh.request.id, 'always');
    expect(await fresh.pending).toMatchObject({ ok: true });
    expect(h.rules[0].actionPolicyPin).toBe('d'.repeat(64));
  });

  it('a policy edit while the action consent dialog is open refuses the stale consent', async () => {
    addAgent('a1', { action: { type: 'notify' } });
    const { pending, request } = await startWithDialog({ agentId: 'a1' });
    h.policyPin = 'e'.repeat(64);
    useMcpApprovalStore.getState().respond(request.id, 'always');
    expect(await pending).toMatchObject({ ok: false, code: 'target_changed' });
    expect(h.rules).toHaveLength(0);
    expect(h.launches).toHaveLength(0);
  });

  it('legacy rules remain dialog-only and are never silently given action consent', async () => {
    addAgent('a1');
    const { pending, request } = await startWithDialog({ agentId: 'a1' });
    useMcpApprovalStore.getState().respond(request.id, 'always');
    await pending;
    delete h.rules[0].actionPolicyPin;
    h.tickets.clear();
    h.appState.currentState = 'background';
    expect(await callTool('run_agent', { agentId: 'a1' })).toMatchObject({ ok: true });
    expect(h.rules[0].actionPolicyPin).toBeUndefined();
  });

  it('a rule that cannot be saved still runs once, with a toast' , async () => {
    addAgent('a1');
    h.addAnswer = { ok: false, code: 'full' };
    const { pending, request } = await startWithDialog({ agentId: 'a1' });
    useMcpApprovalStore.getState().respond(request.id, 'always');
    expect(await pending).toMatchObject({ ok: true });
    expect(h.launches).toHaveLength(1);
    expect(h.rules).toHaveLength(0);
    expect(h.toasts).toEqual(['mcp.always_allow_not_saved']);
  });

  it('a timeout racing a tap launches nothing and writes no rule', async () => {
    addAgent('a1');
    __setMCPApprovalTimeoutForTests(150);
    const { pending, request } = await startWithDialog({ agentId: 'a1' });
    await waitFor(() => useMcpApprovalStore.getState().current === null);
    // The late tap arrives after the timeout settled the request.
    useMcpApprovalStore.getState().respond(request.id, 'always');
    expect(await pending).toMatchObject({ ok: false, code: 'approval_timeout' });
    expect(h.launches).toHaveLength(0);
    expect(h.addCalls).toBe(0);
  });

  it('deny → denied_by_user, nothing launched or written', async () => {
    addAgent('a1');
    const { pending, request } = await startWithDialog({ agentId: 'a1' });
    useMcpApprovalStore.getState().respond(request.id, 'deny');
    expect(await pending).toMatchObject({ ok: false, code: 'denied_by_user' });
    expect(h.launches).toHaveLength(0);
    expect(h.addCalls).toBe(0);
  });

  it('a token revoke (denyAll) during the dialog writes no rule and launches nothing', async () => {
    addAgent('a1');
    const { pending } = await startWithDialog({ agentId: 'a1' });
    await revokePendingMCPRequests({ tokenRevoked: true });
    // The call is dropped (no answer under the old token).
    expect(await pending).toBeNull();
    await new Promise((r) => setTimeout(r, 200));
    expect(h.launches).toHaveLength(0);
    expect(h.addCalls).toBe(0);
    expect(h.rules).toHaveLength(0);
  });

  it('a plain denyAll during the dialog writes no rule', async () => {
    addAgent('a1');
    const { pending } = await startWithDialog({ agentId: 'a1' });
    useMcpApprovalStore.getState().denyAll();
    expect(await pending).toMatchObject({ ok: false, code: 'denied_by_user' });
    expect(h.addCalls).toBe(0);
    expect(h.launches).toHaveLength(0);
  });

  it('the agent edited while the dialog is open → target_changed, no rule, no launch', async () => {
    const agent = addAgent('a1');
    const { pending, request } = await startWithDialog({ agentId: 'a1' });
    agent.prompt = 'Now also post it to the web.';
    useMcpApprovalStore.getState().respond(request.id, 'always');
    expect(await pending).toMatchObject({ ok: false, code: 'target_changed' });
    expect(h.addCalls).toBe(0);
    expect(h.launches).toHaveLength(0);
  });

  it('STOP-ALL or a taint mark set while the dialog is open still refuses after the tap', async () => {
    addAgent('a1');
    let d = await startWithDialog({ agentId: 'a1' });
    h.halted = true;
    useMcpApprovalStore.getState().respond(d.request.id, 'always');
    expect(await d.pending).toMatchObject({ ok: false, code: 'halted' });
    h.halted = false;
    d = await startWithDialog({ agentId: 'a1' });
    h.taintStatus = JSON.stringify({ status: 'unreadable', overflow: false, entries: [] });
    useMcpApprovalStore.getState().respond(d.request.id, 'always');
    expect(await d.pending).toMatchObject({ ok: false, code: 'tainted' });
    expect(h.addCalls).toBe(0);
    expect(h.launches).toHaveLength(0);
  });

  it('the setting turned off while the dialog is open → disabled', async () => {
    addAgent('a1');
    const { pending, request } = await startWithDialog({ agentId: 'a1' });
    h.settings.mcpTypedOpsEnabled = false;
    useMcpApprovalStore.getState().respond(request.id, 'always');
    expect(await pending).toMatchObject({ ok: false, code: 'disabled' });
    expect(h.addCalls).toBe(0);
    expect(h.launches).toHaveLength(0);
  });
});

describe('the execution boundary re-checks what the approval relied on', () => {
  async function ruleFor(agentId: string) {
    const { pending, request } = await startWithDialog({ agentId });
    useMcpApprovalStore.getState().respond(request.id, 'always');
    await pending;
    h.launches = [];
    h.tickets.clear();
  }

  it('an agent edited while the rule lookup is pending does not start (target_changed)', async () => {
    const agent = addAgent('a1');
    await ruleFor('a1');
    h.onMatch = () => {
      agent.prompt = 'edited during the lookup';
    };
    expect(await callTool('run_agent', { agentId: 'a1' })).toMatchObject({ ok: false, code: 'target_changed' });
    expect(h.launches).toHaveLength(0);
  });

  it('an edit that replaces the store object during the boundary check does not start', async () => {
    addAgent('a1');
    await ruleFor('a1');
    h.taintReads = 0;
    // Read 1 = step 6, read 2 = the launch boundary: replace the agent object
    // (as updateAgent does) while the boundary check is awaiting.
    h.onTaintStatus = (n) => {
      if (n === 2) h.agents = h.agents.map((a) => (a.id === 'a1' ? { ...a, prompt: 'edited via updateAgent' } : a));
    };
    expect(await callTool('run_agent', { agentId: 'a1' })).toMatchObject({ ok: false, code: 'target_changed' });
    expect(h.launches).toHaveLength(0);
  });

  it('the setting turned off during the boundary check does not start', async () => {
    addAgent('a1');
    await ruleFor('a1');
    h.taintReads = 0;
    h.onTaintStatus = (n) => {
      if (n === 2) h.settings.mcpTypedOpsEnabled = false;
    };
    expect(await callTool('run_agent', { agentId: 'a1' })).toMatchObject({ ok: false, code: 'disabled' });
    expect(h.launches).toHaveLength(0);
  });

  // Gate finding 2: a run authorized by a rule (no tap) is re-matched at the
  // execution boundary. Read 1 of the taint status = step 6, read 2 = the
  // launch boundary (after the rule lookup, the lock and the ticket list).
  it('a rule removed after it matched (before the launch) does not start the run', async () => {
    addAgent('a1');
    await ruleFor('a1');
    h.appState.currentState = 'background';
    h.taintReads = 0;
    h.onTaintStatus = (n) => {
      if (n === 2) h.rules = [];
    };
    expect(await callTool('run_agent', { agentId: 'a1' })).toMatchObject({ ok: false, code: 'target_changed' });
    expect(h.launches).toHaveLength(0);
  });

  it('a rule replaced by another rule (new id) after it matched does not start the run', async () => {
    addAgent('a1');
    await ruleFor('a1');
    h.appState.currentState = 'background';
    h.taintReads = 0;
    h.onTaintStatus = (n) => {
      if (n === 2) h.rules = h.rules.map((r) => ({ ...r, id: 'r_ffffffffffffffff' }));
    };
    expect(await callTool('run_agent', { agentId: 'a1' })).toMatchObject({ ok: false, code: 'target_changed' });
    expect(h.launches).toHaveLength(0);
  });

  it('the policy becoming unreadable after the rule matched (agent with actions) does not start the run', async () => {
    addAgent('a1', { action: { type: 'draft' } });
    await ruleFor('a1');
    h.appState.currentState = 'background';
    h.taintReads = 0;
    h.onTaintStatus = (n) => {
      if (n === 2) h.policy = null;
    };
    expect(await callTool('run_agent', { agentId: 'a1' })).toMatchObject({ ok: false, code: 'target_changed' });
    expect(h.launches).toHaveLength(0);
  });

  it('the always tap and subsequent rule launches both carry the action consent rule', async () => {
    addAgent('a1');
    const { pending, request } = await startWithDialog({ agentId: 'a1' });
    useMcpApprovalStore.getState().respond(request.id, 'always');
    expect(await pending).toMatchObject({ ok: true });
    expect(await callTool('run_agent', { agentId: 'a1' })).toMatchObject({ ok: true });
    expect(h.launchAuth).toHaveLength(2);
    expect(h.launchAuth[0].ruleId).toBe(h.rules[0].id);
    expect(h.launchAuth[1].ruleId).toBe(h.rules[0].id);
    expect(h.launchAuth[1].bind).toBe(h.rules[0].bind);
    expect(h.launchAuth[0].bind).toMatch(/^[0-9a-f]{64}$/);
  });

  // Codex round 1 on the gate fix: native refuses an agent with actions unless
  // policy.json is still the file RN evaluated, so RN passes that file's state.
  it('the launch carries the policy file state the deny check used (hash, absent, or unknown)', async () => {
    addAgent('a1', { action: { type: 'draft' } });
    h.policyPin = 'c'.repeat(64);
    const first = await startWithDialog({ agentId: 'a1' });
    useMcpApprovalStore.getState().respond(first.request.id, 'once');
    expect(await first.pending).toMatchObject({ ok: true });
    expect(h.launchAuth[0].policyPin).toBe('c'.repeat(64));
    // No file behind the policy: 'absent'.
    h.policyPin = 'absent';
    const second = await startWithDialog({ agentId: 'a1' });
    useMcpApprovalStore.getState().respond(second.request.id, 'once');
    expect(await second.pending).toMatchObject({ ok: true });
    expect(h.launchAuth[1].policyPin).toBe('absent');
    // Policy not loadable: unknown (native then refuses an agent with actions).
    h.policy = null;
    const third = await startWithDialog({ agentId: 'a1' }, 'f'.repeat(32)); // another client: under the busy limit
    useMcpApprovalStore.getState().respond(third.request.id, 'once');
    expect(await third.pending).toMatchObject({ ok: true });
    expect(h.launchAuth[2].policyPin).toBeNull();
  });

  it('a taint mark or STOP-ALL set while the rule lookup is pending does not start', async () => {
    addAgent('a1');
    await ruleFor('a1');
    h.onMatch = () => {
      h.taintStatus = JSON.stringify({ status: 'ok', overflow: false, entries: [{ agentId: 'a1', source: 'mcp', principal: TEST_PRINCIPAL, at: 1 }] });
    };
    expect(await callTool('run_agent', { agentId: 'a1' })).toMatchObject({ ok: false, code: 'tainted' });
    h.taintStatus = '{"status":"empty","overflow":false,"entries":[]}';
    h.onMatch = () => {
      h.halted = true;
    };
    expect(await callTool('run_agent', { agentId: 'a1' })).toMatchObject({ ok: false, code: 'halted' });
    expect(h.launches).toHaveLength(0);
  });
});

describe('idempotency and limits', () => {
  it('a repeated requestId returns the same handle with one launch and no second dialog', async () => {
    addAgent('a1');
    const { pending, request } = await startWithDialog({ agentId: 'a1', requestId: 'req-12345678' });
    useMcpApprovalStore.getState().respond(request.id, 'once');
    const first = await pending;
    expect(first).toMatchObject({ ok: true, data: { requestId: 'req-12345678' } });
    const again = await callTool('run_agent', { agentId: 'a1', requestId: 'req-12345678' });
    expect(again).toMatchObject({ ok: true, data: { runHandle: first!.data.runHandle, existing: true } });
    expect(useMcpApprovalStore.getState().current).toBeNull();
    expect(h.launches).toHaveLength(1);
    expect(h.launches[0].requestId).toBe('req-12345678');
    // Same requestId from another client is a different call (needs its own dialog).
    const other = startWithDialog({ agentId: 'a1', requestId: 'req-12345678' }, OTHER_PRINCIPAL);
    const o = await other;
    useMcpApprovalStore.getState().respond(o.request.id, 'deny');
    expect(await o.pending).toMatchObject({ ok: false, code: 'denied_by_user' });
  });

  it('concurrent calls with the same requestId (rule matched) launch once', async () => {
    addAgent('a1');
    const { pending, request } = await startWithDialog({ agentId: 'a1' });
    useMcpApprovalStore.getState().respond(request.id, 'always');
    await pending;
    h.launches = [];
    h.tickets.clear();
    const [a, b] = await Promise.all([
      callTool('run_agent', { agentId: 'a1', requestId: 'req-concurrent' }),
      callTool('run_agent', { agentId: 'a1', requestId: 'req-concurrent' }),
    ]);
    expect(a!.data.runHandle).toBe(b!.data.runHandle);
    expect(h.launches).toHaveLength(1);
  });

  it('a requestId reused for another agent is invalid_params', async () => {
    addAgent('a1');
    addAgent('a2');
    h.tickets.set(`mr_${'1'.repeat(32)}`, { v: 1, handle: `mr_${'1'.repeat(32)}`, principal: TEST_PRINCIPAL, agentId: 'a1', state: 'running', acceptedAt: Date.now(), requestId: 'req-12345678' });
    expect(await callTool('run_agent', { agentId: 'a2', requestId: 'req-12345678' })).toMatchObject({ ok: false, code: 'invalid_params' });
    expect(h.launches).toHaveLength(0);
  });

  it('busy: at most 2 live runs per client; another client is not counted', async () => {
    addAgent('a1');
    const { pending, request } = await startWithDialog({ agentId: 'a1' });
    useMcpApprovalStore.getState().respond(request.id, 'always');
    await pending;
    expect(await callTool('run_agent', { agentId: 'a1' })).toMatchObject({ ok: true });
    expect(h.launches).toHaveLength(2);
    expect(await callTool('run_agent', { agentId: 'a1' })).toMatchObject({ ok: false, code: 'busy' });
    expect(h.launches).toHaveLength(2);
    // A finished run frees a slot.
    const [firstHandle] = [...h.tickets.keys()];
    h.tickets.get(firstHandle)!.state = 'succeeded';
    expect(await callTool('run_agent', { agentId: 'a1' })).toMatchObject({ ok: true });
    expect(h.launches).toHaveLength(3);
  });

  it('a failed native launch is launch_failed', async () => {
    addAgent('a1');
    h.launchAnswer = false;
    const { pending, request } = await startWithDialog({ agentId: 'a1' });
    useMcpApprovalStore.getState().respond(request.id, 'once');
    expect(await pending).toMatchObject({ ok: false, code: 'launch_failed' });
  });
});

describe('get_run_result', () => {
  const HANDLE = `mr_${'e'.repeat(32)}`;
  const ticket = (over: Record<string, unknown> = {}) => ({ v: 1, handle: HANDLE, principal: TEST_PRINCIPAL, agentId: 'a1', state: 'running', acceptedAt: Date.now() - 1000, startedAt: Date.now() - 900, ...over });

  it("another client's handle reads exactly like a missing one", async () => {
    h.tickets.set(HANDLE, ticket({ principal: OTHER_PRINCIPAL }) as any);
    const theirs = await callTool('get_run_result', { runHandle: HANDLE });
    const missing = await callTool('get_run_result', { runHandle: `mr_${'f'.repeat(32)}` });
    expect(theirs).toEqual(missing);
    expect(theirs).toMatchObject({ ok: false, code: 'unknown_handle' });
  });

  it('returns the current state at once with waitMs 0', async () => {
    h.tickets.set(HANDLE, ticket() as any);
    expect(await callTool('get_run_result', { runHandle: HANDLE })).toMatchObject({ ok: true, data: { runHandle: HANDLE, state: 'running', untrusted: true } });
  });

  it('long-polls until a terminal state, then returns redacted, byte-capped output', async () => {
    h.tickets.set(HANDLE, ticket() as any);
    h.outputs.set(HANDLE, `result line\nexport OPENAI_API_KEY=sk-NOTAREALKEY000000000000000000\n${'x'.repeat(5000)}`);
    const started = Date.now();
    setTimeout(() => {
      Object.assign(h.tickets.get(HANDLE)!, {
        state: 'succeeded',
        finishedAt: Date.now(),
        exitCode: 0,
        runLog: { timestamp: Date.now(), status: 'success', outputPreview: 'token=abcdef123456 done', errorMessage: '' },
        outputFile: `${HANDLE}.out`,
      });
    }, 700);
    const r = await callTool('get_run_result', { runHandle: HANDLE, waitMs: 5000, maxBytes: 200 });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(r).toMatchObject({ ok: true, data: { state: 'succeeded', untrusted: true, result: { status: 'success', truncated: true } } });
    expect(r!.data.result.output).not.toContain('NOTAREALKEY');
    expect(r!.data.result.preview).not.toContain('abcdef123456');
    expect(Buffer.byteLength(r!.data.result.output, 'utf8')).toBeLessThanOrEqual(200);
    expect(r!.data.result.outputBytes).toBeGreaterThan(5000);
  });

  it('waitMs expires with the live state; stopping the poller ends a wait at once', async () => {
    h.tickets.set(HANDLE, ticket() as any);
    const t0 = Date.now();
    expect(await callTool('get_run_result', { runHandle: HANDLE, waitMs: 600 })).toMatchObject({ ok: true, data: { state: 'running' } });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(550);
    const pending = callTool('get_run_result', { runHandle: HANDLE, waitMs: 20_000 });
    // Past one poll tick, so the request is in its long-poll wait.
    await new Promise((r) => setTimeout(r, 1200));
    const t1 = Date.now();
    stopMCPPoller();
    const res = await pending;
    expect(Date.now() - t1).toBeLessThan(2000);
    expect(res).toMatchObject({ ok: true, data: { state: 'running' } });
  }, 15_000);

  it('stopping the poller while a ticket read is in flight still ends the wait', async () => {
    h.tickets.set(HANDLE, ticket() as any);
    let reads = 0;
    let readStarted = false;
    h.onReadTicket = async () => {
      reads += 1;
      readStarted = true;
      await new Promise((r) => setTimeout(r, 300));
    };
    const pending = callTool('get_run_result', { runHandle: HANDLE, waitMs: 20_000 });
    await waitFor(() => readStarted);
    stopMCPPoller(); // lands during the read, not during a sleep
    const t1 = Date.now();
    expect(await pending).toMatchObject({ ok: true, data: { state: 'running' } });
    expect(Date.now() - t1).toBeLessThan(2000);
    expect(reads).toBe(1);
  }, 15_000);

  it('disabled / invalid_params like run_agent', async () => {
    h.settings.mcpTypedOpsEnabled = false;
    expect(await callTool('get_run_result', { runHandle: HANDLE })).toMatchObject({ ok: false, code: 'disabled' });
    h.settings.mcpTypedOpsEnabled = true;
    expect(await callTool('get_run_result', { runHandle: HANDLE, extra: true })).toMatchObject({ ok: false, code: 'invalid_params' });
  });
});

describe('token revoke', () => {
  it('marks live tickets cancelled; finished ones are left alone', async () => {
    h.tickets.set(`mr_${'1'.repeat(32)}`, { v: 1, handle: `mr_${'1'.repeat(32)}`, principal: TEST_PRINCIPAL, agentId: 'a1', state: 'running', acceptedAt: 1 });
    h.tickets.set(`mr_${'2'.repeat(32)}`, { v: 1, handle: `mr_${'2'.repeat(32)}`, principal: TEST_PRINCIPAL, agentId: 'a1', state: 'succeeded', acceptedAt: 1 });
    await revokePendingMCPRequests({ tokenRevoked: true });
    expect(h.tickets.get(`mr_${'1'.repeat(32)}`)).toMatchObject({ state: 'cancelled', reason: 'revoked' });
    expect(h.tickets.get(`mr_${'2'.repeat(32)}`)!.state).toBe('succeeded');
  });

  it('a plain server start (no token revoke) leaves tickets alone', async () => {
    h.tickets.set(`mr_${'1'.repeat(32)}`, { v: 1, handle: `mr_${'1'.repeat(32)}`, principal: TEST_PRINCIPAL, agentId: 'a1', state: 'running', acceptedAt: 1 });
    await revokePendingMCPRequests();
    expect(h.tickets.get(`mr_${'1'.repeat(32)}`)!.state).toBe('running');
  });
});

// PR 6 (Codex review 2026-11-15): run_agent reaches requests/ only by the
// native consumer's handoff, and never outlives the client's 100 s wait.
describe('handed-off typed requests (PR 6)', () => {
  it('a run_agent in requests/ without a valid handoff token is dropped unanswered', async () => {
    addAgent('a1');
    h.rules = [];
    expect(await callTool('run_agent', { agentId: 'a1' }, { handoff: 'none' })).toBeNull();
    expect(await callTool('run_agent', { agentId: 'a1' }, { handoff: 'forged' })).toBeNull();
    expect(h.launches).toEqual([]);
    expect(useMcpApprovalStore.getState().current).toBeNull();
  });

  it('the token is single use: consumed before the request runs', async () => {
    addAgent('a1');
    h.appState.currentState = 'background';
    const r = await callTool('run_agent', { agentId: 'a1' });
    expect(r).toMatchObject({ ok: false, code: 'not_attended' });
    expect([...h.files.keys()].filter((k) => k.includes('/handoffs/'))).toEqual([]);
  });

  it('a handed-off request past its 100 s deadline is dropped (stranded handoff)', async () => {
    addAgent('a1');
    const old = new Date(Date.now() - 101_000).toISOString();
    expect(await callTool('run_agent', { agentId: 'a1' }, { receivedAt: old })).toBeNull();
    expect(h.launches).toEqual([]);
  });

  it('the dialog never outlives the deadline: too little time left refuses at once', async () => {
    addAgent('a1');
    const late = new Date(Date.now() - 99_000).toISOString();
    const r = await callTool('run_agent', { agentId: 'a1' }, { receivedAt: late });
    expect(r).toMatchObject({ ok: false, code: 'approval_timeout' });
    expect(useMcpApprovalStore.getState().current).toBeNull();
    expect(h.launches).toEqual([]);
  });

  it('the native launch gets the signed deadline (receivedAt + 100 s) to re-check under its ticket lock', async () => {
    addAgent('a1');
    const sent = Date.now() - 1_000;
    const { pending, request } = await (async () => {
      const p = callTool('run_agent', { agentId: 'a1' }, { receivedAt: new Date(sent).toISOString() });
      await waitFor(() => useMcpApprovalStore.getState().current !== null);
      return { pending: p, request: useMcpApprovalStore.getState().current! };
    })();
    useMcpApprovalStore.getState().respond(request.id, 'once');
    expect(await pending).toMatchObject({ ok: true });
    expect(h.launchDeadlines).toEqual([sent + 100_000]);
  });

  // Codex re-gate 2026-11-15, finding 5: a same-uid process captures the
  // signed request and its handoff token, lets them be consumed, then
  // restores both within the 100 s deadline. With an always-allow rule and
  // no requestId, a replay that got through would launch a second run.
  async function captureAndRunOnce(callId: string) {
    addAgent('a1');
    const { pending, request } = await startWithDialog({ agentId: 'a1' });
    useMcpApprovalStore.getState().respond(request.id, 'always');
    await pending;
    expect(h.launches).toHaveLength(1);
    const token = await mcpHandoffToken(TEST_BRIDGE_KEY, callId, nodeSha256);
    const body = await signedRequest(callId, 'run_agent', { agentId: 'a1' });
    h.files.set(`${HANDOFFS}/${callId}`, token);
    h.files.set(`${REQUESTS}/${callId}.json`, body);
    await waitFor(() => !h.files.has(`${REQUESTS}/${callId}.json`));
    expect(JSON.parse(h.files.get(`${RESULTS}/${callId}.json`)!)).toMatchObject({ ok: true });
    expect(h.launches).toHaveLength(2); // rule-cleared: no second tap
    expect(h.files.has(`${HANDOFFS}/${callId}`)).toBe(false);
    h.files.delete(`${RESULTS}/${callId}.json`);
    return { token, body };
  }

  async function restore(callId: string, token: string, body: string) {
    h.files.set(`${HANDOFFS}/${callId}`, token);
    h.files.set(`${REQUESTS}/${callId}.json`, body);
    await waitFor(() => !h.files.has(`${REQUESTS}/${callId}.json`));
  }

  it('a captured request + restored token after >1,000 intervening verified requests does not run again', async () => {
    const callId = 'replay-after-1000';
    const { token, body } = await captureAndRunOnce(callId);
    for (let i = 0; i < 1100; i++) {
      const filler = JSON.parse(await signedRequest(`fill-${i}`, 'list_repos', {}));
      expect(await verifyMcpRequest(filler, TEST_BRIDGE_KEY, nodeSha256, { fileName: `fill-${i}.json` })).toMatchObject({ ok: true });
    }
    await restore(callId, token, body);
    expect(h.files.has(`${RESULTS}/${callId}.json`)).toBe(false);
    expect(h.launches).toHaveLength(2);
  });

  it('a restored handoff token is refused even if the callId record were lost (consumed-token record)', async () => {
    const callId = 'restored-token';
    const { token, body } = await captureAndRunOnce(callId);
    __forgetMcpCallIdsOnlyForTests();
    await restore(callId, token, body);
    expect(h.files.has(`${RESULTS}/${callId}.json`)).toBe(false);
    expect(h.launches).toHaveLength(2);
  });

  it('get_run_result from an old script copy in requests/ needs no token', async () => {
    const r = await callTool('get_run_result', { runHandle: `mr_${'f'.repeat(32)}` });
    expect(r).toMatchObject({ ok: false, code: 'unknown_handle' });
  });
});
