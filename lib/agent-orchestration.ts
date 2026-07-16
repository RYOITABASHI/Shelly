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
import type { AgentApiCallConfig, AgentOrchestrationConfig, AgentOrchestrationStep, AgentRunStep, ToolChoice } from '@/store/types';
import { GEMINI_WEB, PERPLEXITY_WEB } from './agent-router-scoring';
import { AUTH_REFS } from './capability-envelope';

/** Sensible default; the hard cap protects the phantom-process ceiling. */
export const DEFAULT_MAX_STEPS = 6;
export const HARD_MAX_STEPS = 10;
export const DEFAULT_TOTAL_TIMEOUT_MS = 30 * 60_000; // 30 min
export const HARD_TOTAL_TIMEOUT_MS = 60 * 60_000; // 1 h ceiling
const MAX_STEP_INSTRUCTION_CHARS = 500;
const MAX_PROMPT_CHARS = 6000;
// Exported (not just module-local) so lib/agent-executor.ts's generated shell
// script can truncate clean_result_preview()/clean_answer_preview() to the SAME
// budget instead of a separately-hardcoded number. Found 2026-07-15 P1 audit:
// the .sh executor's clean_result_preview() truncated to 500 BYTES before a
// step's outputPreview ever reached buildStepPrompt below, so this 1500-char
// carry-forward budget was unreachable in practice — every chain step only ever
// saw <=500 chars of prior context. Importing the same constant can't fully
// close the byte-vs-JS-string-length gap (`head -c` truncates UTF-8 BYTES;
// multi-byte text such as Japanese therefore still gets fewer effective
// characters than this number implies) but it does guarantee the budgets can
// never silently drift back out of sync the way 500-vs-1500 did.
export const MAX_RESULT_CARRY_CHARS = 1500;
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
   *  today's exact auto-routing behavior. Mutually exclusive with `apiCall`
   *  (see AgentOrchestrationStep's doc comment, store/types.ts). */
  tool?: ToolChoice;
  /** Present only when this step is a structured API-call step (api-call v1).
   *  See AgentOrchestrationStep.apiCall's doc comment for the non-final-only,
   *  display-only-instruction contract. */
  apiCall?: AgentApiCallConfig;
}

/**
 * Normalize a single step entry — either the legacy plain-string shape or the
 * Phase 5 { instruction, tool? } / api-call { instruction, apiCall? } object —
 * into one canonical shape. Pure, trims/truncates the instruction the same
 * way for both input shapes. An apiCall step with a blank `instruction` gets
 * a synthesized label (apiCallLabel) so normalizeSteps's
 * `.filter(s => s.instruction.length > 0)` below never silently drops it —
 * without this, an api-call step authored with no display text would vanish
 * from the chain entirely instead of running with a generated label.
 */
export function normalizeStep(step: string | AgentOrchestrationStep): NormalizedStep {
  if (typeof step === 'string') {
    return { instruction: step.trim().slice(0, MAX_STEP_INSTRUCTION_CHARS) };
  }
  let instruction = (step.instruction ?? '').trim().slice(0, MAX_STEP_INSTRUCTION_CHARS);
  if (step.apiCall && instruction.length === 0) {
    instruction = apiCallLabel(step.apiCall);
  }
  if (step.apiCall) return { instruction, apiCall: step.apiCall };
  return step.tool ? { instruction, tool: step.tool } : { instruction };
}

/** A human-readable, display-only label for an api-call step (e.g. shown in
 *  the confirm card's step list and used as the synthesized `instruction`
 *  when the step was authored with no display text — see normalizeStep).
 *  NEVER sent to a model; the executor's model-call branch is skipped
 *  entirely for an apiCall step (see AgentOrchestrationStep.apiCall). */
export function apiCallLabel(cfg: AgentApiCallConfig): string {
  return `${cfg.method} ${cfg.host}${cfg.path}`.slice(0, MAX_STEP_INSTRUCTION_CHARS);
}

/**
 * Resolve the literal "{{result}}" placeholder in an api-call template
 * (path or bodyTemplate) against the prior step's/prompt's result, via plain
 * string-replace — no template engine, same convention as
 * intentShareText/dmReplyText/appActParams. Callers URL-encode `lastResult`
 * themselves before calling this for `path` (this function does no encoding
 * of its own, since `bodyTemplate` must NOT be URL-encoded).
 */
export function resolveApiCallTemplate(template: string | undefined, lastResult: string): string {
  return String(template ?? '').split('{{result}}').join(lastResult);
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
    const raw = text.split(new RegExp(re, re.flags.includes('g') ? re.flags : re.flags + 'g'));
    // raw[0] is whatever precedes the FIRST marker match -- a schedule clause
    // ("5分ごとに"), a greeting, or (when the marker sits at the very start of
    // the text, the common case) an empty string. Every one of these three
    // split patterns anchors on the marker itself (まず/次に/…, first/then/…,
    // "1."/"ステップ1"/…), so by construction a real step can never start
    // before the first marker -- raw[0] is always preamble, never step 1.
    //
    // bug #152: this used to only drop raw[0] when it matched the narrow
    // isScheduleOnlyClause() pattern (weekday/daily markers only), which
    // missed interval schedule cues like "5分ごとに"/"3時間ごとに" -- those
    // survived as a spurious, content-free "step 1". Since raw[0] can never
    // be a legitimate step regardless of what it contains, drop it
    // unconditionally whenever a marker actually matched (raw.length > 1);
    // when nothing matched, raw is just [text] and parts stays a single
    // element below, so this never returns true for a genuinely single-task
    // utterance.
    const parts = (raw.length > 1 ? raw.slice(1) : raw)
      .map((s) => s.trim())
      .filter((s) => s.length > 1);
    if (parts.length >= 2) {
      return parts.slice(0, HARD_MAX_STEPS).map((s) => s.slice(0, MAX_STEP_INSTRUCTION_CHARS));
    }
  }
  return [];
}

// ── Explicit api-call step detection (v1.1) ─────────────────────────────────
//
// api-call is materially different from a provider-pinned model step: the
// executor skips model routing and sends a live structured HTTP request. Keep
// this detector deliberately narrower than TOOL_MENTIONS below. A provider or
// hostname alone is NOT enough; the same clause must also explicitly say to
// call/use that provider's API. Conversely, a generic "call the API" without a
// supported provider is not enough either.
//
// Only the four AUTH_REFS-backed model APIs have a safe, already-shipped
// method/path/body contract we can reuse. The other allowlisted hosts (GitHub
// release infrastructure and loopback) do not have one universally correct
// resource/path, so NL authoring for them stays unsupported instead of guessing.
interface ApiCallPreset {
  provider: RegExp;
  buildConfig: (instruction: string) => AgentApiCallConfig;
}

const EXPLICIT_API_CALL_RE =
  /API\s*(?:を)?\s*(?:呼(?:んで|び出(?:して|す)|ぶ)|叩(?:いて|く)|コール(?:して|する)|使(?:って|う))|API\s*(?:の)?\s*(?:レスポンス|応答|response)\s*(?:を)?\s*使|\bapi\s+call\b|\b(?:call|invoke|query|request|use)\s+(?:the\s+)?(?:[a-z0-9.-]+\s+)?api\b|\buse\s+(?:the\s+)?api\s+(?:response|result)\b/i;

function apiPrompt(instruction: string): string {
  return `${instruction.trim()}\n\nPrevious step result:\n{{result}}`;
}

const API_CALL_PRESETS: ApiCallPreset[] = [
  {
    provider: /api\.perplexity\.ai|パープレ(?:キシティ)?|\bperplexity\b/i,
    buildConfig: (instruction) => ({
      host: AUTH_REFS.perplexity.host,
      method: 'POST',
      path: '/chat/completions',
      authRef: 'perplexity',
      bodyTemplate: JSON.stringify({
        model: 'sonar',
        messages: [{ role: 'user', content: apiPrompt(instruction) }],
      }),
    }),
  },
  {
    provider: /generativelanguage\.googleapis\.com|\bgemini\b|ジェミニ/i,
    buildConfig: (instruction) => ({
      host: AUTH_REFS.gemini.host,
      method: 'POST',
      path: '/v1beta/models/gemini-2.5-flash:generateContent',
      authRef: 'gemini',
      bodyTemplate: JSON.stringify({ contents: [{ parts: [{ text: apiPrompt(instruction) }] }] }),
    }),
  },
  {
    provider: /api\.cerebras\.ai|\bcerebras\b|セレブラス/i,
    buildConfig: (instruction) => ({
      host: AUTH_REFS.cerebras.host,
      method: 'POST',
      path: '/v1/chat/completions',
      authRef: 'cerebras',
      bodyTemplate: JSON.stringify({
        model: 'qwen-3-235b-a22b-instruct-2507',
        messages: [{ role: 'user', content: apiPrompt(instruction) }],
      }),
    }),
  },
  {
    provider: /api\.groq\.com|\bgroq\b/i,
    buildConfig: (instruction) => ({
      host: AUTH_REFS.groq.host,
      method: 'POST',
      path: '/openai/v1/chat/completions',
      authRef: 'groq',
      bodyTemplate: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: apiPrompt(instruction) }],
      }),
    }),
  },
];

/**
 * Convert one explicit provider-API clause to the structured api-call shape.
 * Returns null for every ambiguous/unsupported phrasing so normal model routing
 * remains the default. The caller owns the non-final-step constraint.
 */
export function detectApiCallStep(instruction: string): AgentOrchestrationStep | null {
  const text = instruction.trim().slice(0, MAX_STEP_INSTRUCTION_CHARS);
  if (!EXPLICIT_API_CALL_RE.test(text)) return null;
  const preset = API_CALL_PRESETS.find(({ provider }) => provider.test(text));
  if (!preset) return null;
  return { instruction: text, apiCall: preset.buildConfig(text) };
}

/** Apply the api-call detector to non-final steps only. */
export function detectApiCallSteps(
  steps: Array<string | AgentOrchestrationStep>,
): Array<string | AgentOrchestrationStep> {
  return steps.map((step, index) => {
    if (index === steps.length - 1) return step;
    const instruction = typeof step === 'string' ? step : step.instruction;
    return detectApiCallStep(instruction) ?? step;
  });
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

// A leading clause that is ENTIRELY a schedule/frequency marker (weekday-run,
// optionally with a time, or a bare 毎日/毎週 daily/weekly marker) rather than
// an actual instruction. lib/agent-nl-parser.ts's derivePrompt already strips
// this for the single-step path, but ONLY when parseSchedule judged the
// schedule confident -- which requires a TIME alongside the day markers. A
// slot-fill utterance ("毎週月曜と金曜に、パープレで…") states the days with NO
// time (that's exactly why slot-fill has to ask for one), so at initial-parse
// time schedule.confident is false, derivePrompt's strip never runs, and this
// splitter -- which runs on the unstripped text -- picked up the bare
// schedule clause as a bogus "step 1" with no tool pin (found via on-device
// testing 2026-07-15). Fully anchored (^...$) so it only matches a clause
// that is schedule content and NOTHING else; a real instruction that merely
// contains a weekday/time token elsewhere is never touched.
const SCHEDULE_ONLY_CLAUSE_RE =
  /^(?:毎日|毎朝|毎晩|毎夕|毎週|每週|日次|定期的?に?)?\s*[日月火水木金土]曜日?(?:\s*(?:と|・|、|,|，|および|＆|&)\s*[日月火水木金土]曜?日?)*\s*(?:\d{1,2}\s*(?:時(?:半|\d{1,2}分)?|:\d{2}))?\s*(?:に|の)?$|^(?:毎日|毎朝|毎晩|毎夕|日次)\s*(?:\d{1,2}\s*(?:時(?:半|\d{1,2}分)?|:\d{2}))?\s*(?:に|の)?$/;

function isScheduleOnlyClause(clause: string): boolean {
  return SCHEDULE_ONLY_CLAUSE_RE.test(clause);
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
  let clauses = text
    .split(CLAUSE_BOUNDARY)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
  // Drop a leading schedule-only clause (see isScheduleOnlyClause's doc
  // comment) -- only the FIRST clause, since this phrasing pattern only ever
  // states the schedule as the lead-in, never mid-chain.
  if (clauses.length > 0 && isScheduleOnlyClause(clauses[0])) {
    clauses = clauses.slice(1);
  }
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
