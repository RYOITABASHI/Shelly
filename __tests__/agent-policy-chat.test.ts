/**
 * POLICY-001 chat surface + persistence, against a REAL bash-executed
 * policy.json in a temp $HOME (the same shell commands the app runs), with an
 * in-memory stand-in for the SecureStore seals.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChatMessage } from '@/store/types';
import {
  handlePendingPolicyRevokeReply,
  handlePendingPolicyRuleReply,
  handlePendingTrustReply,
  handlePolicyIntent,
} from '@/lib/agent-policy-chat';
import {
  __resetUserPolicyCacheForTests,
  configureUserPolicySealPort,
  loadUserPolicy,
  mutateUserPolicy,
  parseUserPolicyFile,
  serializeUserPolicyFile,
} from '@/lib/agent-user-policy-store';
import { evaluateApprovalRequestPolicy, recordHumanApprovalDecision } from '@/lib/agent-policy-approval';
import { __resetRunOriginRegistryForTests, markUserRunStarted } from '@/lib/agent-run-origin-registry';
import { describeApprovalRequest } from '@/lib/agent-action-policy';
import { trustKeyOf } from '@/lib/agent-trust-ramp';

jest.setTimeout(60_000);

let home: string;
const policyFile = () => path.join(home, '.shelly/agents/policy.json');
const run = async (cmd: string): Promise<string> =>
  execFileSync('bash', ['-c', cmd], { encoding: 'utf8', env: { ...process.env, HOME: home.replace(/\\/g, '/') } });

type Posted = { content: string; extra?: Partial<ChatMessage> };
// In-memory stand-ins for the SecureStore seals.
let allowSeal: Set<string>;
let fileSeal: string[];
const sealIO = {
  add: async (key: string) => {
    allowSeal.add(key);
  },
  remove: async (key: string) => {
    allowSeal.delete(key);
  },
};

function io(posted: Posted[], llm: Parameters<typeof handlePolicyIntent>[2]['llm'] = null) {
  return { post: (content: string, extra?: Partial<ChatMessage>) => posted.push({ content, extra }), run, llm, seal: sealIO };
}

const K = (command: string, agentId = 'agent1'): string => {
  const key = trustKeyOf(describeApprovalRequest({ actionType: 'cli', command, agentId, origin: 'user' }));
  if (!key) throw new Error(`ineligible: ${command}`);
  return key;
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-policy-'));
  allowSeal = new Set();
  fileSeal = [];
  configureUserPolicySealPort({
    read: async () => fileSeal.slice(),
    write: async (hashes) => {
      fileSeal = hashes.slice();
    },
  });
  __resetUserPolicyCacheForTests();
  __resetRunOriginRegistryForTests();
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
    const text = fs.readFileSync(policyFile(), 'utf8');
    expect(text).toContain('\n  "compiledActionRules": [\n    "ask|webhook||pay"');
    expect(text).toContain('"kind": "shelly.user-policy"');
    // The seal now holds exactly the hash of the bytes on disk.
    expect(fileSeal).toHaveLength(1);
    expect(fileSeal[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('cancel / no stores nothing; unclear re-asks once then drops', async () => {
    const pending = { effect: 'deny' as const, match: { capability: 'post' }, source: 'never post', attempts: 0 };
    await handlePendingPolicyRuleReply(pending, 'キャンセル', 'ja', io([]));
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
    const forged = { effect: 'allow' as unknown as 'ask', match: { capability: 'exec' }, source: 'x', attempts: 0 };
    await handlePendingPolicyRuleReply(forged, 'OK', 'en', io([]));
    expect(fs.existsSync(policyFile())).toBe(false);
  });

  it('an unparseable rule utterance says so and stores nothing', async () => {
    const posted: Posted[] = [];
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
    await mutateUserPolicy(run, () => ({
      rules: [{ id: 'r1', effect: 'draft_only', match: { capability: 'post', domain: 'x.com' }, source: 'Xへの投稿は下書きまで', createdAt: 10 }],
      trust: { counters: {}, allows: [{ id: 'a1', key: K('npm test'), label: '`npm test` (Builder)', createdAt: 20 }] },
    }));
  }

  it('lists rules then allows with one numbering', async () => {
    await seed();
    const posted: Posted[] = [];
    await handlePolicyIntent('許可ルールを見せて', 'ja', io(posted));
    expect(posted[0].content).toContain('1. ルール — x.com への投稿・外部への送信は下書きまで');
    expect(posted[0].content).toContain('2. 確認なしで実行 — `npm test` (Builder)');
  });

  it('「さっきの許可を取り消して」 removes the latest allow immediately (tightening)', async () => {
    await seed();
    allowSeal.add(K('npm test'));
    const posted: Posted[] = [];
    await handlePolicyIntent('さっきの許可を取り消して', 'ja', io(posted));
    const loaded = await loadUserPolicy(run);
    expect(loaded.data.trust.allows).toHaveLength(0);
    expect(loaded.data.rules).toHaveLength(1);
    expect(allowSeal.has(K('npm test'))).toBe(false);
    expect(posted[0].content).toContain('許可を取り消しました');
  });

  it('removing a RULE (loosening) needs the echoed confirm + exact phrase (L1)', async () => {
    await seed();
    const posted: Posted[] = [];
    await handlePolicyIntent('1番目のルールを取り消して', 'ja', io(posted));
    // Nothing removed yet — only the echo with a pending marker.
    expect((await loadUserPolicy(run)).data.rules).toHaveLength(1);
    expect(posted[0].content).toContain('緩くなります');
    const pending = posted[0].extra?.pendingPolicyRevoke;
    expect(pending).toEqual({ ruleId: 'r1', attempts: 0 });

    // Unclear ⇒ re-ask, still kept; cancel ⇒ kept.
    const p2: Posted[] = [];
    await handlePendingPolicyRevokeReply(pending!, 'うーん', 'ja', io(p2));
    expect(p2[0].extra?.pendingPolicyRevoke?.attempts).toBe(1);
    await handlePendingPolicyRevokeReply(pending!, 'キャンセル', 'ja', io([]));
    expect((await loadUserPolicy(run)).data.rules).toHaveLength(1);

    // Exact confirm ⇒ removed.
    const p3: Posted[] = [];
    await handlePendingPolicyRevokeReply(pending!, 'OK', 'ja', io(p3));
    expect((await loadUserPolicy(run)).data.rules).toHaveLength(0);
    expect(p3[0].content).toContain('ルールを削除しました');
  });

  it('empty state is reported, not an error', async () => {
    const posted: Posted[] = [];
    await handlePolicyIntent('list my rules', 'en', io(posted));
    expect(posted[0].content).toMatch(/don't have any/);
  });
});

describe('fail-closed persistence + seal (M1, L5)', () => {
  async function seedRule() {
    await mutateUserPolicy(run, () => ({
      rules: [{ id: 'r1', effect: 'deny', match: { capability: 'post' }, source: 'never post', createdAt: 1 }],
      trust: { counters: {}, allows: [] },
    }));
    expect((await loadUserPolicy(run)).unavailable).toBe(false);
  }

  it('an unparseable policy.json is "unavailable" and is never overwritten', async () => {
    fs.mkdirSync(path.dirname(policyFile()), { recursive: true });
    fs.writeFileSync(policyFile(), '{ broken');
    expect((await loadUserPolicy(run)).unavailable).toBe(true);
    await expect(mutateUserPolicy(run, (d) => d)).rejects.toThrow(/refusing to overwrite/);
    expect(fs.readFileSync(policyFile(), 'utf8')).toBe('{ broken');
  });

  it('deleting the sealed file ⇒ unavailable (a deny rule cannot be removed by deletion)', async () => {
    await seedRule();
    fs.rmSync(policyFile());
    expect((await loadUserPolicy(run)).unavailable).toBe(true);
    await expect(mutateUserPolicy(run, (d) => d)).rejects.toThrow(/refusing to overwrite/);
  });

  it('editing the sealed file (even into valid JSON) ⇒ unavailable', async () => {
    await seedRule();
    const emptied = serializeUserPolicyFile({ rules: [], trust: { counters: {}, allows: [] } }, 1);
    fs.writeFileSync(policyFile(), emptied);
    const loaded = await loadUserPolicy(run);
    expect(loaded.unavailable).toBe(true);
    // And re-sealing it through a later legitimate write is refused (no laundering).
    await expect(mutateUserPolicy(run, (d) => d)).rejects.toThrow(/seal/);
  });

  it('a non-empty file with no seal at all ⇒ unavailable; a missing seal port ⇒ unavailable', async () => {
    fs.mkdirSync(path.dirname(policyFile()), { recursive: true });
    fs.writeFileSync(policyFile(), serializeUserPolicyFile({ rules: [], trust: { counters: {}, allows: [] } }, 1));
    expect((await loadUserPolicy(run)).unavailable).toBe(true);
    configureUserPolicySealPort(null);
    fs.rmSync(policyFile());
    expect((await loadUserPolicy(run)).unavailable).toBe(true);
  });

  it('the [new, old] transition seal keeps a crash between the two writes verifiable', async () => {
    await seedRule();
    const oldSeal = fileSeal[0];
    let mid: string[] = [];
    configureUserPolicySealPort({
      read: async () => fileSeal.slice(),
      write: async (h) => {
        if (!mid.length) mid = h.slice();
        fileSeal = h.slice();
      },
    });
    await mutateUserPolicy(run, (d) => ({ ...d, rules: [] }));
    expect(mid).toHaveLength(2);
    expect(mid[1]).toBe(oldSeal);
  });

  it('L5: a stored file with one invalid rule, or a compiled block that disagrees, is unavailable', () => {
    const withBad = serializeUserPolicyFile({
      rules: [
        { id: 'r1', effect: 'ask', match: { capability: 'exec' }, source: 's', createdAt: 1 },
        { id: 'r2', effect: 'allow' as unknown as 'ask', match: { capability: 'exec' }, source: 's', createdAt: 1 },
      ],
      trust: { counters: {}, allows: [] },
    }, 5);
    expect(parseUserPolicyFile(withBad).unavailable).toBe(true);
    const good = JSON.parse(serializeUserPolicyFile({
      rules: [{ id: 'r1', effect: 'deny', match: { capability: 'post' }, source: 's', createdAt: 1 }],
      trust: { counters: {}, allows: [] },
    }, 5));
    good.compiledActionRules = [];
    expect(parseUserPolicyFile(JSON.stringify(good)).unavailable).toBe(true);
    expect(parseUserPolicyFile('').unavailable).toBe(false);
  });
});

describe('trust ramp end-to-end (B): 3 human approvals → NL offer → strict yes → RN auto-accept', () => {
  const req = (runId: string, command = 'npm test', fileOrigin: string | null = 'user') => ({
    runId,
    agentId: 'agent1',
    agentName: 'Builder',
    actionType: 'cli',
    command,
    // The executor-written, UNTRUSTED origin — must never matter (M2).
    origin: fileOrigin,
  });

  it('counts only RN-registered user runs and offers after 3 with the exact command', async () => {
    markUserRunStarted('agent1');
    expect(await recordHumanApprovalDecision(req('run1'), 'accept', run)).toBeNull();
    expect(await recordHumanApprovalDecision(req('run2'), 'accept', run)).toBeNull();
    const offer = await recordHumanApprovalDecision(req('run3'), 'accept', run);
    expect(offer).toEqual({
      key: K('npm test'),
      label: '`npm test` (Builder)',
      command: 'npm test',
      agentId: 'agent1',
      agentName: 'Builder',
      count: 3,
    });

    expect(evaluateApprovalRequestPolicy(req('run4'), allowSeal).decision).toBe('default');

    const posted: Posted[] = [];
    expect(
      await handlePendingTrustReply({ key: offer!.key, label: offer!.label, command: offer!.command, agentId: offer!.agentId }, 'はい', 'ja', io(posted)),
    ).toBe(true);
    expect(posted[0].content).toContain('確認なしで実行します');
    expect(evaluateApprovalRequestPolicy(req('run4'), allowSeal)).toMatchObject({ decision: 'allow', layer: 'trust-allow' });
    // A drifted command from the same agent is NOT covered (H1).
    expect(evaluateApprovalRequestPolicy(req('run5', 'npm test; python3 evil.py'), allowSeal).decision).toBe('default');
    expect(evaluateApprovalRequestPolicy(req('run6', 'npm test --bail'), allowSeal).decision).toBe('default');
    // Revoke by NL (tightening ⇒ immediate).
    await handlePolicyIntent('さっきの許可を取り消して', 'ja', io([]));
    expect(evaluateApprovalRequestPolicy(req('run4'), allowSeal).decision).toBe('default');
  });

  it('a run RN did not start is proactive even when the request file claims "user" (M2)', async () => {
    for (const id of ['p1', 'p2', 'p3', 'p4']) expect(await recordHumanApprovalDecision(req(id, 'npm test', 'user'), 'accept', run)).toBeNull();
    expect(fs.existsSync(policyFile())).toBe(false);
    expect(evaluateApprovalRequestPolicy(req('p5'), allowSeal).layer).toBe('proactive');
  });

  it('a decline in between resets the ramp', async () => {
    markUserRunStarted('agent1');
    await recordHumanApprovalDecision(req('d1'), 'accept', run);
    await recordHumanApprovalDecision(req('d2'), 'accept', run);
    await recordHumanApprovalDecision(req('d3'), 'decline', run);
    expect(await recordHumanApprovalDecision(req('d4'), 'accept', run)).toBeNull();
    expect(await recordHumanApprovalDecision(req('d5'), 'accept', run)).toBeNull();
  });

  it('no / unclear replies add nothing; unclear is not consumed', async () => {
    const pending = { key: K('npm test'), label: 'npm test', command: 'npm test', agentId: 'agent1' };
    const posted: Posted[] = [];
    expect(await handlePendingTrustReply(pending, 'いいえ', 'ja', io(posted))).toBe(true);
    expect(posted[0].content).toContain('毎回確認');
    expect(await handlePendingTrustReply(pending, 'ところで明日の予定は？', 'ja', io([]))).toBe(false);
    expect(await handlePendingTrustReply(pending, 'yes but only on weekdays', 'en', io([]))).toBe(false);
    const loaded = await loadUserPolicy(run);
    expect(loaded.data.trust.allows).toHaveLength(0);
    expect(loaded.data.trust.counters[pending.key].suppressedUntil).toBeGreaterThan(Date.now());
  });

  it('L2: a yes to a tampered proposal (key/command mismatch, ineligible command) grants nothing', async () => {
    const bad = [
      { key: K('npm test'), label: 'x', command: 'npm test; id', agentId: 'agent1' },
      { key: K('npm test'), label: 'x', command: 'npm test', agentId: 'agent2' },
      { key: K('npm test'), label: 'x' },
    ];
    for (const p of bad) {
      const posted: Posted[] = [];
      expect(await handlePendingTrustReply(p, 'はい', 'ja', io(posted))).toBe(true);
      expect(posted[0].content).toContain('保存できませんでした');
    }
    expect(fs.existsSync(policyFile())).toBe(false);
    expect(allowSeal.size).toBe(0);
  });

  it('a trust allow present in policy.json but not in the allow seal is never honoured', async () => {
    await mutateUserPolicy(run, () => ({
      rules: [],
      trust: { counters: {}, allows: [{ id: 'evil', key: K('npm test'), label: 'npm test', createdAt: 2 }] },
    }));
    markUserRunStarted('agent1');
    expect(evaluateApprovalRequestPolicy(req('f1'), allowSeal).decision).toBe('default');
    expect(evaluateApprovalRequestPolicy(req('f1'), null).decision).toBe('default');
    await handlePendingTrustReply({ key: K('cargo build'), label: 'cargo build', command: 'cargo build', agentId: 'agent1' }, 'はい', 'ja', io([]));
    expect(allowSeal.has(K('npm test'))).toBe(false);
    expect(evaluateApprovalRequestPolicy(req('f1'), allowSeal).decision).toBe('default');
  });

  it('user deny rules beat trust allows at the RN choke point', async () => {
    await mutateUserPolicy(run, () => ({
      rules: [{ id: 'r1', effect: 'deny', match: { keywords: ['npm test'] }, source: 'no npm test', createdAt: 1 }],
      trust: { counters: {}, allows: [{ id: 'a1', key: K('npm test'), label: 'npm test', createdAt: 2 }] },
    }));
    markUserRunStarted('agent1');
    expect(evaluateApprovalRequestPolicy(req('z1'), new Set([K('npm test')])).decision).toBe('deny');
  });
});
