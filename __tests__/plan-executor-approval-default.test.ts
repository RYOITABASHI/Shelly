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

  it('unattendedPreflightFailure allows app-act through ONLY when trusted, still refuses intent/dm-reply/cli/webhook unattended', () => {
    const trustedPlan = basePlan({ action: { type: 'app-act', appActRecipeId: 'x.post' } });
    expect(executor.unattendedPreflightFailure({ unattended: '1', ...trustedArgs() }, trustedPlan)).toBe('');

    const untrustedPlan = basePlan({ action: { type: 'app-act', appActRecipeId: 'x.post' } });
    expect(executor.unattendedPreflightFailure({ unattended: '1' }, untrustedPlan)).not.toBe('');

    for (const actionType of ['intent', 'dm-reply', 'cli', 'webhook']) {
      const plan = basePlan({ action: { type: actionType } });
      expect(executor.unattendedPreflightFailure({ unattended: '1' }, plan)).not.toBe('');
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
