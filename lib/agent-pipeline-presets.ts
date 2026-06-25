/**
 * lib/agent-pipeline-presets.ts — G6: ready-made multi-step pipelines for the
 * North Star scenario (collect → primary source → summarize → char-limited
 * re-summarize), plus the char-limit guarantee helper.
 *
 * Pure & deterministic (no store/native deps) so it is unit-testable. A preset
 * produces the pieces createAgent() needs: a base prompt, an orchestration
 * config (steps + charLimit), a suggested schedule, and the autonomous flag.
 * The orchestration machinery (runAgentOrchestrated) already runs each step
 * through its own ladder — a "collect" step routes to Gemini/Perplexity (web),
 * a "summarize" step to the on-device model — so the preset only has to author
 * the right step instructions.
 */
import type { AgentOrchestrationConfig } from '@/store/types';

export interface PipelinePreset {
  /** Human-friendly agent name (editable in the confirm card). */
  name: string;
  /** Overall goal, prefixed onto every step prompt by buildStepPrompt. */
  prompt: string;
  /** The multi-step chain + char-limit guarantee. */
  orchestration: AgentOrchestrationConfig;
  /** Suggested cron (the North Star cadence). null = run once. */
  schedule: string | null;
  /** Pipelines collect from the web unattended → autonomous. */
  autonomous: boolean;
}

/** North Star default cadence: Mon & Fri at 08:00. */
export const STEAM_DEFAULT_CRON = '0 8 * * 1,5';
/** X/Twitter post budget (characters). */
export const X_CHAR_LIMIT = 280;
const DEFAULT_TOPIC = 'STEAM×AI（科学・技術・工学・芸術・数学 × AI）';

/**
 * Build the STEAM×AI collection pipeline: search the web for fresh papers/news
 * WITH sources, go to the primary source, summarize, then re-summarize within a
 * character budget for an X post. The save is the agent's draft action (writes
 * to the configured output destination), so it is NOT a pipeline step.
 */
export function buildSteamPipeline(opts: {
  topic?: string;
  charLimit?: number;
  schedule?: string | null;
  count?: number;
} = {}): PipelinePreset {
  const topic = (opts.topic && opts.topic.trim()) || DEFAULT_TOPIC;
  const charLimit = clampCharLimit(opts.charLimit ?? X_CHAR_LIMIT);
  const count = Math.min(Math.max(opts.count ?? 5, 1), 10);
  const schedule = opts.schedule === undefined ? STEAM_DEFAULT_CRON : opts.schedule;

  const steps = [
    // 1) Collect — web-mandatory (collection verb + freshness) → Gemini grounded
    //    / Perplexity academic. "出典付き" so the source URLs survive downstream.
    `今日の${topic}の最新ニュース・論文を${count}件、出典URL付きで集めて`,
    // 2) Primary source — go to the actual sources and pull the real facts, not a
    //    second-hand blurb. Worded as "collect the latest primary info on the web"
    //    (collection verb + freshness) so the scorer routes it to a WEB backend —
    //    on-device can't fetch URLs.
    `前段で挙がった各トピックについて、最新の一次情報をWebで収集し、重要な事実・数値・主張を出典URL付きで抽出して`,
    // 3) Summarize — transform (no collection verb) → on-device model.
    `一次情報をもとに各トピックを2〜3文の日本語で要約し、各項目に出典URLを付けて`,
    // 4) Re-summarize for X within the char budget. charLimit below also enforces
    //    a hard guarantee after the run, but instruct the model explicitly too.
    `全体をX(Twitter)投稿用に${charLimit}文字以内で再要約して。最重要トピックのみ、絵文字は使わず、${charLimit}文字を絶対に超えないこと`,
  ];

  const orchestration: AgentOrchestrationConfig = { steps, charLimit };

  return {
    name: `${topic} 収集`,
    prompt: `${topic}の最新動向を定期収集して、一次ソース付きで要約する`,
    orchestration,
    schedule,
    autonomous: true,
  };
}

/** Hard clamp so a typo can't request a 5-char or 50000-char "limit". */
export function clampCharLimit(limit: number): number {
  if (!Number.isFinite(limit)) return X_CHAR_LIMIT;
  return Math.min(Math.max(Math.floor(limit), 40), 4000);
}

/**
 * Guarantee text is ≤ `limit` CODE POINTS (Japanese counts as 1 here — keep it
 * simple; callers wanting Twitter's CJK=2 weighting can pre-halve the limit).
 * Prefers cutting at a sentence boundary (。．.!?！？ or newline) at or before the
 * limit so the result reads cleanly; falls back to a hard cut + ellipsis. The
 * ellipsis is included WITHIN the budget (result length ≤ limit).
 */
export function enforceCharLimit(text: string, limit: number): string {
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  const ELLIPSIS = '…';
  const budget = Math.max(limit - 1, 1); // reserve 1 for the ellipsis
  const head = chars.slice(0, budget);
  // Find the last sentence terminator within the kept head; only honour it if it
  // keeps a reasonable amount (≥ 60% of budget) so we don't gut the text.
  const terminators = new Set(['。', '．', '.', '!', '?', '！', '？', '\n']);
  let cut = -1;
  for (let i = head.length - 1; i >= 0; i--) {
    if (terminators.has(head[i])) {
      cut = i;
      break;
    }
  }
  if (cut >= Math.floor(budget * 0.6)) {
    return head.slice(0, cut + 1).join('').trimEnd();
  }
  return head.join('').trimEnd() + ELLIPSIS;
}
