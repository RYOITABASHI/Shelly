/**
 * lib/agent-continuous.ts — continuous mode ("止めるまで続けて", DEFERRED.md
 * 継続モード Increment 1): shared constants, config normalization, the paid-API
 * provider policy, the summary line, and the checkpoint reader MONITOR uses.
 *
 * A continuous agent is a loop of short unattended runs (iterations). Native
 * owns the loop: TerminalSessionService re-arms the next iteration at
 * now + cooldown after each run, and ContinuousStopPolicy.kt decides — before
 * and after every iteration — whether it must stop (user Stop / STOP-ALL,
 * max iterations, max wall time, daily paid-API budget, 3 failures in a row,
 * DONE twice in a row when goalCheck is on). The constants below mirror that
 * Kotlin file (asserted by __tests__/agent-continuous.test.ts).
 *
 * Checkpoint: `$HOME/.shelly/agents/logs/<id>/checkpoint.json` (the existing
 * per-agent log dir), written atomically at the end of every iteration by the
 * PlanSpec executor / the generated .sh (scripts/shelly-plan-executor.js
 * nextContinuousCheckpoint is the single writer of iteration data); native
 * only adds stoppedReason / stoppedAt. It deliberately has no
 * `agentId`/`timestamp` pair, so no run-log reader mistakes it for a run log.
 */
import type { Agent, AgentContinuousConfig, AgentOrchestrationStep, ToolChoice } from '@/store/types';
// Locale tables imported directly (not the ./i18n runtime): this module is
// reached from lib/agent-nl-parser.ts, which stays free of the RN i18n store.
import enLocale from './i18n/locales/en';
import jaLocale from './i18n/locales/ja';

type Locale = 'en' | 'ja';

function tFor(locale: Locale, key: string, params?: Record<string, string | number>): string {
  let text = (locale === 'ja' ? jaLocale[key] : undefined) ?? enLocale[key] ?? key;
  for (const [k, v] of Object.entries(params ?? {})) text = text.split(`{{${k}}}`).join(String(v));
  return text;
}

/** 'ja' when the text contains Japanese script (the draft's own language). */
export function continuousTextLocale(text: string): Locale {
  return /[぀-ヿ㐀-鿿]/.test(text) ? 'ja' : 'en';
}

export const CONTINUOUS_DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
export const CONTINUOUS_MIN_COOLDOWN_MS = 60 * 1000;
export const CONTINUOUS_MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const CONTINUOUS_DEFAULT_MAX_ITERATIONS = 50;
export const CONTINUOUS_HARD_MAX_ITERATIONS = 1000;
export const CONTINUOUS_DEFAULT_MAX_WALL_MS = 24 * 60 * 60 * 1000;
export const CONTINUOUS_MIN_MAX_WALL_MS = 60 * 1000;
export const CONTINUOUS_HARD_MAX_WALL_MS = 7 * 24 * 60 * 60 * 1000;
export const CONTINUOUS_MAX_DAILY_BUDGET_JPY = 100_000;
export const CONTINUOUS_CONSECUTIVE_FAILURE_LIMIT = 3;
export const CONTINUOUS_DONE_STREAK_TO_STOP = 2;
/** First iteration fires this long after registration / re-enable. */
export const CONTINUOUS_FIRST_FIRE_DELAY_MS = 5 * 1000;
export const CONTINUOUS_CHECKPOINT_FILE = 'checkpoint.json';
export const CONTINUOUS_CHECKPOINT_VERSION = 1;
export const CONTINUOUS_STOP_MARKER_FILE = 'continuous.stop';

/** API-key backends. A loop uses them only when its daily budget is above ¥0
 *  (mirrors scripts/shelly-plan-executor.js CONTINUOUS_PAID_TOOL_TYPES). */
export const PAID_API_TOOL_TYPES: ReadonlySet<string> = new Set([
  'gemini-api',
  'cerebras',
  'groq',
  'openrouter',
  'perplexity',
]);

export type ContinuousStopReason =
  | 'user_stop'
  | 'halted'
  | 'max_iterations'
  | 'max_wall_time'
  | 'budget'
  | 'consecutive_failures'
  | 'goal_reached';

export const CONTINUOUS_STOP_REASONS: readonly ContinuousStopReason[] = [
  'user_stop',
  'halted',
  'max_iterations',
  'max_wall_time',
  'budget',
  'consecutive_failures',
  'goal_reached',
];

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function positive(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

export function clampCooldownMs(ms: number): number {
  return clamp(Math.round(ms), CONTINUOUS_MIN_COOLDOWN_MS, CONTINUOUS_MAX_COOLDOWN_MS);
}

/** Every field filled and clamped exactly like ContinuousStopPolicy.normalize. */
export function normalizeContinuousConfig(raw: Partial<AgentContinuousConfig> | null | undefined): AgentContinuousConfig {
  const r = raw ?? {};
  const loopStartedAt = positive(r.loopStartedAt);
  return {
    cooldownMs: clampCooldownMs(positive(r.cooldownMs) ?? CONTINUOUS_DEFAULT_COOLDOWN_MS),
    maxIterations: Math.min(Math.floor(positive(r.maxIterations) ?? CONTINUOUS_DEFAULT_MAX_ITERATIONS), CONTINUOUS_HARD_MAX_ITERATIONS),
    maxWallMs: clamp(positive(r.maxWallMs) ?? CONTINUOUS_DEFAULT_MAX_WALL_MS, CONTINUOUS_MIN_MAX_WALL_MS, CONTINUOUS_HARD_MAX_WALL_MS),
    goalCheck: r.goalCheck === true,
    dailyBudgetJpy: clamp(Math.floor(typeof r.dailyBudgetJpy === 'number' && Number.isFinite(r.dailyBudgetJpy) ? r.dailyBudgetJpy : 0), 0, CONTINUOUS_MAX_DAILY_BUDGET_JPY),
    ...(loopStartedAt ? { loopStartedAt } : {}),
  };
}

/**
 * Loop config for a confirmed registration / edit. A fresh loop (no existing
 * config) starts now with default limits. Editing an existing loop keeps it
 * the SAME loop: its limits / budget and loopStartedAt (native's iteration +
 * wall-time counters and the checkpoint are keyed by it) stay unless the
 * loop's own settings — cooldown or goalCheck — changed; even then only
 * loopStartedAt restarts, the custom limits are kept. A rename or a task edit
 * therefore never resets the limits.
 */
export function mergeContinuousOnEdit(
  existing: Partial<AgentContinuousConfig> | null | undefined,
  confirmed: { cooldownMs: number; goalCheck?: boolean },
  now: number = Date.now(),
): AgentContinuousConfig {
  if (!existing) return normalizeContinuousConfig({ ...confirmed, loopStartedAt: now });
  const before = normalizeContinuousConfig(existing);
  const after = normalizeContinuousConfig({ ...before, cooldownMs: confirmed.cooldownMs, goalCheck: confirmed.goalCheck === true });
  const loopChanged = after.cooldownMs !== before.cooldownMs || after.goalCheck !== before.goalCheck;
  const loopStartedAt = loopChanged || !before.loopStartedAt ? now : before.loopStartedAt;
  return { ...after, loopStartedAt };
}

export function isContinuousAgent(agent: Pick<Agent, 'continuous'> | null | undefined): boolean {
  return !!agent && !!agent.continuous && typeof agent.continuous === 'object';
}

/** ¥0 budget (the default) ⇒ paid API steps are not allowed at all. */
export function continuousExcludesPaidApi(agent: Pick<Agent, 'continuous'>): boolean {
  if (!isContinuousAgent(agent)) return false;
  return !(normalizeContinuousConfig(agent.continuous).dailyBudgetJpy > 0);
}

export function isPaidApiTool(tool: ToolChoice | null | undefined): boolean {
  return !!tool && PAID_API_TOOL_TYPES.has(tool.type);
}

const LOCAL_TOOL: ToolChoice = { type: 'local' };
const CODEX_TOOL: ToolChoice = { type: 'cli', cli: 'codex' };

/**
 * Provider policy for a continuous agent at a ¥0 budget: local LLM → Codex,
 * never an API-key backend the USER DID NOT NAME. Applied to the agent before
 * its script / PlanSpec is written (lib/agent-manager.ts materializeAgentBody):
 * a configured paid agent-level tool becomes the local LLM (it may have been
 * picked by the router, not the user). The router / ladder apply the same rule
 * to whatever an `auto` route picks (guardContinuousTool /
 * filterContinuousLadder).
 *
 * 2026-10-30 (DEFERRED.md「タスクごとのプロバイダを自由に指定・途中で変更する」):
 * a per-step tool pin only ever comes from the user (a tool named in that
 * clause — lib/agent-tool-mentions.ts — a chat edit「2番目をPerplexityで」, or
 * the MONITOR provider picker), so a paid step pin is the user's explicit
 * permission for THAT step and is kept. The PlanSpec marks it `paidPin`
 * (lib/agent-plan-spec.ts) so the executor lets only that step's own pinned
 * tool through (its ladder stays free) and books the spend apart from the ¥0
 * budget; the confirm summary says so (explicitPaidStepPins). Consent gates
 * (autonomous cloud consent) still apply to the pin unchanged.
 */
export function applyContinuousProviderPolicy(agent: Agent): Agent {
  if (!continuousExcludesPaidApi(agent)) return agent;
  if (!isPaidApiTool(agent.tool)) return agent;
  return { ...agent, tool: LOCAL_TOOL };
}

/** Indices of steps the user explicitly pinned to a paid API (see
 *  applyContinuousProviderPolicy) — what a ¥0 loop still uses, and what the
 *  summary discloses. Empty unless the agent is a ¥0 continuous loop. */
export function explicitPaidStepPins(
  agent: Pick<Agent, 'continuous'>,
  steps: ReadonlyArray<string | AgentOrchestrationStep> | null | undefined,
): number[] {
  if (!continuousExcludesPaidApi(agent) || !steps) return [];
  const out: number[] = [];
  steps.forEach((step, i) => {
    if (typeof step !== 'string' && isPaidApiTool(step.tool)) out.push(i);
  });
  return out;
}

/** A routed tool for a ¥0 continuous agent: a paid pick becomes Codex for a
 *  web-mandatory task (the only web-capable non-API backend), else local. */
export function guardContinuousTool(agent: Pick<Agent, 'continuous'>, tool: ToolChoice, needsWeb: boolean): ToolChoice {
  if (!continuousExcludesPaidApi(agent) || !isPaidApiTool(tool)) return tool;
  return needsWeb ? CODEX_TOOL : LOCAL_TOOL;
}

/** Escalation ladder for a ¥0 continuous agent: paid candidates removed, never
 *  empty (falls back to local → Codex). */
export function filterContinuousLadder(agent: Pick<Agent, 'continuous'>, tools: ToolChoice[]): ToolChoice[] {
  if (!continuousExcludesPaidApi(agent)) return tools;
  const kept = tools.filter((t) => !isPaidApiTool(t));
  return kept.length ? kept : [LOCAL_TOOL, CODEX_TOOL];
}

// ── Summary line ────────────────────────────────────────────────────────────

function durationText(ms: number, locale: Locale): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return tFor(locale, 'continuous.duration_minutes', { n: Math.max(1, minutes) });
  const hours = ms / 3_600_000;
  if (hours < 48 || !Number.isInteger(hours / 24)) {
    return tFor(locale, 'continuous.duration_hours', { n: Number.isInteger(hours) ? hours : Math.round(hours * 10) / 10 });
  }
  return tFor(locale, 'continuous.duration_days', { n: hours / 24 });
}

/** e.g. 「止めるまで続けます（最大50回・24時間・有料APIなし・5分おき）」 */
export function formatContinuousSummary(raw: Partial<AgentContinuousConfig> | null | undefined, locale: Locale): string {
  const cfg = normalizeContinuousConfig(raw);
  const budget = cfg.dailyBudgetJpy > 0
    ? tFor(locale, 'continuous.budget_daily', { yen: cfg.dailyBudgetJpy })
    : tFor(locale, 'continuous.budget_none');
  return tFor(locale, cfg.goalCheck ? 'continuous.summary_until_done' : 'continuous.summary_until_stopped', {
    max: cfg.maxIterations,
    wall: durationText(cfg.maxWallMs, locale),
    budget,
    cooldown: tFor(locale, 'continuous.every', { duration: durationText(cfg.cooldownMs, locale) }),
  });
}

// ── Checkpoint (read-only view for MONITOR) ─────────────────────────────────

export interface ContinuousCheckpointView {
  iteration: number;
  startedAt: number | null;
  nextAction: string;
  stoppedReason?: ContinuousStopReason;
  stoppedAt?: number;
}

/** Parse checkpoint.json text; null for anything that is not a v1 checkpoint
 *  (fail closed: MONITOR then shows nothing rather than a wrong number). */
export function parseContinuousCheckpoint(text: string | null | undefined): ContinuousCheckpointView | null {
  if (!text || !text.trim()) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== CONTINUOUS_CHECKPOINT_VERSION) return null;
  const iteration = positive(r.iteration);
  const view: ContinuousCheckpointView = {
    iteration: iteration ? Math.min(Math.floor(iteration), 1_000_000) : 0,
    startedAt: positive(r.startedAt) ?? null,
    nextAction: typeof r.nextAction === 'string' ? r.nextAction.slice(0, 500) : '',
  };
  if (typeof r.stoppedReason === 'string' && (CONTINUOUS_STOP_REASONS as readonly string[]).includes(r.stoppedReason)) {
    view.stoppedReason = r.stoppedReason as ContinuousStopReason;
    const at = positive(r.stoppedAt);
    if (at) view.stoppedAt = at;
  }
  return view;
}

export function continuousStopReasonKey(reason: ContinuousStopReason): string {
  return `continuous.reason.${reason}`;
}

// ── NL intent ("止めるまで続けて" / "keep going until I stop it") ────────────

export interface ContinuousIntent {
  cooldownMs: number;
  goalCheck: boolean;
  /** [start, end) spans of the continuous / interval phrases in the text. */
  spans: Array<[number, number]>;
}

/** A continue verb (required). */
const JA_CONT_VERB = '(?:続け|つづけ|繰り返し|くりかえし|やり続け|回し続け)(?:て(?:ください|ね|よ)?|る)?';
const JA_UNTIL_STOP = new RegExp(
  `(?:(?:私|僕|俺|こちら|わたし)が)?(?:止める|とめる|停止する|ストップする)まで(?!に)(?:\\s*ずっと)?(?:\\s*${JA_CONT_VERB})?`,
  'g',
);
const JA_FOREVER = new RegExp(`ずっと\\s*${JA_CONT_VERB}`, 'g');
const JA_GOAL =
  /(?:終わる|おわる|完了する|完成する|終了する|片付く|片づく)まで(?!に)(\s*(?:ずっと\s*)?(?:(?:続け|つづけ|繰り返し|くりかえし|やり続け)(?:て(?:ください|ね|よ)?|る)?|やって(?:ください)?|進めて(?:ください)?|頑張って|がんばって))?/g;
const JA_INTERVAL = /([0-9０-９]+)\s*(分|時間)\s*(?:ごと|おき|毎)\s*に?\s*[、,]?/g;
const JA_INTERVAL_CONT_VERB = new RegExp(`^\\s*(?:ずっと\\s*)?${JA_CONT_VERB}`);
const EN_UNTIL_STOP =
  /\b(?:(?:keep (?:going|running|at it|working(?: on it)?)|continue)\s+)?until I (?:stop|cancel|tell you to stop)(?: (?:it|you|this))?\b/gi;
const EN_KEEP = /\bkeep (?:going|running|at it|working(?: on it)?)\b/gi;
const EN_GOAL =
  /\b(?:(?:keep (?:going|working(?: on it)?)|continue)\s+)?until (?:(?:it(?:'s| is)|the (?:task|job|work) is|everything is|you(?:'re| are))\s+)?(?:done|finished|complete|completed)\b/gi;
const EN_INTERVAL = /\bevery\s+(?:(\d+)\s*|(?:an?|one)\s+)?(minutes?|mins?|hours?|hrs?)\b\s*,?/gi;

function toAsciiDigits(s: string): string {
  return s.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
}

function collect(re: RegExp, text: string, accept?: (m: RegExpExecArray) => boolean): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    if (!accept || accept(m)) out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

/**
 * Detects a continuous-run request. JA: 「止めるまで続けて」「ずっと続けて」
 * (cooldown 5 min), 「1時間ごとに続けて」「30分おきに続けて」 (that cooldown),
 * 「終わるまで」「完了するまで」 (goalCheck). EN: "keep going (until I stop
 * it)", "every hour, keep going", "until it's done". null = not a loop.
 * 「…までに」 ("by …") is never read as a loop.
 */
export function parseContinuousIntent(text: string): ContinuousIntent | null {
  const src = String(text ?? '');
  const goalSpans = [
    ...collect(JA_GOAL, src, (m) => {
      if (m[1]) return true;
      // Bare 「終わるまで」: only at a clause end, so 「会議が終わるまで待って」 is not a loop.
      return /^\s*(?:$|[、。,.!！?？])/.test(src.slice(m.index + m[0].length));
    }),
    ...collect(EN_GOAL, src),
  ];
  const loopSpans = [
    ...collect(JA_UNTIL_STOP, src),
    ...collect(JA_FOREVER, src),
    ...collect(EN_UNTIL_STOP, src),
    ...collect(EN_KEEP, src),
  ];
  // 「30分おきに続けて」 is a loop on its own (an interval + a continue verb).
  const jaIntervals = collect(JA_INTERVAL, src);
  const intervalLoop: Array<[number, number]> = [];
  for (const [start, end] of jaIntervals) {
    const verb = JA_INTERVAL_CONT_VERB.exec(src.slice(end));
    if (verb) intervalLoop.push([start, end + verb[0].length]);
  }
  loopSpans.push(...intervalLoop);
  if (!loopSpans.length && !goalSpans.length) return null;

  let cooldownMs = CONTINUOUS_DEFAULT_COOLDOWN_MS;
  const spans: Array<[number, number]> = [...loopSpans, ...goalSpans];
  const jaInterval = intervalLoop[0] ?? jaIntervals[0];
  if (jaInterval) {
    const m = /([0-9０-９]+)\s*(分|時間)/.exec(src.slice(jaInterval[0], jaInterval[1]));
    const n = m ? parseInt(toAsciiDigits(m[1]), 10) : 0;
    if (m && n > 0) cooldownMs = clampCooldownMs(n * (m[2] === '分' ? 60_000 : 3_600_000));
    spans.push(jaInterval);
  } else {
    EN_INTERVAL.lastIndex = 0;
    const m = EN_INTERVAL.exec(src);
    if (m) {
      const n = m[1] ? parseInt(m[1], 10) : 1;
      if (n > 0) cooldownMs = clampCooldownMs(n * (/^h/i.test(m[2]) ? 3_600_000 : 60_000));
      spans.push([m.index, m.index + m[0].length]);
    }
  }
  return { cooldownMs, goalCheck: goalSpans.length > 0, spans };
}

/** The text with the intent's phrases removed (for schedule / prompt parsing). */
export function stripContinuousPhrases(text: string, intent: ContinuousIntent): string {
  const sorted = [...intent.spans].sort((a, b) => a[0] - b[0]);
  let out = '';
  let cursor = 0;
  for (const [start, end] of sorted) {
    if (end <= cursor) continue;
    out += text.slice(cursor, Math.max(cursor, start)) + ' ';
    cursor = Math.max(cursor, end);
  }
  out += text.slice(cursor);
  return out
    .replace(/[ \t]{2,}/g, ' ')
    // A removed span between two Japanese characters leaves no gap.
    .replace(/([぀-ヿ㐀-鿿]) (?=[぀-ヿ㐀-鿿])/g, '$1')
    .replace(/\s+([、。,.!?！？])/g, '$1')
    .replace(/[、,]+(?=[、,。.!?！？]|\s*$)/g, '')
    .replace(/^[\s、,。.]+|\s+$/g, '')
    .trim();
}
