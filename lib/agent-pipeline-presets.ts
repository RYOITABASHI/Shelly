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
import type { AgentAction, AgentLocalStepConfig, AgentOrchestrationConfig, AgentOrchestrationStep, ToolChoice } from '@/store/types';
import { REVIEW_OUTPUT_CONTRACT } from './agent-orchestration';

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
  /** Fixed by the preset instead of derived from the utterance. Absent = the
   *  parser derives them, as for the collection preset. */
  tool?: ToolChoice;
  action?: AgentAction;
  /** Shown in the plain-text confirm when `schedule` is the preset's own. */
  scheduleLabel?: string;
  /** Where the agent's draft action saves. */
  output?: { outputPath: string; outputTemplate: string };
  /** No "remember that …" from the utterance (recall is off for longform
   *  chains, lib/agent-manager.ts applyMemoryAndSkills). */
  memoryOff?: boolean;
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
    // 4) Re-summarize for X within the char budget. charLimit is X's real
    //    WEIGHTED budget (280 for a free-tier post); since Codex writes this
    //    step in Japanese and full-width characters count as 2 units on X,
    //    the character target given to the model is halved so the output
    //    actually fits. enforceCharLimit (using the true weighted charLimit)
    //    is the hard guarantee after the run regardless of what the model does.
    `全体をX(Twitter)投稿用に${Math.floor(charLimit / 2)}文字以内（日本語の全角文字はXでは2文字分としてカウントされるため）で再要約して。最重要トピックのみ、絵文字は使わず、${Math.floor(charLimit / 2)}文字を絶対に超えないこと`,
  ];

  const orchestration: AgentOrchestrationConfig = { steps, charLimit };

  return {
    name: `${topic} 収集`,
    // NEUTRAL base prompt — no collection verb / freshness word. buildStepPrompt
    // prepends this to EVERY step, and the escalation ladder routes a step by its
    // FULL prompt; a freshness/collection word here would force needsWeb on the
    // summarize/re-summarize steps too. Keep routing driven by each step's verb.
    prompt: `${topic}の定例レポート`,
    orchestration,
    schedule,
    autonomous: true,
  };
}

// ── Daily article drafts (docs/superpowers/specs/2026-11-06-article-pipeline-plan.md) ──

export type ArticleStream = 'ai-steam';

const ARTICLE_VAULT_DRAFTS = '/sdcard/Documents/ObsidianVault/50_Drafts';
/** The writer leaves this where the owner's own material belongs; `assemble`
 *  then sets `material: missing`. Mirrored by ARTICLE_MATERIAL_MISSING_RE in
 *  scripts/shelly-plan-executor.js. */
export const ARTICLE_MATERIAL_MISSING_MARKER = '【本人の材料: 未記入】';

// Pinned free-tier engines. The writer and the reviser share an engine so the
// reviewer is never the one who wrote the text. Research is Gemini grounded
// (no Perplexity: the owner wants no new costs).
const ARTICLE_RESEARCH_ENGINE: ToolChoice = { type: 'gemini-api' };
const ARTICLE_WRITER_ENGINE: ToolChoice = { type: 'gemini-api' };
const ARTICLE_REVIEWER_ENGINE: ToolChoice = { type: 'cerebras' };

/** docs/promo/brand/claims-ledger.md: claims that must not reach a public
 *  page. Matched by the executor's assemble step; flags only. */
const ARTICLE_LINT_TERMS = [
  '世界初',
  'world first',
  "world's first",
  'スマホだけで',
  'スマホ一台だけで',
  'デスクトップに一度も触れず',
  'built entirely on a phone',
  'without ever touching a desktop',
  'no desktop, no laptop',
  'このリポジトリの全行',
  'every line in this repo',
  "can't write code",
  'twenty years',
  '20 年分',
  '20年分',
];

/** Name forms other than the canonical one. The ledger's other banned form,
 *  the name in kanji, is not checked: that would put it in the repo. */
const ARTICLE_NAME_LINT = { canonical: 'RYO ITABASHI', forms: ['itabashi', 'イタバシ', 'いたばし'] };

const ARTICLE_FOOTER_JA =
  'AI 利用: この記事の調査・下書き・査読には AI を使いました。\n最終確認者: RYO ITABASHI（本人が内容を確認してから公開します）';

interface ArticleStreamConfig {
  name: string;
  /** Folder under 50_Drafts. */
  folder: string;
  cron: string;
  cronLabel: string;
  /** Base prompt, prefixed onto every step. NEUTRAL like buildSteamPipeline's:
   *  no freshness word (ニュース / 最新 / …), or detectRouteSignals reads the
   *  agent as web-mandatory and the plan prompt turns into a link-list task. */
  prompt: string;
  researchInstruction: string;
  writeInstruction: string;
}

const ARTICLE_STREAMS: Record<ArticleStream, ArticleStreamConfig> = {
  'ai-steam': {
    name: 'AI×STEAM 記事下書き',
    folder: 'Steam',
    cron: '0 6 * * *',
    cronLabel: '毎日 6:00',
    prompt: [
      'AI×STEAM（科学・技術・工学・芸術・数学とAI）の解説記事シリーズ。媒体は note、読者は教員・親子・学生。日本語で書く。',
      '共通ルール:',
      '- 資料はプレプリント・学会論文・学術誌を区別し、査読前か査読後かを必ず書く。',
      '- 自分の文章が主で、引用は従。原文は要約し、細かく追いすぎない。全文訳はしない（CC-BY / CC0 と確認できた資料だけ例外。NC・ND・arXiv 標準ライセンスは不可）。',
      '- 図表は転載しない。',
      '- 数値・結論・限界は資料のとおりに書く。「世界初」のような言い切りは書かない。',
    ].join('\n'),
    // "Web" is what makes this the chain's research step (grounded search +
    // captured sources); 最近 keeps the search to the last 30 days.
    researchInstruction:
      'Webで検索し、最近のAI×STEAMの話題をひとつ選んで調査メモを作る。プレプリント・学会論文・学術誌を優先し、資料ごとに査読前か査読後か、主な数値・結論・限界、わかればライセンスを書く。6000字以内。',
    writeInstruction: `調査メモをもとに、本文3000〜5000字の解説記事を書く。1行目は「# 」で始まる見出し。事実には Sources の番号 [n] を付け、資料の査読前後を本文で示す。最後に「## 本人の見解」の節を作り、本文は書かず ${ARTICLE_MATERIAL_MISSING_MARKER} とだけ書く。`,
  },
};

// A function: agent-orchestration may still be loading when this module is.
const articleReviewInstruction = (): string =>
  `下書きの主張を一つずつ調査メモの本文と照合する。原文ページはあなたには見えないので、根拠にできるのは調査メモだけ。調査メモにない主張、数値の違い、査読前後の取り違え、全文訳に近い箇所、言い切りすぎを指摘する。${ARTICLE_MATERIAL_MISSING_MARKER} は指摘しない。\n\n${REVIEW_OUTPUT_CONTRACT}`;
const ARTICLE_REVISE_INSTRUCTION =`査読の指摘をすべて反映し、修正後の記事全文だけを出力する。差分や説明は書かない。${ARTICLE_MATERIAL_MISSING_MARKER} はそのまま残す。`;

/**
 * One stream's daily draft agent:
 * [research, write, review1, revise1, review2, revise2, assemble], run by the
 * PlanSpec executor on the cron (longform chain; Run now is refused). The
 * chain ends in the draft action: it saves to the vault and publishes nothing.
 * autonomous:false keeps the pinned HTTP engines and the local `assemble` step
 * (an autonomous plan strips Groq/Cerebras pins).
 */
export function buildArticlePipeline(stream: ArticleStream): PipelinePreset {
  const cfg = ARTICLE_STREAMS[stream];
  const assemble: AgentLocalStepConfig = {
    kind: 'assemble',
    parts: [[1, 3, 5]],
    stream,
    footer: ARTICLE_FOOTER_JA,
    lintTerms: ARTICLE_LINT_TERMS,
    nameLint: ARTICLE_NAME_LINT,
  };
  const steps: AgentOrchestrationStep[] = [
    { instruction: cfg.researchInstruction, tool: ARTICLE_RESEARCH_ENGINE, toolPinned: true },
    { instruction: cfg.writeInstruction, tool: ARTICLE_WRITER_ENGINE, toolPinned: true },
    { instruction: articleReviewInstruction(), tool: ARTICLE_REVIEWER_ENGINE, toolPinned: true, handoff: { kind: 'review', of: [0, 1], round: 1 } },
    { instruction: ARTICLE_REVISE_INSTRUCTION, tool: ARTICLE_WRITER_ENGINE, toolPinned: true, handoff: { kind: 'revise', of: [1, 2], round: 1 } },
    { instruction: articleReviewInstruction(), tool: ARTICLE_REVIEWER_ENGINE, toolPinned: true, handoff: { kind: 'review', of: [0, 3], round: 2 } },
    { instruction: ARTICLE_REVISE_INSTRUCTION, tool: ARTICLE_WRITER_ENGINE, toolPinned: true, handoff: { kind: 'revise', of: [3, 4], round: 2 } },
    { instruction: '記事を組み立てて、フロントマターと Sources を付ける（モデルは使わない）', local: assemble },
  ];
  return {
    name: cfg.name,
    prompt: cfg.prompt,
    orchestration: { steps, longform: true },
    schedule: cfg.cron,
    scheduleLabel: cfg.cronLabel,
    autonomous: false,
    tool: ARTICLE_RESEARCH_ENGINE,
    action: { type: 'draft' },
    output: { outputPath: `${ARTICLE_VAULT_DRAFTS}/${cfg.folder}/`, outputTemplate: `{date}-${stream}.md` },
    memoryOff: true,
  };
}

/** Hard clamp so a typo can't request a 5-char or 50000-char "limit". */
export function clampCharLimit(limit: number): number {
  if (!Number.isFinite(limit)) return X_CHAR_LIMIT;
  return Math.min(Math.max(Math.floor(limit), 40), 4000);
}

/**
 * X's actual free-tier post budget is 280 "weighted" units, where full-width
 * characters (hiragana/katakana/CJK ideographs/fullwidth forms/hangul) count
 * as 2 and everything else counts as 1 — so an all-Japanese post effectively
 * caps at 140 characters, not 280. `enforceCharLimit` used to count plain code
 * points (Japanese = 1), which let an all-Japanese "280文字以内" post through
 * at roughly double X's real budget — found via on-device testing 2026-07-31
 * when a generated post couldn't actually fit on X. Not a full reimplementation
 * of twitter-text (no t.co URL discounting to 23, so URL-bearing text has some
 * extra real-world slack beyond what this conservatively counts).
 */
const X_FULLWIDTH_RE = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯가-힯]/;

export function xWeightedLength(text: string): number {
  let total = 0;
  for (const ch of Array.from(text)) total += X_FULLWIDTH_RE.test(ch) ? 2 : 1;
  return total;
}

/**
 * Guarantee text is ≤ `limit` X-weighted units (see xWeightedLength) — i.e.
 * the result is guaranteed to actually fit in an X post of that budget.
 * Prefers cutting at a sentence boundary (。．.!?！？ or newline) at or before the
 * limit so the result reads cleanly; falls back to a hard cut + ellipsis. The
 * ellipsis is included WITHIN the budget (result weighted-length ≤ limit).
 */
export function enforceCharLimit(text: string, limit: number): string {
  // Clamp first so a raw 0 / negative / NaN can never break the ≤-limit guarantee.
  const lim = clampCharLimit(limit);
  if (xWeightedLength(text) <= lim) return text;
  const ELLIPSIS = '…'; // not full-width per X_FULLWIDTH_RE — costs 1 unit.
  const budget = Math.max(lim - 1, 1); // reserve 1 unit for the ellipsis
  const chars = Array.from(text);
  let acc = 0;
  let cutIdx = chars.length;
  for (let i = 0; i < chars.length; i++) {
    const w = X_FULLWIDTH_RE.test(chars[i]) ? 2 : 1;
    if (acc + w > budget) {
      cutIdx = i;
      break;
    }
    acc += w;
  }
  const head = chars.slice(0, cutIdx);
  // Find the last sentence terminator within the kept head; only honour it if it
  // keeps a reasonable amount (≥ 60% of the consumed budget) so we don't gut the text.
  const terminators = new Set(['。', '．', '.', '!', '?', '！', '？', '\n']);
  let cut = -1;
  for (let i = head.length - 1; i >= 0; i--) {
    if (terminators.has(head[i])) {
      cut = i;
      break;
    }
  }
  if (cut >= 0 && xWeightedLength(head.slice(0, cut + 1).join('')) >= Math.floor(acc * 0.6)) {
    return head.slice(0, cut + 1).join('').trimEnd();
  }
  return head.join('').trimEnd() + ELLIPSIS;
}
