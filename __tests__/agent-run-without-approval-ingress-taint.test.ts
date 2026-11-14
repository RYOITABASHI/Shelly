/**
 * MCP ingress taint Inc 5 (DEFERRED.md P1 "MCP の入口（ingress）"), RN side of
 * "承認なしで実行": an agent carrying the MCP ingress mark never gets the
 * "all" level, and nothing of it is auto-answered except a pure read. A taint
 * check that throws reads as tainted. Untainted agents behave as before.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  __setIngressTaintCheckForTests,
  __setRunWithoutApprovalStorageForTests,
  decideActionAutoApproval,
  escalationAutoApprovable,
  getRunWithoutApprovalSetting,
  isIngressTaintedForApproval,
  loadRunWithoutApproval,
  runWithoutApprovalDefinitionHash,
  setRunWithoutApproval,
  type EscalationAutoApproveOpts,
} from '@/lib/agent-run-without-approval';
import { classifyProposedCommand } from '@/lib/agent-boundary-policy';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const HOME = '/data/user/0/dev.shelly.terminal/files/home';
const HOME_PATHS = [HOME, '/data/data/dev.shelly.terminal/files/home'];
const WS = `${HOME}/demo`;

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    get: jest.fn(async () => value),
    set: jest.fn(async (v: string) => { value = v; }),
  };
}

const agent = {
  id: 'agent-mcp',
  prompt: 'build two brick breaker games',
  schedule: null,
  tool: { type: 'cli', cli: 'codex' },
  workspaceRoot: WS,
  outputPath: '$HOME/.shelly/agents/a/output.md',
};

function gateRequest(command: string) {
  const verdict = classifyProposedCommand(command, { workspaceRoot: WS, level: 'L1' });
  return { command, signals: verdict.signals, reason: verdict.reason, cwd: WS, workspaceRoot: WS };
}

const allOpts: EscalationAutoApproveOpts = {
  enabled: true,
  trustedWorkspaceRoot: WS,
  homePaths: HOME_PATHS,
  level: 'all',
  attended: true,
};

const tainted = new Set<string>();
beforeEach(() => {
  tainted.clear();
  __setRunWithoutApprovalStorageForTests(memoryStorage());
  __setIngressTaintCheckForTests(async (id) => tainted.has(id));
});
afterAll(() => {
  __setRunWithoutApprovalStorageForTests(null);
  __setIngressTaintCheckForTests(undefined);
});

describe('isIngressTaintedForApproval', () => {
  it('follows the store and fails closed on a throwing check', async () => {
    expect(await isIngressTaintedForApproval('agent-mcp')).toBe(false);
    tainted.add('agent-mcp');
    expect(await isIngressTaintedForApproval('agent-mcp')).toBe(true);
    __setIngressTaintCheckForTests(async () => { throw new Error('keystore'); });
    expect(await isIngressTaintedForApproval('agent-mcp')).toBe(true);
  });

  it('no native store in this runtime ⇒ nothing is marked (same rule as isAgentIngressTainted)', async () => {
    __setIngressTaintCheckForTests(null);
    expect(await isIngressTaintedForApproval('agent-mcp')).toBe(false);
  });
});

describe('level: never "all" for a marked agent', () => {
  it('an existing "all" entry reads as standard once the agent is marked', async () => {
    const entry = [{ agentId: agent.id, enabledAt: 1, via: 'chat', definitionHash: runWithoutApprovalDefinitionHash(agent), level: 'all' }];
    __setRunWithoutApprovalStorageForTests(memoryStorage(JSON.stringify(entry)));
    expect(await getRunWithoutApprovalSetting(agent)).toBe('all');
    tainted.add(agent.id);
    expect(await getRunWithoutApprovalSetting(agent)).toBe('standard');
  });

  it('an unreadable taint status also caps "all" to standard', async () => {
    const entry = [{ agentId: agent.id, enabledAt: 1, via: 'chat', definitionHash: runWithoutApprovalDefinitionHash(agent), level: 'all' }];
    __setRunWithoutApprovalStorageForTests(memoryStorage(JSON.stringify(entry)));
    __setIngressTaintCheckForTests(async () => { throw new Error('unreadable'); });
    expect(await getRunWithoutApprovalSetting(agent)).toBe('standard');
  });

  it('setRunWithoutApproval never stores "all" for a marked agent', async () => {
    tainted.add(agent.id);
    await setRunWithoutApproval(agent, 'all', 'chat');
    const [stored] = await loadRunWithoutApproval();
    expect(stored.level).toBeUndefined();
    expect(await getRunWithoutApprovalSetting(agent)).toBe('standard');
  });

  it('untainted regression: "all" is stored and read back unchanged', async () => {
    await setRunWithoutApproval(agent, 'all', 'chat');
    expect(await getRunWithoutApprovalSetting(agent)).toBe('all');
  });
});

describe('escalations: a marked agent gets pure reads only', () => {
  const read1 = gateRequest(`cat -- '${HOME}/other/notes.md'`);
  const inRootWrite = gateRequest('tee src/a.txt');
  const allWrite = gateRequest(`rm -rf -- '${WS}/build'`);

  it('untainted regression: read, in-root write and an "all"-level write are auto-answered as before', () => {
    expect(escalationAutoApprovable(read1, allOpts)).toEqual({ ok: true, kind: 'read' });
    expect(escalationAutoApprovable(inRootWrite, allOpts)).toEqual({ ok: true, kind: 'in-root-write' });
    expect(escalationAutoApprovable(allWrite, allOpts).ok).toBe(true);
  });

  it('tainted: the read is still answered, every write is refused with reason ingress-tainted', () => {
    const opts = { ...allOpts, ingressTainted: true };
    expect(escalationAutoApprovable(read1, opts)).toEqual({ ok: true, kind: 'read' });
    expect(escalationAutoApprovable(inRootWrite, opts)).toEqual({ ok: false, reason: 'ingress-tainted' });
    expect(escalationAutoApprovable(allWrite, opts).ok).toBe(false);
    expect(escalationAutoApprovable(inRootWrite, { ...opts, level: 'standard' })).toEqual({ ok: false, reason: 'ingress-tainted' });
  });
});

describe('actions: a marked agent is never auto-accepted', () => {
  const req = { runId: 'r1', agentId: agent.id, actionType: 'draft', requestSha256: 'h', actionNonce: 'n', origin: 'user' };
  const base = {
    enabled: true,
    policyBlocksAutoAccept: false,
    originOf: () => 'user' as const,
    readMinted: async () => req,
  };

  it('untainted regression: a draft is accepted', async () => {
    expect((await decideActionAutoApproval(req, base)).ok).toBe(true);
    expect((await decideActionAutoApproval(req, { ...base, ingressTainted: false })).ok).toBe(true);
  });

  it('tainted: draft and notify are refused before anything is minted', async () => {
    const readMinted = jest.fn(async () => req);
    for (const actionType of ['draft', 'notify']) {
      expect(await decideActionAutoApproval({ ...req, actionType }, { ...base, readMinted, ingressTainted: true }))
        .toEqual({ ok: false, reason: 'ingress-tainted' });
    }
    expect(readMinted).not.toHaveBeenCalled();
  });
});

describe('app/_layout.tsx and the headless drain wire the mark in (source pins)', () => {
  const layout = read('app/_layout.tsx');
  const headless = read('lib/agent-action-approval-headless.ts');

  it('the escalation auto-approval passes ingressTainted into both verdicts', () => {
    expect(layout).toContain('const ingressTainted = await isIngressTaintedForApproval(parsed.agentId);');
    expect(layout).toMatch(/attended: userStarted,\s*ingressTainted,/);
  });

  it('the action drain declines a marked agent before trust-ramp / run-without-approval / autoAccept / ClosePaw', () => {
    const at = layout.indexOf('if (await isIngressTaintedForApproval(parsed.agentId)) {');
    expect(at).toBeGreaterThan(0);
    const block = layout.slice(at, at + 1600);
    expect(block).toContain("policyResolveActionApproval(parsed, 'decline')");
    expect(block).toContain('reason=${taintReason}');
    expect(block).toContain('continue;');
    for (const later of ['evaluateApprovalRequestPolicy(parsed', 'autoApproveActionForFlaggedAgent(parsed', 'closePawPreapprovedFor(parsed)']) {
      expect(layout.indexOf(later, 0)).toBeGreaterThan(-1);
      expect(layout.indexOf(later, at)).toBeGreaterThan(at);
    }
  });

  it('the headless drain never accepts for a marked agent', () => {
    expect(headless).toContain('ingressTainted,');
    expect(headless).toContain('(deps.isIngressTainted ?? isIngressTaintedForApproval)(parsed.agentId).catch(() => true)');
  });
});
