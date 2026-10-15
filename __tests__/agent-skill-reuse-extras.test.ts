/**
 * Follow-up item 5 (2026-10-15, on-device): skill reuse must never drop an
 * instruction that only the new request carries, must not reuse a skill for
 * a materially different request, and only an EXECUTABLE skill plan keeps a
 * `shelly agent add` draft in-app-only (with the reason in the summary).
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));
jest.mock('expo-file-system/legacy', () => ({}));

import {
  applyExecutableSkillPlan,
  buildSkillInjectionContext,
  skillDiffersMaterially,
  skillHasExecutablePlan,
  uncoveredRequestInstructions,
  type SkillRecipe,
} from '@/lib/agent-skills';
import { assessAgentDraftRisk, buildAgentAddSummary } from '@/lib/agent-add-approval';
import type { Agent } from '@/store/types';

const recipe = {
  id: 'skill-ai-papers',
  name: 'AI papers digest',
  trigger: 'collect latest ai research papers pick notable',
  prompt: 'Collect the latest AI research papers and pick 3 notable ones with a short summary each.',
  route: 'cloud',
  toolLabel: 'Perplexity API',
  tags: [],
  successCount: 1,
  lastUsed: '2026-10-14T00:00:00.000Z',
  created: '2026-10-14T00:00:00.000Z',
} as SkillRecipe;

const REQUEST = 'Every day at 16:20, collect the latest AI research papers and pick 3 notable ones. Write the summaries in English.';

describe('uncovered instructions are carried, never dropped', () => {
  it('finds the extra instruction only the new request has', () => {
    expect(uncoveredRequestInstructions(recipe, REQUEST)).toEqual(['Write the summaries in English']);
  });

  it('an added instruction is not a material difference; a different task is', () => {
    expect(skillDiffersMaterially(recipe, REQUEST)).toBe(false);
    expect(skillDiffersMaterially(recipe, 'Summarize my unread email newsletters. Draft replies to the urgent ones.')).toBe(true);
  });

  it('the injected recipe context lists the extra instruction and says the task is authoritative', () => {
    const ctx = buildSkillInjectionContext(recipe, REQUEST);
    expect(ctx).toContain('The task below is authoritative');
    expect(ctx).toContain('Write the summaries in English');
  });

  it('an executable plan appends the extra instruction to its final step', () => {
    const executable = {
      ...recipe,
      planSpec: {
        steps: {
          list: [{ instruction: 'collect papers' }, { instruction: 'pick 3 and summarize' }],
          budget: { maxSteps: 2, totalTimeoutMs: 60_000 },
        },
        tool: { type: 'perplexity', model: 'sonar' },
        limits: {},
      },
    } as unknown as SkillRecipe;
    expect(skillHasExecutablePlan(executable)).toBe(true);
    const agent = { id: 'a', name: 'a', prompt: REQUEST, tool: { type: 'auto' } } as unknown as Agent;
    const out = applyExecutableSkillPlan(agent, executable);
    const steps = out.orchestration!.steps as Array<{ instruction: string }>;
    expect(steps[0].instruction).toBe('collect papers');
    expect(steps[1].instruction).toContain('pick 3 and summarize');
    expect(steps[1].instruction).toContain('Write the summaries in English');
  });
});

describe('skill reuse risk for `shelly agent add`', () => {
  const draft = (executablePlan?: boolean) => ({
    name: 'papers',
    prompt: REQUEST,
    schedule: '20 16 * * *',
    action: { type: 'draft' },
    matchedSkill: { id: 'skill-ai-papers', name: 'AI papers digest', successCount: 1, ...(executablePlan === undefined ? {} : { executablePlan }) },
  });

  it('a prompt-only skill no longer forces in-app-only approval', () => {
    expect(assessAgentDraftRisk(draft(false))).not.toContain('skill');
  });

  it('an executable-plan skill (or an older draft without the flag) still does, and the summary says why', () => {
    expect(assessAgentDraftRisk(draft(true))).toContain('skill');
    expect(assessAgentDraftRisk(draft())).toContain('skill');
    const s = buildAgentAddSummary(
      { reqId: '1760500000000-abcdef12', riskReasons: ['skill'], approvable: false, expiresAt: 0, fireable: true, draftHash: 'b'.repeat(64) },
      draft(true),
      'daily 16:20',
    );
    expect(s.message).toContain('reuses the saved skill "AI papers digest"');
    expect(s.message).toContain('open Shelly and confirm');
  });
});
