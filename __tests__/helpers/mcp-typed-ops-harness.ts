/**
 * Test harness for the MCP typed operations (run_agent / get_run_result)
 * through the real RN bridge (lib/mcp-server-bridge.ts): signed request files,
 * the real poller, and in-memory stand-ins for the native always-allow store,
 * run tickets, ingress-taint status and audit writer.
 *
 * Use from a test file's jest.mock factories, e.g.
 *   jest.mock('expo-file-system/legacy', () => require('./helpers/mcp-typed-ops-harness').fsMock);
 * Dummy values only.
 */
import * as nodeCrypto from 'crypto';
import { mcpHandoffToken } from '@/lib/mcp-request-auth';
import { nodeSha256, signedRequest, TEST_BRIDGE_KEY, TEST_PRINCIPAL } from './mcp-signed-request';

export const HOME = 'file:///data/home-root/home';
export const QUEUE = `${HOME}/.shelly-mcp-queue`;
export const REQUESTS = `${QUEUE}/requests`;
export const RESULTS = `${QUEUE}/results`;
export const HANDOFFS = `${QUEUE}/handoffs`;
export const AGENTS = `${HOME}/.shelly/agents`;
export const OTHER_PRINCIPAL = 'fedcba9876543210fedcba9876543210';

type Rule = { id: string; principal: string; op: string; target: string; bind?: string; actionPolicyPin?: string; label: string; createdAt: number };
type Ticket = Record<string, unknown> & { handle: string; principal: string; state: string; acceptedAt: number };

export const h = {
  files: new Map<string, string>(),
  fileMtimes: new Map<string, number>(),
  settings: { mcpTypedOpsEnabled: true } as Record<string, unknown>,
  agents: [] as Record<string, unknown>[],
  halted: false,
  appState: { currentState: 'active' as string },
  rules: [] as Rule[],
  /** null: add succeeds; otherwise the native add answers this. */
  addAnswer: null as null | Record<string, unknown>,
  addCalls: 0,
  tickets: new Map<string, Ticket>(),
  outputs: new Map<string, string>(),
  launches: [] as { agentId: string; handle: string; principal: string; requestId: string | null }[],
  launchAnswer: true,
  launchDeadlines: [] as (number | null)[],
  /** What each native launch was told authorized it (approved binding, rule id or null = tap). */
  launchAuth: [] as { bind: string; ruleId: string | null; policyPin: string | null }[],
  /** getCachedUserPolicyPin: the file state behind h.policy (sha256, 'absent', or null = unknown). */
  policyPin: 'absent' as string | null,
  audits: [] as { agentId: string | null; json: Record<string, unknown> }[],
  taintStatus: '{"status":"empty","overflow":false,"entries":[]}',
  policy: { unavailable: false, data: { rules: [] as unknown[], trust: { allows: [], counts: {} } } } as Record<string, any> | null,
  logs: [] as string[],
  toasts: [] as string[],
  /** Runs inside the native rule match (simulates a change during the lookup). */
  onMatch: null as null | (() => void),
  /** Awaited inside the native ticket read (simulates a slow read). */
  onReadTicket: null as null | (() => Promise<void>),
  /** Runs on every native taint-status read, with the 1-based read count. */
  onTaintStatus: null as null | ((n: number) => void),
  taintReads: 0,
};

export function resetHarness(): void {
  h.files.clear();
  h.fileMtimes.clear();
  h.settings = { mcpTypedOpsEnabled: true };
  h.agents = [];
  h.halted = false;
  h.appState.currentState = 'active';
  h.rules = [];
  h.addAnswer = null;
  h.addCalls = 0;
  h.tickets.clear();
  h.outputs.clear();
  h.launches = [];
  h.launchAnswer = true;
  h.launchDeadlines = [];
  h.launchAuth = [];
  h.policyPin = 'absent';
  h.audits = [];
  h.taintStatus = '{"status":"empty","overflow":false,"entries":[]}';
  h.policy = { unavailable: false, data: { rules: [], trust: { allows: [], counts: {} } } };
  h.logs = [];
  h.toasts = [];
  h.onMatch = null;
  h.onReadTicket = null;
  h.onTaintStatus = null;
  h.taintReads = 0;
}

export const fsMock = {
  documentDirectory: 'file:///data/home-root/',
  readDirectoryAsync: async (dir: string) => {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    return [...h.files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).filter((n) => !n.includes('/'));
  },
  readAsStringAsync: async (uri: string) => {
    const v = h.files.get(uri);
    if (v === undefined) throw new Error(`ENOENT ${uri}`);
    return v;
  },
  writeAsStringAsync: async (uri: string, content: string) => {
    h.files.set(uri, content);
    h.fileMtimes.set(uri, Date.now());
  },
  makeDirectoryAsync: async () => {},
  moveAsync: async () => {},
  getInfoAsync: async (uri: string) => {
    const exists = h.files.has(uri);
    const mtimeMs = h.fileMtimes.get(uri);
    return exists && mtimeMs !== undefined ? { exists, modificationTime: mtimeMs / 1000 } : { exists };
  },
  deleteAsync: async (uri: string) => {
    for (const k of [...h.files.keys()]) {
      if (k === uri || k.startsWith(`${uri}/`)) {
        h.files.delete(k);
        h.fileMtimes.delete(k);
      }
    }
  },
};

function matchRule(principal: string, op: string, target: string, bind: string | null): Rule | undefined {
  return h.rules.find((r) => r.principal === principal && r.op === op && r.target === target && (r.bind === undefined || r.bind === bind));
}

export const nativeMock = {
  __esModule: true,
  default: {
    invalidateStageInstalls: () => true,
    setMcpSkipApproval: async () => false,
    getMcpSkipApproval: async () => false,
    setApproveAllWithoutAsking: async (enabled: boolean) => (h.settings.approveAllWithoutAsking = enabled),
    // The native "Skip all approvals" switch (ApproveAllStore); tests drive it
    // through h.settings.approveAllWithoutAsking.
    getApproveAllWithoutAsking: async () => h.settings.approveAllWithoutAsking === true,
    mcpAlwaysAllowMatch: async (p: string, op: string, t: string, b: string | null) => {
      const hit = !!matchRule(p, op, t, b);
      h.onMatch?.();
      return hit;
    },
    mcpAlwaysAllowList: async () => JSON.stringify({ version: 1, status: h.rules.length ? 'ok' : 'empty', rules: h.rules }),
    mcpAlwaysAllowAdd: async (p: string, op: string, t: string, b: string | null, label: string, actionPolicyPin: string | null) => {
      h.addCalls += 1;
      if (h.addAnswer) return JSON.stringify(h.addAnswer);
      // Mirrors native McpAlwaysAllowStore.withAdded: a grant for an existing
      // (principal, op, target) replaces that rule in place and keeps its id.
      const idx = h.rules.findIndex((r) => r.principal === p && r.op === op && r.target === t);
      const id = idx >= 0 ? h.rules[idx].id : `r_${nodeCrypto.randomBytes(8).toString('hex')}`;
      const rule: Rule = { id, principal: p, op, target: t, label, createdAt: Date.now() };
      if (b !== null) rule.bind = b;
      if (actionPolicyPin !== null && actionPolicyPin !== undefined) rule.actionPolicyPin = actionPolicyPin;
      if (idx >= 0) {
        h.rules[idx] = rule;
        return JSON.stringify({ ok: true, code: 'replaced', id });
      }
      h.rules.push(rule);
      return JSON.stringify({ ok: true, code: 'added', id });
    },
    mcpAlwaysAllowPurgeExcept: async () => true,
    runAgentForMcp: async (
      agentId: string,
      handle: string,
      principal: string,
      requestId: string | null,
      deadlineMs: number | null,
      approvedBind: string,
      ruleId: string | null,
      policyPin: string | null,
    ) => {
      h.launchDeadlines.push(deadlineMs);
      h.launchAuth.push({ bind: approvedBind, ruleId, policyPin });
      h.launches.push({ agentId, handle, principal, requestId });
      if (!h.launchAnswer) return false;
      const t: Ticket = { v: 1, handle, principal, agentId, state: 'accepted', acceptedAt: Date.now() };
      if (requestId) t.requestId = requestId;
      h.tickets.set(handle, t);
      return true;
    },
    readMcpRunTicket: async (handle: string) => {
      if (h.onReadTicket) await h.onReadTicket();
      const t = h.tickets.get(handle);
      return t ? JSON.stringify(t) : null;
    },
    readMcpRunOutput: async (handle: string, maxBytes: number) => {
      const o = h.outputs.get(handle);
      if (o === undefined) return null;
      const b = Buffer.from(o, 'utf8');
      return b.length <= maxBytes ? o : b.subarray(0, maxBytes).toString('utf8');
    },
    listMcpRunTickets: async (principal: string) => JSON.stringify([...h.tickets.values()].filter((t) => t.principal === principal)),
    cancelMcpRunTickets: async (principal: string | null) => {
      let n = 0;
      for (const t of h.tickets.values()) {
        if ((principal === null || t.principal === principal) && (t.state === 'accepted' || t.state === 'running')) {
          t.state = 'cancelled';
          t.reason = 'revoked';
          n++;
        }
      }
      return n;
    },
    appendMcpIngressAudit: async (agentId: string | null, json: string) => {
      h.audits.push({ agentId, json: JSON.parse(json) });
      return true;
    },
    getAgentIngressStatus: async () => {
      h.taintReads += 1;
      h.onTaintStatus?.(h.taintReads);
      return h.taintStatus;
    },
  },
};

export const agentStoreMock = {
  useAgentStore: { getState: () => ({ agents: h.agents, halted: h.halted }), subscribe: () => () => {} },
};
export const settingsStoreMock = { useSettingsStore: { getState: () => ({ settings: h.settings }) } };
export const policyStoreMock = {
  getCachedUserPolicy: () => h.policy,
  getCachedUserPolicyPin: () => h.policyPin,
  loadUserPolicy: async () => {
    throw new Error('not loadable in tests');
  },
};
export const loggerMock = {
  logInfo: (_m: string, msg: string) => h.logs.push(`info ${msg}`),
  logError: (_m: string, msg: string) => h.logs.push(`error ${msg}`),
  logWarn: (_m: string, msg: string) => h.logs.push(`warn ${msg}`),
};
export const reactNativeMock = {
  AppState: h.appState,
  ToastAndroid: { LONG: 1, SHORT: 0, show: (text: string) => h.toasts.push(text) },
};

/** Registers an enabled agent in the store and on disk. */
export function addAgent(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const agent: Record<string, unknown> = {
    id,
    name: `Agent ${id}`,
    description: '',
    prompt: 'Summarize the morning feeds.',
    schedule: null,
    tool: { type: 'auto' },
    outputPath: '~/out',
    outputTemplate: null,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 1,
    version: 1,
    ...overrides,
  };
  h.agents.push(agent);
  h.files.set(`${AGENTS}/${id}.json`, JSON.stringify(agent));
  return agent;
}

async function waitFor(cond: () => boolean, ms = 5000, now = () => Date.now()): Promise<void> {
  const end = now() + ms;
  while (!cond()) {
    if (now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
export { waitFor };

/**
 * Drops one signed request and resolves with the bridge's answer (the result
 * file), or null when the bridge wrote none. The poller must be running.
 */
export async function callTool(
  tool: string,
  args: Record<string, unknown>,
  opts: { principal?: string; handoff?: 'valid' | 'none' | 'forged'; receivedAt?: string; waitClock?: () => number } = {},
): Promise<{ ok: boolean; data?: any; error?: string; code?: string } | null> {
  const callId = nodeCrypto.randomUUID();
  // run_agent reaches requests/ only by the native consumer's handoff (PR 6),
  // which leaves a single-use token; simulate it unless told otherwise.
  // service_control / request_pipeline_refire likewise (background ingress, phase A).
  // update_delivery_script / update_pipeline_config too (phase B-2), and stage_install.
  const handoff = opts.handoff ?? (['run_agent', 'service_control', 'request_pipeline_refire', 'update_delivery_script', 'update_pipeline_config', 'stage_install'].includes(tool) ? 'valid' : 'none');
  if (handoff !== 'none') {
    const token = handoff === 'valid' ? await mcpHandoffToken(TEST_BRIDGE_KEY, callId, nodeSha256) : 'b'.repeat(64);
    h.files.set(`${HANDOFFS}/${callId}`, token);
  }
  const requestUri = `${REQUESTS}/${callId}.json`;
  h.files.set(
    requestUri,
    await signedRequest(callId, tool, args, { principal: opts.principal ?? TEST_PRINCIPAL, receivedAt: opts.receivedAt }),
  );
  h.fileMtimes.set(requestUri, Date.now());
  await waitFor(() => !h.files.has(requestUri), 30_000, opts.waitClock);
  const raw = h.files.get(`${RESULTS}/${callId}.json`);
  return raw === undefined ? null : JSON.parse(raw);
}
