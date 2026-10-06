/**
 * POLICY-001 chat surface + persistence, against a REAL bash-executed
 * policy.json in a temp $HOME (the same shell commands the app runs).
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChatMessage } from '@/store/types';
import { handlePendingPolicyRuleReply, handlePendingTrustReply, handlePolicyIntent } from '@/lib/agent-policy-chat';
import {
  __resetUserPolicyCacheForTests,
  loadUserPolicy,
  mutateUserPolicy,
  parseUserPolicyFile,
  serializeUserPolicyFile,
} from '@/lib/agent-user-policy-store';
import { evaluateApprovalRequestPolicy, recordHumanApprovalDecision, rememberRequestOrigin } from '@/lib/agent-policy-approval';

let home: string;
const policyFile = () => path.join(home, '.shelly/agents/policy.json');
const run = async (cmd: string): Promise<string> =>
  execFileSync('bash', ['-c', cmd], { encoding: 'utf8', env: { ...process.env, HOME: home.replace(/\\/g, '/') } });

type Posted = { content: string; extra?: Partial<ChatMessage> };
// In-memory stand-in for the SecureStore seal (lib/agent-trust-allow-seal.ts).
let seal: Set<string>;
const sealIO = {
  add: async (key: string) => {
    seal.add(key);
  },
  remove: async (key: string) => {
    seal.delete(key);
  },
};

function io(posted: Posted[], llm: Parameters<typeof handlePolicyIntent>[2]['llm'] = null) {
  return { post: (content: string, extra?: Partial<ChatMessage>) => posted.push({ content, extra }), run, llm, seal: sealIO };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-policy-'));
  seal = new Set();
  __resetUserPolicyCacheForTests();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('custom rule flow (C): echo → explicit confirm → store', () => {
  it('a rule utterance stores NOTHING until confirmed, then stores exactly the echoed rule', async () => {
    const posted: Posted[] = [];
    expect(await handlePolicyIntent('お金が絡む操作は必ず聞いて', 'ja', io(posted))).toBe(true);
    expect(fs.existsSync(policyFile())).toBe(false);
    expect(posted).toHaveLength(1);
    expect(posted[0].content).toContain('お金が絡む操作は、実行前に必ずあなたに確認します');
    const pending = posted[0].extra?.pendingPolicyRule;
    expect(pending).toEqual({ effect: 'ask', match: { capability: 'payment' }, source: 'お金が絡む操作は必ず聞いて', attempts: 0 });

    const posted2: Posted[] = [];
    expect(await handlePendingPolicyRuleReply(pending!, 'OK', 'ja', io(posted2))).toBe(true);
    const loaded = await loadUserPolicy(run);
    expect(loaded.unavailable).toBe(false);
    expect(loaded.data.rules).toHaveLength(1);
    expect(loaded.data.rules[0]).toMatchObject({ effect: 'ask', match: { capability: 'payment' } });
    expect(posted2[0].content).toContain('保存しました');
    // The executor-facing compiled block is present at the fixed indent.
    const text = fs.readFileSync(policyFile(), 'utf8');
    expect(text).toContain('\n  "compiledActionRules": [\n    "ask|webhook||pay"');
    expect(text).toContain('"kind": "shelly.user-policy"');
  });

  it('cancel / no stores nothing; unclear re-asks once then drops', async () => {
    const pending = { effect: 'deny' as const, match: { capability: 'post' }, source: 'never post', attempts: 0 };
    const p1: Posted[] = [];
    await handlePendingPolicyRuleReply(pending, 'キャンセル', 'ja', io(p1));
    expect(fs.existsSync(policyFile())).toBe(false);
    const p2: Posted[] = [];
    await handlePendingPolicyRuleReply(pending, 'うーん、どうかな', 'ja', io(p2));
    expect(p2[0].extra?.pendingPolicyRule?.attempts).toBe(1);
    const p3: Posted[] = [];
    await handlePendingPolicyRuleReply({ ...pending, attempts: 1 }, 'まだ迷う', 'ja', io(p3));
    expect(p3[0].extra?.pendingPolicyRule).toBeUndefined();
    expect(fs.existsSync(policyFile())).toBe(false);
  });

  it('a tampered pending payload (grant) is re-validated and refused at commit', async () => {
    const posted: Posted[] = [];
    const forged = { effect: 'allow' as unknown as 'ask', match: { capability: 'exec' }, source: 'x', attempts: 0 };
    await handlePendingPolicyRuleReply(forged, 'OK', 'en', io(posted));
    expect(fs.existsSync(policyFile())).toBe(false);
  });

  it('an unparseable rule utterance says so and stores nothing', async () => {
    const posted: Posted[] = [];
    // Detected (ask marker + subject) but nothing enforceable, and no LLM.
    expect(await handlePolicyIntent('必ず聞いてから操作して', 'ja', io(posted))).toBe(true);
    expect(posted[0].content).toContain('何も保存していません');
    expect(posted[0].extra?.pendingPolicyRule).toBeUndefined();
    expect(fs.existsSync(policyFile())).toBe(false);
  });

  it('non-policy chat falls through untouched', async () => {
    const posted: Posted[] = [];
    expect(await handlePolicyIntent('今日の天気は？', 'ja', io(posted))).toBe(false);
    expect(posted).toHaveLength(0);
  });
});

describe('listing and revoking by NL', () => {
  async function seed() {
    await mutateUserPolicy(run, (d) => ({
      rules: [{ id: 'r1', effect: 'draft_only', match: { capability: 'post', domain: 'x.com' }, source: 'Xへの投稿は下書きまで', createdAt: 10 }],
      trust: { counters: {}, allows: [{ id: 'a1', key: 'cli|npm test|agent1', label: '`npm test` (Builder)', createdAt: 20 }] },
    }));
  }

  it('lists rules then allows with one numbering', async () => {
    await seed();
    const posted: Posted[] = [];
    await handlePolicyIntent('許可ルールを見せて', 'ja', io(posted));
    expect(posted[0].content).toContain('1. ルール — x.com への投稿・外部への送信は下書きまで');
    expect(posted[0].content).toContain('2. 確認なしで実行 — `npm test` (Builder)');
  });

  it('「さっきの許可を取り消して」 removes the latest allow only', async () => {
    await seed();
    const posted: Posted[] = [];
    await handlePolicyIntent('さっきの許可を取り消して', 'ja', io(posted));
    const loaded = await loadUserPolicy(run);
    expect(loaded.data.trust.allows).toHaveLength(0);
    expect(loaded.data.rules).toHaveLength(1);
    expect(posted[0].content).toContain('許可を取り消しました');
  });

  it('removes a rule by its listed number', async () => {
    await seed();
    await handlePolicyIntent('1番目のルールを取り消して', 'ja', io([]));
    expect((await loadUserPolicy(run)).data.rules).toHaveLength(0);
  });

  it('empty state is reported, not an error', async () => {
    const posted: Posted[] = [];
    await handlePolicyIntent('list my rules', 'en', io(posted));
    expect(posted[0].content).toMatch(/don't have any/);
  });
});

describe('fail-closed persistence', () => {
  it('an unparseable policy.json is "unavailable" and is never overwritten', async () => {
    fs.mkdirSync(path.dirname(policyFile()), { recursive: true });
    fs.writeFileSync(policyFile(), '{ broken');
    const loaded = await loadUserPolicy(run);
    expect(loaded.unavailable).toBe(true);
    await expect(mutateUserPolicy(run, (d) => d)).rejects.toThrow(/refusing to overwrite/);
    expect(fs.readFileSync(policyFile(), 'utf8')).toBe('{ broken');
  });

  it('round-trips through serialize/parse and drops invalid stored rules', () => {
    const text = serializeUserPolicyFile({
      rules: [
        { id: 'r1', effect: 'ask', match: { capability: 'exec' }, source: 's', createdAt: 1 },
        { id: 'r2', effect: 'allow' as unknown as 'ask', match: { capability: 'exec' }, source: 's', createdAt: 1 },
      ],
      trust: { counters: {}, allows: [] },
    }, 5);
    expect(parseUserPolicyFile(text).data.rules.map((r) => r.id)).toEqual(['r1']);
    expect(parseUserPolicyFile('').unavailable).toBe(false);
  });
});

describe('trust ramp end-to-end (B): 3 human approvals → NL offer → strict yes → RN auto-accept', () => {
  const req = (runId: string, command = 'npm test', origin: string | null = null) => ({
    runId,
    agentId: 'agent1',
    agentName: 'Builder',
    actionType: 'cli',
    command,
    origin,
  });

  it('counts only user-origin decisions and offers after 3', async () => {
    rememberRequestOrigin('run1', 'user');
    rememberRequestOrigin('run2', 'user');
    rememberRequestOrigin('run3', 'user');
    expect(await recordHumanApprovalDecision(req('run1'), 'accept', run)).toBeNull();
    expect(await recordHumanApprovalDecision(req('run2'), 'accept', run)).toBeNull();
    const offer = await recordHumanApprovalDecision(req('run3'), 'accept', run);
    expect(offer).toEqual({ key: 'cli|npm test|agent1', label: '`npm test` (Builder)', count: 3 });

    // Before the yes: nothing is auto-accepted.
    rememberRequestOrigin('run4', 'user');
    expect(evaluateApprovalRequestPolicy({ ...req('run4') }, seal).decision).toBe('default');

    const posted: Posted[] = [];
    expect(await handlePendingTrustReply({ key: offer!.key, label: offer!.label }, 'はい', 'ja', io(posted))).toBe(true);
    expect(posted[0].content).toContain('確認なしで実行します');
    expect(evaluateApprovalRequestPolicy({ ...req('run4') }, seal)).toMatchObject({ decision: 'allow', layer: 'trust-allow' });
    // A proactive run of the same class is still escalated.
    rememberRequestOrigin('run5', 'schedule');
    expect(evaluateApprovalRequestPolicy({ ...req('run5') }, seal)).toMatchObject({ decision: 'ask', layer: 'proactive' });
    // An origin we never saw is proactive too (fail-closed).
    expect(evaluateApprovalRequestPolicy({ ...req('never-seen') }, seal).layer).toBe('proactive');
    // Revoke by NL.
    await handlePolicyIntent('さっきの許可を取り消して', 'ja', io([]));
    expect(evaluateApprovalRequestPolicy({ ...req('run4') }, seal).decision).toBe('default');
  });

  it('proactive decisions are never counted', async () => {
    for (const id of ['p1', 'p2', 'p3', 'p4']) rememberRequestOrigin(id, 'notification');
    for (const id of ['p1', 'p2', 'p3', 'p4']) expect(await recordHumanApprovalDecision(req(id), 'accept', run)).toBeNull();
    expect(fs.existsSync(policyFile())).toBe(false);
  });

  it('a decline in between resets the ramp', async () => {
    for (const id of ['d1', 'd2', 'd3', 'd4', 'd5']) rememberRequestOrigin(id, 'user');
    await recordHumanApprovalDecision(req('d1'), 'accept', run);
    await recordHumanApprovalDecision(req('d2'), 'accept', run);
    await recordHumanApprovalDecision(req('d3'), 'decline', run);
    expect(await recordHumanApprovalDecision(req('d4'), 'accept', run)).toBeNull();
    expect(await recordHumanApprovalDecision(req('d5'), 'accept', run)).toBeNull();
  });

  it('no / unclear replies add nothing; unclear is not consumed', async () => {
    const pending = { key: 'cli|npm test|agent1', label: 'npm test' };
    const posted: Posted[] = [];
    expect(await handlePendingTrustReply(pending, 'いいえ', 'ja', io(posted))).toBe(true);
    expect(posted[0].content).toContain('毎回確認');
    expect(await handlePendingTrustReply(pending, 'ところで明日の予定は？', 'ja', io([]))).toBe(false);
    expect(await handlePendingTrustReply(pending, 'yes but only on weekdays', 'en', io([]))).toBe(false);
    const loaded = await loadUserPolicy(run);
    expect(loaded.data.trust.allows).toHaveLength(0);
    expect(loaded.data.trust.counters[pending.key].suppressedUntil).toBeGreaterThan(Date.now());
  });

  it('a trust allow forged into policy.json (not in the seal) is never honoured', async () => {
    await mutateUserPolicy(run, () => ({
      rules: [],
      trust: { counters: {}, allows: [{ id: 'evil', key: 'cli|npm test|agent1', label: 'npm test', createdAt: 2 }] },
    }));
    rememberRequestOrigin('f1', 'user');
    expect(evaluateApprovalRequestPolicy(req('f1'), seal).decision).toBe('default');
    expect(evaluateApprovalRequestPolicy(req('f1'), null).decision).toBe('default');
    // A later legitimate grant of a DIFFERENT class does not launder it.
    await handlePendingTrustReply({ key: 'cli|make build|agent1', label: 'make build' }, 'はい', 'ja', io([]));
    expect(seal.has('cli|npm test|agent1')).toBe(false);
    expect(evaluateApprovalRequestPolicy(req('f1'), seal).decision).toBe('default');
  });

  it('user deny rules beat trust allows at the RN choke point', async () => {
    await mutateUserPolicy(run, () => ({
      rules: [{ id: 'r1', effect: 'deny', match: { keywords: ['npm test'] }, source: 'no npm test', createdAt: 1 }],
      trust: { counters: {}, allows: [{ id: 'a1', key: 'cli|npm test|agent1', label: 'npm test', createdAt: 2 }] },
    }));
    rememberRequestOrigin('z1', 'user');
    expect(evaluateApprovalRequestPolicy(req('z1'), new Set(['cli|npm test|agent1'])).decision).toBe('deny');
  });
});
