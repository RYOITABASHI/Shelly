/**
 * lib/agent-nl-parser.ts — Deterministic JP/EN NL → agent-fields parser (Phase 0 §2.1 / §3).
 *
 * This is the **deterministic template grammar**: a pure, offline, unit-testable parser
 * that turns an utterance like "毎日8時にXの下書きを作って" into a structured draft
 * {name, prompt, schedule, action, tool}. It is BOTH the MVP's primary parser for common
 * phrasings AND the fallback the spec requires when the LLM parse is unavailable (§3:
 * "NL parse must never hard-block registration").
 *
 * HARD REQUIREMENT (§2.1): the schedule MUST be one of the scheduler's 3 cron shapes —
 *   every-N-minutes (N=1..59) | daily "M H * * *" | weekly "M H * * D" (D=0..6)
 * (see lib/agent-scheduler.ts). If a confident schedule cannot be produced, we return
 * `schedule: null` with `scheduleConfident: false` so the confirmation card forces a manual
 * selection — we NEVER silently register an agent that will never fire.
 *
 * The result is a PREVIEW draft, not a live agent. The caller shows it in the confirm card.
 */
import { AgentAction, ToolChoice } from '@/store/types';
import { suggestTool, toolChoiceToLabel } from './agent-tool-router';

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
  /** Delivery capability. Defaults to 'draft' (write to outputPath). Never 'publish'. */
  action: AgentAction;
  /** Routed tool (reuses the keyword router). */
  tool: ToolChoice;
  toolLabel: string;
  /** Default for the card's Autonomous toggle (set true when the `@agent autonomous`
   *  alias was used). The card is the source of truth; this is just the initial value. */
  autonomous?: boolean;
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

interface ParsedTime {
  hour: number;
  minute: number;
}

/** Extract a time-of-day from JP or EN text. Returns null when none is found. */
function extractTime(text: string): ParsedTime | null {
  // JP: optional meridiem + N時 + (半 | M分)
  //   "午後8時半" "夜8時" "朝7時30分" "8時"
  const jp = text.match(/(午前|午後|朝|夜|夕方|晩|深夜|昼)?\s*(\d{1,2})\s*時\s*(半|(\d{1,2})\s*分)?/);
  if (jp) {
    let hour = parseInt(jp[2], 10);
    let minute = 0;
    if (jp[3] === '半') minute = 30;
    else if (jp[4] !== undefined) minute = parseInt(jp[4], 10);
    const meridiem = jp[1];
    if ((meridiem === '午後' || meridiem === '夜' || meridiem === '夕方' || meridiem === '晩') && hour < 12) {
      hour += 12;
    } else if ((meridiem === '午前' || meridiem === '朝' || meridiem === '深夜') && hour === 12) {
      hour = 0; // 午前12時/深夜12時 = 0:00
    }
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return { hour, minute };
  }

  // EN/numeric: "8:30am" "8 pm" "20:30" "at 9"
  const en = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (en && (en[2] !== undefined || en[3] !== undefined || /\bat\s+\d/i.test(text))) {
    let hour = parseInt(en[1], 10);
    const minute = en[2] !== undefined ? parseInt(en[2], 10) : 0;
    const mer = en[3]?.toLowerCase();
    if (mer === 'pm' && hour < 12) hour += 12;
    else if (mer === 'am' && hour === 12) hour = 0;
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return { hour, minute };
  }

  return null;
}

function fmtTime(t: ParsedTime): string {
  return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}

const JP_DOW_LABEL = ['日', '月', '火', '水', '木', '金', '土'];

interface ScheduleResult {
  schedule: string | null;
  confident: boolean;
  label: string;
  suggestedTime?: ParsedTime;
}

/** Parse the schedule, constrained to the 3 whitelisted cron shapes. */
function parseSchedule(text: string): ScheduleResult {
  const lower = text.toLowerCase();

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

  // Hour-interval ("N時間ごと"/"every N hours") is NOT in the whitelist (`0 */N * * *`
  // is rejected by the scheduler), so it must fall to manual selection.
  if (/(\d+)\s*時間\s*(?:ごと|おき|毎)/.test(text) || /every\s+\d+\s*hours?\b/.test(lower)) {
    return { schedule: null, confident: false, label: '未設定（時間間隔は非対応・要選択）' };
  }

  const time = extractTime(text);

  // ── 2. Weekly → `M H * * D` (requires a weekday + a time) ──
  let dow: number | null = null;
  const weeklyJp = text.match(/(?:毎週|每週)?\s*([日月火水木金土])曜?/);
  if (/毎週|每週/.test(text) && weeklyJp) {
    dow = JP_WEEKDAY[weeklyJp[1]];
  } else {
    for (const [re, d] of EN_WEEKDAY) {
      if (re.test(lower)) {
        dow = d;
        break;
      }
    }
  }
  if (dow !== null) {
    if (time) {
      return {
        schedule: `${time.minute} ${time.hour} * * ${dow}`,
        confident: true,
        label: `毎週${JP_DOW_LABEL[dow]} ${fmtTime(time)}`,
      };
    }
    return {
      schedule: null,
      confident: false,
      label: `毎週${JP_DOW_LABEL[dow]} 時刻未設定（要選択）`,
      suggestedTime: undefined,
    };
  }

  // ── 3. Daily → `M H * * *` (explicit daily marker + a time) ──
  const dailyMarker = /毎日|毎朝|毎晩|毎夕|日次/.test(text) || /\b(every\s*day|everyday|daily|each\s+day)\b/.test(lower);
  if (dailyMarker) {
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

/** Detect the delivery action. Default = draft. Never returns 'publish'. */
function detectAction(text: string): AgentAction {
  const lower = text.toLowerCase();

  // webhook — an explicit URL is the strongest signal.
  const url = text.match(URL_RE);
  if (url || /webhook|フック|\bpost\b/i.test(text)) {
    return { type: 'webhook', webhookUrl: url ? url[0] : undefined };
  }

  // cli — only on an explicit "run a command" intent (privilege escalation guard:
  // do NOT infer cli from generic task text). Command template is left for the
  // user to fill in the card; cli is never one-tap (§2.6).
  if (/コマンド(を)?実行|シェルで実行|run (the )?command|execute (the )?command|run a command/i.test(text)) {
    return { type: 'cli' };
  }

  // notify — explicit delivery-by-notification verbs.
  if (/通知|知らせ|教えて|リマインド|アラート|notify|alert|\bremind\b|tell me|push notification/i.test(lower)) {
    return { type: 'notify' };
  }

  // default — draft (write the result to a file).
  return { type: 'draft' };
}

// Tokens stripped when deriving a short display name.
const NAME_STRIP_RE = new RegExp(
  [
    '毎日', '毎朝', '毎晩', '毎夕', '毎週', '每週', '日次',
    '午前', '午後', '朝', '夜', '夕方', '晩', '深夜', '昼',
    '\\d+\\s*時(?:\\s*半|\\s*\\d+\\s*分)?', '\\d+\\s*分\\s*(?:ごと|おき|毎|間隔)?',
    '[日月火水木金土]曜?日?',
    'を?(作って|作成して?|書いて|まとめて|要約して|送って|通知して|教えて|して)',
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
      .replace(/^.*?(毎日|毎朝|毎晩|毎夕|毎週|每週|日次)[^、。]*?(時(?:半|\d+分)?|分\s*(?:ごと|おき|毎|間隔))\s*(に|の)?/, '')
      .replace(/^\s*(every\s*day|everyday|daily|each\s+day|every\s+\d+\s*\w+)\b[\s,]*/i, '')
      .trim();
  }
  return s || text.trim();
}

/**
 * Parse an utterance into a structured agent draft. Pure & deterministic — safe to call
 * offline and in unit tests. Always returns a draft (never throws / never hard-blocks);
 * an unparseable schedule yields `schedule: null` + `scheduleConfident: false`.
 */
export function parseAgentNL(utterance: string): ParsedAgentDraft {
  const rawText = utterance.trim();
  const sched = parseSchedule(rawText);
  const action = detectAction(rawText);
  const prompt = derivePrompt(rawText, sched);
  const suggestion = suggestTool(prompt || rawText);

  return {
    name: deriveName(rawText),
    prompt,
    schedule: sched.schedule,
    scheduleConfident: sched.confident,
    scheduleLabel: sched.label,
    suggestedTime: sched.suggestedTime
      ? { hour: sched.suggestedTime.hour, minute: sched.suggestedTime.minute }
      : undefined,
    action,
    tool: suggestion.tool,
    toolLabel: suggestion.label ?? toolChoiceToLabel(suggestion.tool),
    rawText,
  };
}
