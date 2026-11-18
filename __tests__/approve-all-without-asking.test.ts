/**
 * settings.approveAllWithoutAsking ("Skip all approvals"): the master switch
 * answers every approval RN can answer — and nothing a hard check refuses.
 * Pure decisions (lib/approve-all-without-asking.ts), the headless drain,
 * registration confirm, and the app/_layout.tsx / ConfigTUI wiring.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  APPROVE_ALL_AUDIT_KEY,
  approveAllActionVerdict,
  approveAllCommandRefusal,
  approveAllEscalationVerdict,
  approveAllMintedRefusal,
  approveAllPolicyBlocks,
  decideApproveAllActionApproval,
  type ApproveAllActionOpts,
} from '@/lib/approve-all-without-asking';
import { UI_ONLY_ENABLE_SETTINGS } from '@/lib/ui-only-settings';
import {
  __resetHeadlessActionDrainForTests,
  drainHeadlessRunWithoutApproval,
  type HeadlessActionDrainDeps,
} from '@/lib/agent-action-approval-headless';
import { resolveRegistrationConfirmRequirement } from '@/lib/widget-agent-registration';

jest.mock('expo-notifications', () => ({ scheduleNotificationAsync: jest.fn() }));

const NOW = 1_800_000_000_000;
const trustedAgent = { prompt: 'Summarize my notes folder into a weekly digest', tool: { type: 'gemini-api' } };
const webAgent = { prompt: 'Research the latest news on https://example.com', tool: { type: 'perplexity' } };

// ── Escalations ───────────────────────────────────────────────────────────

const esc = (over: Record<string, unknown> = {}) => ({
  command: 'cp out/a.js ~/projects/site/a.js',
  signals: ['write-or-exec', 'leaves-root'],
  reason: 'boundary: write-or-exec, leaves-root',
  cwd: '/data/user/0/dev.shelly.terminal/files/home/agent-output',
  workspaceRoot: '/data/user/0/dev.shelly.terminal/files/home/agent-output',
  state: null,
  ...over,
});
const escOpts = (over: Partial<Parameters<typeof approveAllEscalationVerdict>[1]> = {}) => ({
  on: true,
  attended: true,
  ingressTainted: false,
  agent: trustedAgent,
  ...over,
});

describe('escalation verdict', () => {
  it('off: never allows', () => {
    expect(approveAllEscalationVerdict(esc(), escOpts({ on: false }))).toEqual({ ok: false, reason: 'approve-all-off' });
  });

  it('on: allows what the per-agent "all" level would refuse for soft reasons (outside root, network)', () => {
    expect(approveAllEscalationVerdict(esc(), escOpts())).toEqual({ ok: true, kind: 'all' });
    expect(approveAllEscalationVerdict(esc({
      command: 'curl -sS https://api.example.com/status -o status.json',
      signals: ['network-send', 'write-or-exec'],
      reason: 'boundary: network-send, write-or-exec',
    }), escOpts()).ok).toBe(true);
    expect(approveAllEscalationVerdict(esc({ command: 'npm run build', signals: ['write-or-exec'] }), escOpts()).ok).toBe(true);
  });

  it.each([
    ['secret-read'], ['policy-write'], ['indirect-exec'], ['opaque-script-exec'], ['something-new'],
  ])('keeps the %s signal asking', (signal) => {
    expect(approveAllEscalationVerdict(esc({ signals: ['write-or-exec', signal] }), escOpts())).toEqual({ ok: false, reason: `signal:${signal}` });
  });

  it('answers destructive commands inside the home folder (owner decision), but not CRITICAL ones', () => {
    expect(approveAllEscalationVerdict(esc({ command: 'rm -rf ~/demo/build', signals: ['destructive'], reason: 'boundary: destructive' }), escOpts())).toEqual({ ok: true, kind: 'all' });
    expect(approveAllEscalationVerdict(esc({ command: 'rm -rf /', signals: ['destructive'], reason: 'boundary: destructive' }), escOpts())).toEqual({ ok: false, reason: 'safety:CRITICAL' });
  });

  it("answers the owner's own POLICY-001 ask rule, even with no boundary signal", () => {
    expect(approveAllEscalationVerdict(esc({ command: 'git push', signals: [], reason: 'user rule: ask before git push · allowed' }), escOpts())).toEqual({ ok: true, kind: 'all' });
    expect(approveAllEscalationVerdict(esc({ command: 'cat ~/.ssh/id_rsa', signals: [], reason: 'user rule: r1 · allowed' }), escOpts())).toEqual({ ok: false, reason: 'secret-file' });
  });

  it('approveAllPolicyBlocks: deny / draft_only / proactive / unreadable block; an owner ask rule does not', () => {
    expect(approveAllPolicyBlocks({ decision: 'deny', layer: 'deny-rule', ruleId: 'r' })).toBe(true);
    expect(approveAllPolicyBlocks({ decision: 'draft_only', layer: 'draft-rule', ruleId: 'r' })).toBe(true);
    expect(approveAllPolicyBlocks({ decision: 'ask', layer: 'proactive' })).toBe(true);
    expect(approveAllPolicyBlocks({ decision: 'ask', layer: 'ask-rule' })).toBe(true);
    expect(approveAllPolicyBlocks({ decision: 'ask', layer: 'ask-rule', ruleId: 'r1' })).toBe(false);
    expect(approveAllPolicyBlocks({ decision: 'allow', layer: 'trust' })).toBe(false);
    expect(approveAllPolicyBlocks(null)).toBe(false);
  });

  it('keeps CRITICAL, trust-state and credential paths asking (raw and dequoted)', () => {
    expect(approveAllEscalationVerdict(esc({ command: 'rm -rf /' }), escOpts())).toEqual({ ok: false, reason: 'safety:CRITICAL' });
    expect(approveAllEscalationVerdict(esc({ command: 'echo x > ~/.shelly/agents/policy.json' }), escOpts())).toEqual({ ok: false, reason: 'trust-state-path' });
    expect(approveAllEscalationVerdict(esc({ command: "cat ~/'.shelly'/agents/roles.json > x" }), escOpts()).ok).toBe(false);
    expect(approveAllEscalationVerdict(esc({ command: 'cp x /data/data/dev.shelly.terminal/shared_prefs/a.xml' }), escOpts()).ok).toBe(false);
    expect(approveAllEscalationVerdict(esc({ command: 'sqlite3 /data/data/dev.shelly.terminal/databases/RKStorage "select 1"' }), escOpts()).ok).toBe(false);
    expect(approveAllEscalationVerdict(esc({ command: 'cat ~/.ssh/id_rsa > /tmp/k' }), escOpts())).toEqual({ ok: false, reason: 'secret-file' });
    expect(approveAllEscalationVerdict(esc({ command: 'cp .env /tmp/e' }), escOpts())).toEqual({ ok: false, reason: 'secret-file' });
    expect(approveAllEscalationVerdict(esc({ command: 'ls', cwd: '/data/user/0/dev.shelly.terminal/files/home/.shelly/agents' }), escOpts()).ok).toBe(false);
  });

  it('keeps prompt-injection defenses, proactive runs, POLICY-001 and stale requests asking', () => {
    expect(approveAllEscalationVerdict(esc(), escOpts({ ingressTainted: true }))).toEqual({ ok: false, reason: 'ingress-tainted' });
    expect(approveAllEscalationVerdict(esc(), escOpts({ agent: webAgent }))).toEqual({ ok: false, reason: 'untrusted-input' });
    expect(approveAllEscalationVerdict(esc(), escOpts({ agent: { ...trustedAgent, notificationTrigger: { packageNames: ['x'] } } }))).toEqual({ ok: false, reason: 'untrusted-input' });
    expect(approveAllEscalationVerdict(esc(), escOpts({ agent: null }))).toEqual({ ok: false, reason: 'untrusted-input' });
    expect(approveAllEscalationVerdict(esc(), escOpts({ attended: false }))).toEqual({ ok: false, reason: 'proactive' });
    expect(approveAllEscalationVerdict(esc(), escOpts({ policyBlocksAutoAccept: true }))).toEqual({ ok: false, reason: 'policy-ask' });
    expect(approveAllEscalationVerdict(esc({ state: 'queued' }), escOpts())).toEqual({ ok: false, reason: 'not-live' });
    expect(approveAllEscalationVerdict(esc({ reason: 'policy: ask rule r1' }), escOpts())).toEqual({ ok: false, reason: 'not-boundary-gray' });
    expect(approveAllEscalationVerdict(esc({ signals: [] }), escOpts())).toEqual({ ok: false, reason: 'no-signals' });
  });

  it('plain commands have no hard refusal', () => {
    expect(approveAllCommandRefusal('python3 tools/gen.py --out dist')).toBeNull();
    expect(approveAllCommandRefusal('ls /data/user/0/dev.shelly.terminal/files/home/projects')).toBeNull();
  });
});

// ── Actions ───────────────────────────────────────────────────────────────

const action = (over: Record<string, unknown> = {}) => ({
  runId: 'run-1',
  agentId: 'agent-a',
  actionType: 'webhook',
  preview: 'POST https://hooks.example.com',
  ts: '2026-11-19T10:00:00Z',
  expiresAt: NOW + 300_000,
  origin: 'user',
  ...over,
});
const actOpts = (over: Partial<ApproveAllActionOpts> = {}): ApproveAllActionOpts => ({
  on: true,
  ingressTainted: false,
  policyBlocksAutoAccept: false,
  originOf: () => 'user',
  agentFor: () => trustedAgent,
  ...over,
});

describe('action verdict', () => {
  it('off: never allows', () => {
    expect(approveAllActionVerdict(action(), actOpts({ on: false })).ok).toBe(false);
  });

  it.each([['draft'], ['notify'], ['webhook'], ['api-call'], ['social-post']])('on: allows %s', (actionType) => {
    expect(approveAllActionVerdict(action({ actionType }), actOpts()).ok).toBe(true);
  });

  it('allows a cli action unless it is CRITICAL or names trust state', () => {
    expect(approveAllActionVerdict(action({ actionType: 'cli', command: 'git -C ~/repo status' }), actOpts()).ok).toBe(true);
    expect(approveAllActionVerdict(action({ actionType: 'cli', command: 'rm -rf /' }), actOpts())).toEqual({ ok: false, reason: 'safety:CRITICAL' });
    expect(approveAllActionVerdict(action({ actionType: 'cli', command: 'cp a ~/.shelly/agents/agents.json' }), actOpts())).toEqual({ ok: false, reason: 'trust-state-path' });
    expect(approveAllActionVerdict(action({ actionType: 'cli', command: '' }), actOpts())).toEqual({ ok: false, reason: 'no-command' });
  });

  it('intent only where RN fires it, never ClosePaw; dm-reply / browser-pane never', () => {
    expect(approveAllActionVerdict(action({ actionType: 'intent', intentMode: 'launch' }), actOpts()).ok).toBe(false);
    expect(approveAllActionVerdict(action({ actionType: 'intent', intentMode: 'launch' }), actOpts({ allowRnFired: true })).ok).toBe(true);
    expect(approveAllActionVerdict(action({ actionType: 'intent', intentMode: 'closepaw' }), actOpts({ allowRnFired: true }))).toEqual({ ok: false, reason: 'closepaw' });
    expect(approveAllActionVerdict(action({ actionType: 'dm-reply' }), actOpts({ allowRnFired: true })).ok).toBe(false);
    expect(approveAllActionVerdict(action({ actionType: 'browser-pane' }), actOpts({ allowRnFired: true })).ok).toBe(false);
  });

  it('keeps tainted, untrusted-input, proactive and POLICY-001 asking', () => {
    expect(approveAllActionVerdict(action(), actOpts({ ingressTainted: true }))).toEqual({ ok: false, reason: 'ingress-tainted' });
    expect(approveAllActionVerdict(action(), actOpts({ agentFor: () => webAgent }))).toEqual({ ok: false, reason: 'untrusted-input' });
    expect(approveAllActionVerdict(action(), actOpts({ agentFor: () => ({ ...trustedAgent, action: { type: 'dm-reply' } }) }))).toEqual({ ok: false, reason: 'untrusted-input' });
    expect(approveAllActionVerdict(action(), actOpts({ originOf: () => 'event' }))).toEqual({ ok: false, reason: 'proactive' });
    expect(approveAllActionVerdict(action(), actOpts({ policyBlocksAutoAccept: true }))).toEqual({ ok: false, reason: 'policy-ask' });
  });

  it('the minted copy must match, be unexpired and still pass', () => {
    const p = action();
    const ok = { ...p, requestSha256: 's', actionNonce: 'n' };
    expect(approveAllMintedRefusal(p, ok, actOpts(), NOW)).toBeNull();
    expect(approveAllMintedRefusal(p, null, actOpts(), NOW)).toBe('minted-unreadable');
    expect(approveAllMintedRefusal(p, { ...ok, expiresAt: NOW - 1 }, actOpts(), NOW)).toBe('minted-expired');
    expect(approveAllMintedRefusal(p, { ...ok, agentId: 'agent-b' }, actOpts(), NOW)).toBe('minted-mismatch');
    expect(approveAllMintedRefusal(p, { ...ok, actionType: 'social-post' }, actOpts(), NOW)).toBe('minted-mismatch');
    expect(approveAllMintedRefusal(p, ok, actOpts({ on: false }), NOW)).toBe('minted-approve-all-off');
  });

  it('decide: switch turned off between drain and mint answers nothing', async () => {
    const p = action();
    const r = await decideApproveAllActionApproval(p, {
      ...actOpts(),
      isOn: () => false,
      readMinted: async () => ({ ...p, requestSha256: 's', actionNonce: 'n' }),
      now: NOW,
    });
    expect(r).toEqual({ ok: false, reason: 'minted-approve-all-off' });
  });
});

// ── Headless drain ────────────────────────────────────────────────────────

function makeDeps(over: Partial<HeadlessActionDrainDeps> = {}, files: unknown[] = [action()]) {
  const resolved: string[] = [];
  const audits: string[] = [];
  const deps: HeadlessActionDrainDeps = {
    listRequests: async () => files,
    readMinted: async (runId) => {
      const f = files.find((x) => (x as { runId: string }).runId === runId) as Record<string, unknown> | undefined;
      return f ? { ...f, requestSha256: 'sha', actionNonce: 'nonce' } : null;
    },
    resolve: async (runId, decision) => {
      resolved.push(`${runId}|${decision}`);
      return true;
    },
    agentFor: () => trustedAgent,
    getSetting: async () => 'off',
    originOf: () => 'user',
    policyEngineEnabled: () => false,
    evaluatePolicy: async () => 'default',
    audit: () => undefined,
    log: () => undefined,
    now: () => NOW,
    isIngressTainted: async () => false,
    approveAllOn: () => true,
    approveAllToken: async () => '7',
    resolveApproveAll: async (runId, _sha, _nonce, token) => {
      resolved.push(`${runId}|accept-all@${token}`);
      return true;
    },
    auditApproveAll: (agentId, what) => audits.push(`${agentId}|${what}`),
    ...over,
  };
  return { deps, resolved, audits };
}

describe('headless drain with the master switch', () => {
  beforeEach(() => __resetHeadlessActionDrainForTests());

  it('accepts a webhook of an attended trusted agent through the token-checked entry, and writes the audit line', async () => {
    const h = makeDeps();
    await drainHeadlessRunWithoutApproval(h.deps);
    expect(h.resolved).toEqual(['run-1|accept-all@7']);
    expect(h.audits).toEqual(['agent-a|webhook: POST https://hooks.example.com']);
  });

  it('a stale token (switched off / STOP-ALL after the decision) answers nothing and writes no audit line', async () => {
    const h = makeDeps({ resolveApproveAll: async () => false });
    await drainHeadlessRunWithoutApproval(h.deps);
    expect(h.resolved).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it('no token (off / STOP-ALL) or no token-checked entry: the master switch never answers, and never via the generic resolve', async () => {
    for (const over of [{ approveAllToken: async () => null }, { resolveApproveAll: undefined }, { approveAllToken: undefined }] as Partial<HeadlessActionDrainDeps>[]) {
      __resetHeadlessActionDrainForTests();
      const h = makeDeps(over);
      await drainHeadlessRunWithoutApproval(h.deps);
      expect(h.resolved).toEqual([]);
    }
  });

  it('off: unchanged (webhook is not even parsed)', async () => {
    const h = makeDeps({ approveAllOn: () => false });
    await drainHeadlessRunWithoutApproval(h.deps);
    expect(h.resolved).toEqual([]);
  });

  it('never answers RN-fired / untrusted types, tainted, untrusted-input, proactive or policy-blocked requests', async () => {
    const cases: Array<[Partial<HeadlessActionDrainDeps>, Record<string, unknown>]> = [
      [{}, { actionType: 'intent', intentMode: 'launch' }],
      [{}, { actionType: 'dm-reply' }],
      [{ isIngressTainted: async () => true }, {}],
      [{ agentFor: () => webAgent }, {}],
      [{ originOf: () => 'event' }, {}],
      [{ policyEngineEnabled: () => true, evaluatePolicy: async () => 'ask' }, {}],
      [{ policyEngineEnabled: () => true, evaluatePolicy: async () => 'ask', policyBlocksApproveAll: async () => true }, {}],
      [{ policyEngineEnabled: () => true, evaluatePolicy: async () => 'deny', policyBlocksApproveAll: async () => true }, {}],
      [{}, { actionType: 'cli', command: 'rm -rf /' }],
      [{}, { expiresAt: NOW - 1 }],
    ];
    for (const [over, req] of cases) {
      __resetHeadlessActionDrainForTests();
      const h = makeDeps(over, [action(req)]);
      await drainHeadlessRunWithoutApproval(h.deps);
      expect(h.resolved).toEqual([]);
    }
  });
});

// ── Registration confirm ──────────────────────────────────────────────────

describe('registration confirm', () => {
  const base = { agentRegistrationRequireConfirm: true, widgetAgentRegistrationNoConfirm: false };

  it('off: unchanged', () => {
    for (const source of ['ai-pane', 'widget-ask', 'terminal-request', 'monitor-team'] as const) {
      expect(resolveRegistrationConfirmRequirement(base, source)).toBe(true);
    }
  });

  it('on: the user\'s own @agent registers without confirm; terminal / MONITOR requests still confirm', () => {
    const s = { ...base, approveAllWithoutAsking: true };
    expect(resolveRegistrationConfirmRequirement(s, 'ai-pane')).toBe(false);
    expect(resolveRegistrationConfirmRequirement(s, 'widget-ask')).toBe(false);
    expect(resolveRegistrationConfirmRequirement(s, 'terminal-request')).toBe(true);
    expect(resolveRegistrationConfirmRequirement(s, 'monitor-team')).toBe(true);
  });
});

// ── Wiring ────────────────────────────────────────────────────────────────

describe('wiring', () => {
  const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

  it('app/_layout.tsx answers escalations and actions after the per-agent option, and wires the headless drain', () => {
    const src = read('app/_layout.tsx');
    expect(src).toContain('autoApproveEscalationForApproveAll(parsed)');
    const perAgent = src.indexOf('if (await autoApproveEscalation(parsed))');
    const master = src.indexOf('if (await autoApproveEscalationForApproveAll(parsed))');
    expect(perAgent).toBeGreaterThan(0);
    expect(master).toBeGreaterThan(perAgent);
    expect(src).toContain('autoApproveActionForApproveAll(parsed, approveAllPolicyBlocked || proactiveRun)');
    expect(src).toContain('policyBlocksApproveAll: async (req) =>');
    expect(src).toContain('approveAllOn: isApproveAllWithoutAskingOn');
    // The ingress-taint decline runs before every auto-accept path.
    expect(src.indexOf('if (await isIngressTaintedForApproval(parsed.agentId)) {')).toBeLessThan(
      src.indexOf('if (await autoApproveActionForApproveAll('),
    );
  });

  it('ConfigTUI offers the toggle; both locales carry its strings and the audit line', () => {
    expect(read('components/config/ConfigTUI.tsx')).toContain("key: 'approveAllWithoutAsking'");
    for (const loc of ['en', 'ja']) {
      const strings = read(`lib/i18n/locales/${loc}.ts`);
      expect(strings).toContain("'settings.approve_all_without_asking_label'");
      expect(strings).toContain("'settings.approve_all_without_asking_desc'");
      expect(strings).toContain(`'${APPROVE_ALL_AUDIT_KEY}'`);
    }
    expect(read('lib/i18n/locales/ja.ts')).toContain('すべての承認を省略: 自動許可 {{command}}');
    expect(read('lib/i18n/locales/en.ts')).toContain('All approvals skipped: auto-allowed {{command}}');
  });

  it('defaults off and is UI-only', () => {
    expect(read('store/settings-store.ts')).toContain('approveAllWithoutAsking: false');
    expect(UI_ONLY_ENABLE_SETTINGS.has('approveAllWithoutAsking')).toBe(true);
  });
});
