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
import { matchToolMention } from './agent-tool-mentions';
import { AUTH_REFS } from './capability-envelope';
import { GROQ_DEFAULT_MODEL } from './groq';
import { MAX_EVIDENCE_CHARS, renderStepEvidence, type StepEvidence } from './agent-sources';

/** Sensible default; the hard cap protects the phantom-process ceiling. */
export const DEFAULT_MAX_STEPS = 6;
export const HARD_MAX_STEPS = 10;
export const DEFAULT_TOTAL_TIMEOUT_MS = 30 * 60_000; // 30 min
export const HARD_TOTAL_TIMEOUT_MS = 60 * 60_000; // 1 h ceiling
const MAX_STEP_INSTRUCTION_CHARS = 500;
// Exported (not just module-local) for the same reason as MAX_RESULT_CARRY_CHARS
// below: bug #155(b) follow-up (docs/superpowers/DEFERRED.md, 2026-07-16) —
// lib/agent-executor.ts's generated shell script now ports buildStepPrompt's
// exact template shape into bash (codexOrchestrationChainCommand) so an
// orchestrated agent resolved to the codex driver actually runs its full chain
// on an unattended/scheduled fire. That bash-side prompt assembly must cap the
// composed prompt to the SAME budget buildStepPrompt uses, not a
// separately-hardcoded number that could silently drift from this one.
export const MAX_PROMPT_CHARS = 6000;
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
// Fan-out subtasks (2026-08-13): hard cap on branches per parallel group.
// Chosen well below HARD_MAX_STEPS and mindful of the same Android
// phantom-process ceiling the step budget protects. The unattended PlanSpec
// executor enforces this as a live in-process semaphore on real concurrent
// dispatch (Increments 1a-1c, 2026-08-14); the attended TS chain remains
// serial (see AgentOrchestrationStep.parallelGroup's doc comment in
// store/types.ts for the split). Mirrored (parity-tested) into
// scripts/shelly-plan-executor.js.
export const MAX_PARALLEL_BRANCHES = 3;
// Group ids come from user-authored config (or a future NL parser) — bound
// them to a safe, display-friendly charset; anything else fails safe to
// serial (marker dropped at normalization, never an error).
const PARALLEL_GROUP_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

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
  /** Fan-out subtasks (2026-08-13): sanitized group id carried through from
   *  AgentOrchestrationStep.parallelGroup (see its doc comment in
   *  store/types.ts for the full contract). Presence here means only "the
   *  author marked this step"; whether the marker takes EFFECT (>= 2
   *  consecutive members, not the final step, within the branch cap) is
   *  decided exclusively by planParallelGroups() below — executors must
   *  consume that plan, never this raw field. */
  parallelGroup?: string;
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
  // Fan-out subtasks: carry the group id only when it passes the strict id
  // charset — a malformed id silently degrades that step to serial (fail-safe)
  // rather than failing the whole normalization.
  const rawGroup = typeof step.parallelGroup === 'string' ? step.parallelGroup.trim() : '';
  const groupField = PARALLEL_GROUP_ID_RE.test(rawGroup) ? { parallelGroup: rawGroup } : {};
  if (step.apiCall) return { instruction, apiCall: step.apiCall, ...groupField };
  return step.tool ? { instruction, tool: step.tool, ...groupField } : { instruction, ...groupField };
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
 * intentShareText/dmReplyText. Callers URL-encode `lastResult`
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

// ── Fan-out subtasks (parallel groups) ───────────────────────────────────────

/** The resolved fan-out plan for one normalized step list — see
 *  planParallelGroups() below. Index-aligned with the steps array. */
export interface ParallelPlan {
  /** For step i: how many entries of the chain's ordered success-result list
   *  this step's prompt/quality-check may SEE. Serial steps see everything
   *  before them (contextBase[i] === i, the exact pre-existing behavior, so
   *  `results.slice(0, contextBase[i])` is a no-op there); every branch of an
   *  effective group shares its group's START index — the pre-group snapshot —
   *  so no branch ever sees a sibling's output. Valid to use as a slice bound
   *  only under the chain's fail-fast invariant (a step only runs when every
   *  earlier step succeeded, so the results list has exactly i entries when
   *  step i launches), which both executors preserve unchanged. */
  contextBase: number[];
  /** For step i: the group id it EFFECTIVELY runs as a branch of, after the
   *  >= 2-consecutive-members / not-final-step / branch-cap rules — undefined
   *  for every serial step (including marked steps whose marker was severed
   *  by those rules). */
  group: (string | undefined)[];
}

/**
 * Resolve which steps EFFECTIVELY run as fan-out branches. Pure; the single
 * place the grouping rules live (see AgentOrchestrationStep.parallelGroup's
 * doc comment in store/types.ts for the user-facing contract):
 *   1. only CONSECUTIVE steps sharing the same sanitized group id group;
 *   2. an effective group needs >= 2 members — a singleton stays serial;
 *   3. the chain's FINAL step is never a branch (it performs the agent
 *      action and must see the aggregated context) — it is severed first,
 *      and the remaining run may still group if >= 2 members survive;
 *   4. members beyond MAX_PARALLEL_BRANCHES are severed to serial (the cap
 *      is a hard limit, deterministic, never an error).
 * Severing NEVER drops a step — a severed member runs as an ordinary serial
 * step at its declared position, seeing everything before it (including its
 * former group's branch results), so every authored instruction still runs.
 * Mirrored (parity-tested) into scripts/shelly-plan-executor.js.
 */
export function planParallelGroups(steps: NormalizedStep[]): ParallelPlan {
  const contextBase = steps.map((_, i) => i);
  const group: (string | undefined)[] = steps.map(() => undefined);
  let runStart = 0;
  for (let i = 0; i <= steps.length; i++) {
    const sameRun =
      i < steps.length &&
      steps[i].parallelGroup !== undefined &&
      steps[i].parallelGroup === steps[runStart]?.parallelGroup;
    if (sameRun) continue;
    // [runStart, i) is a maximal run of one marker value (or unmarked steps).
    if (steps[runStart]?.parallelGroup !== undefined) {
      // Rule 3: the final step never groups — a run reaching the end of the
      // chain is trimmed by one (runStart < steps.length here, so this can
      // only shrink the run, never underflow past runStart).
      let runEnd = i;
      if (runEnd === steps.length) runEnd = steps.length - 1;
      // Rule 4: cap the group size.
      const effectiveEnd = Math.min(runEnd, runStart + MAX_PARALLEL_BRANCHES);
      // Rule 2: >= 2 members or stay serial.
      if (effectiveEnd - runStart >= 2) {
        for (let j = runStart; j < effectiveEnd; j++) {
          group[j] = steps[j].parallelGroup;
          contextBase[j] = runStart;
        }
      }
    }
    runStart = i;
  }
  return { contextBase, group };
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
 *
 * The current step's own instruction ("# This step\n...", always the LAST
 * segment) must never be silently truncated away. The previous implementation
 * composed the full string (head + carried + tail) and then sliced the WHOLE
 * thing to MAX_PROMPT_CHARS from the front — on a long enough `carried` block
 * (several prior steps each near their own MAX_RESULT_CARRY_CHARS budget),
 * that cutoff could land before the tail even started, leaving the model with
 * prior-step content and NO instruction telling it what to do with it.
 * 2026-08-04 real on-device symptom this fixes: an orchestrated
 * summarize-then-notify chain's later steps produced content that was either
 * unrelated to (fabricated relative to) the carried research, or a
 * byte-for-byte repeat of the immediately preceding step's own output — both
 * consistent with the model receiving no live instruction for that step.
 *
 * Fix: reserve the tail's budget FIRST (it is small and already bounded —
 * normalizeStep caps instruction to MAX_STEP_INSTRUCTION_CHARS before this
 * function ever sees it), then truncate only the head+carried prefix to
 * whatever budget remains. The tail itself is still defensively capped to
 * MAX_PROMPT_CHARS so the overall return value can never exceed the budget
 * even in a pathological case.
 */
export function buildStepPrompt(
  basePrompt: string,
  instruction: string,
  priorResults: string[],
  evidence?: StepEvidence,
): string {
  const tail = `# This step\n${instruction.trim()}`.slice(0, MAX_PROMPT_CHARS);
  // Sourced briefings (2026-10-09, lib/agent-sources.ts): the research
  // directive / numbered Sources + sourcing contract is reserved BEFORE the
  // head+carried prefix is truncated, exactly like the tail — so neither the
  // 1500-char text carry nor a long base prompt can push the sources or the
  // contract out of the prompt. Absent evidence = byte-identical to before.
  const evidenceBlock = evidence ? renderStepEvidence(evidence).slice(0, MAX_EVIDENCE_CHARS) : '';
  const headBudget = Math.max(0, MAX_PROMPT_CHARS - tail.length - evidenceBlock.length);
  const head = basePrompt.trim() ? `${basePrompt.trim()}\n\n` : '';
  const carried = priorResults.length
    ? `# Results from previous steps\n${priorResults
        .map((r, i) => `## Step ${i + 1}\n${r.replace(/\s+/g, ' ').trim().slice(0, MAX_RESULT_CARRY_CHARS)}`)
        .join('\n\n')}\n\n---\n\n`
    : '';
  return `${`${head}${carried}`.slice(0, headBudget)}${evidenceBlock}${tail}`;
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
): 'success' | 'error' | 'skipped' | 'unavailable' | 'pending' {
  if (steps.length === 0) return 'skipped';
  if (steps.some((s) => s.status === 'error')) return 'error';
  if (steps.some((s) => s.status === 'unavailable')) return 'unavailable';
  // 'pending' (2026-10-09): the final action is still running in the
  // background; never an error, never counted by the circuit breaker.
  if (steps.some((s) => s.status === 'pending')) return 'pending';
  if (steps.every((s) => s.status === 'skipped')) return 'skipped';
  return 'success';
}

/** Build the single run-log preview for an orchestrated run (bounded). */
export function combineFinalPreview(steps: AgentRunStep[], totalSteps?: number): string {
  if (steps.length === 0) return '';
  // totalSteps (2026-08-03): the chain's FULL planned length. Defaults to
  // steps.length (the old behavior) when the caller doesn't have it handy —
  // but a fail-fast chain stops after the failing step, so steps.length is
  // really "attempted so far", not "planned total". A 5-step chain that dies
  // on step 1 used to render "Step 1/1 failed", reading as if that were the
  // whole chain — pass the real total so it reads "Step 1/5 failed" instead.
  const total = totalSteps ?? steps.length;
  const failed = steps.find((s) => s.status === 'error');
  if (failed) {
    return `Step ${failed.index + 1}/${total} failed: ${failed.outputPreview}`.slice(0, MAX_PREVIEW_CHARS);
  }
  // No hard error but a transient web outage stopped the chain — surface it as
  // "temporarily unavailable" (will retry next schedule), not a failure.
  const transient = steps.find((s) => s.status === 'unavailable');
  if (transient) {
    return `Step ${transient.index + 1}/${total} temporarily unavailable (web backend busy): ${transient.outputPreview}`.slice(
      0,
      MAX_PREVIEW_CHARS,
    );
  }
  const pending = steps.find((s) => s.status === 'pending');
  if (pending) {
    return `Step ${pending.index + 1}/${total} still running: ${pending.outputPreview}`.slice(0, MAX_PREVIEW_CHARS);
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

// Same trigger-verb vocabulary as EXPLICIT_API_CALL_RE, reused below to strip
// the tool-invocation clause out of the text that actually reaches the model.
const JP_TRIGGER_VERB = '(?:呼(?:んで|び出(?:して|す)|ぶ)|叩(?:いて|く)|コール(?:して|する)|使(?:って|う))';
const EN_TRIGGER_VERB = '(?:call|invoke|query|request|use)';

/**
 * Strip the tool-invocation clause (e.g. "PerplexityのAPIを呼んで" / "call the
 * Perplexity API to") out of an instruction before it becomes the model's
 * actual prompt. Found 2026-07-16 on-device: without this, apiPrompt() sent
 * the RAW instruction verbatim as the chat message — but that text was
 * authored as a ROUTING directive for the agent ("use Perplexity for this
 * step"), not as a question for the model itself. A real search-augmented
 * model (sonar) reads "call the Perplexity API and get the latest STEAM
 * news" as a meta-request to explain HOW to call an API, and answers with
 * usage instructions instead of performing the search — reproduced live via
 * agent-mrnaqw5g (step 1 "succeeded" at the HTTP layer, but step 2 correctly
 * recognized the carried-forward content was an API-usage explanation, not
 * real news, and refused to summarize it as fact).
 *
 * Only strips the FIRST clause matching this provider's own detection
 * pattern plus a trigger verb; falls back to the untouched instruction if
 * stripping would leave nothing substantive (e.g. an instruction that is
 * ONLY the tool mention, with no separate content clause).
 */
function stripApiCallClause(instruction: string, providerRe: RegExp): string {
  const jpClause = new RegExp(`(?:${providerRe.source})\\s*の?\\s*API\\s*(?:を)?\\s*${JP_TRIGGER_VERB}[、,]?\\s*`, 'i');
  const enClause = new RegExp(`${EN_TRIGGER_VERB}\\s+(?:the\\s+)?(?:${providerRe.source})\\s+api\\s*(?:to|and|,)?\\s*`, 'i');
  const stripped = instruction.replace(jpClause, '').replace(enClause, '').replace(/^[の、,\s]+/, '').trim();
  return stripped.length >= 4 ? stripped : instruction.trim();
}

function apiPrompt(instruction: string, providerRe: RegExp): string {
  return `${stripApiCallClause(instruction, providerRe)}\n\nPrevious step result:\n{{result}}`;
}

const PERPLEXITY_PROVIDER_RE = /api\.perplexity\.ai|パープレ(?:キシティ)?|\bperplexity\b/i;
const GEMINI_PROVIDER_RE = /generativelanguage\.googleapis\.com|\bgemini\b|ジェミニ/i;
const CEREBRAS_PROVIDER_RE = /api\.cerebras\.ai|\bcerebras\b|セレブラス/i;
const GROQ_PROVIDER_RE = /api\.groq\.com|\bgroq\b/i;

const API_CALL_PRESETS: ApiCallPreset[] = [
  {
    provider: PERPLEXITY_PROVIDER_RE,
    buildConfig: (instruction) => ({
      host: AUTH_REFS.perplexity.host,
      method: 'POST',
      path: '/chat/completions',
      authRef: 'perplexity',
      bodyTemplate: JSON.stringify({
        model: 'sonar',
        messages: [{ role: 'user', content: apiPrompt(instruction, PERPLEXITY_PROVIDER_RE) }],
      }),
    }),
  },
  {
    provider: GEMINI_PROVIDER_RE,
    buildConfig: (instruction) => ({
      host: AUTH_REFS.gemini.host,
      method: 'POST',
      path: '/v1beta/models/gemini-2.5-flash:generateContent',
      authRef: 'gemini',
      bodyTemplate: JSON.stringify({ contents: [{ parts: [{ text: apiPrompt(instruction, GEMINI_PROVIDER_RE) }] }] }),
    }),
  },
  {
    provider: CEREBRAS_PROVIDER_RE,
    buildConfig: (instruction) => ({
      host: AUTH_REFS.cerebras.host,
      method: 'POST',
      path: '/v1/chat/completions',
      authRef: 'cerebras',
      bodyTemplate: JSON.stringify({
        model: 'gpt-oss-120b',
        messages: [{ role: 'user', content: apiPrompt(instruction, CEREBRAS_PROVIDER_RE) }],
      }),
    }),
  },
  {
    provider: GROQ_PROVIDER_RE,
    buildConfig: (instruction) => ({
      host: AUTH_REFS.groq.host,
      method: 'POST',
      path: '/openai/v1/chat/completions',
      authRef: 'groq',
      bodyTemplate: JSON.stringify({
        model: GROQ_DEFAULT_MODEL,
        messages: [{ role: 'user', content: apiPrompt(instruction, GROQ_PROVIDER_RE) }],
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

// TOOL_MENTIONS / matchToolMention moved to lib/agent-tool-mentions.ts
// (2026-10-15) so lib/agent-tool-router.ts can reuse the SAME table for the
// single-clause agent-level pin (suggestToolForDraft) without an import cycle.

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

/** Exported (2026-08-03) so lib/agent-conversational-registration.ts's Tier 3
 *  step sanitizer can share the SAME weekday/daily schedule-clause detection
 *  this file's Tier 1 splitter uses, instead of growing a drifting copy.
 *  Tier 1's own usage (detectToolPinnedSteps' leading-clause drop below) is
 *  unchanged. */
// English counterpart (v8.1.1 on-device, 2026-10-16): "Every day at 09:45,
// research … with Perplexity …" — derivePrompt stripped "Every day" but left
// "at 09:45", and the comma split turned that fragment into a bogus step 1
// (which also made the draft look like a per-step tool chain, i.e. high-risk).
// Same fully-anchored rule as the JA pattern: an optional recurrence marker
// (every day / daily / every Monday and Friday / on weekdays …) plus an
// optional "at HH[:MM][am|pm]" and NOTHING else. Full weekday names or their
// standard abbreviations only, so an ordinary word ("sunshine") never matches.
const EN_DAY = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)s?';
const EN_SCHEDULE_ONLY_CLAUSE_RE = new RegExp(
  '^(?:(?:every|each)\\s+(?:day|morning|evening|night|weekday|week)|everyday|daily|weekly|on\\s+weekdays|' +
    `(?:(?:every|each|on)\\s+)?${EN_DAY}(?:\\s*(?:,|and|&)\\s*${EN_DAY})*)?` +
    '\\s*(?:at\\s+\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)?)?$',
  'i',
);

export function isScheduleOnlyClause(clause: string): boolean {
  if (SCHEDULE_ONLY_CLAUSE_RE.test(clause)) return true;
  const t = clause.trim().replace(/[.,;:]+$/, '').trim();
  return t.length > 0 && EN_SCHEDULE_ONLY_CLAUSE_RE.test(t);
}

/** A pure delivery directive and nothing else — the agent's own action.type
 *  already performs the delivery AFTER the chain, so a trailing step saying
 *  only "notify" duplicates it as a pointless model call. Allowed prefixes
 *  are object/recipient fillers (「結果を」「ユーザーに」…); anything else
 *  before 通知/お知らせ (e.g. 「通知内容を作成して」— 通知 is the object of real
 *  work there, not the verb) fails the anchor and is kept. Shared with
 *  lib/agent-conversational-registration.ts's Tier 3 step sanitizer (2026-08-04)
 *  — this was previously duplicated per-tier and drifted: Tier 1's own
 *  detectToolPinnedSteps had NO equivalent filter at all, so a plain
 *  conjunctive utterance ("…を集めて、…で要約して、通知して") kept a bare
 *  "通知して" as its own orchestration step even after Tier 3's sanitizer was
 *  fixed — on-device repro (2026-08-04) confirmed this exact utterance never
 *  reaches Tier 3 at all when the deterministic parser already resolves
 *  action.type + all steps and only the schedule time is missing (Tier 2
 *  single-slot-fill path). */
const JA_NOTIFY_ONLY_CLAUSE_RE =
  /^(?:(?:結果|それ|完了|内容)[をは]\s*|私に\s*|ユーザー[にへ]\s*)*(?:プッシュ)?(?:通知|お知らせ)\s*(?:して(?:ね|ください)?|する|を(?:送信|送)(?:して(?:ください)?|する|って|る)?)?$/;
const EN_NOTIFY_ONLY_CLAUSE_RE =
  /^(?:(?:please\s+)?notify(?:\s+me)?|send(?:\s+me)?\s+(?:a\s+)?(?:push\s+)?notification)\.?$/i;

/** Strip trailing sentence punctuation before the anchored checks — callers
 *  may hand this a full-sentence clause ("通知して。"). */
function stripTrailingClausePunct(text: string): string {
  return text.trim().replace(/[。．.、,！!]+$/, '').trim();
}

export function isNotifyOnlyClause(clause: string): boolean {
  const t = stripTrailingClausePunct(clause);
  if (!t) return false;
  return JA_NOTIFY_ONLY_CLAUSE_RE.test(t) || EN_NOTIFY_ONLY_CLAUSE_RE.test(t);
}

// ── Verb-less clause handling (2026-10-30, "zero questions" agent setup) ─────
//
// On-device repro: 「STOPALLテスト: ローカルLLMで、日本の四季について800字の文章
// を書き、それを英語に翻訳し、最後に3行で要約して、結果をメモとして保存して」 split
// on every 、 into five steps: step 1 was the bare fragment 「STOPALLテスト:
// ローカルLLMで」 (name prefix + tool phrase, no verb) carrying the only tool pin,
// the three real work steps were unpinned, and the trailing save directive ran
// as its own model call. The helpers below fix each piece deterministically.

/** Explicit name prefix: 「名前: X、…」 / "Name: X, …". The name runs up to the
 *  first clause boundary. */
const EXPLICIT_NAME_PREFIX_RE = /^\s*(?:名前|エージェント名|name|agent\s+name)\s*[:：]\s*([^\n、,。]+?)\s*(?:[\n、,。]\s*|$)/i;
/** Bare label prefix: 「STOPALLテスト: …」. One short token (no whitespace,
 *  no quotes/brackets) followed by a colon and real content. */
const LABEL_NAME_PREFIX_RE = /^\s*([^\s:：、。,「」『』"'`（）()[\]{}<>]{1,24})\s*[:：]\s*(?=\S)/;
/** A label that is really a URL scheme, a clock time or a key/value style
 *  word must never be read as a name ("https://…", "9:30に…", "API key: …"). */
const NOT_A_NAME_LABEL_RE = /^(?:https?|ftp|file|mailto|tel|data|ssh|git|note|memo|todo|api|key|token|password|pw)$/i;

/**
 * Split a leading agent-name prefix off an utterance. Returns null when there
 * is none (or nothing would be left of the task). Rules, in order:
 *  - 「名前: X、…」/「Name: X, …」 → name X (may contain spaces).
 *  - 「<label>: …」 where <label> is one short token that is not a URL scheme,
 *    not a time ("9:30"), not a tool name (「Perplexity: …」 names the tool,
 *    not the agent) and not a key/value word.
 */
export function extractNamePrefix(text: string): { name: string; rest: string } | null {
  const explicit = EXPLICIT_NAME_PREFIX_RE.exec(text);
  if (explicit) {
    const name = explicit[1].trim();
    const rest = text.slice(explicit[0].length).trim();
    return name && rest ? { name, rest } : null;
  }
  const label = LABEL_NAME_PREFIX_RE.exec(text);
  if (!label) return null;
  const name = label[1].trim();
  const rest = text.slice(label[0].length).trim();
  if (!name || !rest) return null;
  if (/^\d/.test(name) || /^\/\//.test(rest) || NOT_A_NAME_LABEL_RE.test(name)) return null;
  // Review fix (2026-10-30): a clock time ("毎朝8:30に…") or a sentence that
  // merely has a colon in it ("ニュースを要約して: 3行で") is not a name.
  if (/^[0-9０-９]/.test(rest)) return null;
  if (LABEL_SENTENCE_LIKE_RE.test(name) || LABEL_SCHEDULE_CUE_RE.test(name)) return null;
  if (matchToolMention(name)) return null;
  return { name, rest };
}

/** Hiragana particles / verb endings inside a bare label mean it is a clause
 *  of the sentence, not a name (「ニュースを要約して」「朝の要約」). An explicit
 *  「名前: …」 prefix is the way to give a name like that. */
const LABEL_SENTENCE_LIKE_RE = /[てにをはがでへとのもやかよ]|(?:する|した|して|ます|ない|たい|れる|せる)$|[るうくすつぬむぶぐ]$/;
/** A schedule word or any digit inside a bare label (「毎朝8」「朝」「週末」
 *  「every day」) — the colon belongs to a time or a schedule lead-in. */
const LABEL_SCHEDULE_CUE_RE =
  /[0-9０-９]|毎|ごと|おき|曜|平日|週|月次|日次|朝|昼|夕|夜|晩|深夜|午前|午後|今日|明日|今夜|今晩|[一二三四五六七八九十]+時|\b(?:daily|weekly|monthly|hourly|every|each|morning|evening|night|noon|tonight|today|tomorrow|weekdays?|weekends?)\b/i;

/** Particles / instrument markers that may surround a tool name in a clause
 *  that does nothing but name the tool (「ローカルLLMで」「Perplexityを使って」
 *  "with the local LLM"). */
const TOOL_ONLY_FILLER_RE =
  /^(?:(?:全部|すべて|全て|ぜんぶ)\s*)?(?:で|にて|を\s*使(?:って|い)|を\s*用いて|を\s*利用して|経由で|に\s*(?:任せて|頼んで))?$|^(?:with|using|via|through|use|on|in)?\s*(?:the\s+)?$/i;
const TOOL_ONLY_PREFIX_RE = /^(?:(?:with|using|via|through|use|on|in)\s+(?:the\s+)?)?/i;

/** true when `clause` names a tool and contains no work of its own — a pure
 *  instrument phrase like 「ローカルLLMで」. */
export function isToolOnlyClause(clause: string): boolean {
  const t = clause.trim().replace(/[。．.、,！!]+$/, '').trim();
  if (!t || !matchToolMention(t)) return false;
  // Remove the FIRST tool mention (same table as matchToolMention), then see
  // whether anything but filler particles remains.
  const withoutPrefix = t.replace(TOOL_ONLY_PREFIX_RE, '');
  const mention = /パープレ(?:キシティ)?|perplexity|ローカル\s*llm|local\s*llm|ローカル|\bcodex\b|\bgemini\b/i.exec(withoutPrefix);
  if (!mention || mention.index !== 0) return false;
  const remainder = withoutPrefix.slice(mention[0].length).trim();
  return TOOL_ONLY_FILLER_RE.test(remainder);
}

/** Leading sequence markers on a clause-split step (「最後に3行で要約して」) — the
 *  order is already encoded by the step list itself. */
const LEADING_SEQUENCE_MARKER_RE = /^(?:まず(?:は)?|最初に|次に|その後|それから|続いて|最後に|そして)\s*[、,]?\s*/;

/** Trailing "save the result as <noun>" directive — absorbed into the agent's
 *  'draft' action rather than run as a step. Requires an explicit destination
 *  NOUN ("メモとして保存", "save it as a note") so a bare 「保存して」 / "save the
 *  digest" (which may carry intent this cannot judge) stays a step. */
const JA_SAVE_ONLY_CLAUSE_RE =
  /^(?:(?:結果|それ|これ|内容|全部|すべて|まとめ|出力)\s*[をは]\s*)?((?:メモ|ノート|ファイル|テキスト(?:ファイル)?|マークダウン|markdown|下書き|ドラフト|記録)\s*(?:として|に)\s*(?:保存|記録|残)(?:し|す)?)(?:て(?:おいて|おいてください|ください|ね)?|る|ておく|といて|しといて)?$/i;
const EN_SAVE_ONLY_CLAUSE_RE =
  /^(?:and\s+)?(?:then\s+)?(?:please\s+)?(save|store|keep)\s+(?:it|this|that|the\s+results?|the\s+output|everything)\s+(as|in|to)\s+(?:a\s+|an\s+)?(note|memo|file|markdown\s+file|draft)\.?$/i;

/**
 * The user's own label for a trailing save directive, or null when `clause`
 * is not one: 「結果をメモとして保存して」 → 「メモとして保存」, "save it as a
 * note" → "save as a note".
 */
export function saveOnlyClauseLabel(clause: string): string | null {
  const t = clause.trim().replace(/[。．.、,！!]+$/, '').trim();
  if (!t) return null;
  const ja = JA_SAVE_ONLY_CLAUSE_RE.exec(t);
  if (ja) {
    const core = ja[1].replace(/\s+/g, '');
    // Normalize the verb stem: 保存し → 保存, 残 → 残す.
    return core.replace(/(保存|記録)(?:し|す)$/, '$1').replace(/残$/, '残す');
  }
  const en = EN_SAVE_ONLY_CLAUSE_RE.exec(t);
  if (en) return `${en[1].toLowerCase()} ${en[2].toLowerCase()} a ${en[3].toLowerCase()}`;
  return null;
}

/** The label of `text`'s LAST clause when it is a save-only directive. */
export function trailingSaveClauseLabel(text: string): string | null {
  const clauses = text.split(CLAUSE_BOUNDARY).map((s) => s.trim()).filter((s) => s.length > 1);
  return clauses.length > 0 ? saveOnlyClauseLabel(clauses[clauses.length - 1]) : null;
}

/**
 * Tool-scope rule (documented, 2026-10-30): a clause that ONLY names a tool
 * (isToolOnlyClause — 「ローカルLLMで、」) is not a step. It scopes the clauses
 * after it: every following clause that does not name its own tool is pinned
 * to it, until a later clause names a different tool (that clause's own pin
 * applies to itself only, exactly as before — a mention inside a working
 * clause never carries forward). A tool-only clause at the very end has
 * nothing after it, so it pins the preceding clause if that one is unpinned.
 * Clauses naming their own tool keep the pre-existing per-clause semantics.
 */
const ACTION_LIKE_CLAUSE_RE =
  /投稿|ポスト|つぶや|呟|シェア|共有|送信|送っ|送る|送り|転送|通知|お知らせ|保存|書き出|アップロード|webhook|ウェブフック|https?:\/\/|\b(?:post|tweet|send|share|notify|save|upload|publish|email|mail)\b/i;

interface ScopedClause {
  instruction: string;
  tool?: ToolChoice;
  /** A sequencing boundary ("then", 「最後に」…) stood right before this clause. */
  seqBefore?: boolean;
  /** A parallel marker (「同時に」, "in parallel"…) opened a group at this clause. */
  startsGroup?: boolean;
}

function applyToolScopes(clauses: ReadonlyArray<string | Omit<ScopedClause, 'tool'>>): ScopedClause[] {
  const out: ScopedClause[] = [];
  let scope: ToolChoice | undefined;
  // A marker / sequencing flag on a tool-only clause carries to the next real
  // step (「同時に、ローカルLLMで、春について…」).
  let pending: Pick<ScopedClause, 'seqBefore' | 'startsGroup'> = {};
  clauses.forEach((entry, idx) => {
    const c = typeof entry === 'string' ? { instruction: entry } : entry;
    const clause = c.instruction;
    const flags = {
      ...(c.seqBefore || pending.seqBefore ? { seqBefore: true } : {}),
      ...(c.startsGroup || pending.startsGroup ? { startsGroup: true } : {}),
    };
    if (isToolOnlyClause(clause)) {
      const tool = matchToolMention(clause);
      if (out.length > 0 && idx === clauses.length - 1 && !out[out.length - 1].tool) {
        out[out.length - 1].tool = tool;
      }
      scope = tool;
      pending = flags;
      return;
    }
    pending = {};
    const own = matchToolMention(clause);
    // Review fix: a delivery/side-effect clause (post / send / webhook /
    // notify / save / a URL target) is never pulled into a model scope — the
    // tool named for the WORK steps must not become the instrument of a send.
    const scoped = scope && !ACTION_LIKE_CLAUSE_RE.test(clause) ? scope : undefined;
    const tool = own ?? scoped;
    out.push({ instruction: clause, ...(tool ? { tool } : {}), ...flags });
  });
  return out;
}

// ── Parallel markers → parallelGroup (2026-10-30) ───────────────────────────
//
// On-device repro (build 2679): 「同時に、ローカルLLMで日本の春について200字で
// 書いて、…夏…、…秋…、最後にローカルLLMで3つを1つの文章にまとめて」 produced a
// bogus step 「同時に」 and no parallelGroup at all — there was no natural-
// language way to author a fan-out group. Rules (explicit marker ONLY; an
// unmarked list is never guessed to be parallel):
//   - a marker clause (「同時に」「並行して」「並列で」「並列に」, "in parallel",
//     "at the same time", "simultaneously", "each of these") is never a step,
//     and may also lead a clause that carries work (「同時に春について書いて」,
//     "In parallel: write about spring"). 「それぞれ」 (per object) and 「一緒に」
//     (together) are NOT markers (review 2026-10-30);
//   - the work clauses right after the marker join one group with a sanitized
//     id (p1, p2, … — PARALLEL_GROUP_ID_RE);
//   - the group ends at a sequencing word (「最後に」「その後」「それから」「次に」,
//     then / finally / after that), at a clause that uses earlier output
//     (stepReferencesPriorOutput, 「3つを」「全部を」, "the three"), at a
//     transform verb (翻訳/要約/校正/… — it most likely works on the previous
//     sibling's output) unless that clause names its own topic (「〜について」,
//     a URL, "about …"), at a delivery clause (post / save / notify …), at
//     another marker, and never takes the chain's final step. When in doubt
//     the clause stays sequential, which is always safe;
//   - a sequencing-only clause (「その後、」 "finally,") is not a step either;
//     it marks the next clause as sequenced;
//   - members beyond MAX_PARALLEL_BRANCHES keep the marker so the summary can
//     say they run one after another; planParallelGroups severs them (it stays
//     the single authority on what runs in parallel);
//   - a marker left with fewer than 2 effective members is removed.

/** Markers that can lead a clause carrying work. */
const PARALLEL_LEAD_RE =
  /^(?:(?:以下を|次の(?:こと|作業)を)\s*)?(?:同時に|並行して|並列で|並列に)\s*[:：、,]?\s*|^(?:(?:do|run)\s+)?(?:(?:all\s+)?(?:of\s+)?(?:these|the\s+following)\s+)?(?:in\s+parallel|at\s+the\s+same\s+time|simultaneously)\s*[:,]?\s*|^(?:(?:do|run)\s+)?(?:for\s+)?each\s+of\s+(?:these|the\s+following)\s*[:：]\s*/i;
/** Markers that count only as a clause of their own. */
const PARALLEL_ONLY_RE =
  /^(?:(?:以下を|次の(?:こと|作業)を|これらを)\s*)?(?:同時に|並行して|並列で|並列に)\s*(?:(?:実行|処理)して|やって)?$|^(?:(?:do|run)\s+)?(?:(?:all\s+)?(?:of\s+)?(?:these|the\s+following|this)\s+)?(?:in\s+parallel|at\s+the\s+same\s+time|simultaneously)$|^(?:(?:do|run)\s+)?(?:for\s+)?each\s+of\s+(?:these|the\s+following)(?:\s+(?:in\s+parallel|at\s+the\s+same\s+time|simultaneously))?$/i;

/** The clause's work text after a leading parallel marker: '' for a marker-
 *  only clause, the remainder for a leading marker, null for no marker. */
export function parallelMarkerRemainder(clause: string): string | null {
  const t = clause.trim().replace(/[。．.、,！!:：]+$/, '').trim();
  if (!t) return null;
  if (PARALLEL_ONLY_RE.test(t)) return '';
  const lead = PARALLEL_LEAD_RE.exec(clause.trim());
  if (!lead) return null;
  const rest = clause.trim().slice(lead[0].length).trim();
  return rest.length > 1 ? rest : '';
}

/** A clause opened by a sequencing word (the order marker itself). EN
 *  "then" is a clause boundary, so it is seen through `seqBefore` instead. */
const SEQUENCE_LEAD_RE =
  /^(?:まず(?:は)?|最初に|次に|その後|それから|続いて|最後に|そして)|^(?:and\s+)?(?:then|finally|lastly|after\s+that|afterwards|next)\b/i;
const EN_SEQUENCE_STRIP_RE = /^(?:and\s+)?(?:then|finally|lastly|after\s+that|afterwards|next)\b\s*[,:]?\s*/i;
const LEADING_AND_RE = /^and\s+/i;

/** A clause that consumes the SIBLINGS' output — 「3つを」「全部を」「両方の結果」
 *  / "the three", "all of them", "both". */
const SIBLING_REFERENCE_RE =
  /(?:[0-9０-９一二三四五六七八九十両]+\s*(?:つ|個|件|本|種類)|全部|すべて|全て|両方)\s*(?:を|とも|の(?:結果|文章|内容|回答|出力))|\b(?:the\s+(?:two|three|four|five)|all\s+(?:of\s+)?(?:them|these|those|three|two)|both)\b/i;

/** A clause that is nothing but a sequencing word (「その後、」 "finally,"). */
const SEQUENCE_ONLY_CLAUSE_RE =
  /^(?:まず(?:は)?|最初に|次に|その後|それから|続いて|最後に|そして|(?:and\s+)?(?:then|finally|lastly|after\s+that|afterwards|next))$/i;

/** Verbs that transform existing text — a sibling with one of these most
 *  likely works on the PREVIOUS sibling's output (「記事を書いて、翻訳して」). */
const TRANSFORM_VERB_RE =
  /要約|翻訳|英訳|和訳|校正|添削|推敲|比較|比べ|評価|整理|まとめ|直し|直す|リライト|書き直|タイトルを\s*(?:付|つ)け|返信案|レビュー|清書|\b(?:summari[sz]e[sd]?|summary|translat(?:e|es|ed|ion)|proofread|compare|evaluate|rewrite|re-write|edit|polish|title|review|shorten|refine)\b/i;
/** The clause names its own independent source/topic, so a transform verb in
 *  it does not imply it works on a sibling (「春のニュースについて要約して」). */
const OWN_TOPIC_RE = /について|に関して|に関する|https?:\/\/|\babout\b|\bregarding\b/i;

function endsParallelGroup(step: ScopedClause, opts: { first?: boolean } = {}): boolean {
  return (
    !!step.seqBefore ||
    !!step.startsGroup ||
    SEQUENCE_LEAD_RE.test(step.instruction) ||
    stepReferencesPriorOutput(step.instruction) ||
    SIBLING_REFERENCE_RE.test(step.instruction) ||
    ACTION_LIKE_CLAUSE_RE.test(step.instruction) ||
    // The first member has no sibling before it to depend on.
    (!opts.first && TRANSFORM_VERB_RE.test(step.instruction) && !OWN_TOPIC_RE.test(step.instruction))
  );
}

/** Assign `parallelGroup` ids to the marked runs of `steps` (rules above). */
function assignParallelGroups(steps: ScopedClause[]): Array<ScopedClause & { parallelGroup?: string }> {
  const out: Array<ScopedClause & { parallelGroup?: string }> = steps.map((s) => ({ ...s }));
  let ordinal = 0;
  for (let i = 0; i < out.length; i++) {
    if (!out[i].startsGroup) continue;
    const first = { ...out[i], startsGroup: false };
    if (i === out.length - 1 || endsParallelGroup(first, { first: true })) continue;
    ordinal += 1;
    const id = `p${ordinal}`;
    out[i].parallelGroup = id;
    let j = i + 1;
    while (j < out.length - 1 && !endsParallelGroup(out[j])) {
      out[j].parallelGroup = id;
      j++;
    }
    i = j - 1;
  }
  return out;
}

/** Leading (JA / EN) or trailing (EN) instrument phrase for a tool mention —
 *  「ローカルLLMで…」「Perplexityを使って…」 / "with the local LLM, …" / "… with
 *  the local LLM". Same token set as TOOL_MENTIONS (lib/agent-tool-mentions.ts). */
const TOOL_TOKEN_SRC = String.raw`パープレ(?:キシティ)?|perplexity|ローカル\s*llm|local\s*llm|ローカル|\bcodex\b|\bgemini\b`;
const JA_TOOL_LEAD_RE = new RegExp(
  String.raw`^((?:全部|すべて|全て)\s*)?(${TOOL_TOKEN_SRC})(?:\s*の?\s*(?:api|モデル))?\s*(?:で(?!の|は|も)|にて|を\s*(?:使って|使い|用いて|利用して)|経由で)\s*[、,]?\s*`,
  'i',
);
const EN_TOOL_LEAD_RE = new RegExp(
  String.raw`^(?:with|using|via|through|on)\s+(?:(?:the|a)\s+)?(${TOOL_TOKEN_SRC})(?:\s+(?:api|model))?\s*[,:]?\s*`,
  'i',
);
const EN_TOOL_TAIL_RE = new RegExp(
  String.raw`\s*,?\s+(?:with|using|via|through|on)\s+(?:(?:the|a)\s+)?(${TOOL_TOKEN_SRC})(?:\s+(?:api|model))?\s*[.!]?$`,
  'i',
);

/**
 * Drop the instrument phrase the step's own tool pin came from — the pin
 * already says which tool runs it, so 「ローカルLLMで日本の春について書いて」
 * becomes 「日本の春について書いて」 pinned [Local LLM]. Only when the phrase names
 * the SAME tool as the pin, never on an explicit API-call clause (the api-call
 * detector needs the provider name), and never when nothing would be left.
 */
export function stripToolPhrase(instruction: string, tool: ToolChoice | undefined): string {
  if (!tool || EXPLICIT_API_CALL_RE.test(instruction)) return instruction;
  const ja = JA_TOOL_LEAD_RE.exec(instruction);
  if (ja && matchToolMention(ja[2])?.type === tool.type) {
    const remainder = instruction.slice(ja[0].length).trim();
    // Review fix: 「Geminiで作った画像を説明して」 — the phrase modifies a noun
    // (past attributive 〜た/〜だ + noun), it is not the instrument. Keep it.
    if (remainder.length > 1 && !JA_PAST_ATTRIBUTIVE_RE.test(remainder)) {
      return `${ja[1] ?? ''}${remainder}`.trim();
    }
    return instruction;
  }
  const lead = EN_TOOL_LEAD_RE.exec(instruction);
  if (lead && matchToolMention(lead[1])?.type === tool.type) {
    const remainder = instruction.slice(lead[0].length).trim();
    return remainder.length > 1 ? remainder : instruction;
  }
  const tail = EN_TOOL_TAIL_RE.exec(instruction);
  if (tail && matchToolMention(tail[1])?.type === tool.type) {
    const before = instruction.slice(0, tail.index).trim();
    // "the article written with Gemini" — a past participle right before the
    // phrase means it describes the object, not the instrument.
    if (before.length > 1 && !EN_PAST_PARTICIPLE_END_RE.test(before)) return before;
  }
  return instruction;
}

/** 「作った画像」「書いたコード」「調べた結果」: a short verb ending in た/だ
 *  immediately followed by a noun at the start of the remainder. */
const JA_PAST_ATTRIBUTIVE_RE = /^[぀-ゟ一-鿿]{0,6}?[ただ](?=[一-鿿゠-ヿA-Za-z])/;
const EN_PAST_PARTICIPLE_END_RE =
  /\b(?:\w+ed|written|made|done|drawn|taken|given|built|shown|seen|known|chosen|spoken|driven|grown|begun|run|got|gotten|found|told|said)$/i;

/** Split into clauses, recording which ones a sequencing boundary ("then")
 *  preceded — CLAUSE_BOUNDARY consumes the word itself. */
function splitClausesWithSequence(text: string): Array<{ instruction: string; seqBefore?: boolean }> {
  const boundary = new RegExp(`(${CLAUSE_BOUNDARY.source})`, CLAUSE_BOUNDARY.flags);
  const parts = text.split(boundary);
  const out: Array<{ instruction: string; seqBefore?: boolean }> = [];
  let seq = false;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? '';
    if (i % 2 === 1) {
      if (/\bthen\b/i.test(part)) seq = true;
      continue;
    }
    const s = part.trim();
    if (s.length <= 1) continue;
    out.push(seq ? { instruction: s, seqBefore: true } : { instruction: s });
    seq = false;
  }
  return out;
}

/**
 * Detect a tool-pinned multi-step chain in plain conjunctive text — e.g.
 * "パープレで論文を集めて、ローカルLLMで要約して、Xに投稿して". Returns null when
 * fewer than 2 usable clauses result, OR when none of them names a tool and no
 * explicit parallel marker formed a group (the narrow trigger condition — see
 * the file comment above). `tool` is set on a NormalizedStep ONLY when that
 * clause matched a mention (or a tool-only clause scopes it); the other
 * clauses stay auto-routed (Phase 1's additive contract: absent tool = today's
 * exact auto-routing behavior for that step).
 */
export function detectToolPinnedSteps(text: string): NormalizedStep[] | null {
  let clauses = splitClausesWithSequence(text);
  // Drop a leading schedule-only clause (see isScheduleOnlyClause's doc
  // comment) -- only the FIRST clause, since this phrasing pattern only ever
  // states the schedule as the lead-in, never mid-chain.
  if (clauses.length > 0 && isScheduleOnlyClause(clauses[0].instruction)) {
    clauses = clauses.slice(1);
  }
  // 2026-10-30: a parallel marker clause is never a step; it flags the next
  // work clause as the start of a group.
  const marked: Array<Omit<ScopedClause, 'tool'>> = [];
  let markerPending = false;
  let seqPending = false;
  for (const c of clauses) {
    const work = c.instruction.replace(LEADING_AND_RE, '');
    // A sequencing-only clause (「その後、」) is not a step either; it sequences
    // the next clause.
    if (SEQUENCE_ONLY_CLAUSE_RE.test(work.replace(/[。．.、,！!:：]+$/, '').trim())) {
      seqPending = true;
      markerPending = false;
      continue;
    }
    const rest = parallelMarkerRemainder(work);
    if (rest === '') {
      markerPending = true;
      continue;
    }
    const instruction = rest ?? c.instruction;
    marked.push({
      instruction,
      ...(c.seqBefore || seqPending ? { seqBefore: true } : {}),
      ...(rest !== null || markerPending ? { startsGroup: true } : {}),
    });
    markerPending = false;
    seqPending = false;
  }
  // 2026-10-30: a tool-only clause is folded into the clauses it scopes (see
  // applyToolScopes), and a leading sequence marker (「最後に」) is dropped from
  // a step's text when real content remains. The group boundaries are decided
  // BEFORE that strip, while the sequencing words are still visible.
  const grouped = assignParallelGroups(applyToolScopes(marked));
  if (grouped.length < 2) return null;

  const steps: NormalizedStep[] = grouped.slice(0, HARD_MAX_STEPS).map((s) => {
    let instruction = s.instruction.replace(LEADING_AND_RE, '');
    const noSeq = instruction.replace(LEADING_SEQUENCE_MARKER_RE, '').replace(EN_SEQUENCE_STRIP_RE, '').trim();
    if (noSeq.length > 1) instruction = noSeq;
    instruction = stripToolPhrase(instruction, s.tool).slice(0, MAX_STEP_INSTRUCTION_CHARS);
    return {
      instruction,
      ...(s.tool ? { tool: s.tool } : {}),
      ...(s.parallelGroup ? { parallelGroup: s.parallelGroup } : {}),
    };
  });
  const pruned = pruneIneffectiveParallelGroups(steps);

  const anyToolMatched = pruned.some((s) => s.tool !== undefined);
  const anyGroup = pruned.some((s) => s.parallelGroup !== undefined);
  if (!anyToolMatched && !anyGroup) return null;

  return pruned;
}

/**
 * Remove parallelGroup markers that never take effect: a group that does not
 * survive planParallelGroups (a single member after the final-step rule, e.g.
 * 「同時に、Aして、Bして」 where B is final) and any marker on the final step.
 * Members severed only by the branch cap keep the shared id (see the rule list
 * above). Callers that drop steps afterwards (lib/agent-nl-parser.ts drops a
 * trailing 「通知して」 / save step) must run this again. Returns new objects;
 * string steps pass through.
 */
export function pruneIneffectiveParallelGroups<T extends string | AgentOrchestrationStep>(steps: readonly T[]): T[] {
  const effective = new Set(
    planParallelGroups(steps.map((s) => normalizeStep(s))).group.filter((g): g is string => g !== undefined),
  );
  return steps.map((s, i) => {
    if (typeof s === 'string' || s.parallelGroup === undefined) return s;
    if (effective.has(s.parallelGroup) && i !== steps.length - 1) return s;
    const { parallelGroup: _dropped, ...rest } = s as AgentOrchestrationStep;
    return rest as T;
  });
}

/**
 * The clause-split steps when the text forms at least one effective parallel
 * group from an explicit marker, else null. lib/agent-nl-parser.ts prefers
 * this over the explicit-sequence splitter: parseStepsFromText drops
 * everything before the first 「最後に」/「その後」, which would silently lose
 * the marked group (「同時に、A、B、C、その後D、最後にE」 → [D, E]).
 */
export function detectParallelSteps(text: string): NormalizedStep[] | null {
  const steps = detectToolPinnedSteps(text);
  return steps && steps.some((s) => s.parallelGroup !== undefined) ? steps : null;
}

/**
 * Display grouping for a step list: consecutive members of one EFFECTIVE
 * group (planParallelGroups) collapse into one entry. `cappedCount` counts
 * the steps the author marked into a group that run one after another
 * because of MAX_PARALLEL_BRANCHES.
 */
export function groupStepsForDisplay<T extends string | AgentOrchestrationStep>(
  steps: readonly T[],
): { entries: Array<{ parallel: boolean; items: T[] }>; cappedCount: number } {
  const normalized = steps.map((s) => normalizeStep(s));
  const plan = planParallelGroups(normalized);
  const entries: Array<{ parallel: boolean; items: T[] }> = [];
  let cappedCount = 0;
  steps.forEach((s, i) => {
    const g = plan.group[i];
    const prev = entries[entries.length - 1];
    if (g !== undefined && i > 0 && plan.group[i - 1] === g && prev?.parallel) {
      prev.items.push(s);
    } else {
      entries.push({ parallel: g !== undefined, items: [s] });
    }
    const raw = normalized[i].parallelGroup;
    if (g === undefined && raw !== undefined && i > 0 && plan.group.slice(0, i).includes(raw) && i < steps.length - 1) {
      cappedCount++;
    }
  });
  return { entries, cappedCount };
}

/**
 * Phase 6b (2026-07-17, on-device bug: "まずPerplexityのAPIを呼んで…、次に…"
 * resolved the WHOLE agent to Gemini API, ignoring the per-clause Perplexity
 * mention on step 1). Tag EXPLICIT-marker-split steps (parseStepsFromText's
 * output — まず/次に/…, numbered lists, EN first/then/…) with the SAME
 * per-clause tool-mention detection detectToolPinnedSteps already applies to
 * plain conjunctive/comma clause chains. Before this, only the narrower
 * detectToolPinnedSteps path ever produced a `.tool`-pinned NormalizedStep —
 * an explicit-marker utterance's per-clause tool mentions (e.g. "Perplexityの
 * …", "ローカルLLMで…") were completely inert display text, because
 * lib/agent-nl-parser.ts's parseAgentNL only calls detectToolPinnedSteps when
 * parseStepsFromText found FEWER than 2 explicit-marker steps (see that
 * file's detectedSteps ternary) — the two detectors were mutually exclusive
 * by construction, so an explicit-marker utterance never got tool-tagged at
 * all. This symmetrizes the two step-splitting paths: whichever one actually
 * fires, a clause that names a tool gets `.tool` set the same way.
 *
 * A step whose clause ALSO matches the api-call detector (see
 * detectApiCallSteps below, e.g. "PerplexityのAPIを呼んで…") gets its `.tool`
 * pin here, but detectApiCallSteps — which lib/agent-nl-parser.ts always
 * applies AFTER this function, uniformly regardless of which detector split
 * the steps — REPLACES the whole step object with an apiCall step (dropping
 * `.tool` entirely) whenever a clause explicitly says to call/use that
 * provider's API. That preserves AgentOrchestrationStep's tool/apiCall
 * mutual-exclusivity contract: apiCall (the more specific, already
 * end-to-end-executed mechanism) always wins.
 *
 * Returns the SAME plain strings unchanged when no clause names a tool
 * (today's exact behavior for the common case — regression-tested: a marker
 * chain with no tool mention must stay entirely untagged).
 *
 * RESOLVED GAP (2026-08-03, Phase 7 — was a KNOWN GAP here, see
 * docs/superpowers/DEFERRED.md for the fix's history): a step's `.tool` pin
 * used to be honored ONLY on the ATTENDED path (lib/agent-manager.ts's
 * runAgentOrchestrated — foreground "Run Now" / @agent run,
 * `tool: step.tool ?? agent.tool`), while the UNATTENDED/scheduled path
 * (scripts/shelly-plan-executor.js's runOrchestrationChain, used by every
 * gemini-api/local/perplexity/cerebras/groq-resolved orchestrated agent on a
 * native alarm fire) unconditionally ignored `step.tool`. It now honors it
 * too, for step.tool values the PlanSpec executor can actually dispatch
 * (STEP_TOOL_DISPATCHABLE_TYPES there — a step pinned to `cli`, e.g. "Codex",
 * still falls back to the agent-level tool for THAT step, since this JS
 * runtime has no shell-exec path). The credential/consent boundary this gap
 * used to accidentally protect (an unvetted step.tool could otherwise name an
 * api-key-class tool the agent has no Autonomous Cloud consent to use
 * unattended) is now protected properly instead: lib/agent-plan-spec.ts's
 * buildAgentPlanSpec runs EVERY step.tool through the exact same
 * resolveForAutonomous() gate the agent-level tool already goes through, at
 * plan-BUILD time, before it's ever written to the PlanSpec JSON the
 * unattended executor reads — the executor itself makes no credential
 * decision, it only consumes an already-vetted value. By contrast `.apiCall`
 * (the structured HTTP request mechanism `detectApiCallSteps` below produces)
 * was already honored end-to-end on both paths before this fix, and remains
 * unchanged.
 *
 * The legacy bash/codex chain (lib/agent-executor.ts's canRunOrchestrationChain
 * — used when the agent-level tool resolves to `cli`, i.e. Codex) dispatches
 * a step `.tool` pin through its own per-step arm (Phase 7 follow-up,
 * 2026-08-04, STEP_TOOL_BASH_DISPATCHABLE_TYPES); only `.apiCall` steps still
 * collapse that chain to a single step with a visible note.
 *
 * 2026-10-15 (named-tool pins on scheduled runs): the unattended consent gate
 * used to vet a step pin against the AGENT-LEVEL tool + the agent prompt's
 * needsWeb (`consentWebTool`), so a consented 「パープレで集めて」 step was still
 * stripped whenever the agent-level tool was local/codex — the pin worked
 * attended but not on a scheduled fire. Both unattended executors now also
 * judge each step pin on its own (lib/agent-credential-policy.ts's
 * autonomousWebConsentCovers over the step's own instruction), matching the
 * attended ladder. A SINGLE-clause request's tool mention is handled by
 * lib/agent-tool-router.ts's suggestToolForDraft instead (agent-level pin,
 * persisted as the agent's configured tool) — same TOOL_MENTIONS table, see
 * lib/agent-tool-mentions.ts.
 */
export function tagStepsWithToolMentions(steps: string[]): Array<string | NormalizedStep> {
  return steps.map((instruction) => {
    const tool = matchToolMention(instruction);
    return tool ? { instruction: stripToolPhrase(instruction, tool), tool } : instruction;
  });
}


/**
 * Review H-A (2026-10-15): which unattended chain steps send their prompt to
 * an API-KEY cloud backend. In an autonomous run these steps get an ISOLATED
 * prompt — the user's task text + the step's own instruction only — never the
 * device status / notification context / memory recall / prior-step carry the
 * other steps see, because that carry can hold local data (files a Codex step
 * read, notification text, device status). Before the named-tool fix such a
 * step pin was stripped unattended, so this egress never existed.
 */
export const API_KEY_STEP_TOOL_TYPES: ReadonlySet<string> = new Set(['perplexity', 'gemini-api', 'cerebras', 'groq', 'openrouter']);

export function isApiKeyStep(step: Pick<NormalizedStep, 'tool' | 'apiCall'>): boolean {
  return !step.apiCall && !!step.tool && API_KEY_STEP_TOOL_TYPES.has(step.tool.type);
}

// The step builds on what earlier steps produced ("それを要約して",
// "summarize the results above"). Deliberately broad — a false positive only
// makes an isolated step fail closed or receive web-only carry.
const PRIOR_OUTPUT_REFERENCE_RE =
  /それ|その|これら|これを|これらを|上記|前の|前述|先ほど|結果|収集した|集めた|取得した|調べた|読んだ|\b(?:it|them|those|these|that|results?|above|previous|prior|earlier|collected|gathered|retrieved)\b/i;

export function stepReferencesPriorOutput(instruction: string): boolean {
  return PRIOR_OUTPUT_REFERENCE_RE.test(instruction);
}

/**
 * Prompt policy for an API-key step at `index` of an AUTONOMOUS chain:
 *  - `{ carry: false }` — task text + own instruction only;
 *  - `{ carry: true }`  — also the prior results, allowed only when every
 *    earlier step is itself an isolated API-key step (its output came from a
 *    clean prompt + the web, so it holds no local data);
 *  - `{ blocked }`      — the step needs earlier output that may contain local
 *    data: fail closed with this message instead of sending it.
 */
export function isolatedApiStepPolicy(
  steps: ReadonlyArray<Pick<NormalizedStep, 'tool' | 'apiCall' | 'instruction'>>,
  index: number,
): { carry: boolean } | { blocked: string } {
  const step = steps[index];
  if (index === 0 || !stepReferencesPriorOutput(step.instruction)) return { carry: false };
  const priorIsolated = steps.slice(0, index).every((s) => isApiKeyStep(s));
  if (priorIsolated) return { carry: true };
  const name = step.tool?.type === 'perplexity' ? 'Perplexity' : step.tool?.type === 'gemini-api' ? 'Gemini' : (step.tool?.type ?? 'a cloud API');
  return {
    blocked:
      `Step ${index + 1} would send earlier steps' results to ${name} unattended, but those results may contain local data ` +
      '(files, notifications, device status, memory). Shelly does not send that to a cloud API without you. ' +
      'Run this agent with Run now, or make every earlier step a web-only step.',
  };
}
