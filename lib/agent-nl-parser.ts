/**
 * lib/agent-nl-parser.ts — Deterministic JP/EN NL → agent-fields parser (Phase 0 §2.1 / §3).
 *
 * This is the **deterministic template grammar**: a pure, offline, unit-testable parser
 * that turns an utterance like "毎日8時にXの下書きを作って" into a structured draft
 * {name, prompt, schedule, action, tool}. It is BOTH the MVP's primary parser for common
 * phrasings AND the fallback the spec requires when the LLM parse is unavailable (§3:
 * "NL parse must never hard-block registration").
 *
 * HARD REQUIREMENT (§2.1): the schedule MUST be one of the scheduler's whitelisted cron
 *   shapes — every-N-minutes (N=1..59) | every-N-hours, fixed minute 0 (N=1..23) |
 *   daily "M H * * *" | weekly "M H * * D" (D=0..6)
 * (see lib/agent-scheduler.ts). If a confident schedule cannot be produced, we return
 * `schedule: null` with `scheduleConfident: false` so the confirmation card forces a manual
 * selection — we NEVER silently register an agent that will never fire.
 *
 * The result is a PREVIEW draft, not a live agent. The caller shows it in the confirm card.
 */
import { AgentAction, AgentMemoryConfig, AgentOrchestrationStep, ToolChoice } from '@/store/types';
import { suggestTool, toolChoiceToLabel } from './agent-tool-router';
import { parseStepsFromText, normalizeSteps, detectToolPinnedSteps } from './agent-orchestration';
import { buildSteamPipeline, type PipelinePreset } from './agent-pipeline-presets';

export interface ParsedAgentDraft {
  /** Short, editable label derived from the task (user can override in the card). */
  name: string;
  /** The actionable instruction fed to the agent (schedule phrase stripped). */
  prompt: string;
  /** Cron in one of the 3 whitelisted shapes, or null when it could not be parsed. */
  schedule: string | null;
  /** false → the card MUST force a manual schedule selection before registering. */
  scheduleConfident: boolean;
  /** Human-readable schedule label for the card, e.g. "毎日 08:00" / "未設定（要選択）". */
  scheduleLabel: string;
  /** When a time was parsed but the frequency was ambiguous, pre-fill this in the card. */
  suggestedTime?: { hour: number; minute: number };
  /** A recurrence was stated but the time is missing: the card pre-selects this
   *  frequency (instead of falling to 'once'/run-now) and asks for a time. The
   *  schedule itself stays null/not-confident — never auto-registered. */
  suggestedFrequency?: 'daily' | 'weekly';
  /** Dow csv ("1" / "1,5") accompanying a 'weekly' suggestedFrequency. */
  suggestedDowList?: string;
  /** Delivery capability. Defaults to 'draft' (write to outputPath). Never 'publish'. */
  action: AgentAction;
  /** Routed tool (reuses the keyword router). */
  tool: ToolChoice;
  toolLabel: string;
  /** Default for the card's Autonomous toggle (set true when the `@agent autonomous`
   *  alias was used). The card is the source of truth; this is just the initial value. */
  autonomous?: boolean;
  /** Phase 1 memory: set when the utterance asked the agent to remember something
   *  ("覚えておいて" / "remember that …"). Absent = no memory write. Recall is
   *  always attempted at run time regardless of this flag. */
  memory?: AgentMemoryConfig;
  /** Phase 2a: a matching reusable skill surfaced for gated reuse in the confirm
   *  card. Set by the dispatcher (async skill match), not the pure parser. */
  matchedSkill?: { id: string; name: string; successCount: number };
  /** Phase 4: ordered step instructions when the utterance is multi-step
   *  ("まず…次に…最後に" / numbered), OR (Phase 6) a plain て-form/comma-delimited
   *  chain naming a tool per clause ("パープレで集めて、ローカルLLMで要約して…") —
   *  see detectToolPinnedSteps. Each entry is either a plain string (auto-routed,
   *  same as before) or a { instruction, tool } object pinning a concrete tool for
   *  just that step. Absent/<2 = single-run. */
  orchestrationSteps?: Array<string | AgentOrchestrationStep>;
  /** G6: hard character budget for the final orchestration output. */
  charLimit?: number;
  /** Set when the utterance asked for a delivery action that isn't backed by a
   *  real `action.type` yet (currently: LINE-posting — "LINEに投稿して" has a
   *  scaffolded `line.send-message` app-act recipe but no wired detection here
   *  yet), so `action` stayed `draft` instead of reflecting what the user
   *  actually asked for. X-posting used to hit this same fallback but is now a
   *  real `app-act` action (Phase 6) — see X_POST_RE / detectAction. The confirm
   *  card should surface this as a visible warning; absent = no caveat. */
  actionCaveat?: string;
  /** Package name(s) that should trigger this agent when a matching
   *  notification arrives (NOTIFY-001). Set by the pure parser when
   *  confidently extractable from the utterance, OR filled in later via
   *  conversational slot-filling when the utterance implies a
   *  notification-triggered agent but no package was extractable. Absent =
   *  not a notification-triggered agent. */
  notificationTrigger?: { packageNames: string[] };
  /** Free-text output destination hint, gathered either from the utterance
   *  or via conversational slot-filling when the agent's action is 'draft'
   *  and no global vault/output-path preference is configured. Absent =
   *  the caller falls back to its default output path template. */
  outputPath?: string;
  /** The original utterance, preserved for the card / fallback editing. */
  rawText: string;
}

// cron dow is Sunday=0..Saturday=6 (Linux). JP weekday char → dow.
const JP_WEEKDAY: Record<string, number> = {
  日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6,
};
const EN_WEEKDAY: Array<[RegExp, number]> = [
  [/\bsun(day)?\b/i, 0],
  [/\bmon(day)?\b/i, 1],
  [/\btue(s|sday)?\b/i, 2],
  [/\bwed(nesday)?\b/i, 3],
  [/\bthu(r|rs|rsday)?\b/i, 4],
  [/\bfri(day)?\b/i, 5],
  [/\bsat(urday)?\b/i, 6],
];

export interface ParsedTime {
  hour: number;
  minute: number;
}

// ── Time-match interpreters ──────────────────────────────────────────────
// Each function turns a single regex match into a ParsedTime (or null when the
// resulting hour/minute is out of range). These are the SOLE source of truth
// for "what does this match mean" — both the singular extractTime() and the
// plural extractTimes() call them, so JP/EN AM-PM arithmetic can never drift
// between the two paths.

/** Interpret a match of the JP `(meridiem)? N時 (半|M分)?` pattern. */
function interpretJpMatch(match: RegExpMatchArray): ParsedTime | null {
  let hour = parseInt(match[2], 10);
  let minute = 0;
  if (match[3] === '半') minute = 30;
  else if (match[4] !== undefined) minute = parseInt(match[4], 10);
  const meridiem = match[1];
  if ((meridiem === '午後' || meridiem === '夜' || meridiem === '夕方' || meridiem === '晩' || meridiem === '昼') && hour < 12) {
    // 昼1時=13:00 … 昼3時=15:00; 昼12時 stays 12:00 (guarded by hour < 12).
    hour += 12;
  } else if ((meridiem === '午前' || meridiem === '朝' || meridiem === '深夜') && hour === 12) {
    hour = 0; // 午前12時/深夜12時 = 0:00
  }
  if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return { hour, minute };
  return null;
}

/** Interpret a match of the EN `at N(:MM)?(am/pm)?` or `H:MM(am/pm)?` pattern
 *  (both share the same 3-group shape: hour, optional minute, optional meridiem). */
function interpretEnHourMinuteMatch(match: RegExpMatchArray): ParsedTime | null {
  let hour = parseInt(match[1], 10);
  const minute = match[2] !== undefined ? parseInt(match[2], 10) : 0;
  const mer = match[3]?.toLowerCase();
  if (mer === 'pm' && hour < 12) hour += 12;
  else if (mer === 'am' && hour === 12) hour = 0;
  if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return { hour, minute };
  return null;
}

/** Interpret a match of the EN bare `H am/pm` pattern. */
function interpretEnMeridiemOnlyMatch(match: RegExpMatchArray): ParsedTime | null {
  let hour = parseInt(match[1], 10);
  const mer = match[2].toLowerCase();
  if (mer === 'pm' && hour < 12) hour += 12;
  else if (mer === 'am' && hour === 12) hour = 0;
  if (hour >= 0 && hour <= 23) return { hour, minute: 0 };
  return null;
}

/** Extract a time-of-day from JP or EN text. Returns null when none is found. */
function extractTime(text: string): ParsedTime | null {
  // JP: optional meridiem + N時 + (半 | M分)
  //   "午後8時半" "夜8時" "朝7時30分" "8時"
  const jp = text.match(/(午前|午後|朝|夜|夕方|晩|深夜|昼)?\s*(\d{1,2})\s*時\s*(半|(\d{1,2})\s*分)?/);
  if (jp) {
    const t = interpretJpMatch(jp);
    if (t) return t;
  }

  // EN/numeric. Ordered branches; a bare standalone number is NOT a time (ambiguous).
  //  1. "at N(:MM)?(am/pm)?" — bound to "at", so "process top 10 posts at 8" → 8:00.
  //  2. "H:MM(am/pm)?"       — colon form; minute and meridiem are independent so
  //                            "8:30pm" → 20:30 and "9:15am" → 09:15 both work.
  //  3. "H am/pm"            — bare hour carrying a meridiem ("8pm" → 20:00).
  const at = text.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  const colon = at ? null : text.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i);
  const meridiemOnly = at || colon ? null : text.match(/\b(\d{1,2})\s*(am|pm)\b/i);
  const m = at || colon;
  if (m) {
    const t = interpretEnHourMinuteMatch(m);
    if (t) return t;
  } else if (meridiemOnly) {
    const t = interpretEnMeridiemOnlyMatch(meridiemOnly);
    if (t) return t;
  }

  return null;
}

/**
 * Extract MULTIPLE non-overlapping times from JP or EN text (Track B: "daily-multi"
 * — e.g. "毎日朝8:00と夜21:00に" / "every day at 8am and 9pm"). Reuses the exact
 * same interpreters as extractTime() so plural parsing can never drift from the
 * singular path. Builds a FRESH global RegExp per pattern per call — never reuses
 * a shared/module-level `g`-flagged RegExp, whose `lastIndex` would leak state
 * across calls.
 *
 * Each of the 4 sub-patterns (mirroring extractTime's precedence: JP=0 highest,
 * EN "at"=1, EN colon=2, EN bare meridiem=3) is scanned independently across the
 * whole text. Hits are sorted by start position (ties broken by priority), then
 * walked left-to-right accepting only non-overlapping spans — so e.g. "at 8:30pm"
 * (EN "at", priority 1) wins over the overlapping bare "8:30pm" (colon, priority 2)
 * reading of the same substring. Exact-duplicate {hour,minute} results are deduped.
 * Returned in text-encounter order.
 */
function extractTimes(text: string): ParsedTime[] {
  interface TimeHit {
    start: number;
    end: number;
    priority: number;
    time: ParsedTime;
  }
  const hits: TimeHit[] = [];

  for (const m of text.matchAll(new RegExp(/(午前|午後|朝|夜|夕方|晩|深夜|昼)?\s*(\d{1,2})\s*時\s*(半|(\d{1,2})\s*分)?/.source, 'g'))) {
    const t = interpretJpMatch(m);
    if (t) hits.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, priority: 0, time: t });
  }
  for (const m of text.matchAll(new RegExp(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.source, 'gi'))) {
    const t = interpretEnHourMinuteMatch(m);
    if (t) hits.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, priority: 1, time: t });
  }
  for (const m of text.matchAll(new RegExp(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/.source, 'gi'))) {
    const t = interpretEnHourMinuteMatch(m);
    if (t) hits.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, priority: 2, time: t });
  }
  for (const m of text.matchAll(new RegExp(/\b(\d{1,2})\s*(am|pm)\b/.source, 'gi'))) {
    const t = interpretEnMeridiemOnlyMatch(m);
    if (t) hits.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, priority: 3, time: t });
  }

  hits.sort((a, b) => a.start - b.start || a.priority - b.priority);

  const accepted: TimeHit[] = [];
  for (const hit of hits) {
    const overlaps = accepted.some((a) => hit.start < a.end && hit.end > a.start);
    if (!overlaps) accepted.push(hit);
  }

  const seen = new Set<string>();
  const result: ParsedTime[] = [];
  for (const hit of accepted) {
    const key = `${hit.time.hour}:${hit.time.minute}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(hit.time);
  }
  return result;
}

// Exported so lib/agent-slot-fill.ts's applySlotAnswer can build a schedule
// label/cron from a suggestedDowList/suggestedTime pair without duplicating
// this formatting -- see the "merge partial recurrence across turns" fix.
export function fmtTime(t: ParsedTime): string {
  return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}

export const JP_DOW_LABEL = ['日', '月', '火', '水', '木', '金', '土'];

export interface ScheduleResult {
  schedule: string | null;
  confident: boolean;
  label: string;
  suggestedTime?: ParsedTime;
  /** A recurrence was clearly stated but the TIME is missing, so we can't emit a
   *  confident cron. The card pre-selects this frequency (instead of 'once') and
   *  forces the user to pick a time. schedule stays null — never auto-registered. */
  suggestedFrequency?: 'daily' | 'weekly';
  /** For a weekly suggestion: the dow csv ("1" or "1,5") to pre-select the chips. */
  suggestedDowList?: string;
}

/** Parse the schedule, constrained to the whitelisted cron shapes. */
export function parseSchedule(text: string): ScheduleResult {
  const lower = text.toLowerCase();

  // ── 0. Run once, right now — no recurrence, no time to parse. The single most
  // common answer to "when should this run?" was previously unrecognized (fell
  // through every branch to the generic "未設定" fallback below), so a plain
  // "すぐに"/"今すぐ" answer looped the slot-fill question forever instead of
  // resolving to the Once frequency. `schedule: 'once'` is a sentinel (see
  // decodeCron) — not a real cron string. ──
  if (/^\s*(?:今\s*すぐ|すぐ(?:に)?|直ちに|即時|即座に)\s*$/.test(text) ||
      /^\s*(?:right\s+(?:now|away)|immediately|now|asap)\s*[.!]?\s*$/i.test(text)) {
    return { schedule: 'once', confident: true, label: '今すぐ（1回のみ）' };
  }

  // ── 1. Every-N-minutes interval → `*/N * * * *` (N must be 1..59) ──
  const intervalJp = text.match(/(\d+)\s*分\s*(?:ごと|おき|毎|間隔)|(\d+)\s*分に\s*1\s*回/);
  const intervalEn = lower.match(/every\s+(\d+)\s*(?:min|mins|minute|minutes)\b/);
  const intervalN = intervalJp
    ? parseInt(intervalJp[1] ?? intervalJp[2], 10)
    : intervalEn
    ? parseInt(intervalEn[1], 10)
    : null;
  if (intervalN !== null) {
    if (intervalN >= 1 && intervalN <= 59) {
      return { schedule: `*/${intervalN} * * * *`, confident: true, label: `${intervalN}分ごと` };
    }
    // 60+ min or 0 cannot be expressed by `*/N` → force manual selection.
    return {
      schedule: null,
      confident: false,
      label: '未設定（分間隔が範囲外・要選択）',
    };
  }

  // ── 1b. Every-N-hours interval → `0 */N * * *` (N must be 1..23) ──
  const hourIntervalJp = text.match(/(\d+)\s*時間\s*(?:ごと|おき|毎)/);
  const hourIntervalEn = lower.match(/every\s+(\d+)\s*hours?\b/);
  const hourIntervalN = hourIntervalJp
    ? parseInt(hourIntervalJp[1], 10)
    : hourIntervalEn
    ? parseInt(hourIntervalEn[1], 10)
    : null;
  if (hourIntervalN !== null) {
    if (hourIntervalN >= 1 && hourIntervalN <= 23) {
      return { schedule: `0 */${hourIntervalN} * * *`, confident: true, label: `${hourIntervalN}時間おき` };
    }
    // 24+ hours or 0 cannot be expressed by `0 */N * * *` → force manual selection.
    return {
      schedule: null,
      confident: false,
      label: '未設定（時間間隔は1〜23の範囲外・要選択）',
    };
  }

  // Biweekly / Nth-weekday / N-times-a-week cadences are NOT expressible in the
  // whitelisted weekly cron. Registering them as a plain weekly would silently
  // change the meaning ("隔週月曜" → EVERY Monday, "第2月曜" → every Monday), so
  // force manual selection. These markers are schedule-specific (not topic words).
  if (
    /隔週|隔月|第\s*[0-9０-９一二三四五六七八九十]+\s*(?:週|[日月火水木金土]曜)|週\s*[2-7２-７]\s*回|biweekly|fortnightly/i.test(text) ||
    /\b(every\s+other\s+week|every\s+\d+\s+weeks?)\b/i.test(lower)
  ) {
    return { schedule: null, confident: false, label: '未設定（この周期は非対応・要選択）' };
  }

  const time = extractTime(text);

  // "1日1回 / 1日に1回 / 一日一回 / 1日1度" = once per day → daily. The leading "1日"
  // run is REQUIRED (no bare 日 alternative): that both rejects a DATE context
  // ("7月1日に1回", "21日に1回" — the digit/月 before 日 fails the negated class) and
  // kanji-compound day-words ("今日/明日/誕生日/平日に1回" — no [1一] before 日). No JS
  // lookbehind reliance (Hermes-safe negated class).
  const dailyOnce = /(?:^|[^0-9０-９月/／])[1１一]\s*日\s*に?\s*[1１一]\s*[回度]/.test(text);
  // An explicit daily marker (毎日 / daily) outranks an incidental weekday mention,
  // so "毎日月曜の予定を8時に通知" stays daily instead of collapsing to weekly-Mon.
  const dailyMarker =
    /毎日|毎朝|毎晩|毎夕|日次/.test(text) ||
    dailyOnce ||
    /\b(every\s*day|everyday|daily|each\s+day|once\s+a\s+day)\b/.test(lower);

  // ── 2. Weekly → `M H * * D` (single day) or `M H * * d1,d2,…` (multi-day) ──
  // Collect EVERY weekday mentioned so "月曜と金曜" → `* * 1,5` instead of being
  // flattened to the first day. JP detection requires 曜 (unambiguous: avoids
  // 日次 / 今日 / 日報 false-positives); a bare 月/金/日 is too ambiguous to trust.
  // EN matches whole words. The scheduler accepts a comma DOW list (DOW_LIST_RE).
  const dows = new Set<number>();
  if (!dailyMarker) {
    // (a) 曜-qualified weekdays (月曜 / 金曜) — always unambiguous.
    const jpQualified = text.match(/[日月火水木金土](?=曜)/g);
    if (jpQualified) for (const ch of jpQualified) dows.add(JP_WEEKDAY[ch]);
    // (b) A separator-joined bare run of 2+ weekday chars (火・金 / 月、水、金 / 火と金)
    // is admitted ONLY when it leads directly into the time ("火・金の朝8時"). That
    // adjacency is what separates a real schedule from element / celestial lists
    // like 火・水 (fire/water 五行) or 日・月 (sun/moon), which are followed by a NOUN,
    // not a time. A lone bare 月/金/日 stays ambiguous and is never matched.
    const runs = text.match(
      /[日月火水木金土]曜?日?(?:\s*[・、，,と＆&]\s*[日月火水木金土]曜?日?)+(?=\s*(?:の|は|、|,)?\s*(?:朝|昼|夜|晩|夕|午前|午後)?\s*\d{1,2}\s*[:時])/g,
    );
    if (runs) {
      for (const run of runs) {
        // Strip "曜日"/"曜" FIRST so the trailing 日 of 曜日 (e.g. "火曜日") isn't
        // extracted as Sunday — "月曜日と火曜日" must be 1,2 not 0,1,2.
        const chars = run.replace(/曜日?/g, ' ').match(/[日月火水木金土]/g);
        if (chars) for (const ch of chars) dows.add(JP_WEEKDAY[ch]);
      }
    }
    for (const [re, d] of EN_WEEKDAY) {
      if (re.test(lower)) dows.add(d);
    }
  }
  const dowList = [...dows].sort((a, b) => a - b);
  if (dowList.length > 0) {
    const dowField = dowList.join(',');
    const dayLabel = dowList.map((d) => JP_DOW_LABEL[d]).join('・');
    if (time) {
      return {
        schedule: `${time.minute} ${time.hour} * * ${dowField}`,
        confident: true,
        label: `毎週${dayLabel} ${fmtTime(time)}`,
      };
    }
    return {
      schedule: null,
      confident: false,
      label: `毎週${dayLabel} 時刻未設定（要選択）`,
      suggestedFrequency: 'weekly',
      suggestedDowList: dowField,
    };
  }

  // ── 3. Daily → `M H * * *` (explicit daily marker + a time) ──
  if (dailyMarker) {
    // 3a. Multiple specific times per day ("毎日朝8:00と夜21:00に" / "every day at
    // 8am and 9pm") → `M H1,H2,... * * *`, one shared minute across all hours.
    // Only reachable here (no weekday qualifier — §2's dowList branch already
    // returned above), so this never touches the weekly path.
    const times = extractTimes(text);
    if (times.length >= 2) {
      if (times.length > 4) {
        // Cap: max 4 times/day.
        return { schedule: null, confident: false, label: '未設定（1日4件までのみ対応・要選択）' };
      }
      const minutes = new Set(times.map((t) => t.minute));
      if (minutes.size > 1) {
        // Different minutes per time is explicitly OUT OF SCOPE — never silently
        // collapse/drop one time. Force manual selection instead.
        return { schedule: null, confident: false, label: '未設定（時刻ごとに分が異なる場合は要選択）' };
      }
      const minute = times[0].minute;
      const hourList = [...new Set(times.map((t) => t.hour))].sort((a, b) => a - b);
      if (hourList.length >= 2) {
        const hhmmList = hourList.map((h) => fmtTime({ hour: h, minute })).join('・');
        return {
          schedule: `${minute} ${hourList.join(',')} * * *`,
          confident: true,
          label: `毎日 ${hhmmList}`,
        };
      }
    }

    if (time) {
      return {
        schedule: `${time.minute} ${time.hour} * * *`,
        confident: true,
        label: `毎日 ${fmtTime(time)}`,
      };
    }
    return {
      schedule: null,
      confident: false,
      label: '毎日 時刻未設定（要選択）',
      suggestedFrequency: 'daily',
    };
  }

  // ── Ambiguous: a time but no frequency word. We cannot tell once-vs-daily, and a
  // one-shot isn't in the cron whitelist anyway. Surface the time so the card can
  // pre-fill HH:MM and ask the user to pick a frequency. Never auto-register. ──
  if (time) {
    return {
      schedule: null,
      confident: false,
      label: `時刻 ${fmtTime(time)}（頻度未選択）`,
      suggestedTime: time,
    };
  }

  return { schedule: null, confident: false, label: '未設定（要選択）' };
}

const URL_RE = /https?:\/\/[^\s、。)）]+/i;

/** Slice `text` down to the clause that actually names the delivery action —
 *  the part after the LAST "たら" marker when a conditional ("Xたら、Y") is
 *  present, else the whole text. Shared by detectAction's own keyword scans
 *  and by detectActionCaveat() below, so every action-phrase detector agrees
 *  on what counts as "the action" vs. "the condition". See the comment on
 *  detectAction's たら handling for the full rationale / known limitation. */
function actionDetectionScope(text: string): string {
  const talaIndex = text.lastIndexOf('たら');
  return talaIndex >= 0 ? text.slice(talaIndex + 2) : text;
}

// X-posting phrasing ("Xに投稿して" / "post to X" / "tweet this"). Phase 0 kept
// this as a `draft` fallback + caveat because there was no `app-act` action type
// on `main` yet to target. Phase 2 added the `app-act` schema (appActRecipeId /
// appActParams on AgentAction — see store/types.ts), so detectAction() below now
// returns a REAL `{ type: 'app-act', appActRecipeId: 'x.post', … }` action for
// this phrasing instead of falling through to draft. (Real on-device dispatch of
// `app-act` is separate, in-progress work — this parser change is what lets NL
// text reach that action type at all; the recipe/params are fixed and reviewed
// once at registration time, per the AgentActionType doc comment.) Kept as its
// own named const (not inlined) since it's still reused verbatim by the tests
// and by the "no caveat when X-posting is absent" invariant.
const X_POST_RE = /Xに(?:自動)?投稿|Xに上げて|Xでポスト|Xにポスト|post(?:ing)?\s+to\s+x\b|tweet\s+this|\bxポスト/i;

// LINE-posting phrasing ("LINEに投稿して" / "send this to LINE"). Phase 3
// scaffolded a `line.send-message` app-act recipe on the native layer, but
// wiring NL detection + dispatch for it is OUT OF SCOPE for this phase (only
// X was asked for) — so, unlike X above, this still falls through to `draft`
// with a caveat, exactly like X used to. Deliberately narrow (a literal
// 投稿/送信 verb, or "send ... to line") so it never collides with
// "LINEで知らせて/LINEで教えて", which already resolves to a real `notify`
// action via the notify-keyword branch in detectAction below.
const LINE_POST_RE = /LINEに(?:自動)?投稿|LINEに(?:メッセージを)?送(?:って|信)|send\s+(?:this|a\s+message)?\s*to\s+line\b|post(?:ing)?\s+to\s+line\b/i;

/** Detect a delivery request for a not-yet-supported action (currently just
 *  LINE-posting — see LINE_POST_RE above; X-posting graduated to a real
 *  app-act action in Phase 6 and no longer needs this fallback). Returns a
 *  user-facing warning string, or undefined when none applies. Callers should
 *  only surface this when `detectAction()` actually fell back to `draft` for
 *  the same text (see parseAgentNL). */
function detectActionCaveat(text: string): string | undefined {
  const actionScope = actionDetectionScope(text);
  if (LINE_POST_RE.test(actionScope)) {
    return 'LINEへの投稿にはまだ対応していないため、下書き（ファイル保存）として登録します';
  }
  return undefined;
}

/** Detect the delivery action. Default = draft. Never returns 'publish'. */
function detectAction(text: string): AgentAction {
  // webhook — an explicit URL is the strongest signal.
  const url = text.match(URL_RE);
  if (url || /webhook|フック/i.test(text)) {
    return { type: 'webhook', webhookUrl: url ? url[0] : undefined };
  }

  // cli — only on an explicit "run a command" intent (privilege escalation guard:
  // do NOT infer cli from generic task text). Command template is left for the
  // user to fill in the card; cli is never one-tap (§2.6).
  if (/コマンド(を)?実行|シェルで実行|run (the )?command|execute (the )?command|run a command/i.test(text)) {
    return { type: 'cli' };
  }

  // A conditional utterance ("Xたら、Y") names its trigger CONDITION before the
  // "たら" marker and its delivery ACTION after it -- e.g. "通知が来たらドラフトを
  // 作成して" (条件=通知, 動作=ドラフト) vs "下書きができたら通知して" (条件=下書き,
  // 動作=通知). "通知" and "下書き/ドラフト" are each both a NOTIFY-001
  // trigger-condition word AND a delivery-action keyword in this project, so
  // scanning the WHOLE string for either would misread whichever one happens to
  // describe the condition as if it were the delivery type. Restrict both
  // keyword scans below to the clause after the LAST "たら" when one is present
  // -- that's the only part of the sentence that actually names the delivery.
  // No "たら" at all (e.g. "毎日20時30分に通知して") scans the whole text, same
  // as before this fix.
  //
  // Known residual limitation (low severity -- always human-gated via the
  // confirm card's editable action picker before registration): a compound
  // utterance with a SECOND, trailing "たら" clause after the real delivery
  // verb truncates that verb out of scope, e.g. "毎朝ニュースが届いたら通知
  // して、余裕があったら要約も作って" falls to the default draft instead of
  // notify, because slicing after the LAST "たら" drops "通知して". Rare in
  // practice (needs two chained conditionals in one utterance); not fixed
  // here, no known simple fix without deeper clause parsing.
  const actionScope = actionDetectionScope(text);

  // app-act: X-posting (Phase 6). Checked before the draft/notify keyword scans
  // so "Xに自動投稿して" resolves to the real recipe even if the same clause
  // happens to also contain a draft/notify word elsewhere. {{result}} is the
  // agreed placeholder convention (same as intentShareText/dmReplyText) —
  // string-replaced with the run's output preview at request-build time,
  // BEFORE the approval request is written.
  if (X_POST_RE.test(actionScope)) {
    return { type: 'app-act', appActRecipeId: 'x.post', appActParams: { text: '{{result}}' } };
  }

  if (/ドラフト|下書き|\bdraft\b/i.test(actionScope)) {
    return { type: 'draft' };
  }

  // notify — explicit delivery-by-notification verbs.
  if (/通知|知らせ|教えて|リマインド|アラート|notify|alert|\bremind\b|tell me|push notification/i.test(actionScope.toLowerCase())) {
    return { type: 'notify' };
  }

  // default — draft (write the result to a file).
  return { type: 'draft' };
}

// Memory-write markers (JP/EN). Presence flips on memory.remember; the clause
// captured before the marker (JP) or after it (EN) becomes the remembered fact.
const MEMORY_JP_RE = /(.+?)(?:を|って|と)?\s*(?:覚えておいて|覚えてて|覚えといて|記憶しておいて|メモしておいて|メモして|忘れないで)/;
const MEMORY_EN_RE = /\b(?:remember|note|keep in mind|don'?t forget)\b(?:\s+(?:that|to|this)?)?\s*[:：]?\s*(.+)/i;

// A NEGATED "remember" is a statement about NOT recalling ("I don't remember the
// password") — not a request to store. It must never write a memory note. Note
// "don't forget" is the opposite (an affirmative keep-this) and is handled apart.
const EN_NEGATED_REMEMBER = /\b(?:do(?:n'?t| not)|can'?t|cannot|could ?n'?t|wo ?n'?t|will not|never|did ?n'?t)\s+remember\b/i;
const JP_NEGATED_MEMORY = /覚えて(?:い)?ない|覚えてません|思い出せない|記憶にない/;

/** Detect a "remember that …" request and extract the fact. Returns undefined when absent. */
function detectMemory(text: string): AgentMemoryConfig | undefined {
  // JP imperative keep-this markers, excluding negated "don't remember" forms.
  const hasJp = !JP_NEGATED_MEMORY.test(text) &&
    /(?:覚えておいて|覚えてて|覚えといて|記憶して|メモして|忘れないで)/.test(text);
  // EN: "keep in mind" / "don't forget" / "note that" are always affirmative;
  // bare "remember" counts only when it is NOT negated.
  const hasEnAlways = /\b(?:keep in mind|don'?t forget|note that)\b/i.test(text);
  const hasEnRemember = !EN_NEGATED_REMEMBER.test(text) && /\bremember\b/i.test(text);
  const hasEn = hasEnAlways || hasEnRemember;
  if (!hasJp && !hasEn) return undefined;

  let fact: string | undefined;
  if (hasJp) {
    const m = text.match(MEMORY_JP_RE);
    if (m && m[1]) fact = m[1].trim().replace(/^[「『]|[」』]$/g, '').trim();
  }
  if (!fact && hasEn) {
    const m = text.match(MEMORY_EN_RE);
    if (m && m[1]) fact = m[1].trim().replace(/^["']|["']$/g, '').trim();
  }
  return { remember: true, rememberFact: fact && fact.length > 0 ? fact : undefined };
}

// Tokens stripped when deriving a short display name.
const NAME_STRIP_RE = new RegExp(
  [
    '毎日', '毎朝', '毎晩', '毎夕', '毎週', '每週', '日次',
    '午前', '午後', '朝', '夜', '夕方', '晩', '深夜', '昼',
    '\\d+\\s*時(?:\\s*半|\\s*\\d+\\s*分)?', '\\d+\\s*分\\s*(?:ごと|おき|毎|間隔)?',
    // Weekday tokens (月曜日 / 月曜) — require 曜 so a bare 日月火水木金土 is NOT
    // stripped. Without it, '今日'→'今', '日本'→'本', '金融'→'融' all lost a char.
    '[日月火水木金土]曜日?',
    'を?(作って|作成して?|書いて|まとめて|要約して|送って|通知して|教えて|して)',
    // Memory markers (G2): "…と覚えておいて" etc. are the remember-fact trigger,
    // not the topic — they leaked into the derived display name.
    '覚えて(?:おいて|て|といて)', '記憶して', 'メモして', '忘れないで',
    '\\bremember(?:\\s+(?:that|to))?\\b', "\\bdon'?t\\s+forget(?:\\s+(?:that|to))?\\b",
    '\\bkeep\\s+in\\s+mind(?:\\s+that)?\\b', '\\bnote\\s+that\\b',
    'every\\s*day', 'everyday', 'daily', 'each\\s+day',
    'every\\s+\\d+\\s*(?:min|mins|minute|minutes|hours?)',
    '\\bat\\s+\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?',
    '\\b\\d{1,2}:\\d{2}\\s*(?:am|pm)?', '\\b\\d{1,2}\\s*(?:am|pm)\\b',
    'every\\s+(?:mon|tue|wed|thu|fri|sat|sun)\\w*',
    URL_RE.source,
  ].join('|'),
  'gi',
);

/** Derive a short, human-friendly name (editable in the card). */
function deriveName(text: string): string {
  let s = text.replace(NAME_STRIP_RE, ' ').replace(/[にをはがでへと、。,.\s]+/g, ' ').trim();
  if (!s) s = text.trim();
  // Collapse and truncate.
  s = s.replace(/\s+/g, ' ');
  if (s.length > 28) s = s.slice(0, 28).trim() + '…';
  return s || 'Agent';
}

/** Build the prompt fed to the agent — the task minus the leading schedule phrase. */
function derivePrompt(text: string, schedule: ScheduleResult): string {
  // Keep it simple and faithful: strip a leading schedule clause when we recognised
  // one, otherwise pass the utterance through. Codex/LLM handles the rest.
  let s = text.trim();
  if (schedule.confident) {
    s = s
      // Strip the schedule clause IN PLACE (no leading `.*?`) so a topic BEFORE it
      // survives: "GitHub Trendingを毎日8時にまとめて" → "GitHub Trendingをまとめて",
      // not "まとめて". Bounded by 、。 so it never crosses a clause boundary.
      .replace(/(毎日|毎朝|毎晩|毎夕|毎週|每週|日次)[^、。]*?(時(?:半|\d+分)?|分\s*(?:ごと|おき|毎|間隔))\s*(に|の)?/, '')
      // Colon-form JP time list following a daily marker ("毎日朝8:00と夜21:00に…").
      // The 時-based strip above requires a literal 時 char and never matches this
      // colon form, so it survived untouched — this is the daily-multi companion.
      // Bounded by the same 、。 boundary chars as the 時-based strip above.
      .replace(
        /(毎日|毎朝|毎晩|毎夕|毎週|每週|日次)[^、。]*?\d{1,2}:\d{2}(?:\s*(?:と|・|、|,|，|および|＆|&)\s*(?:朝|昼|夜|晩|夕|午前|午後)?\s*\d{1,2}:\d{2})*\s*(に|の)?/,
        '',
      )
      // 時-form JP multi-time LEFTOVER ("毎日朝8時と夜21時に…"). The 時-based strip
      // above is lazy and only consumes the FIRST 時 occurrence ("毎日朝8時"), leaving
      // a dangling "と夜21時に" (or, in a mixed 時+colon phrasing, "と夜21:00に")
      // continuation fragment in the string it hands to this replace. Anchored to the
      // START of the (already-reduced) string — it can only ever match a leftover
      // conjunction-prefixed time clause, never a legitimate prompt that happens to
      // begin with "と" on its own.
      .replace(
        /^\s*(?:と|・|、|,|，|および|＆|&)\s*(?:朝|昼|夜|晩|夕|午前|午後)?\s*\d{1,2}\s*(?:時(?:半|\d{1,2}分)?|:\d{2})(?:\s*(?:と|・|、|,|，|および|＆|&)\s*(?:朝|昼|夜|晩|夕|午前|午後)?\s*\d{1,2}\s*(?:時(?:半|\d{1,2}分)?|:\d{2}))*\s*(に|の)?/,
        '',
      )
      // No-毎週 multi-day path. Two narrow strips, each requiring a trailing 時 so a
      // non-schedule opener is untouched:
      //  (A) a leading 曜-qualified weekday clause ("月曜と金曜の朝8時に…").
      .replace(
        /^[日月火水木金土]曜日?(?:\s*(?:と|・|、|,|，|および|＆|&)\s*[日月火水木金土]曜?日?)*\s*[^、。]*?時(?:半|\d+分)?\s*(?:に|の)?/,
        '',
      )
      //  (B) a leading bare run of 2+ weekday chars that leads DIRECTLY into the time
      //  ("火・金の朝8時に…"). Mirrors detection's adjacency so it can't eat an element
      //  pair (火・水の実験を…8時) that merely precedes an unrelated time downstream.
      .replace(
        /^[日月火水木金土]曜?日?(?:\s*[・、，,と＆&]\s*[日月火水木金土]曜?日?)+\s*(?:の|は|、|,)?\s*(?:朝|昼|夜|晩|夕|午前|午後)?\s*\d{1,2}\s*(?:時(?:半|\d+分)?|:\d{2})\s*(?:に|の)?/,
        '',
      )
      .replace(/^\s*((on\s+)?(mon|tue|wed|thu|fri|sat|sun)\w*(\s*(,|and|&)\s*(mon|tue|wed|thu|fri|sat|sun)\w*)*)\b[^.,]*?\b(at\s+\d|\d\s*(am|pm|:))[^,.]*[\s,]*/i, '')
      .replace(/^\s*(every\s*day|everyday|daily|each\s+day|every\s+\d+\s*\w+)\b[\s,]*/i, '')
      .trim();
  }
  return s || text.trim();
}

/**
 * G6: an explicit "パイプライン" / "pipeline" request builds the ready-made STEAM
 * collection pipeline (search → primary source → summarize → char-limited
 * re-summarize) instead of the single-step parse. A topic before the keyword is
 * carried through ("量子コンピュータのパイプライン" → topic=量子コンピュータ); a bare
 * "パイプライン" or a STEAM topic falls back to the STEAM×AI default. Returns null
 * when the utterance isn't a pipeline request, so the normal parse path runs.
 */
function detectPipelinePreset(text: string): PipelinePreset | null {
  if (!/パイプライン|pipeline/i.test(text)) return null;
  // Don't hijack the OTHER senses of "pipeline" into a data-collection preset:
  //  - DevOps / CI build pipelines (debugging, not scheduled collection)
  //  - "design / architect a pipeline" (engineering, not collection)
  if (
    /エラー|直し|直す|修正|\bfix\b|失敗|\bfail|デプロイ|deploy|\bci\b|\bcd\b|ci\/cd|cicd|ジョブ|\bjob\b|\bbuild\b|ビルド/i.test(text) ||
    /設計|構築|アーキ|\bdesign\b|\barchitect|\bdata pipeline\b|データパイプライン/i.test(text)
  ) {
    return null;
  }
  const m = text.match(
    /(.+?)(?:の|を|に関する)?\s*(?:最新の?)?\s*(?:ニュース|論文|情報|動向)?\s*(?:を)?\s*(?:パイプライン|pipeline)/i,
  );
  let topic = (m?.[1] ?? '').trim();
  topic = topic
    .replace(/[@＠]?agent\s*/gi, '')
    // Strip a leading schedule clause so "毎日8時に量子コンピュータ" → "量子コンピュータ".
    .replace(
      /^((?:毎日|毎週|毎朝|毎晩|毎夕|定期的?に?|\d+\s*時(?:\s*\d+\s*分)?|\d+\s*分(?:ごと|おき)?|[日月火水木金土]曜日?)\s*に?\s*)+/g,
      '',
    )
    .trim();
  if (/^steam/i.test(topic) || topic.length < 2) topic = '';
  return buildSteamPipeline({ topic: topic || undefined });
}

// Explicit autonomous/unattended-execution intent — the ONLY way to set
// draft.autonomous=true outside the G6 "パイプライン" preset (which is
// hardcoded autonomous by design, a fixed-shape exception). Without this,
// there was no way to request autonomous execution for a hand-written
// multi-step instruction through the free-form/chat-native confirm path at
// all: AgentChatConfirm (used for app-act/tool-pinned drafts) has no toggle
// UI, unlike the older AgentConfirmCard's explicit Autonomous switch, so
// app-act's Tier-B trust gate (agent.autonomous===true) could never unlock
// for anything but the rigid G6 preset shape — found via on-device testing
// 2026-07-15 (a hand-authored Perplexity->local-LLM->Obsidian->X pipeline
// correctly tool-pinned and scheduled, but silently registered non-
// autonomous, so app-act still asked for a human tap every run). Curated
// phrase list (not a loose regex on "自動"/"確認" alone) to avoid false
// positives on unrelated uses of those characters.
const AUTONOMOUS_INTENT_RE =
  /自律(?:的に|で|実行)|完全無人|人の確認(?:は)?なし|確認(?:は)?なしで|承認(?:は)?なしで|勝手に(?:投稿|実行|やって)|autonomous(?:ly)?|unattended|without\s+(?:approval|confirmation|review)|fully\s+automat(?:ed|ically)/i;

function detectAutonomousIntent(text: string): boolean {
  return AUTONOMOUS_INTENT_RE.test(text);
}

/**
 * Parse an utterance into a structured agent draft. Pure & deterministic — safe to call
 * offline and in unit tests. Always returns a draft (never throws / never hard-blocks);
 * an unparseable schedule yields `schedule: null` + `scheduleConfident: false`.
 */
export function parseAgentNL(utterance: string): ParsedAgentDraft {
  const rawText = utterance.trim();

  // G6: a "パイプライン" request becomes the multi-step collection preset. The
  // user's own schedule (if confidently parsed) overrides the preset's Mon/Fri.
  const preset = detectPipelinePreset(rawText);
  if (preset) {
    const presetSched = parseSchedule(rawText);
    const presetSuggestion = suggestTool(preset.prompt);
    const presetAction = detectAction(rawText);
    const presetActionCaveat = presetAction.type === 'draft' ? detectActionCaveat(rawText) : undefined;
    // Use the preset's Mon/Fri default ONLY when the user gave no schedule cue at
    // all. If they stated one that we couldn't confidently parse (e.g. "90分ごと"),
    // fall to manual selection rather than silently rewriting it to Mon/Fri.
    const hasScheduleCue = /毎日|毎週|毎朝|毎晩|毎夕|日次|[日月火水木金土]曜|\d+\s*時|\d+\s*分|ごと|おき|daily|weekly|every|hourly|\bmin/i.test(rawText);
    const usePresetDefault = !presetSched.confident && !hasScheduleCue;
    const schedule = presetSched.confident
      ? presetSched.schedule
      : usePresetDefault
      ? preset.schedule
      : null;
    return {
      name: deriveName(preset.name),
      prompt: preset.prompt,
      // The G6 preset's own steps stay plain strings here (its fixed
      // search→primary-source→summarize→re-summarize shape has no per-clause
      // tool mentions to detect) — normalize + extract the instruction so an
      // object-shaped preset step entry can't leak through un-normalized. The
      // Phase 6 tool-pin detector (detectToolPinnedSteps) only runs in the
      // non-preset branch below, on the user's own utterance text.
      orchestrationSteps: normalizeSteps(preset.orchestration).map((s) => s.instruction),
      charLimit: preset.orchestration.charLimit,
      schedule,
      scheduleConfident: presetSched.confident || usePresetDefault,
      scheduleLabel: presetSched.confident
        ? presetSched.label
        : usePresetDefault
        ? '毎週 月・金 8:00'
        : presetSched.label,
      suggestedTime: presetSched.suggestedTime
        ? { hour: presetSched.suggestedTime.hour, minute: presetSched.suggestedTime.minute }
        : undefined,
      action: presetAction,
      tool: presetSuggestion.tool,
      toolLabel: presetSuggestion.label ?? toolChoiceToLabel(presetSuggestion.tool),
      autonomous: true,
      memory: detectMemory(rawText),
      actionCaveat: presetActionCaveat,
      rawText,
    };
  }

  const sched = parseSchedule(rawText);
  const action = detectAction(rawText);
  const actionCaveat = action.type === 'draft' ? detectActionCaveat(rawText) : undefined;
  const prompt = derivePrompt(rawText, sched);
  const suggestion = suggestTool(prompt || rawText);
  const memory = detectMemory(rawText);
  // Phase 4: detect an explicit multi-step instruction (≥ 2 ordered parts) via
  // an explicit sequence marker (まず/次に/… , first/then/…, numbered list).
  const explicitSteps = parseStepsFromText(prompt || rawText);
  // Phase 6: when there's no EXPLICIT marker, fall back to the narrower
  // tool-mention detector (plain て-form/comma chain naming a tool per clause,
  // e.g. "パープレで集めて、ローカルLLMで要約して、Xに投稿して"). Checked only when
  // explicitSteps didn't already find a confident split, so a marker-based
  // utterance is never double-processed by both detectors.
  const orchestrationSteps: Array<string | AgentOrchestrationStep> | undefined =
    explicitSteps.length >= 2
      ? explicitSteps
      : detectToolPinnedSteps(prompt || rawText) ?? undefined;

  return {
    name: deriveName(rawText),
    prompt,
    orchestrationSteps,
    schedule: sched.schedule,
    scheduleConfident: sched.confident,
    scheduleLabel: sched.label,
    suggestedTime: sched.suggestedTime
      ? { hour: sched.suggestedTime.hour, minute: sched.suggestedTime.minute }
      : undefined,
    suggestedFrequency: sched.suggestedFrequency,
    suggestedDowList: sched.suggestedDowList,
    action,
    tool: suggestion.tool,
    toolLabel: suggestion.label ?? toolChoiceToLabel(suggestion.tool),
    autonomous: detectAutonomousIntent(rawText),
    memory,
    actionCaveat,
    rawText,
  };
}
