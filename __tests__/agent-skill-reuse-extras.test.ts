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
  skillPlanFingerprint,
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

describe('v8.1.1: a materially different request does not reuse the skill', () => {
  // Shape of the on-device recipe (build 2593) that was wrongly offered.
  const onDevice = {
    ...recipe,
    id: 'skill-arxiv-hf',
    name: 'collect the latest AI research papers from arXiv and Hugging Face pick 3 notable',
    trigger: 'collect the latest AI research papers from arXiv and Hugging Face pick 3 notable',
    prompt:
      'Every day at 16:20, collect the latest AI research papers from arXiv and Hugging Face and pick 3 notable ones. Write the summaries in English.',
    toolLabel: 'Gemini API',
    successCount: 2,
  } as SkillRecipe;

  it.each([
    'Every day at 09:45, research the latest LLM papers with Perplexity and summarize 3 of them in English.',
    'research the latest LLM papers with Perplexity and summarize 3 of them in English.',
    '毎日9時45分に、パープレで最新のLLM論文を調べて英語で3本要約して',
  ])('%s -> differs', (req) => {
    expect(skillDiffersMaterially(onDevice, req)).toBe(true);
  });

  it('the same request without the named tool still differs (topic/source coverage is below the same-task bar)', () => {
    expect(skillDiffersMaterially(onDevice, 'Every day at 09:45, research the latest LLM papers and summarize 3 of them in English.')).toBe(true);
    expect(skillDiffersMaterially({ ...onDevice, toolLabel: 'Perplexity API' }, 'research the latest LLM papers with Perplexity and summarize 3 of them in English.')).toBe(true);
  });

  it('the genuinely same task (other schedule, added instruction) still reuses it', () => {
    expect(skillDiffersMaterially(onDevice, 'Every day at 07:00, collect the latest AI research papers from arXiv and Hugging Face and pick 3 notable ones.')).toBe(false);
    expect(skillDiffersMaterially(onDevice, 'Daily at 8am, collect the latest AI research papers from arXiv and Hugging Face and pick 3 notable ones. Keep each summary under 50 words.')).toBe(false);
  });

  it('naming the same tool the skill ran with does not by itself make it differ', () => {
    const pplx = { ...onDevice, toolLabel: 'Perplexity API' } as SkillRecipe;
    expect(skillDiffersMaterially(pplx, 'Every day at 07:00, collect the latest AI research papers from arXiv and Hugging Face with Perplexity and pick 3 notable ones.')).toBe(false);
  });

  it('a JA request for the same JA recipe still reuses it', () => {
    const ja = {
      ...recipe,
      name: '最新のAI論文を集める',
      trigger: '最新のAI研究論文を集めて注目の3本を選ぶ',
      prompt: '毎日16時20分に、arXivとHugging Faceから最新のAI研究論文を集めて注目の3本を選び、英語で要約して',
      toolLabel: 'Gemini API',
    } as SkillRecipe;
    expect(skillDiffersMaterially(ja, '毎日7時に、arXivとHugging Faceから最新のAI研究論文を集めて注目の3本を選び、英語で要約して')).toBe(false);
    expect(skillDiffersMaterially(ja, '毎日9時45分に、パープレで最新のLLM論文を調べて英語で3本要約して')).toBe(true);
  });
});

describe('review M-B: the plan approved at registration is the only plan that runs', () => {
  const executable = {
    ...recipe,
    planSpec: {
      steps: { list: [{ instruction: 'collect papers' }, { instruction: 'pick 3' }], budget: { maxSteps: 2, totalTimeoutMs: 60_000 } },
      tool: { type: 'perplexity', model: 'sonar' },
      limits: {},
    },
  } as unknown as SkillRecipe;
  const base = { id: 'a', name: 'a', prompt: 'collect the latest AI research papers', tool: { type: 'auto' } } as unknown as Agent;

  it('registered against a prompt-only recipe (null) → a plan added later is NOT applied', () => {
    const out = applyExecutableSkillPlan({ ...base, skillPlanFingerprint: null }, executable);
    expect(out.orchestration).toBeUndefined();
  });

  it('registered against this exact plan → applied; changed plan → not applied', () => {
    const fp = skillPlanFingerprint(executable);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(applyExecutableSkillPlan({ ...base, skillPlanFingerprint: fp }, executable).orchestration).toBeDefined();
    const changed = { ...executable, planSpec: { ...executable.planSpec!, tool: { type: 'gemini-api' } } } as unknown as SkillRecipe;
    expect(skillPlanFingerprint(changed)).not.toBe(fp);
    expect(applyExecutableSkillPlan({ ...base, skillPlanFingerprint: fp }, changed).orchestration).toBeUndefined();
  });

  it('legacy agents without the field keep the previous behaviour', () => {
    expect(applyExecutableSkillPlan(base, executable).orchestration).toBeDefined();
    expect(skillPlanFingerprint(recipe)).toBeNull();
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
