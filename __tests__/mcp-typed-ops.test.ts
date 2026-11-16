/**
 * MCP typed operations (plan "typed MCP operations with always-allow rules",
 * PR 5): the pure helpers in lib/mcp-typed-ops.ts and the run_agent deny
 * ORDER through the real bridge — an always-allow rule is consulted only after
 * every deny class, so it never rescues STOP-ALL, an ingress-marked agent (or
 * an unreadable / overflowing mark store), a POLICY-001 deny or a CRITICAL cli
 * action; a rule of another client or for another binding doesn't match;
 * without a rule a backgrounded app refuses at once (not_attended).
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
  __setMCPRandomBytesForTests,
  __setMCPRequestSha256ForTests,
  redactForMcp,
  setMCPBridgeKey,
  startMCPPoller,
  stopMCPPoller,
} from '@/lib/mcp-server-bridge';
import { __resetMcpSeenCallIdsForTests } from '@/lib/mcp-request-auth';
import { useMcpApprovalStore } from '@/store/mcp-approval-store';
import {
  AGENT_BIND_FIELDS,
  agentBindingHash,
  agentBindingProjection,
  buildRunResultResponse,
  classifyRunAgentDeny,
  cutToBytes,
  findIdempotentTicket,
  liveRunCount,
  parseRunTicket,
  validateGetRunResultArgs,
  validateRunAgentArgs,
  type McpRunTicket,
} from '@/lib/mcp-typed-ops';
import { checkCommandSafety } from '@/lib/command-safety';
import { TEST_BRIDGE_KEY, TEST_PRINCIPAL, nodeSha256 } from './helpers/mcp-signed-request';
import { addAgent, AGENTS, callTool, h, OTHER_PRINCIPAL, resetHarness } from './helpers/mcp-typed-ops-harness';

const CRITICAL_CMD = 'rm -rf /';
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
});
beforeEach(() => {
  resetHarness();
  setMCPBridgeKey(TEST_BRIDGE_KEY);
  __resetMcpSeenCallIdsForTests();
  useMcpApprovalStore.setState({ current: null, queue: [] });
  startMCPPoller();
});
afterEach(() => {
  stopMCPPoller();
  useMcpApprovalStore.getState().denyAll();
});

async function bindOf(agent: Record<string, unknown>): Promise<string> {
  return agentBindingHash(agent, nodeSha256);
}

async function addRule(agentId: string, opts: { principal?: string; bind?: string | null } = {}): Promise<void> {
  const agent = h.agents.find((a) => a.id === agentId)!;
  const bind = opts.bind === undefined ? await bindOf(agent) : opts.bind;
  h.rules.push({
    id: `r_${'0'.repeat(15)}${h.rules.length}`,
    principal: opts.principal ?? TEST_PRINCIPAL,
    op: 'run_agent',
    target: `agent:${agentId}`,
    ...(bind === null ? {} : { bind }),
    label: 'x',
    createdAt: 1,
  });
}

// ── Pure helpers ───────────────────────────────────────────────────────────

describe('argument validation', () => {
  it('run_agent: strict keys and patterns', () => {
    expect(validateRunAgentArgs({ agentId: 'daily_1' })).toEqual({ ok: true, args: { agentId: 'daily_1', requestId: null } });
    expect(validateRunAgentArgs({ agentId: 'daily', requestId: 'req-12345678' })).toEqual({ ok: true, args: { agentId: 'daily', requestId: 'req-12345678' } });
    for (const bad of [
      { agentId: 'daily', input: 'free text' },
      { agentId: '../x' },
      { agentId: '' },
      {},
      { agentId: 'daily', requestId: 'short' },
      { agentId: 'daily', requestId: 7 },
      null,
      [],
    ]) {
      const r = validateRunAgentArgs(bad);
      expect(r.ok).toBe(false);
      if ('refusal' in r) expect(r.refusal.code).toBe('invalid_params');
    }
  });

  it('get_run_result: strict keys, waitMs capped at 20000, maxBytes at 65536', () => {
    const handle = `mr_${'a'.repeat(32)}`;
    expect(validateGetRunResultArgs({ runHandle: handle })).toEqual({ ok: true, args: { runHandle: handle, waitMs: 0, maxBytes: 16384 } });
    expect(validateGetRunResultArgs({ runHandle: handle, waitMs: 999_999, maxBytes: 10_000_000 })).toEqual({
      ok: true,
      args: { runHandle: handle, waitMs: 20_000, maxBytes: 65_536 },
    });
    expect(validateGetRunResultArgs({ runHandle: handle, waitMs: -5, maxBytes: 0 })).toEqual({ ok: true, args: { runHandle: handle, waitMs: 0, maxBytes: 1 } });
    for (const bad of [{ runHandle: 'mr_xyz' }, { runHandle: handle, extra: 1 }, { runHandle: handle, waitMs: 'x' }, { runHandle: handle, maxBytes: Infinity }]) {
      expect(validateGetRunResultArgs(bad).ok).toBe(false);
    }
  });
});

describe('binding', () => {
  it('covers exactly the plan fields, absent as null, and ignores runtime fields', async () => {
    const base = addAgent('b1');
    const p = agentBindingProjection(base);
    expect(Object.keys(p).sort()).toEqual([...AGENT_BIND_FIELDS].sort());
    expect(p.action).toBeNull();
    const b0 = await bindOf(base);
    expect(b0).toMatch(/^[0-9a-f]{64}$/);
    expect(await bindOf({ ...base, lastRun: 99, lastResult: 'success', nextExpectedAt: 5, name: 'renamed' })).toBe(b0);
    expect(await bindOf({ ...base, prompt: 'Something else' })).not.toBe(b0);
    expect(await bindOf({ ...base, action: { type: 'webhook', webhookUrl: 'https://example.invalid/h' } })).not.toBe(b0);
    // Key order does not matter (canonical JSON).
    expect(await bindOf({ tool: base.tool, prompt: base.prompt, outputPath: base.outputPath })).toBe(await bindOf({ outputPath: base.outputPath, prompt: base.prompt, tool: base.tool }));
  });
});

describe('classifyRunAgentDeny (steps 5–7)', () => {
  const policy = (rules: unknown[] = []) => ({ unavailable: false, data: { rules, trust: { allows: [], counts: {} } } }) as any;
  const base = { agentId: 'a', halted: false, tainted: false, homeDir: '/home' };

  it('halted before tainted before policy', () => {
    const agent = { action: { type: 'cli', command: CRITICAL_CMD } } as any;
    expect(classifyRunAgentDeny({ ...base, agent, halted: true, tainted: true, policy: policy() }).refusal?.code).toBe('halted');
    expect(classifyRunAgentDeny({ ...base, agent, tainted: true, policy: policy() }).refusal?.code).toBe('tainted');
    expect(classifyRunAgentDeny({ ...base, agent, policy: policy() }).refusal?.code).toBe('policy_denied');
  });

  it('CRITICAL cli action and POLICY-001 deny / draft_only deny; ask does not', () => {
    expect(checkCommandSafety(CRITICAL_CMD).level).toBe('CRITICAL');
    const webhook = { action: { type: 'webhook', webhookUrl: 'https://hooks.example.invalid/x' } } as any;
    const deny = { id: 'p1', effect: 'deny', match: { capability: 'network' }, source: 'no network', createdAt: 1 };
    const draftOnly = { id: 'p2', effect: 'draft_only', match: { capability: 'post' }, source: 'draft only', createdAt: 1 };
    const ask = { id: 'p3', effect: 'ask', match: { capability: 'network' }, source: 'ask', createdAt: 1 };
    expect(classifyRunAgentDeny({ ...base, agent: webhook, policy: policy([deny]) }).refusal?.code).toBe('policy_denied');
    expect(classifyRunAgentDeny({ ...base, agent: { actions: [{ type: 'draft' }, webhook.action] } as any, policy: policy([draftOnly]) }).refusal?.code).toBe('policy_denied');
    expect(classifyRunAgentDeny({ ...base, agent: webhook, policy: policy([ask]) })).toEqual({ refusal: null, ruleEligible: true });
    // A draft-only agent is not caught by a network deny rule.
    expect(classifyRunAgentDeny({ ...base, agent: { action: { type: 'draft' } } as any, policy: policy([deny]) }).refusal).toBeNull();
  });

  it('unreadable policy: side-effecting agents may not skip the tap via a rule', () => {
    const webhook = { action: { type: 'webhook', webhookUrl: 'https://hooks.example.invalid/x' } } as any;
    expect(classifyRunAgentDeny({ ...base, agent: webhook, policy: null })).toEqual({ refusal: null, ruleEligible: false });
    expect(classifyRunAgentDeny({ ...base, agent: webhook, policy: { ...policy(), unavailable: true } })).toEqual({ refusal: null, ruleEligible: false });
    // Gate finding 1: ANY declared action needs a readable, verified policy
    // (a deny / draft_only rule in the unreadable policy could match it).
    expect(classifyRunAgentDeny({ ...base, agent: { action: { type: 'draft' } } as any, policy: null })).toEqual({ refusal: null, ruleEligible: false });
    expect(classifyRunAgentDeny({ ...base, agent: { actions: [{ type: 'notify' }] } as any, policy: { ...policy(), unavailable: true } })).toEqual({ refusal: null, ruleEligible: false });
    // No declared action at all: nothing for a policy rule to match.
    expect(classifyRunAgentDeny({ ...base, agent: {} as any, policy: null })).toEqual({ refusal: null, ruleEligible: true });
    expect(classifyRunAgentDeny({ ...base, agent: { actions: [] } as any, policy: { ...policy(), unavailable: true } })).toEqual({ refusal: null, ruleEligible: true });
  });
});

describe('ticket mapping, truncation and redaction', () => {
  const handle = `mr_${'b'.repeat(32)}`;
  const ticket = (over: Partial<McpRunTicket> = {}): McpRunTicket => ({
    handle,
    principal: TEST_PRINCIPAL,
    agentId: 'a1',
    state: 'succeeded',
    acceptedAt: 1000,
    startedAt: 1100,
    finishedAt: 4100,
    exitCode: 0,
    runLog: { timestamp: 1200, status: 'success', outputPreview: 'p'.repeat(800), errorMessage: '', savedPath: '/x/out.md' },
    outputFile: `${handle}.out`,
    ...over,
  });

  it('maps fields, caps the preview at 500 chars, marks untrusted', () => {
    const r = buildRunResultResponse(ticket(), null, 100, (s) => s);
    expect(r).toMatchObject({ runHandle: handle, agentId: 'a1', state: 'succeeded', durationMs: 3000, exitCode: 0, untrusted: true });
    expect(r.result!.preview).toHaveLength(500);
    expect(r.result!.output).toBeUndefined();
    expect(r.result!.outputBytes).toBe(0);
    expect(r.result!.savedPath).toBe('/x/out.md');
  });

  it('redacts BEFORE cutting to maxBytes, never splits a character', () => {
    const secret = 'api_key=sk-THISISNOTAREALKEY0123456789';
    const out = `head ${secret} tail ${'あ'.repeat(10)}`;
    const r = buildRunResultResponse(ticket(), out, 20, redactForMcp);
    expect(r.result!.output).not.toContain('THISISNOTAREALKEY');
    expect(Buffer.byteLength(r.result!.output!, 'utf8')).toBeLessThanOrEqual(20);
    expect(r.result!.truncated).toBe(true);
    expect(r.result!.outputBytes).toBe(Buffer.byteLength(redactForMcp(out), 'utf8'));
    const full = buildRunResultResponse(ticket(), out, 65536, redactForMcp);
    expect(full.result!.truncated).toBe(false);
    expect(full.result!.output).toBe(redactForMcp(out));
    expect(full.result!.output).not.toContain('THISISNOTAREALKEY');
    expect(cutToBytes('あいう', 4)).toBe('あ');
    expect(cutToBytes('abc', 0)).toBe('');
  });

  it('the preview is redacted too', () => {
    const r = buildRunResultResponse(ticket({ runLog: { timestamp: 1, status: 'success', outputPreview: 'Authorization: Bearer abcdefghijklmnop', errorMessage: '' } }), null, 10, redactForMcp);
    expect(r.result!.preview).not.toContain('abcdefghijklmnop');
  });

  it('parseRunTicket rejects malformed tickets; idempotency and live count', () => {
    expect(parseRunTicket(JSON.stringify({ v: 1, ...ticket() }))).not.toBeNull();
    expect(parseRunTicket({ v: 1, ...ticket(), state: 'weird' })).toBeNull();
    expect(parseRunTicket({ v: 1, ...ticket(), principal: 'nothex' })).toBeNull();
    expect(parseRunTicket({ v: 2, ...ticket() })).toBeNull();
    expect(parseRunTicket({ v: 1, ...ticket(), outputFile: '../x' })).toBeNull();
    const now = 10 * 60_000 + 5000;
    const tickets: McpRunTicket[] = [
      ticket({ state: 'running', requestId: 'req-aaaaaaaa', acceptedAt: now - 1000 }),
      ticket({ handle: `mr_${'c'.repeat(32)}`, state: 'accepted', requestId: 'req-old-aaaa', acceptedAt: 1000 }),
      ticket({ handle: `mr_${'d'.repeat(32)}`, state: 'accepted', principal: OTHER_PRINCIPAL, requestId: 'req-aaaaaaaa', acceptedAt: now }),
    ];
    expect(findIdempotentTicket(tickets, TEST_PRINCIPAL, 'req-aaaaaaaa', now)?.handle).toBe(handle);
    expect(findIdempotentTicket(tickets, TEST_PRINCIPAL, 'req-old-aaaa', now)).toBeNull(); // > 10 min
    expect(findIdempotentTicket(tickets, OTHER_PRINCIPAL, 'req-old-aaaa', now)).toBeNull();
    expect(liveRunCount(tickets, TEST_PRINCIPAL)).toBe(2);
  });
});

// ── Deny order through the bridge ─────────────────────────────────────────

describe('run_agent deny order: a matching rule never rescues a deny class', () => {
  it('with a matching rule and nobody in the foreground it proceeds without a dialog', async () => {
    addAgent('a1');
    await addRule('a1');
    h.appState.currentState = 'background';
    const r = await callTool('run_agent', { agentId: 'a1' });
    expect(r).toMatchObject({ ok: true, data: { agentId: 'a1', state: 'accepted', untrusted: true } });
    expect(r!.data.runHandle).toMatch(/^mr_[0-9a-f]{32}$/);
    expect(h.launches).toHaveLength(1);
    expect(useMcpApprovalStore.getState().current).toBeNull();
    expect(h.logs.some((l) => l.includes('always-allow rule r_') && l.includes('matched run_agent a1'))).toBe(true);
  });

  it('STOP-ALL (store flag or .halted sentinel) → halted', async () => {
    addAgent('a1');
    await addRule('a1');
    h.halted = true;
    expect(await callTool('run_agent', { agentId: 'a1' })).toMatchObject({ ok: false, code: 'halted' });
    h.halted = false;
    h.files.set(`${AGENTS}/.halted`, '');
    expect(await callTool('run_agent', { agentId: 'a1' })).toMatchObject({ ok: false, code: 'halted' });
    expect(h.launches).toHaveLength(0);
  });

  it.each([
    ['marked', JSON.stringify({ status: 'ok', overflow: false, entries: [{ agentId: 'a1', source: 'mcp', principal: TEST_PRINCIPAL, at: 1 }] })],
    ['unreadable store', JSON.stringify({ status: 'unreadable', overflow: false, entries: [] })],
    ['overflowing store', JSON.stringify({ status: 'overflow', overflow: true, entries: [] })],
    ['garbage status', 'not json'],
  ])('tainted (%s) → tainted, no dialog, audit line', async (_label, status) => {
    addAgent('a1');
    await addRule('a1');
    h.taintStatus = status;
    expect(await callTool('run_agent', { agentId: 'a1' })).toMatchObject({ ok: false, code: 'tainted' });
    expect(h.launches).toHaveLength(0);
    expect(useMcpApprovalStore.getState().current).toBeNull();
    expect(h.audits).toEqual([
      { agentId: 'a1', json: { kind: 'ingress_tainted_refused', event: 'mcp_run_agent', agentId: 'a1', principal: TEST_PRINCIPAL, code: 'tainted' } },
    ]);
  });

  it('POLICY-001 deny rule → policy_denied', async () => {
    addAgent('a1', { action: { type: 'webhook', webhookUrl: 'https://hooks.example.invalid/x' } });
    await addRule('a1');
    h.policy = { unavailable: false, data: { rules: [{ id: 'p1', effect: 'deny', match: { capability: 'network' }, source: 'no', createdAt: 1 }], trust: { allows: [], counts: {} } } };
    expect(await callTool('run_agent', { agentId: 'a1' })).toMatchObject({ ok: false, code: 'policy_denied' });
    expect(h.launches).toHaveLength(0);
  });

  it('CRITICAL cli action → policy_denied', async () => {
    addAgent('a1', { actions: [{ type: 'cli', command: CRITICAL_CMD }] });
    await addRule('a1');
    expect(await callTool('run_agent', { agentId: 'a1' })).toMatchObject({ ok: false, code: 'policy_denied' });
    expect(h.launches).toHaveLength(0);
  });

  it('a rule of another client does not match → not_attended in the background', async () => {
    addAgent('a1');
    await addRule('a1', { principal: OTHER_PRINCIPAL });
    h.appState.currentState = 'background';
    expect(await callTool('run_agent', { agentId: 'a1' })).toMatchObject({ ok: false, code: 'not_attended' });
    expect(h.launches).toHaveLength(0);
    expect(h.audits.map((a) => a.json)).toEqual([{ kind: 'mcp_typed_op_refused', event: 'mcp_run_agent', agentId: 'a1', principal: TEST_PRINCIPAL, code: 'not_attended' }]);
  });

  it('a rule for a changed binding does not match', async () => {
    addAgent('a1');
    await addRule('a1', { bind: 'f'.repeat(64) });
    h.appState.currentState = 'background';
    expect(await callTool('run_agent', { agentId: 'a1' })).toMatchObject({ ok: false, code: 'not_attended' });
    expect(h.launches).toHaveLength(0);
  });

  it('unreadable policy rules + side-effecting agent: a rule does not skip the tap', async () => {
    addAgent('a1', { action: { type: 'webhook', webhookUrl: 'https://hooks.example.invalid/x' } });
    await addRule('a1');
    h.policy = null;
    h.appState.currentState = 'background';
    expect(await callTool('run_agent', { agentId: 'a1' })).toMatchObject({ ok: false, code: 'not_attended' });
    expect(h.launches).toHaveLength(0);
  });

  it.each([
    ['draft', { action: { type: 'draft' } }],
    ['notify', { actions: [{ type: 'notify' }] }],
  ])('unreadable / unverified policy + a %s action: an existing rule does not skip the tap (gate finding 1)', async (_label, overrides) => {
    addAgent('a1', overrides);
    await addRule('a1');
    h.appState.currentState = 'background';
    for (const policy of [null, { unavailable: true, data: { rules: [], trust: { allows: [], counts: {} } } }]) {
      h.policy = policy;
      expect(await callTool('run_agent', { agentId: 'a1' })).toMatchObject({ ok: false, code: 'not_attended' });
    }
    expect(h.launches).toHaveLength(0);
  });

  it('unreadable policy + an agent with no declared action: the rule still applies', async () => {
    addAgent('a1');
    await addRule('a1');
    h.policy = null;
    h.appState.currentState = 'background';
    expect(await callTool('run_agent', { agentId: 'a1' })).toMatchObject({ ok: true });
    expect(h.launches).toHaveLength(1);
  });

  it('earlier steps: disabled, invalid_params, unknown_agent (incl. on-disk mismatch, disabled agent)', async () => {
    addAgent('a1');
    await addRule('a1');
    h.settings.mcpTypedOpsEnabled = false;
    expect(await callTool('run_agent', { agentId: 'a1' })).toMatchObject({ ok: false, code: 'disabled' });
    h.settings.mcpTypedOpsEnabled = true;
    expect(await callTool('run_agent', { agentId: 'a1', input: 'x' })).toMatchObject({ ok: false, code: 'invalid_params' });
    expect(await callTool('run_agent', { agentId: 'nope' })).toMatchObject({ ok: false, code: 'unknown_agent' });
    h.files.set(`${AGENTS}/a1.json`, JSON.stringify({ id: 'other', enabled: true }));
    expect(await callTool('run_agent', { agentId: 'a1' })).toMatchObject({ ok: false, code: 'unknown_agent' });
    addAgent('a2', { enabled: false });
    await addRule('a2');
    expect(await callTool('run_agent', { agentId: 'a2' })).toMatchObject({ ok: false, code: 'unknown_agent' });
    expect(h.launches).toHaveLength(0);
  });

  it('the error text carries the code', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const server = require('../scripts/shelly-mcp-server.js');
    const r = await callTool('run_agent', { agentId: 'nope' });
    expect(server.toolResultBody(r).content[0].text).toMatch(/^Error: \[unknown_agent\] /);
    expect(server.toolResultBody({ ok: false, error: 'x', code: 'Bad Code!' }).content[0].text).toBe('Error: x');
  });
});
