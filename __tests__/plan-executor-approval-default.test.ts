// Project owner directive 2026-07-14 ("デフォは承認なしな。任意で確認" —
// default is no-approval, confirmation optional; "実行時の許可も任意だって
// 言ってんだろ。デフォは承認なし" — runtime permission is optional too,
// default is no-approval). Node PlanSpec executor counterpart to
// __tests__/agent-executor-approval-default.test.ts (the .sh executor):
// (1) default-OFF, (2) opt-in-ON, (3) hard safety floor untouched,
// (4) app-act's Tier-B unattended path (registration-time consent binding).
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
  it('defaults to false (auto-approve) when neither the per-agent field nor the global .env flag is set', () => {
    expect(executor.requireActionApprovalTap(basePlan(), {})).toBe(false);
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

describe('trustedNativeLowRiskAction / unattendedPreflightFailure — app-act Tier-B (project owner directive point 3)', () => {
  const trustedArgs = (recipeId = 'x.post') => ({
    'trusted-autonomous-agent-id': 'agent-approval-default',
    'trusted-autonomous-action': 'app-act',
    'trusted-tool-type': 'local',
    'trusted-app-act-recipe-id': recipeId,
  });

  it('app-act is trusted ONLY when native supplied a matching trusted-autonomous-action + on-device tool + matching recipe id', () => {
    const plan = basePlan({ action: { type: 'app-act', appActRecipeId: 'x.post' } });
    expect(executor.trustedNativeLowRiskAction(trustedArgs(), plan, 'app-act')).toBe(true);
  });

  it('a mismatched recipe id refuses trust — defense-in-depth against the plan diverging from what native read', () => {
    const plan = basePlan({ action: { type: 'app-act', appActRecipeId: 'x.post' } });
    expect(executor.trustedNativeLowRiskAction(trustedArgs('line.send-message'), plan, 'app-act')).toBe(false);
  });

  it('a cloud tool IS trusted when trustedTool agrees with the plan (widened 2026-07-14: chat-confirmed autonomous consent is the gate, not tool backend)', () => {
    const plan = basePlan({ tool: { type: 'gemini-api', label: 'Gemini' }, action: { type: 'app-act', appActRecipeId: 'x.post' } });
    expect(executor.trustedNativeLowRiskAction({ ...trustedArgs(), 'trusted-tool-type': 'gemini-api' }, plan, 'app-act')).toBe(true);
  });

  it('a trustedTool that diverges from what the plan carries refuses — defense-in-depth against the plan tool diverging from what native read', () => {
    const plan = basePlan({ tool: { type: 'gemini-api', label: 'Gemini' }, action: { type: 'app-act', appActRecipeId: 'x.post' } });
    expect(executor.trustedNativeLowRiskAction(trustedArgs(), plan, 'app-act')).toBe(false);
  });

  it('no --trusted-* args at all (the default/no-consent state) refuses trust', () => {
    const plan = basePlan({ action: { type: 'app-act', appActRecipeId: 'x.post' } });
    expect(executor.trustedNativeLowRiskAction({}, plan, 'app-act')).toBe(false);
  });

  it('unattendedPreflightFailure allows app-act through ONLY when trusted, still hard-refuses intent/dm-reply unattended unconditionally', () => {
    const trustedPlan = basePlan({ action: { type: 'app-act', appActRecipeId: 'x.post' } });
    expect(executor.unattendedPreflightFailure({ unattended: '1', ...trustedArgs() }, trustedPlan)).toBe('');

    const untrustedPlan = basePlan({ action: { type: 'app-act', appActRecipeId: 'x.post' } });
    expect(executor.unattendedPreflightFailure({ unattended: '1' }, untrustedPlan)).not.toBe('');

    // intent/dm-reply are always refused unattended, matching the legacy .sh
    // executor's hard `return 1` for these two — no approval-mode or trust
    // flag can unlock them (unlike cli/webhook below).
    for (const actionType of ['intent', 'dm-reply']) {
      const plan = basePlan({ action: { type: actionType } });
      expect(executor.unattendedPreflightFailure({ unattended: '1' }, plan)).not.toBe('');
    }
  });

  // North Star P0(c) fix (docs/superpowers/DEFERRED.md's "スケジュール実行が
  // 多段オーケストレーションを使わない問題"): AgentRuntime.kt now routes ANY
  // scheduled/unattended fire with orchestration.steps through this executor,
  // not just agent.autonomous ones. Before this fix, cli/webhook were always
  // refused unattended here (unconditionally, via trustedNativeLowRiskAction),
  // which was STRICTER than the legacy .sh executor's actual policy — .sh
  // fires draft/notify/webhook/cli unattended whenever approval mode is
  // "auto" (the default), independent of agent.autonomous. That mismatch
  // meant a real orchestrated agent (which today fires successfully via the
  // collapsed single-step .sh script) would have been silently skipped after
  // the routing change, a strict regression. This block verifies the fix:
  // cli/webhook now mirror .sh's policy exactly.
  it('cli/webhook fire unattended when approval mode is auto (the default) — mirrors the .sh executor policy, independent of agent.autonomous', () => {
    for (const actionType of ['cli', 'webhook']) {
      // basePlan() has agent.autonomous: false and no requireActionApproval
      // override, and no config is passed (defaults to {}) — auto-approve.
      const plan = basePlan({ action: { type: actionType } });
      expect(executor.unattendedPreflightFailure({ unattended: '1' }, plan)).toBe('');
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

  it('draft/notify remain trusted exactly as before (2026-07-14 only ADDED app-act, did not touch the existing gate)', () => {
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

  it('a real .env with the flag absent falls back to auto-approve, matching the no-file case', () => {
    const envFile = withTempEnvFile("LOCAL_LLM_URL='http://127.0.0.1:8080'\n");
    const config = executor.parseConfigEnv(envFile);
    expect(config.SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL).toBeUndefined();
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
