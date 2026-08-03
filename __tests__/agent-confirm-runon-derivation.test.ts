/**
 * 2026-08-03 on-device bug (agent-msd4bkjt, docs/superpowers/DEFERRED.md
 * 「会話型登録がステップピンを無視してエージェント全体をローカル固定にする」):
 *
 * A Tier 3 conversational registration of
 * 「パープレキシティで最新のAIニュースを集めて、ローカルLLMで要約して、通知して」
 * correctly pinned its orchestration steps (step 1 → Perplexity, step 2 →
 * local), but the persisted agent came out `tool: {type:'local'}` +
 * `runOn: 'on-device'` — so at run time EVERY step, the Perplexity-pinned
 * collect step included, resolved to {"toolType":"local","guard":"manual-pin"}
 * and the local model fabricated "news" with invented URLs, logged as success.
 *
 * Mechanism (verified against HEAD f9da9ad58):
 *  1. mergeConversationalExtractionIntoDraft ran suggestTool() over the WHOLE
 *     task prompt; 「要約」 hit the transform keywords → agent-level draft.tool
 *     became local (steps were pinned correctly and independently).
 *  2. confirmAgentDraftInner (hooks/use-ai-pane-dispatch.ts) auto-derived
 *     `runOn: 'on-device'` from `tool.type === 'local'` for autonomous agents.
 *  3. resolveAgentRoute treats runOn 'on-device' as a MANUAL pin — a hard stop
 *     that outranks the 'configured-tool' branch where step pins are honored.
 *     That precedence is intentional (4ddf45029 / ab514e73a7: a user's
 *     explicit "never leave the device" choice must beat step intent) and is
 *     deliberately NOT changed here.
 *
 * Fix under test: the confirm boundary (resolveConfirmedToolAndRunOn) no
 * longer synthesizes runOn from tool.type — runOn is persisted exactly as the
 * confirm surface handed it, so a manual-pin can only exist when a human made
 * one. tool:local alone still routes on-device via 'configured-tool'.
 */
import { resolveConfirmedToolAndRunOn, resolveAgentRoute } from '@/lib/agent-tool-router';
import { resolveEscalationLadder, LadderEnv } from '@/lib/agent-escalation-ladder';
import { Agent, ToolChoice } from '@/store/types';

const LOCAL: ToolChoice = { type: 'local' };
const PERPLEXITY: ToolChoice = { type: 'perplexity', model: 'sonar-deep-research' };
const GEMINI: ToolChoice = { type: 'gemini-api' };

const mk = (over: Partial<Agent> = {}): Agent => ({
  id: 'a',
  name: 'A',
  description: '',
  prompt: 'summarize this note',
  schedule: null,
  tool: { type: 'auto' } as ToolChoice,
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
  ...over,
});

// ── Layer 1: the confirm/persist boundary derivation (pure) ─────────────────

describe('resolveConfirmedToolAndRunOn — runOn is never auto-derived from tool.type', () => {
  it('BUG REPRO: autonomous + local tool persists runOn "auto", NOT "on-device"', () => {
    // Before the fix this returned runOn 'on-device' — a synthesized manual
    // pin the user never made, which then squashed every step's own tool pin.
    const r = resolveConfirmedToolAndRunOn({
      autonomous: true,
      runOn: 'auto',
      tool: LOCAL,
      cloudConsent: true,
      needsWeb: true,
    });
    expect(r.tool).toEqual(LOCAL); // local stays local (resolveAutonomousFinalTool)
    expect(r.runOn).toBe('auto');
  });

  it('autonomous + non-local tool keeps runOn "auto" (unchanged behavior)', () => {
    const r = resolveConfirmedToolAndRunOn({
      autonomous: true,
      runOn: 'auto',
      tool: GEMINI,
      cloudConsent: true,
      needsWeb: true,
    });
    expect(r.runOn).toBe('auto');
    expect(r.tool).toEqual(GEMINI); // consent + needsWeb keeps the web tool
  });

  it('a runOn pin handed over by the confirm surface passes through untouched (autonomous)', () => {
    // Today both confirm surfaces pass 'auto' for autonomous agents, but a
    // surface that DOES let the user pin must have that pin honored — the
    // whole point of the fix is that runOn means "the user chose this".
    const r = resolveConfirmedToolAndRunOn({
      autonomous: true,
      runOn: 'on-device',
      tool: GEMINI,
      cloudConsent: false,
      needsWeb: false,
    });
    expect(r.runOn).toBe('on-device');
  });

  it('regression: non-autonomous + runOn auto stores tool "auto" for the run-time scorer', () => {
    const r = resolveConfirmedToolAndRunOn({
      autonomous: false,
      runOn: 'auto',
      tool: LOCAL,
      cloudConsent: false,
      needsWeb: false,
    });
    expect(r.tool).toEqual({ type: 'auto' });
    expect(r.runOn).toBe('auto');
  });

  it('regression: a user-picked runOn on-device (non-autonomous card picker) persists as-is', () => {
    const r = resolveConfirmedToolAndRunOn({
      autonomous: false,
      runOn: 'on-device',
      tool: LOCAL,
      cloudConsent: false,
      needsWeb: false,
    });
    expect(r.tool).toEqual(LOCAL);
    expect(r.runOn).toBe('on-device');
  });
});

// ── Layer 2: what the persisted runOn means for a step's route at run time ──
//
// Mirrors EXACTLY how runAgentOrchestrated builds a step attempt
// (lib/agent-manager.ts): stepAgent = {...agent, tool: step.tool ?? agent.tool}
// (runOn is inherited from the agent), and the ladder routes on the step's OWN
// instruction (routeTextOverride).

const STEP1_INSTRUCTION = 'パープレキシティで最新のAIニュースを集めて';
const CONSENTED: LadderEnv = {
  hasCerebrasKey: false,
  hasGroqKey: false,
  hasPerplexityKey: true,
  autonomousCloudConsent: true,
};

describe('run-time effect — runOn "auto" lets a Perplexity step pin actually reach Perplexity', () => {
  it('FIXED PATH: autonomous agent, runOn auto, step pinned to Perplexity → Perplexity is attempted first (with consent)', () => {
    const stepAgent = mk({
      autonomous: true,
      runOn: 'auto', // what the fixed confirm boundary now persists
      tool: PERPLEXITY, // step.tool ?? agent.tool — the step's explicit pin
      prompt: STEP1_INSTRUCTION,
    });
    const ladder = resolveEscalationLadder(stepAgent, CONSENTED, STEP1_INSTRUCTION);
    expect(ladder.tools[0]).toEqual(PERPLEXITY);
    expect(ladder.guard).toBe('configured-tool');
    expect(ladder.noEscalation).toBe(false);
  });

  it('BUG SHAPE (pre-fix persisted value): runOn "on-device" forces the SAME pinned step to local/manual-pin', () => {
    // This is the exact routeDecision recorded on device:
    // {"toolType":"local","guard":"manual-pin"} for the Perplexity-pinned step.
    const stepAgent = mk({
      autonomous: true,
      runOn: 'on-device',
      tool: PERPLEXITY,
      prompt: STEP1_INSTRUCTION,
    });
    const ladder = resolveEscalationLadder(stepAgent, CONSENTED, STEP1_INSTRUCTION);
    expect(ladder.guard).toBe('manual-pin');
    expect(ladder.noEscalation).toBe(true);
    expect(ladder.tools).toHaveLength(1);
    expect(ladder.tools[0].type).toBe('local');
  });

  it('REGRESSION (problem C — intentional design, unchanged): a REAL user runOn on-device pin still outranks a step pin', () => {
    // The router's manual-pin hard stop is the documented safety boundary
    // (store/types.ts Agent.runOn, commit ab514e73a7): when the user
    // explicitly chose "never leave the device", a step's own tool mention
    // must NOT override it. The fix removes the SYNTHESIZED pin, not this.
    const { tool, decision } = resolveAgentRoute(
      mk({ runOn: 'on-device', tool: PERPLEXITY, prompt: STEP1_INSTRUCTION }),
      STEP1_INSTRUCTION,
    );
    expect(decision.guard).toBe('manual-pin');
    expect(decision.route).toBe('on-device');
    expect(tool.type).toBe('local');
  });

  it('with runOn auto, an agent-level local tool still routes on-device via configured-tool (no pin needed)', () => {
    // Proves the removed auto-derivation was redundant for its ostensible
    // purpose: tool:local alone already resolves to the on-device route.
    const { tool, decision } = resolveAgentRoute(mk({ runOn: 'auto', tool: LOCAL }));
    expect(decision.guard).toBe('configured-tool');
    expect(decision.route).toBe('on-device');
    expect(tool).toEqual(LOCAL);
  });

  it('heterogeneous step pins in ONE chain each resolve independently under runOn auto', () => {
    const agent = mk({ autonomous: true, runOn: 'auto', tool: LOCAL });
    // Step 1: Perplexity pin (collect news — web-mandatory instruction).
    const step1 = resolveEscalationLadder(
      { ...agent, tool: PERPLEXITY, prompt: STEP1_INSTRUCTION },
      CONSENTED,
      STEP1_INSTRUCTION,
    );
    expect(step1.tools[0]).toEqual(PERPLEXITY);
    // Step 2: local pin (pure transform instruction).
    const step2Instruction = 'ローカルLLMで要約して';
    const step2 = resolveEscalationLadder(
      { ...agent, tool: LOCAL, prompt: step2Instruction },
      CONSENTED,
      step2Instruction,
    );
    expect(step2.tools[0]).toEqual(LOCAL);
  });
});
