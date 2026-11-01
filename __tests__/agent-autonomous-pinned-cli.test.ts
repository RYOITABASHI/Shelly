// 2026-11-01 product-owner decision: when the user names the engine for a step
// ("using Codex, …"), an AUTONOMOUS (unattended) agent runs that step on that
// engine too — no local-first substitution, no silent fallback. Before this,
// the autonomous ladder could not tell a words-derived step pin from the
// agent's default cli:codex tool, so it ran [local, codex].
import { parseAgentNL } from '@/lib/agent-nl-parser';
import { resolveEscalationLadder, LadderEnv } from '@/lib/agent-escalation-ladder';
import { normalizeStep, normalizeSteps, tagStepsWithToolMentions, detectToolPinnedSteps } from '@/lib/agent-orchestration';
import { Agent, AgentOrchestrationStep, ToolChoice } from '@/store/types';

const KEYED: LadderEnv = { hasCerebrasKey: true, hasGroqKey: true };
const CODEX: ToolChoice = { type: 'cli', cli: 'codex' };
const CLAUDE: ToolChoice = { type: 'cli', cli: 'claude' };
const UTTERANCE = 'Every day at 9am, using Codex, check the git log in ~/demo, then summarize it';

const mkAgent = (over: Partial<Agent>): Agent => ({
  id: 'a',
  name: 'A',
  description: '',
  prompt: 'x',
  schedule: null,
  tool: CODEX,
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
  ...over,
});

/** The per-step agent lib/agent-manager.ts stepAgent builds. */
const stepAgentFor = (base: Agent, step: AgentOrchestrationStep): Agent => ({
  ...base,
  prompt: step.instruction,
  orchestration: undefined,
  tool: step.tool ?? base.tool,
  toolPinned: step.tool && step.toolPinned === true ? true : undefined,
});

const types = (l: { tools: ToolChoice[] }) => l.tools.map((t) => (t.type === 'cli' ? `cli:${t.cli}` : t.type));

describe('autonomous agent honors an engine named for a step', () => {
  it('the parsed autonomous draft: step 1 is a words-derived Codex pin → Codex only', () => {
    const d = parseAgentNL(UTTERANCE);
    const steps = (d.orchestrationSteps ?? []) as AgentOrchestrationStep[];
    expect(steps.length).toBe(2);
    expect(steps[0].tool).toEqual(CODEX);
    expect(steps[0].toolPinned).toBe(true);
    const base = mkAgent({ tool: d.tool, autonomous: true, prompt: d.prompt ?? UTTERANCE });
    const l = resolveEscalationLadder(stepAgentFor(base, steps[0]), KEYED, steps[0].instruction);
    expect(types(l)).toEqual(['cli:codex']);
    expect(l.why).toMatch(/that CLI only/);
  });

  it('the pin survives normalization (agent JSON / PlanSpec round-trip)', () => {
    const d = parseAgentNL(UTTERANCE);
    const persisted = JSON.parse(JSON.stringify({ steps: d.orchestrationSteps }));
    const normalized = normalizeSteps(persisted);
    expect(normalized[0]).toMatchObject({ tool: CODEX, toolPinned: true });
  });

  it('a non-pinned autonomous step keeps the local-first ladder', () => {
    const base = mkAgent({ tool: CODEX, autonomous: true });
    const step: AgentOrchestrationStep = { instruction: 'summarize it' };
    expect(types(resolveEscalationLadder(stepAgentFor(base, step), KEYED, step.instruction))).toEqual(['local', 'cli:codex']);
  });

  it('an old agent (step tool without toolPinned) behaves as before', () => {
    const base = mkAgent({ tool: CODEX, autonomous: true });
    const step: AgentOrchestrationStep = { instruction: 'check the git log', tool: CODEX };
    expect(types(resolveEscalationLadder(stepAgentFor(base, step), KEYED, step.instruction))).toEqual(['local', 'cli:codex']);
  });

  it('Claude pin without the flag is unchanged (first, then local → Codex)', () => {
    const l = resolveEscalationLadder(mkAgent({ tool: CLAUDE, autonomous: true, prompt: 'READMEを要約して' }), KEYED);
    expect(types(l)).toEqual(['cli:claude', 'local', 'cli:codex']);
  });

  it('a words-derived Claude step pin also runs on Claude only when autonomous', () => {
    const base = mkAgent({ tool: CODEX, autonomous: true });
    const step: AgentOrchestrationStep = { instruction: 'READMEを要約して', tool: CLAUDE, toolPinned: true };
    expect(types(resolveEscalationLadder(stepAgentFor(base, step), KEYED, step.instruction))).toEqual(['cli:claude']);
  });

  it('a web-flavoured pinned Codex step is not swapped for a web backend', () => {
    const base = mkAgent({ tool: CODEX, autonomous: true });
    const step: AgentOrchestrationStep = { instruction: '最新のAIニュースを集めて', tool: CODEX, toolPinned: true };
    expect(types(resolveEscalationLadder(stepAgentFor(base, step), { ...KEYED, autonomousCloudConsent: true }, step.instruction))).toEqual(['cli:codex']);
  });

  it('attended pinned CLI rule is unchanged', () => {
    const base = mkAgent({ tool: { type: 'local' } });
    const step: AgentOrchestrationStep = { instruction: 'check the git log', tool: CODEX };
    expect(types(resolveEscalationLadder(stepAgentFor(base, step), KEYED, step.instruction))).toEqual(['cli:codex']);
  });

  it('both tagging paths set the flag; untagged steps stay plain', () => {
    const tagged = tagStepsWithToolMentions(['Codexでgit logを確認して', '要約して']);
    expect(tagged[0]).toMatchObject({ tool: CODEX, toolPinned: true });
    expect(tagged[1]).toBe('要約して');
    const pinned = detectToolPinnedSteps('Codexでgit logを確認して、ローカルLLMで要約して');
    expect(pinned?.[0]).toMatchObject({ tool: CODEX, toolPinned: true });
    expect(normalizeStep({ instruction: 'x', toolPinned: true } as AgentOrchestrationStep).toolPinned).toBeUndefined();
  });
});
