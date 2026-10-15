/**
 * Final review (2026-10-15) H1 / H2 / L1 / L2: research-intent consent never
 * widens what an unattended run sends to an API-key backend.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { generateRunScript } from '@/lib/agent-executor';
import { buildAgentPlanSpec } from '@/lib/agent-plan-spec';
import { resolveEscalationLadder } from '@/lib/agent-escalation-ladder';
import type { Agent, ToolChoice } from '@/store/types';

const PPLX: ToolChoice = { type: 'perplexity', model: 'sonar-deep-research' };
const MEMORY = '# Memory\n- private note: my bank is X';
const TASK = 'パープレで量子計算について調べて';

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'fr',
  name: 'fr',
  description: '',
  prompt: `${MEMORY}\n\n---\n\n${TASK}`,
  schedule: '0 8 * * *',
  tool: PPLX,
  autonomous: true,
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
  ...over,
});

describe('H1: studio context (Obsidian / content-studio output) is not sent on an isolated research run', () => {
  it('SOURCE_CONTEXT is cleared after the studio block; the draft destination is unchanged', () => {
    const s = generateRunScript(agent({ outputPath: '/sdcard/Documents/ObsidianVault/50_Drafts/Research' }), { autonomousCloudConsent: true });
    expect(s).toContain('STUDIO_CONTEXT=1');
    expect(s).toContain('USE_GLOBAL_OUTPUT=0');
    expect(s).toContain('ISOLATE_RESEARCH_PROMPT=1');
    const studio = s.indexOf('echo "## Local project context"');
    const clear = s.indexOf('if [ "${ISOLATE_RESEARCH_PROMPT:-0}" = "1" ]; then\n  SOURCE_CONTEXT=""\nfi');
    const call = s.indexOf('https://api.perplexity.ai/chat/completions');
    expect(studio).toBeGreaterThan(0);
    expect(clear).toBeGreaterThan(studio);
    expect(call).toBeGreaterThan(clear);
  });

  it('a web-mandatory content agent keeps its studio context (unchanged behaviour)', () => {
    const s = generateRunScript(agent({ prompt: 'パープレで最新のAIニュースを集めて', outputPath: '~/projects/shelly-content-studio/drafts/x' }), { autonomousCloudConsent: true });
    expect(s).toContain('ISOLATE_RESEARCH_PROMPT=0');
  });
});

describe('H2: a chain whose AGENT-level tool is Perplexity isolates every step that runs on it', () => {
  const chain = agent({
    orchestration: {
      steps: [
        'パープレで量子計算の論文を集めて',
        'ローカルLLMで要点を整理して',
      ],
    },
  });

  it('unpinned steps are judged on the effective (agent-level) tool; plan.prompt has no memory', () => {
    const spec = buildAgentPlanSpec(chain, { autonomousCloudConsent: true });
    expect(spec.tool.type).toBe('perplexity');
    const iso = spec.steps!.isolation!;
    expect(iso[0]).toMatchObject({ carry: false });
    expect((iso[0] as { base: string }).base).not.toContain('private note');
    expect(spec.prompt).not.toContain('private note');
    expect(spec.prompt).toContain(TASK);
  });

  it('a later unpinned step that needs earlier output also runs isolated (all prior steps isolated → carry)', () => {
    const spec = buildAgentPlanSpec(
      agent({ orchestration: { steps: ['パープレで量子計算の論文を集めて', 'その結果をまとめて'] } }),
      { autonomousCloudConsent: true },
    );
    expect(spec.steps!.isolation![1]).toMatchObject({ carry: true });
  });

  it('forced single-step PlanSpec path: research-only consent builds plan.prompt from the task text', () => {
    const spec = buildAgentPlanSpec(agent(), { autonomousCloudConsent: true });
    expect(spec.steps).toBeUndefined();
    expect(spec.prompt).not.toContain('private note');
    expect(spec.prompt).toContain(TASK);
  });

  it('web-mandatory consent keeps the full plan prompt (pre-branch behaviour)', () => {
    const spec = buildAgentPlanSpec(agent({ prompt: `${MEMORY}\n\n---\n\nパープレで最新のAIニュースを集めて` }), { autonomousCloudConsent: true });
    expect(spec.prompt).toContain('private note');
  });
});

describe('L1: no per-step research-intent extension for notification-triggered agents', () => {
  const trigger = { notificationTrigger: { packageNames: ['com.google.android.gm'] } };
  it('PlanSpec and codex-chain .sh strip the research-only step pin', () => {
    const steps = [{ instruction: 'パープレで量子計算について調べて', tool: PPLX }, 'まとめて'];
    const spec = buildAgentPlanSpec(agent({ ...trigger, tool: { type: 'local' }, orchestration: { steps } }), { autonomousCloudConsent: true });
    expect(spec.steps!.list[0].tool).toBeUndefined();
    const sh = generateRunScript(agent({ ...trigger, tool: { type: 'cli', cli: 'codex' }, orchestration: { steps } }), { autonomousCloudConsent: true });
    expect(sh).not.toContain('https://api.perplexity.ai/chat/completions');
  });
});

describe('L2: memory recall cannot supply the research intent', () => {
  const memResearch = `# Memory\n- the user likes research papers and 論文\n\n---\n\nパープレでこの文章を整えて`;
  it('.sh, PlanSpec and ladder judge consent on the task text only', () => {
    expect(generateRunScript(agent({ prompt: memResearch }), { autonomousCloudConsent: true })).toContain('[REFUSED]');
    expect(buildAgentPlanSpec(agent({ prompt: memResearch }), { autonomousCloudConsent: true }).tool.type).toBe('unsupported');
    const l = resolveEscalationLadder(agent({ prompt: memResearch }), { hasCerebrasKey: true, hasGroqKey: true, autonomousCloudConsent: true });
    expect(l.tools.map((t) => t.type)).toEqual(['cli']);
  });
});
