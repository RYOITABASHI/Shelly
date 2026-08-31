// Superseded 2026-08-25 (Fable5 review): the 2026-07-14 project-owner
// directive this file used to cite ("デフォは承認なしな" — default is
// no-approval) put an unattended agent with real side effects (webhook/cli/
// dm-reply/notify) at zero human approval the moment `.env` sourcing failed
// or a device had never persisted the setting — an "unknown state ⇒
// approved" failure mode for a security gate. Reversed: the default is now
// REQUIRE approval (manual), and only an explicit opt-out
// (SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL='0'/'false'/'no'/'off') restores
// the old auto-approve behavior. Node PlanSpec executor counterpart to
// __tests__/agent-executor-approval-default.test.ts (the .sh executor):
// (1) default-ON, (2) opt-out via explicit falsy value, (3) hard safety
// floor untouched.
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const root = path.resolve(__dirname, '..');
const executorPath = path.join(root, 'scripts', 'shelly-plan-executor.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const executor = require(executorPath);

function basePlan(overrides: any = {}) {
  return {
    agent: { id: 'agent-approval-default', name: 'Approval Default', autonomous: false, autonomyLevel: 'L2' },
    tool: { type: 'local', label: 'Local LLM' },
    action: { type: 'draft' },
    ...overrides,
  };
}

describe('requireActionApprovalTap (Node executor global/per-agent resolution)', () => {
  it('defaults to true (require approval) when neither the per-agent field nor the global .env flag is set', () => {
    expect(executor.requireActionApprovalTap(basePlan(), {})).toBe(true);
  });

  it('an unrecognized/garbage config value is treated as unset — still requires approval, never silently auto-approves', () => {
    expect(executor.requireActionApprovalTap(basePlan(), { SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL: 'nonsense' })).toBe(true);
  });

  it('the per-agent override wins over the global default in both directions', () => {
    expect(executor.requireActionApprovalTap(
      basePlan({ agent: { ...basePlan().agent, requireActionApproval: true } }),
      { SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL: '0' },
    )).toBe(true);
    expect(executor.requireActionApprovalTap(
      basePlan({ agent: { ...basePlan().agent, requireActionApproval: false } }),
      { SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL: '1' },
    )).toBe(false);
  });

  it('falls back to the global default read live from config (.env) when no per-agent override is present', () => {
    expect(executor.requireActionApprovalTap(basePlan(), { SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL: '1' })).toBe(true);
    expect(executor.requireActionApprovalTap(basePlan(), { SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL: '0' })).toBe(false);
  });
});

describe('trustedNativeLowRiskAction / unattendedPreflightFailure — unattended dispatch gating', () => {
  it('intent/dm-reply are always refused unattended, matching the legacy .sh executor\'s hard refusal for these two', () => {
    // No approval-mode or trust flag can unlock them (unlike cli/webhook below).
    for (const actionType of ['intent', 'dm-reply']) {
      const plan = basePlan({ action: { type: actionType } });
      expect(executor.unattendedPreflightFailure({ unattended: '1' }, plan)).not.toBe('');
    }
  });

  // North Star P0(c) fix (docs/superpowers/DEFERRED.md's "スケジュール実行が
  // 多段オーケストレーションを使わない問題"): AgentRuntime.kt now routes ANY
  // scheduled/unattended fire with orchestration.steps through this executor,
  // not just agent.autonomous ones. cli/webhook mirror the legacy .sh
  // executor's policy exactly: whatever requireActionApprovalTap resolves to
  // (see the describe block above) is what gates unattended cli/webhook here
  // too, independent of agent.autonomous. Fable5 review 2026-08-25 flipped
  // that resolution's default from auto-approve to require-approval, so
  // cli/webhook now need an EXPLICIT opt-out to fire unattended — this block
  // was rewritten to match (it used to assert the opposite: that they fired
  // unattended with no config at all).
  it('cli/webhook now REQUIRE the explicit opt-out to fire unattended — the bare default (no config) blocks them', () => {
    for (const actionType of ['cli', 'webhook']) {
      // basePlan() has agent.autonomous: false and no requireActionApproval
      // override, and no config is passed (defaults to {}) — this used to
      // mean auto-approve; it now means "still gated", per the reversal above.
      const plan = basePlan({ action: { type: actionType } });
      const failure = executor.unattendedPreflightFailure({ unattended: '1' }, plan);
      expect(failure).not.toBe('');
      expect(failure).toContain('requires manual approval and cannot run unattended');
    }
  });

  it('cli/webhook fire unattended only once the global default is EXPLICITLY opted out (mirrors the .sh executor policy)', () => {
    for (const actionType of ['cli', 'webhook']) {
      const plan = basePlan({ action: { type: actionType } });
      const failure = executor.unattendedPreflightFailure(
        { unattended: '1' },
        plan,
        { SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL: '0' },
      );
      expect(failure).toBe('');
    }
  });

  it('cli/webhook still refuse unattended when the resolved approval mode requires manual approval', () => {
    for (const actionType of ['cli', 'webhook']) {
      const perAgentPlan = basePlan({
        agent: { ...basePlan().agent, requireActionApproval: true },
        action: { type: actionType },
      });
      const perAgentFailure = executor.unattendedPreflightFailure({ unattended: '1' }, perAgentPlan);
      expect(perAgentFailure).not.toBe('');
      expect(perAgentFailure).toContain('requires manual approval and cannot run unattended');

      const globalDefaultPlan = basePlan({ action: { type: actionType } });
      const globalFailure = executor.unattendedPreflightFailure(
        { unattended: '1' },
        globalDefaultPlan,
        { SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL: '1' },
      );
      expect(globalFailure).not.toBe('');
      expect(globalFailure).toContain('requires manual approval and cannot run unattended');
    }
  });

  it('draft/notify remain trusted exactly as before', () => {
    for (const actionType of ['draft', 'notify']) {
      const plan = basePlan({ action: { type: actionType } });
      const args = {
        'trusted-autonomous-agent-id': 'agent-approval-default',
        'trusted-autonomous-action': actionType,
        'trusted-tool-type': 'local',
      };
      expect(executor.trustedNativeLowRiskAction(args, plan, actionType)).toBe(true);
    }
  });
});

// Adversarial review finding (2026-07-16, Codex): parseConfigEnv() silently
// dropped SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL because it wasn't in
// CONFIG_ENV_KEYS — every test above passes a handcrafted config object
// directly to requireActionApprovalTap/unattendedPreflightFailure, which
// never exercises the real .env file-parsing path and so never caught this.
// This block reads a REAL temp .env file through parseConfigEnv, the exact
// function production `run()` calls, to close that gap.
describe('parseConfigEnv reads SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL from a real .env file (production parsing path)', () => {
  function withTempEnvFile(contents: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-plan-executor-env-'));
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(envFile, contents);
    return envFile;
  }

  it('parses SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL=1 and requireActionApprovalTap sees it as true', () => {
    const envFile = withTempEnvFile("SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL='1'\n");
    const config = executor.parseConfigEnv(envFile);
    expect(config.SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL).toBe('1');
    expect(executor.requireActionApprovalTap(basePlan(), config)).toBe(true);
  });

  it('a real .env with the flag absent falls back to require-approval, matching the no-file case', () => {
    const envFile = withTempEnvFile("LOCAL_LLM_URL='http://127.0.0.1:8080'\n");
    const config = executor.parseConfigEnv(envFile);
    expect(config.SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL).toBeUndefined();
    expect(executor.requireActionApprovalTap(basePlan(), config)).toBe(true);
  });

  it('a real .env that explicitly opts out (=0) reads as auto-approve', () => {
    const envFile = withTempEnvFile("SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL='0'\n");
    const config = executor.parseConfigEnv(envFile);
    expect(config.SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL).toBe('0');
    expect(executor.requireActionApprovalTap(basePlan(), config)).toBe(false);
  });

  it('end-to-end: an unattended webhook agent is refused when the real .env sets the global flag', () => {
    const envFile = withTempEnvFile("SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL='1'\n");
    const config = executor.parseConfigEnv(envFile);
    const plan = basePlan({ action: { type: 'webhook' } });
    const failure = executor.unattendedPreflightFailure({ unattended: '1' }, plan, config);
    expect(failure).not.toBe('');
    expect(failure).toContain('requires manual approval and cannot run unattended');
  });
});

// Adversarial review finding (2026-07-16, Codex): the webhook payload's
// "result" field shipped raw resultText, unredacted — write_webhook_payload's
// caller passed the raw model output directly instead of the same redact()
// pass the 500-char "preview" field right next to it already gets. Harmless
// while webhook was always refused unattended (a human always saw the
// approval card first), but a real secret-leak risk once the P0(c) fix
// widened unattended webhook dispatch. fullResultText() is the fix: same
// redact() call as previewText(), no truncation.
describe('fullResultText redacts secrets in the full webhook body (P0(c) companion fix)', () => {
  it('redacts an OpenAI-shaped secret key with no truncation', () => {
    const secret = 'sk-proj-abcdefghijklmnopqrstuvwxyz1234567890';
    const long = `here is the result: ${secret} and more text after it that would be past a 500-char preview truncation point`;
    const cleaned = executor.fullResultText(long);
    expect(cleaned).not.toContain(secret);
    expect(cleaned).toContain('<redacted>');
    expect(cleaned).toContain('and more text after it');
  });

  it('leaves ordinary content untouched', () => {
    expect(executor.fullResultText('plain result text, nothing secret here')).toBe(
      'plain result text, nothing secret here',
    );
  });
});
