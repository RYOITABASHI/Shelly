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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PolicyRule, compilePolicyRuleLines, evaluateCompiledLines } from '@/lib/agent-action-policy';
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
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function writePolicy(r: PolicyRule[] = rules) {
  const dir = path.join(home, '.shelly/agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'policy.json'), serializeUserPolicyFile({ rules: r, trust: { counters: {}, allows: [] } }, 1));
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
});
