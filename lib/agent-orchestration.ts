/**
 * lib/agent-orchestration.ts — Phase 4 multi-step orchestration: pure core.
 *
 * Orchestration runs a task as an ORDERED LINEAR sequence of steps, passing each
 * step's result into the next. CRITICAL SECURITY PROPERTY: this layer NEVER
 * executes a command. It only sequences prompts and enforces a step/time budget.
 * Each step is run through the EXISTING single-run path (generateRunScript → B2
 * driver), so every command still passes the same `classifyProposedCommand`
 * boundary + command-safety gate. An orchestrated run therefore can never exceed
 * the privileges of a single manual command — chaining adds no privilege.
 *
 * The B-persistence finding (Android phantom-process ceiling) means long local
 * chains must REFUSE/STOP rather than hang: the budget (hard step + time caps)
 * gates each step before it launches.
 *
 * All functions are pure (no IO) for deterministic unit tests.
 */
import type { AgentOrchestrationConfig, AgentOrchestrationStep, AgentRunStep, ToolChoice } from '@/store/types';
import { GEMINI_WEB, PERPLEXITY_WEB } from './agent-router-scoring';

/** Sensible default; the hard cap protects the phantom-process ceiling. */
export const DEFAULT_MAX_STEPS = 6;
export const HARD_MAX_STEPS = 10;
export const DEFAULT_TOTAL_TIMEOUT_MS = 30 * 60_000; // 30 min
export const HARD_TOTAL_TIMEOUT_MS = 60 * 60_000; // 1 h ceiling
const MAX_STEP_INSTRUCTION_CHARS = 500;
const MAX_PROMPT_CHARS = 6000;
const MAX_RESULT_CARRY_CHARS = 1500;
const MAX_PREVIEW_CHARS = 500;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export interface ResolvedBudget {
  maxSteps: number;
  totalTimeoutMs: number;
}

/**
 * Resolve the effective budget from the agent config, clamped to the hard caps.
 * maxSteps never exceeds HARD_MAX_STEPS (phantom-process ceiling); the timeout
 * never exceeds HARD_TOTAL_TIMEOUT_MS.
 */
export function resolveBudget(cfg: AgentOrchestrationConfig | undefined): ResolvedBudget {
  const stepCount = cfg?.steps?.length ?? 0;
  const requestedMax = cfg?.maxSteps ?? Math.min(stepCount || DEFAULT_MAX_STEPS, DEFAULT_MAX_STEPS);
  const requestedTimeout = cfg?.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  return {
    maxSteps: clamp(Math.floor(requestedMax) || 1, 1, HARD_MAX_STEPS),
    totalTimeoutMs: clamp(Math.floor(requestedTimeout) || DEFAULT_TOTAL_TIMEOUT_MS, 1_000, HARD_TOTAL_TIMEOUT_MS),
  };
}

export interface NormalizedStep {
  instruction: string;
  /** Present only when this step pins a concrete tool (Phase 5). Absent =
   *  today's exact auto-routing behavior. */
  tool?: ToolChoice;
}

/**
 * Normalize a single step entry — either the legacy plain-string shape or the
 * Phase 5 { instruction, tool? } object — into one canonical shape. Pure,
 * trims/truncates the instruction the same way for both input shapes.
 */
export function normalizeStep(step: string | AgentOrchestrationStep): NormalizedStep {
  if (typeof step === 'string') {
    return { instruction: step.trim().slice(0, MAX_STEP_INSTRUCTION_CHARS) };
  }
  const instruction = (step.instruction ?? '').trim().slice(0, MAX_STEP_INSTRUCTION_CHARS);
  return step.tool ? { instruction, tool: step.tool } : { instruction };
}

/** Return the ordered, bounded, non-empty steps for an agent (normalized). */
export function normalizeSteps(cfg: AgentOrchestrationConfig | undefined): NormalizedStep[] {
  if (!cfg?.steps) return [];
  return cfg.steps
    .map(normalizeStep)
    .filter((s) => s.instruction.length > 0)
    .slice(0, HARD_MAX_STEPS);
}

/** True when the agent should run as a multi-step orchestration (≥ 2 steps). */
export function isOrchestrated(cfg: AgentOrchestrationConfig | undefined): boolean {
  return normalizeSteps(cfg).length >= 2;
}

export interface StepGate {
  proceed: boolean;
  reason?: string;
}

/**
 * Decide whether to launch the next step. REFUSES (never hangs) when the prior
 * step failed, the step budget is reached, or the time budget is exceeded.
 */
export function nextStepGate(opts: {
  stepIndex: number;
  budget: ResolvedBudget;
  startedAtMs: number;
  now: number;
  priorFailed: boolean;
}): StepGate {
  if (opts.priorFailed) return { proceed: false, reason: 'previous step failed — chain stopped' };
  if (opts.stepIndex >= opts.budget.maxSteps) {
    return { proceed: false, reason: `step budget reached (${opts.budget.maxSteps})` };
  }
  if (opts.now - opts.startedAtMs > opts.budget.totalTimeoutMs) {
    return { proceed: false, reason: 'total time budget exceeded' };
  }
  return { proceed: true };
}

/**
 * Build the prompt for step `i`: the base prompt + the carried (bounded) prior
 * results + this step's instruction. Bounded so a long chain can't unbounded-grow
 * the prompt.
 */
export function buildStepPrompt(
  basePrompt: string,
  instruction: string,
  priorResults: string[]
): string {
  const head = basePrompt.trim() ? `${basePrompt.trim()}\n\n` : '';
  const carried = priorResults.length
    ? `# Results from previous steps\n${priorResults
        .map((r, i) => `## Step ${i + 1}\n${r.replace(/\s+/g, ' ').trim().slice(0, MAX_RESULT_CARRY_CHARS)}`)
        .join('\n\n')}\n\n---\n\n`
    : '';
  return `${head}${carried}# This step\n${instruction.trim()}`.slice(0, MAX_PROMPT_CHARS);
}

/**
 * Reduce per-step statuses to a single run status. Precedence:
 *   1. any hard 'error' → error (the run is a unit and feeds the circuit breaker
 *      as ONE failure),
 *   2. else any transient 'unavailable' → unavailable (a web outage stopped the
 *      chain; the breaker EXCLUDES this so a multi-step agent is not auto-disabled
 *      by a transient failure — same invariant as the single-run path),
 *   3. all skipped → skipped,
 *   4. else success.
 */
export function reduceStatus(
  steps: Pick<AgentRunStep, 'status'>[],
): 'success' | 'error' | 'skipped' | 'unavailable' {
  if (steps.length === 0) return 'skipped';
  if (steps.some((s) => s.status === 'error')) return 'error';
  if (steps.some((s) => s.status === 'unavailable')) return 'unavailable';
  if (steps.every((s) => s.status === 'skipped')) return 'skipped';
  return 'success';
}

/** Build the single run-log preview for an orchestrated run (bounded). */
export function combineFinalPreview(steps: AgentRunStep[]): string {
  if (steps.length === 0) return '';
  const failed = steps.find((s) => s.status === 'error');
  if (failed) {
    return `Step ${failed.index + 1}/${steps.length} failed: ${failed.outputPreview}`.slice(0, MAX_PREVIEW_CHARS);
  }
  // No hard error but a transient web outage stopped the chain — surface it as
  // "temporarily unavailable" (will retry next schedule), not a failure.
  const transient = steps.find((s) => s.status === 'unavailable');
  if (transient) {
    return `Step ${transient.index + 1}/${steps.length} temporarily unavailable (web backend busy): ${transient.outputPreview}`.slice(
      0,
      MAX_PREVIEW_CHARS,
    );
  }
  const last = [...steps].reverse().find((s) => s.status === 'success');
  const head = `Completed ${steps.length} step(s). `;
  return `${head}${last?.outputPreview ?? ''}`.slice(0, MAX_PREVIEW_CHARS);
}

// ── NL step detection ────────────────────────────────────────────────────────

const JP_SEQUENCE_SPLIT = /(?:^|[、。\n])\s*(?:まず|最初に|次に|その後|それから|続いて|最後に|そして)\s*/;
const NUMBERED_SPLIT = /(?:^|\n)\s*(?:\d+[.)、]|ステップ\s*\d+[:：.]?|step\s*\d+[:.]?)\s*/i;
const EN_SEQUENCE_SPLIT = /(?:^|[.\n])\s*(?:first|then|next|after that|finally|lastly)[,:]?\s+/i;

/**
 * Detect an explicit multi-step instruction in an utterance and split it into
 * ordered steps. Returns [] when it is not clearly multi-step (≥ 2 parts), so a
 * normal single task stays single-run. Conservative on purpose.
 */
export function parseStepsFromText(text: string): string[] {
  for (const re of [NUMBERED_SPLIT, JP_SEQUENCE_SPLIT, EN_SEQUENCE_SPLIT]) {
    const parts = text
      .split(new RegExp(re, re.flags.includes('g') ? re.flags : re.flags + 'g'))
      .map((s) => s.trim())
      .filter((s) => s.length > 1);
    if (parts.length >= 2) {
      return parts.slice(0, HARD_MAX_STEPS).map((s) => s.slice(0, MAX_STEP_INSTRUCTION_CHARS));
    }
  }
  return [];
}

// ── Tool-pinned step detection (Phase 6) ─────────────────────────────────────
//
// A plain て-form conjunctive chain ("集めて、…付けて、…投稿して") carries none of
// the explicit sequence markers JP_SEQUENCE_SPLIT/EN_SEQUENCE_SPLIT/NUMBERED_SPLIT
// look for (まず/次に/… , first/then/next/…, numbered lists), so parseStepsFromText
// never fires for it. We deliberately do NOT widen JP_SEQUENCE_SPLIT itself to
// catch plain "て、" — that risks false-positiving on ordinary prose that merely
// happens to contain "て、" with no multi-step intent. Instead this is a NARROWER,
// SEPARATE detector: it only turns a clause-boundary-delimited chain into pinned
// orchestration steps when at least one clause explicitly NAMES a tool/provider
// (パープレ/Perplexity, ローカルLLM/ローカル, Codex, Gemini). The tool mention is the
// actual "this is deliberately multi-step" signal, not the punctuation — a clause
// chain with boundaries but NO tool mention returns null and the normal
// single-run / other-detector path is used instead (regression-tested).

// Clause boundaries: JP 、/。 runs, EN ", " / "; ", and the EN conjunctions
// "then" / "and then" (which, unlike EN_SEQUENCE_SPLIT above, are recognised
// mid-sentence, not just at a clause's leading edge — this detector's own tool-
// mention gate is what keeps it narrow, so it doesn't need EN_SEQUENCE_SPLIT's
// stricter start-of-clause anchoring).
const CLAUSE_BOUNDARY = /[、。]+|,\s+|;\s+|\s*\band then\b\s*|\s*\bthen\b\s*/gi;

interface ToolMention {
  re: RegExp;
  tool: ToolChoice;
}

// Ordered; the FIRST pattern that matches a clause wins (a clause naming two
// tools is not a supported phrasing — pick the earliest/most specific). JP
// tokens match as a plain substring (no word boundary — CJK has none); Latin
// tokens use \b so e.g. "codex" doesn't fire inside an unrelated longer word.
const TOOL_MENTIONS: ToolMention[] = [
  { re: /パープレ(?:キシティ)?|perplexity/i, tool: PERPLEXITY_WEB },
  { re: /ローカル\s*llm|local\s*llm|ローカル/i, tool: { type: 'local' } },
  { re: /\bcodex\b/i, tool: { type: 'cli', cli: 'codex' } },
  { re: /\bgemini\b/i, tool: GEMINI_WEB },
];

function matchToolMention(clause: string): ToolChoice | undefined {
  for (const { re, tool } of TOOL_MENTIONS) {
    if (re.test(clause)) return tool;
  }
  return undefined;
}

/**
 * Detect a tool-pinned multi-step chain in plain conjunctive text — e.g.
 * "パープレで論文を集めて、ローカルLLMで要約して、Xに投稿して". Returns null when
 * fewer than 2 usable clauses result, OR when none of them names a tool (the
 * narrow trigger condition — see the file comment above). `tool` is set on a
 * NormalizedStep ONLY when that specific clause matched a mention; the other
 * clauses stay auto-routed (Phase 1's additive contract: absent tool = today's
 * exact auto-routing behavior for that step).
 */
export function detectToolPinnedSteps(text: string): NormalizedStep[] | null {
  const clauses = text
    .split(CLAUSE_BOUNDARY)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
  if (clauses.length < 2) return null;

  const steps: NormalizedStep[] = clauses.slice(0, HARD_MAX_STEPS).map((instruction) => {
    const tool = matchToolMention(instruction);
    const trimmedInstruction = instruction.slice(0, MAX_STEP_INSTRUCTION_CHARS);
    return tool ? { instruction: trimmedInstruction, tool } : { instruction: trimmedInstruction };
  });

  const anyToolMatched = steps.some((s) => s.tool !== undefined);
  if (!anyToolMatched) return null;

  return steps;
}
