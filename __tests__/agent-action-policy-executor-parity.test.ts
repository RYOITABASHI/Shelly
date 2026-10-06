jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

/**
 * POLICY-001 executor twins: the PlanSpec executor (JS) and the generated
 * .sh (bash) must evaluate the compiled rule lines exactly like the TS
 * reference (lib/agent-action-policy.ts evaluateCompiledLines) and apply the
 * proactive read-only floor fail-closed.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PolicyRule, compilePolicyRuleLines, describeApprovalRequest, evaluateActionPolicy, evaluateCompiledLines } from '@/lib/agent-action-policy';
import { serializeUserPolicyFile } from '@/lib/agent-user-policy-store';
import { generateRunScript } from '@/lib/agent-executor';
import type { Agent, ToolChoice } from '@/store/types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const executor = require('../scripts/shelly-plan-executor.js');

// Real bash subprocesses (slow on Windows Git Bash).
jest.setTimeout(120_000);

const rules: PolicyRule[] = [
  { id: 'r1', effect: 'draft_only', match: { capability: 'post', domain: 'x.com' }, source: 'Xへの投稿は下書きまで', createdAt: 1 },
  { id: 'r2', effect: 'ask', match: { capability: 'payment' }, source: 'お金が絡む操作は必ず聞いて', createdAt: 2 },
  { id: 'r3', effect: 'deny', match: { capability: 'fs-write', outsidePath: '~/work' }, source: '~/work以外には書き込まないで', createdAt: 3 },
  { id: 'r4', effect: 'deny', match: { capability: 'message', keywords: ['secretword'] }, source: 'k', createdAt: 4 },
];
const lines = compilePolicyRuleLines(rules);
const TYPES = ['draft', 'notify', 'webhook', 'cli', 'intent', 'dm-reply', 'api-call', 'social-post', 'browser-pane'];
const HOSTS = ['', 'api.x.com', 'x.com', 'hooks.slack.com', 'notx.com'];
const TEXTS = ['', 'hello', 'Pay the invoice', '支払いを実行', 'the SECRETWORD here'];

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-exec-policy-'));
  delete process.env.SHELLY_AGENT_POLICY_SEAL;
});
afterEach(() => {
  delete process.env.SHELLY_AGENT_POLICY_SEAL;
  fs.rmSync(home, { recursive: true, force: true });
});

/** Writes policy.json AND seals it (as native would export it), like RN does. */
function writePolicy(r: PolicyRule[] = rules) {
  const dir = path.join(home, '.shelly/agents');
  fs.mkdirSync(dir, { recursive: true });
  const text = serializeUserPolicyFile({ rules: r, trust: { counters: {}, allows: [] } }, 1);
  fs.writeFileSync(path.join(dir, 'policy.json'), text);
  process.env.SHELLY_AGENT_POLICY_SEAL = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/** Reference: what both executors must return for (type, host, text, origin). */
function expected(type: string, host: string, text: string, origin: string, unavailable = false): string {
  const eff = evaluateCompiledLines(lines, type, host, text);
  const side = !['', 'draft', 'notify', '__suppressed__'].includes(type);
  if (eff === 'deny' || (eff === 'draft_only' && side)) return eff;
  if (side && origin !== 'user' && origin !== 'widget') return 'ask';
  if (eff === 'ask') return 'ask';
  if (side && unavailable) return 'ask';
  return '';
}

describe('PlanSpec executor twin (scripts/shelly-plan-executor.js)', () => {
  it('compiledPolicyEffect == TS evaluateCompiledLines over the full matrix', () => {
    for (const t of TYPES) for (const h of HOSTS) for (const x of TEXTS) {
      expect(executor.compiledPolicyEffect(lines, t, h, x)).toBe(evaluateCompiledLines(lines, t, h, x));
    }
  });

  describe('policyActionEffect', () => {
    const prevOrigin = process.env.SHELLY_RUN_ORIGIN;
    afterEach(() => {
      if (prevOrigin === undefined) delete process.env.SHELLY_RUN_ORIGIN;
      else process.env.SHELLY_RUN_ORIGIN = prevOrigin;
    });
    const plan = (type: string, action: Record<string, unknown> = {}) => ({ agent: { id: 'a' }, action: { type, ...action } });

    it('is a no-op when the flag is off', () => {
      writePolicy();
      delete process.env.SHELLY_RUN_ORIGIN;
      expect(executor.policyActionEffect({ home }, plan('webhook'), {}, 'webhook', 'x').effect).toBe('');
    });

    it('matches the reference for every origin / type (incl. missing origin)', () => {
      writePolicy();
      for (const origin of ['user', 'widget', 'schedule', 'notification', 'boot', 'event', '', 'bogus']) {
        if (origin) process.env.SHELLY_RUN_ORIGIN = origin;
        else delete process.env.SHELLY_RUN_ORIGIN;
        for (const t of TYPES) for (const x of TEXTS) {
          const got = executor.policyActionEffect({ home }, plan(t), { SHELLY_AGENT_POLICY: '1' }, t, x).effect;
          expect([origin, t, x, got]).toEqual([origin, t, x, expected(t, '', x, origin)]);
        }
      }
    });

    it('uses the action destination host for domain rules', () => {
      writePolicy();
      process.env.SHELLY_RUN_ORIGIN = 'user';
      const cfg = { SHELLY_AGENT_POLICY: '1', SOCIAL_CONNECTOR_XMAIN_HOST: 'api.x.com' };
      const p = plan('social-post', { socialPost: { connectorId: 'xmain' } });
      expect(executor.policyActionEffect({ home }, p, cfg, 'social-post', 'hi').effect).toBe('draft_only');
      const w = plan('webhook', { webhookUrl: 'https://hooks.slack.com/x' });
      expect(executor.policyActionEffect({ home }, w, cfg, 'webhook', 'hi').effect).toBe('');
    });

    it('missing policy.json = no rules; corrupt policy.json escalates side effects', () => {
      process.env.SHELLY_RUN_ORIGIN = 'user';
      expect(executor.policyActionEffect({ home }, plan('cli'), { SHELLY_AGENT_POLICY: '1' }, 'cli', '').effect).toBe('');
      fs.mkdirSync(path.join(home, '.shelly/agents'), { recursive: true });
      fs.writeFileSync(path.join(home, '.shelly/agents/policy.json'), '{bad');
      expect(executor.policyActionEffect({ home }, plan('cli'), { SHELLY_AGENT_POLICY: '1' }, 'cli', '').effect).toBe('ask');
      expect(executor.policyActionEffect({ home }, plan('notify'), { SHELLY_AGENT_POLICY: '1' }, 'notify', '').effect).toBe('');
    });

    it('unattendedPreflightFailure refuses proactive side effects before any model IO', () => {
      process.env.SHELLY_RUN_ORIGIN = 'schedule';
      const cfg = { SHELLY_AGENT_POLICY: '1', SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL: '0' };
      expect(executor.unattendedPreflightFailure({ unattended: '1' }, plan('webhook'), cfg, { home })).toMatch(/proactive run.*cannot run unattended/);
      expect(executor.unattendedPreflightFailure({ unattended: '1' }, plan('notify'), cfg, { home })).toBe('');
      // Flag off ⇒ today's behaviour (webhook allowed unattended in auto mode).
      expect(executor.unattendedPreflightFailure({ unattended: '1' }, plan('webhook'), { SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL: '0' }, { home })).toBe('');
    });
  });
});

describe('generated .sh twin (shelly_policy_action_effect / request_and_wait_approval)', () => {
  const agent = (overrides: Partial<Agent> = {}): Agent => ({
    id: 't', name: 'T', description: '', prompt: 'hi', schedule: null,
    tool: { type: 'local' } as ToolChoice, outputPath: '~/out', outputTemplate: null,
    enabled: true, lastRun: null, lastResult: null, createdAt: 0, version: 1,
    action: { type: 'draft' }, ...overrides,
  });
  const script = generateRunScript(agent());
  const start = script.indexOf('SHELLY_POLICY_FILE="$HOME/.shelly/agents/policy.json"');
  const rwStart = script.indexOf('request_and_wait_approval() {');
  const rwEnd = script.indexOf('\n}', rwStart);
  const policyFns = script.slice(start, rwStart);
  const requestFn = script.slice(rwStart, rwEnd + 2);

  it('the generated script contains the gate, exports the flag and carries origin', () => {
    expect(start).toBeGreaterThan(-1);
    expect(script).toContain('export SHELLY_AGENT_POLICY="${SHELLY_AGENT_POLICY:-0}"');
    expect(script).toContain('"origin":"$origin_json"');
    expect(requestFn).toContain('shelly_policy_action_effect "$approval_type"');
  });

  function bash(body: string, env: Record<string, string>): string {
    const homeFwd = home.replace(/\\/g, '/');
    const file = path.join(home, 'policy-test.sh');
    fs.writeFileSync(file, `set -eu\nHOME='${homeFwd}'\n${policyFns}\n${body}\n`, 'utf8');
    return execFileSync('bash', [file.replace(/\\/g, '/')], {
      encoding: 'utf8',
      env: { ...process.env, ...env, HOME: homeFwd },
    }).trim();
  }

  it('effect matches the TS reference over the matrix (sampled origins)', () => {
    writePolicy();
    const cases: Array<[string, string, string, string]> = [];
    for (const origin of ['user', 'schedule', '']) for (const t of TYPES) for (const h of ['', 'api.x.com', 'notx.com']) for (const x of ['', 'Pay the invoice', 'the SECRETWORD here']) {
      cases.push([origin, t, h, x]);
    }
    const body = cases
      .map(([origin, t, h, x], i) => `${origin ? `SHELLY_RUN_ORIGIN='${origin}'` : 'unset SHELLY_RUN_ORIGIN'}; shelly_policy_action_effect '${t}' '${h}' '${x}'; echo "${i}=$SHELLY_POLICY_EFFECT"`)
      .join('\n');
    const out = bash(body, { SHELLY_AGENT_POLICY: '1' }).split('\n');
    cases.forEach(([origin, t, h, x], i) => {
      expect([origin, t, h, x, out[i]]).toEqual([origin, t, h, x, `${i}=${expected(t, h, x, origin)}`]);
    });
  });

  it('flag off ⇒ no effect at all, even for a proactive run', () => {
    writePolicy();
    expect(bash(`SHELLY_RUN_ORIGIN=schedule; shelly_policy_action_effect webhook '' ''; echo "[$SHELLY_POLICY_EFFECT]"`, { SHELLY_AGENT_POLICY: '0' })).toBe('[]');
  });

  it('a non-Shelly / corrupt policy.json escalates side effects', () => {
    fs.mkdirSync(path.join(home, '.shelly/agents'), { recursive: true });
    fs.writeFileSync(path.join(home, '.shelly/agents/policy.json'), '{"hand":"edited"}');
    expect(bash(`SHELLY_RUN_ORIGIN=user; shelly_policy_action_effect cli '' ''; echo "[$SHELLY_POLICY_EFFECT]"`, { SHELLY_AGENT_POLICY: '1' })).toBe('[ask]');
    expect(bash(`SHELLY_RUN_ORIGIN=user; shelly_policy_action_effect notify '' ''; echo "[$SHELLY_POLICY_EFFECT]"`, { SHELLY_AGENT_POLICY: '1' })).toBe('[]');
  });

  function runRequest(type: string, env: Record<string, string>, host = '', preview = 'x'): string {
    const body = `LOG=""
write_action_approval_request() { LOG="\${LOG}WROTE:$1;"; }
wait_action_approval() { LOG="\${LOG}WAITED:$1;"; return 0; }
write_native_notification_request() { LOG="\${LOG}NOTE:$1;"; }
save_draft_result() { LOG="\${LOG}DRAFT;"; }
${requestFn}
ACTION_APPROVAL_MODE=auto
ACTION_COMMAND_SAFETY_LEVEL=""
ACTION_COMMAND=""
rc=0
request_and_wait_approval '${type}' '${preview}' result.md '${host}' || rc=$?
echo "$LOG|rc=$rc|\${ACTION_DISPATCH_STATUS:-}"`;
    return bash(body, env);
  }

  it('auto mode + user origin + no rule ⇒ unchanged skip (no round trip)', () => {
    writePolicy([]);
    expect(runRequest('webhook', { SHELLY_AGENT_POLICY: '1', SHELLY_RUN_ORIGIN: 'user' })).toBe('|rc=0|');
  });

  it('proactive attended run ⇒ the round trip is FORCED even in auto mode', () => {
    writePolicy([]);
    expect(runRequest('webhook', { SHELLY_AGENT_POLICY: '1', SHELLY_RUN_ORIGIN: 'notification' })).toBe('WROTE:webhook;WAITED:webhook;|rc=0|');
  });

  it('proactive unattended run ⇒ refused without waiting', () => {
    writePolicy([]);
    expect(runRequest('cli', { SHELLY_AGENT_POLICY: '1', SHELLY_RUN_ORIGIN: 'schedule', SHELLY_RUN_UNATTENDED: '1' })).toBe('NOTE:skipped;|rc=1|skipped');
  });

  it('draft_only rule ⇒ draft saved, dispatch skipped', () => {
    writePolicy();
    expect(runRequest('social-post', { SHELLY_AGENT_POLICY: '1', SHELLY_RUN_ORIGIN: 'user' }, 'api.x.com')).toBe('DRAFT;NOTE:skipped;|rc=1|skipped');
  });

  it('deny rule ⇒ refused even for a user run', () => {
    writePolicy();
    expect(runRequest('dm-reply', { SHELLY_AGENT_POLICY: '1', SHELLY_RUN_ORIGIN: 'user' }, '', 'the secretword')).toBe('NOTE:skipped;|rc=1|skipped');
  });

  it('read-only actions are untouched by the proactive floor', () => {
    writePolicy([]);
    expect(runRequest('notify', { SHELLY_AGENT_POLICY: '1', SHELLY_RUN_ORIGIN: 'schedule', SHELLY_RUN_UNATTENDED: '1' })).toBe('|rc=0|');
  });

  // ── security review M1 / L3 / L4 / L5 ─────────────────────────────────────
  const effectOf = (env: Record<string, string>, t = 'webhook', h = '', x = '') =>
    bash(`shelly_policy_action_effect '${t}' '${h}' '${x}'; echo "[$SHELLY_POLICY_EFFECT]"`, { SHELLY_AGENT_POLICY: '1', SHELLY_RUN_ORIGIN: 'user', ...env });

  it('M1: deleted / edited / unsealed policy.json escalates side effects in bash and JS', () => {
    writePolicy();
    const sealed = process.env.SHELLY_AGENT_POLICY_SEAL!;
    expect(effectOf({})).toBe('[]');
    // edited (valid JSON with the deny rule removed)
    fs.writeFileSync(path.join(home, '.shelly/agents/policy.json'), serializeUserPolicyFile({ rules: [], trust: { counters: {}, allows: [] } }, 2));
    expect(effectOf({})).toBe('[ask]');
    process.env.SHELLY_RUN_ORIGIN = 'user';
    expect(executor.policyActionEffect({ home }, { agent: { id: 'a' }, action: { type: 'cli' } }, { SHELLY_AGENT_POLICY: '1' }, 'cli', '').effect).toBe('ask');
    // deleted while sealed
    fs.rmSync(path.join(home, '.shelly/agents/policy.json'));
    expect(effectOf({})).toBe('[ask]');
    expect(executor.policyActionEffect({ home }, { agent: { id: 'a' }, action: { type: 'cli' } }, { SHELLY_AGENT_POLICY: '1' }, 'cli', '').effect).toBe('ask');
    // never sealed, file present
    writePolicy();
    expect(effectOf({ SHELLY_AGENT_POLICY_SEAL: '' })).toBe('[ask]');
    // malformed seal
    expect(effectOf({ SHELLY_AGENT_POLICY_SEAL: 'zz' })).toBe('[ask]');
    // [new, old] transition seal accepted
    expect(effectOf({ SHELLY_AGENT_POLICY_SEAL: `${'a'.repeat(64)},${process.env.SHELLY_AGENT_POLICY_SEAL}` })).toBe('[]');
    expect(sealed).toMatch(/^[0-9a-f]{64}$/);
    // read-only actions are never escalated by an unavailable policy
    expect(effectOf({ SHELLY_AGENT_POLICY_SEAL: '' }, 'notify')).toBe('[]');
    delete process.env.SHELLY_RUN_ORIGIN;
  });

  it('re-review M1: file AND seal deleted after a seal was ever written ⇒ unavailable (bash + JS)', () => {
    // No file, no seal: first run ⇒ nothing.
    expect(effectOf({ SHELLY_AGENT_POLICY_SEAL: '' })).toBe('[]');
    // Same, but native's Keystore marker exists ⇒ the seal was deleted.
    expect(effectOf({ SHELLY_AGENT_POLICY_SEAL: '', SHELLY_AGENT_POLICY_EVER_SEALED: '1' })).toBe('[ask]');
    expect(effectOf({ SHELLY_AGENT_POLICY_SEAL: '', SHELLY_AGENT_POLICY_EVER_SEALED: '1' }, 'notify')).toBe('[]');
    process.env.SHELLY_RUN_ORIGIN = 'user';
    process.env.SHELLY_AGENT_POLICY_EVER_SEALED = '1';
    try {
      expect(executor.policyActionEffect({ home }, { agent: { id: 'a' }, action: { type: 'webhook' } }, { SHELLY_AGENT_POLICY: '1' }, 'webhook', '').effect).toBe('ask');
      expect(executor.policySealAccepts('', null, '1')).toBe(false);
      expect(executor.policySealAccepts('', null, '0')).toBe(true);
    } finally {
      delete process.env.SHELLY_RUN_ORIGIN;
      delete process.env.SHELLY_AGENT_POLICY_EVER_SEALED;
    }
  });

  it('L5: a malformed compiled line makes the policy unavailable (bash + JS)', () => {
    const dir = path.join(home, '.shelly/agents');
    fs.mkdirSync(dir, { recursive: true });
    const text = serializeUserPolicyFile({ rules: [], trust: { counters: {}, allows: [] } }, 1)
      .replace('"compiledActionRules": []', '"compiledActionRules": [\n    "allow|cli||"\n  ]');
    fs.writeFileSync(path.join(dir, 'policy.json'), text);
    process.env.SHELLY_AGENT_POLICY_SEAL = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
    expect(effectOf({})).toBe('[ask]');
    process.env.SHELLY_RUN_ORIGIN = 'user';
    expect(executor.policyActionEffect({ home }, { agent: { id: 'a' }, action: { type: 'cli' } }, { SHELLY_AGENT_POLICY: '1' }, 'cli', '').effect).toBe('ask');
    delete process.env.SHELLY_RUN_ORIGIN;
  });

  it('L3: non-ASCII case folding — node fold matches TS; ASCII-only fallback fails closed to ask', () => {
    const umlaut: PolicyRule[] = [{ id: 'u', effect: 'deny', match: { keywords: ['ärger'] }, source: 'k', createdAt: 1 }];
    writePolicy(umlaut);
    const nodeBin = process.execPath.replace(/\\/g, '/');
    const withNode = `node_usable() { return 0; }\nshelly_node() { "${nodeBin}" "$@"; }\n`;
    const run = (prefix: string, x: string) =>
      bash(`${prefix}shelly_policy_action_effect webhook '' '${x}'; echo "[$SHELLY_POLICY_EFFECT]"`, { SHELLY_AGENT_POLICY: '1', SHELLY_RUN_ORIGIN: 'user' });
    // TS reference: deny for "ÄRGER" (Unicode lowercase), nothing for unrelated text.
    expect(evaluateCompiledLines(compilePolicyRuleLines(umlaut), 'webhook', '', 'ÄRGER'.toLowerCase())).toBe('deny');
    expect(run(withNode, 'großer ÄRGER')).toBe('[deny]');
    expect(run(withNode, 'weather')).toBe('[]');
    // Without node: cannot fold Ä, so an unmatched keyword on non-ASCII text ⇒ ask (never silently "").
    expect(run('', 'großer ÄRGER')).toBe('[ask]');
    expect(run('', 'weather')).toBe('[]');
  });

  it('L4: TS evaluateActionPolicy is the floor — JS and bash are never LESS strict', () => {
    const matrixRules: PolicyRule[] = [
      ...rules,
      { id: 'u', effect: 'ask', match: { keywords: ['ärger'] }, source: 'k', createdAt: 5 },
    ];
    writePolicy(matrixRules);
    const rank = (e: string) => (e === 'deny' ? 3 : e === 'draft_only' ? 2 : e === 'ask' ? 1 : 0);
    const origins = ['user', 'widget', 'USER', 'Widget', 'schedule', 'notification', ''];
    const cmds = ['npm test', 'npm test; python3 x', 'bash -c id', 'git push'];
    const texts = ['hello', 'Pay the invoice', 'großer ÄRGER', 'the SECRETWORD'];
    const cases: Array<{ origin: string; t: string; x: string; cmd: string; ts: number }> = [];
    for (const origin of origins) for (const t of TYPES) for (const x of texts) {
      const cmd = t === 'cli' ? cmds[(x.length + origin.length) % cmds.length] : '';
      const desc = describeApprovalRequest({ actionType: t, preview: x, command: cmd, origin, agentId: 'a1' });
      const v = evaluateActionPolicy(desc, { enabled: true, rules: matrixRules, homeDir: home });
      cases.push({ origin, t, x, cmd, ts: rank(v.decision) });
    }
    // JS twin.
    for (const c of cases) {
      if (c.origin) process.env.SHELLY_RUN_ORIGIN = c.origin;
      else delete process.env.SHELLY_RUN_ORIGIN;
      const js = executor.policyActionEffect({ home }, { agent: { id: 'a1' }, action: { type: c.t, command: c.cmd } }, { SHELLY_AGENT_POLICY: '1' }, c.t, c.x).effect;
      expect([c.origin, c.t, c.x, rank(js) >= c.ts]).toEqual([c.origin, c.t, c.x, true]);
    }
    delete process.env.SHELLY_RUN_ORIGIN;
    // bash twin (one process, ASCII-only fold — the stricter fallback).
    const body = cases
      .map((c, i) => `${c.origin ? `SHELLY_RUN_ORIGIN='${c.origin}'` : 'unset SHELLY_RUN_ORIGIN'}; ACTION_COMMAND='${c.cmd}'; shelly_policy_action_effect '${c.t}' '' '${c.x}\n${c.cmd}'; echo "${i}=$SHELLY_POLICY_EFFECT"`)
      .join('\n');
    const out = bash(body, { SHELLY_AGENT_POLICY: '1' }).split('\n');
    cases.forEach((c, i) => {
      const got = (out[i] || '').split('=')[1] ?? '';
      expect([c.origin, c.t, c.x, rank(got) >= c.ts]).toEqual([c.origin, c.t, c.x, true]);
    });
  });
});
