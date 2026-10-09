jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

/**
 * Owner decision 2026-10-09 (option A): on an UNATTENDED run (scheduled /
 * notification / boot fire) the local-only actions — draft (scoped file
 * write) and notify (local notification) — do NOT need the per-run manual
 * approval tap. Every other action type keeps its existing unattended
 * behavior, and POLICY-001 (`ask` rule / proactive floor / unavailable
 * policy) still wins.
 *
 * Three copies of this rule must agree:
 *   - TS:   lib/agent-action-types.ts UNATTENDED_LOCAL_ONLY_ACTION_TYPES / runWaitsOnApprovalTap
 *   - JS:   scripts/shelly-plan-executor.js isUnattendedLocalOnlyAction / unattendedPreflightFailure
 *   - bash: lib/agent-executor.ts generated request_and_wait_approval
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ALL_APPROVAL_ACTION_TYPES,
  UNATTENDED_LOCAL_ONLY_ACTION_TYPES,
  isUnattendedLocalOnlyActionType,
  runWaitsOnApprovalTap,
} from '@/lib/agent-action-types';
import type { PolicyRule } from '@/lib/agent-action-policy';
import { serializeUserPolicyFile } from '@/lib/agent-user-policy-store';
import { generateRunScript } from '@/lib/agent-executor';
import type { Agent, ToolChoice } from '@/store/types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const executor = require('../scripts/shelly-plan-executor.js');

// Real bash subprocesses (slow on Windows Git Bash).
jest.setTimeout(120_000);

const root = path.resolve(__dirname, '..');
const LOCAL_ONLY = new Set<string>(UNATTENDED_LOCAL_ONLY_ACTION_TYPES);
const literalsIn = (text: string) => new Set(Array.from(text.matchAll(/'([a-z_-]+)'/g), (m) => m[1]));

const agent = (overrides: Partial<Agent> = {}): Agent => ({
  id: 't', name: 'T', description: '', prompt: 'hi', schedule: null,
  tool: { type: 'local' } as ToolChoice, outputPath: '~/out', outputTemplate: null,
  enabled: true, lastRun: null, lastResult: null, createdAt: 0, version: 1,
  action: { type: 'draft' }, ...overrides,
});
const script = generateRunScript(agent());
const policyStart = script.indexOf('SHELLY_POLICY_FILE="$HOME/.shelly/agents/policy.json"');
const rwStart = script.indexOf('request_and_wait_approval() {');
const rwEnd = script.indexOf('\n}', rwStart);
const policyFns = script.slice(policyStart, rwStart);
const requestFn = script.slice(rwStart, rwEnd + 2);

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-unattended-local-'));
  delete process.env.SHELLY_AGENT_POLICY_SEAL;
  delete process.env.SHELLY_RUN_ORIGIN;
});
afterEach(() => {
  delete process.env.SHELLY_AGENT_POLICY_SEAL;
  delete process.env.SHELLY_RUN_ORIGIN;
  fs.rmSync(home, { recursive: true, force: true });
});

function writePolicy(rules: PolicyRule[]) {
  const dir = path.join(home, '.shelly/agents');
  fs.mkdirSync(dir, { recursive: true });
  const text = serializeUserPolicyFile({ rules, trust: { counters: {}, allows: [] } }, 1);
  fs.writeFileSync(path.join(dir, 'policy.json'), text);
  process.env.SHELLY_AGENT_POLICY_SEAL = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function bash(body: string, env: Record<string, string>): string {
  const homeFwd = home.replace(/\\/g, '/');
  const file = path.join(home, 'unattended-test.sh');
  fs.writeFileSync(file, `set -eu\nHOME='${homeFwd}'\n${policyFns}\n${body}\n`, 'utf8');
  return execFileSync('bash', [file.replace(/\\/g, '/')], {
    encoding: 'utf8',
    env: { ...process.env, ...env, HOME: homeFwd },
  }).trim();
}

/** Runs the REAL generated request_and_wait_approval for each type; one line per type. */
function runRequests(types: readonly string[], mode: 'auto' | 'manual', env: Record<string, string>, preview = 'x'): Record<string, string> {
  const body = `${requestFn}
write_action_approval_request() { LOG="\${LOG}WROTE:$1;"; }
wait_action_approval() { LOG="\${LOG}WAITED:$1;"; return 0; }
write_native_notification_request() { LOG="\${LOG}NOTE:$1;"; }
save_draft_result() { LOG="\${LOG}DRAFT;"; }
ACTION_APPROVAL_MODE=${mode}
ACTION_COMMAND_SAFETY_LEVEL=""
ACTION_COMMAND=""
for t in ${types.join(' ')}; do
  LOG=""; ACTION_DISPATCH_STATUS=""; SHELLY_UNATTENDED_LOCAL_BYPASS=0; rc=0
  request_and_wait_approval "$t" '${preview}' result.md '' || rc=$?
  echo "$t=$LOG|rc=$rc|$ACTION_DISPATCH_STATUS|bypass=$SHELLY_UNATTENDED_LOCAL_BYPASS"
done`;
  const out: Record<string, string> = {};
  for (const line of bash(body, env).split('\n')) {
    const i = line.indexOf('=');
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

const plan = (type: string, agentOverrides: Record<string, unknown> = {}) => ({
  agent: { id: 'a', ...agentOverrides },
  tool: { type: 'local' },
  action: { type, socialPost: { connectorId: 'xmain' } },
});

describe('the local-only set is identical in TS / JS / bash', () => {
  it('TS constant is exactly draft + notify', () => {
    expect([...UNATTENDED_LOCAL_ONLY_ACTION_TYPES].sort()).toEqual(['draft', 'notify']);
  });

  it('JS isUnattendedLocalOnlyAction (script + byte-identical APK asset) lists the same types', () => {
    for (const file of [
      path.join(root, 'scripts', 'shelly-plan-executor.js'),
      path.join(root, 'modules/terminal-emulator/android/src/main/assets/shelly-plan-executor.js'),
    ]) {
      const src = fs.readFileSync(file, 'utf8');
      const start = src.indexOf('function isUnattendedLocalOnlyAction(actionType) {');
      expect(start).toBeGreaterThan(-1);
      expect(literalsIn(src.slice(start, src.indexOf('\n}', start)))).toEqual(LOCAL_ONLY);
    }
    for (const t of ALL_APPROVAL_ACTION_TYPES) {
      expect([t, executor.isUnattendedLocalOnlyAction(t)]).toEqual([t, isUnattendedLocalOnlyActionType(t)]);
    }
  });

  it('bash request_and_wait_approval unattended early-return case lists the same types', () => {
    const anchor = requestFn.indexOf('if [ "${SHELLY_RUN_UNATTENDED:-0}" = "1" ] && [ "$SHELLY_POLICY_FORCE_MANUAL" != "1" ]; then');
    expect(anchor).toBeGreaterThan(-1);
    const block = requestFn.slice(anchor, requestFn.indexOf('\n  fi', anchor));
    const pattern = block.match(/\n\s+([a-z|_-]+)\)/);
    expect(pattern).not.toBeNull();
    expect(new Set(pattern![1].split('|'))).toEqual(LOCAL_ONLY);
  });
});

describe('matrix: unattended + manual approval mode (the default)', () => {
  it('JS preflight: draft/notify allowed; every other type still refused', () => {
    for (const t of ALL_APPROVAL_ACTION_TYPES) {
      const failure = executor.unattendedPreflightFailure({ unattended: '1' }, plan(t), {});
      if (LOCAL_ONLY.has(t)) {
        expect([t, failure]).toEqual([t, '']);
      } else {
        expect([t, failure]).not.toEqual([t, '']);
      }
    }
    // cli/webhook/api-call keep the precise pre-existing manual-approval reason.
    for (const t of ['cli', 'webhook', 'api-call']) {
      expect(executor.unattendedPreflightFailure({ unattended: '1' }, plan(t), {})).toBe(
        `${t} action requires manual approval and cannot run unattended`,
      );
    }
    // per-agent requireActionApproval:true behaves the same as the global default.
    expect(executor.unattendedPreflightFailure({ unattended: '1' }, plan('draft', { requireActionApproval: true }), {})).toBe('');
    expect(executor.unattendedPreflightFailure({ unattended: '1' }, plan('webhook', { requireActionApproval: true }), {})).toContain(
      'requires manual approval and cannot run unattended',
    );
  });

  it('bash: draft/notify return 0 with no approval request (and arm the root-confinement flag); others still write+wait', () => {
    const out = runRequests(ALL_APPROVAL_ACTION_TYPES, 'manual', { SHELLY_RUN_UNATTENDED: '1' });
    for (const t of ALL_APPROVAL_ACTION_TYPES) {
      if (LOCAL_ONLY.has(t)) expect([t, out[t]]).toEqual([t, '|rc=0||bypass=1']);
      else expect([t, out[t]]).toEqual([t, `WROTE:${t};WAITED:${t};|rc=0||bypass=0`]);
    }
  });

  it('TS runWaitsOnApprovalTap agrees with both executors', () => {
    for (const t of ALL_APPROVAL_ACTION_TYPES) {
      expect([t, runWaitsOnApprovalTap(t, true, true)]).toEqual([t, !LOCAL_ONLY.has(t)]);
    }
  });
});

describe('unchanged paths', () => {
  it('attended + manual: draft/notify still request the approval tap (bash) and TS says so', () => {
    const out = runRequests(['draft', 'notify'], 'manual', { SHELLY_RUN_UNATTENDED: '0' });
    expect(out.draft).toBe('WROTE:draft;WAITED:draft;|rc=0||bypass=0');
    expect(out.notify).toBe('WROTE:notify;WAITED:notify;|rc=0||bypass=0');
    expect(runWaitsOnApprovalTap('draft', true, false)).toBe(true);
  });

  it('unattended + auto: nothing changes for draft/notify (already no tap) and the confinement flag is NOT armed', () => {
    const out = runRequests(['draft', 'notify', 'webhook'], 'auto', { SHELLY_RUN_UNATTENDED: '1' });
    expect(out.draft).toBe('|rc=0||bypass=0');
    expect(out.notify).toBe('|rc=0||bypass=0');
    expect(out.webhook).toBe('|rc=0||bypass=0');
    expect(executor.unattendedPreflightFailure({ unattended: '1' }, plan('webhook'), { SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL: '0' })).toBe('');
  });

  it('intent / dm-reply / browser-pane stay hard-refused unattended regardless of approval mode', () => {
    for (const t of ['intent', 'dm-reply', 'browser-pane']) {
      expect(executor.unattendedPreflightFailure({ unattended: '1' }, plan(t), { SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL: '0' })).toBe(
        `unsupported unattended PlanSpec action: ${t}`,
      );
    }
  });
});

describe('POLICY-001 still takes precedence over the local-only exemption', () => {
  const askEverything: PolicyRule[] = [{ id: 'all', effect: 'ask', match: {}, source: '全部聞いて', createdAt: 1 }];
  const askBriefing: PolicyRule[] = [{ id: 'kw', effect: 'ask', match: { keywords: ['briefing'] }, source: 'briefingは聞いて', createdAt: 1 }];

  it('JS: an ask rule matching draft/notify refuses them unattended', () => {
    writePolicy(askEverything);
    process.env.SHELLY_RUN_ORIGIN = 'schedule';
    const cfg = { SHELLY_AGENT_POLICY: '1' };
    for (const t of ['draft', 'notify']) {
      expect(executor.unattendedPreflightFailure({ unattended: '1' }, plan(t), cfg, { home })).toMatch(/needs approval: user policy rule and cannot run unattended/);
    }
  });

  it('bash: an ask rule (blanket or keyword) refuses draft/notify unattended instead of skipping the tap', () => {
    writePolicy(askEverything);
    const out = runRequests(['draft', 'notify'], 'manual', { SHELLY_AGENT_POLICY: '1', SHELLY_RUN_ORIGIN: 'schedule', SHELLY_RUN_UNATTENDED: '1' });
    expect(out.draft).toBe('NOTE:skipped;|rc=1|skipped|bypass=0');
    expect(out.notify).toBe('NOTE:skipped;|rc=1|skipped|bypass=0');

    writePolicy(askBriefing);
    const kw = runRequests(['draft'], 'manual', { SHELLY_AGENT_POLICY: '1', SHELLY_RUN_ORIGIN: 'schedule', SHELLY_RUN_UNATTENDED: '1' }, 'AI briefing');
    expect(kw.draft).toBe('NOTE:skipped;|rc=1|skipped|bypass=0');
    const noKw = runRequests(['draft'], 'manual', { SHELLY_AGENT_POLICY: '1', SHELLY_RUN_ORIGIN: 'schedule', SHELLY_RUN_UNATTENDED: '1' }, 'weather');
    expect(noKw.draft).toBe('|rc=0||bypass=1');
  });

  it('policy ON with no rules: the proactive floor already allows draft/notify unattended (both executors)', () => {
    writePolicy([]);
    process.env.SHELLY_RUN_ORIGIN = 'schedule';
    const cfg = { SHELLY_AGENT_POLICY: '1' };
    expect(executor.unattendedPreflightFailure({ unattended: '1' }, plan('draft'), cfg, { home })).toBe('');
    expect(executor.unattendedPreflightFailure({ unattended: '1' }, plan('webhook'), cfg, { home })).toMatch(/proactive run.*cannot run unattended/);
    const out = runRequests(['draft', 'notify'], 'manual', { SHELLY_AGENT_POLICY: '1', SHELLY_RUN_ORIGIN: 'schedule', SHELLY_RUN_UNATTENDED: '1' });
    expect(out.draft).toBe('|rc=0||bypass=1');
    expect(out.notify).toBe('|rc=0||bypass=1');
  });
});

describe('bash: unattended bypass writes stay inside the scoped output roots (cap_dest_within_roots / cap_fs_write_file)', () => {
  const fnStart = script.indexOf('cap_fs_write_file() {');
  const fnEnd = script.indexOf('\n}', script.indexOf('cap_dest_within_roots() {'));
  const fsFns = script.slice(fnStart, fnEnd + 2);
  // cap_dest_within_roots requires an absolute POSIX path (always true on
  // Android); on Windows Git Bash map "C:\x" to "/c/x".
  const posixHome = () => home.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`);

  function write(dest: string, extra: Record<string, string> = {}): string {
    const homeFwd = posixHome();
    const assign = Object.entries(extra).map(([k, v]) => `${k}='${v}'`).join('\n');
    const body = `${fsFns}
TMP_DIR='${homeFwd}/tmp'
mkdir -p "$TMP_DIR"
printf 'hello' > "$TMP_DIR/src.md"
node_usable() { return 1; }
SHELLY_UNATTENDED_LOCAL_BYPASS=1
${assign}
rc=0
cap_fs_write_file '${dest}' "$TMP_DIR/src.md" || rc=$?
echo "rc=$rc|$([ -f '${dest}' ] && echo written || echo absent)"`;
    const file = path.join(home, 'fs-test.sh');
    fs.writeFileSync(file, `set -u\nHOME='${homeFwd}'\n${body}\n`, 'utf8');
    return execFileSync('bash', [file.replace(/\\/g, '/')], { encoding: 'utf8', env: { ...process.env, HOME: homeFwd } }).trim();
  }

  it('inside agent-output ⇒ written', () => {
    const h = posixHome();
    expect(write(`${h}/agent-output/2026-10-09/2026-10-09_ai-briefing.md`)).toBe('rc=0|written');
  });

  it('inside the configured vault (OBSIDIAN_VAULT_PATH) ⇒ written', () => {
    const h = posixHome();
    expect(write(`${h}/vault/News/2026-10-09/x.md`, { OBSIDIAN_VAULT_PATH: `${h}/vault/` })).toBe('rc=0|written');
  });

  it('a topic folder with ".." escaping the roots ⇒ refused, nothing written', () => {
    const h = posixHome();
    expect(write(`${h}/agent-output/../escaped.md`)).toBe('rc=44|absent');
    expect(write(`${h}/vault/../../escaped2.md`, { OBSIDIAN_VAULT_PATH: `${h}/vault` })).toBe('rc=44|absent');
  });

  it('outside every root ⇒ refused; a sibling-prefix path (agent-output-evil) is not inside agent-output', () => {
    const h = posixHome();
    expect(write(`${h}/elsewhere/x.md`)).toBe('rc=44|absent');
    expect(write(`${h}/agent-output-evil/x.md`)).toBe('rc=44|absent');
  });

  it('without the bypass flag (attended / auto mode) the legacy unbrokered write is unchanged', () => {
    const h = posixHome();
    expect(write(`${h}/elsewhere/legacy.md`, { SHELLY_UNATTENDED_LOCAL_BYPASS: '0' })).toBe('rc=0|written');
  });
});
