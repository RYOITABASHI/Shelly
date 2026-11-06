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

export type ArticleStream = 'ai-steam' | 'dev-ja' | 'dev-en' | 'vintage-ja' | 'vintage-en';

const ARTICLE_VAULT_DRAFTS = '/sdcard/Documents/ObsidianVault/50_Drafts';
const ARTICLE_DIGEST_FOLDER = 'Digest';
/** The writer leaves this where the owner's own material belongs; `assemble`
 *  then sets `material: missing`. Mirrored by ARTICLE_MATERIAL_MISSING_RE in
 *  scripts/shelly-plan-executor.js. */
export const ARTICLE_MATERIAL_MISSING_MARKER = '【本人の材料: 未記入】';

// Pinned free-tier engines. The writer and the reviser share an engine, and the
// reviewer's pin is a different one. A ladder fallback can still bring them
// together: the executor then moves that review to the other family, and leaves
// the draft unresolved if the two still match.
// Research is Gemini grounded, except the academic stream: owner decision
// 2026-11-06, Perplexity only for papers.
const ARTICLE_RESEARCH_ENGINE: ToolChoice = { type: 'gemini-api' };
const ARTICLE_ACADEMIC_RESEARCH_ENGINE: ToolChoice = { type: 'perplexity' };
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
const ARTICLE_FOOTER_EN =
  'AI disclosure: AI tools were used for the research, drafting and review of this post.\nFinal check: RYO ITABASHI (the author read and verified it before it went out).';

/** Vintage drafts: no images, no listing links, no claim that an item is real.
 *  Mercari checks stay attended (docs/promo/research/plan-v2.md). Flags only. */
const ARTICLE_VINTAGE_LINT_TERMS = ['![', '<img', 'mercari', 'merc.li', 'メルカリ', '本物です', '正規品', 'authentic', 'genuine'];

// In the write and revise instructions: on the second device run the draft held
// lines addressed to the writer itself, such as 検索結果からは取得できなかった.
const ARTICLE_NO_SELF_TALK_JA = 'この指示・検索・調査メモのことは本文に書かない。資料に書かれたことだけを書く。資料が非公開と述べる数値だけ、文章でそう書く。括弧の注記にしない。';
const ARTICLE_NO_SELF_TALK_EN = 'Never mention these rules, the search or the notes. Write only what the sources say; if they say a figure is not public, say so.';

interface ArticleStreamConfig {
  name: string;
  /** Shown in the digest. */
  label: string;
  /** Folder under 50_Drafts. */
  folder: string;
  cron: string;
  cronLabel: string;
  /** Language of the instructions and of the draft. */
  lang: 'ja' | 'en';
  /** The chain starts with `queue-pop`: the topic comes from
   *  50_Drafts/<folder>/_queue.md, which the owner fills by hand. */
  queue: boolean;
  /** One X intent link in the digest. Off for a stream with no X account. */
  intent: boolean;
  footer: string;
  /** Added to ARTICLE_LINT_TERMS. */
  extraLintTerms?: string[];
  /** Also lint the chain's source titles and URLs. */
  lintSources?: boolean;
  /** Added to the review instruction, before the output contract. */
  reviewExtra?: string;
  /** Flagged in frontmatter `lint`, never enforced. */
  quality: { minChars?: number; minWords?: number; minSources: number };
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
    label: 'AI×STEAM',
    folder: 'Steam',
    cron: '0 6 * * *',
    cronLabel: '毎日 6:00',
    lang: 'ja',
    queue: false,
    intent: true,
    footer: ARTICLE_FOOTER_JA,
    quality: { minChars: 2500, minSources: 2 },
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
      'Webで検索し、最近のAI×STEAMの話題をひとつに絞って調査メモを作る。別々の資料を3件以上使い、プレプリント・学会論文・学術誌を優先し、雑誌の目次ページより論文の記事ページを選ぶ。資料ごとに査読前か査読後か、具体的な数値・結論・限界、わかればライセンスを書く。4000〜6000字。',
    writeInstruction: `調査メモをもとに、本文3000〜5000字の解説記事を書く。1行目は「# 」で始まる見出し。事実には Sources の番号 [n] を付け、資料の査読前後を本文で示す。一つの事例から一般化しない。単一の事例に「実証した」と書かない。子どもの未来で締めるような定型の結びは書かない。${ARTICLE_NO_SELF_TALK_JA}最後に「## 本人の見解」の節を作り、本文は書かず ${ARTICLE_MATERIAL_MISSING_MARKER} とだけ書く。`,
  },
  // Dev: docs/promo/research/plan-v2.md and docs/promo/brand/claims-ledger.md.
  'dev-ja': {
    name: '開発記 記事下書き',
    label: '開発記（Zenn）',
    folder: 'Dev',
    cron: '20 6 * * *',
    cronLabel: '毎日 6:20',
    lang: 'ja',
    queue: true,
    intent: true,
    footer: ARTICLE_FOOTER_JA,
    quality: { minChars: 2500, minSources: 2 },
    prompt: [
      'Shelly（Android で動く AI ターミナル）の開発記シリーズ。媒体は Zenn、読者は開発者。日本語の技術記事として書く。',
      '共通ルール:',
      '- テーマはキューの項目のとおり。連載の順に縛られず、そのテーマだけで読める記事にする。',
      '- 要点と材料のコミットハッシュは、項目にあるものだけ使う。ないコミットや数字を作らない。項目の「要確認」は事実として書かない。',
      '- コミット数などの数字には取得日と対象ブランチを併記する。行数を見出しにしない。',
      '- 当時の話と今の話を混ぜない。当時の設計が今も残っていると書くなら、項目か調査メモに根拠が要る。',
      '- 位置づけは「コードは書かない。AI を率いて、実機で動くまで完了と呼ばない。」。開発は Galaxy Z Fold6 での設計・検証と、スマホと PC の AI コーディングエージェントによる実装で、実機検証は Fold6 の 1 台。',
      '- 作者の名前は初出だけ RYO ITABASHI、以降は「私」。Codex を「公式」と呼ばない。Shelly の宣伝はしない。',
    ].join('\n'),
    researchInstruction:
      'Webで検索し、項目のテーマひとつの背景を調べて調査メモを作る。別々の資料を3件以上使い、公式ドキュメント・仕様・一次資料を優先し、雑誌の目次ページより記事ページを選ぶ。資料ごとに具体的な数値・結論・限界と、分からないことを書く。項目の要点とコミットハッシュはメモの先頭にそのまま写す。4000〜6000字。',
    writeInstruction: `項目と調査メモをもとに、本文3000〜5000字の技術記事を書く。1行目は「# 」で始まる見出し。問題、原因、やったこと、結果の順に書き、コミットハッシュは短縮形のまま本文に出す。外部の事実には Sources の番号 [n] を付ける。「## 既知の限界」の節を作る。${ARTICLE_NO_SELF_TALK_JA}最後に「## 本人の見解」の節を作り、本文は書かず ${ARTICLE_MATERIAL_MISSING_MARKER} とだけ書く。`,
    reviewExtra: '当時と今の混同、項目にないコミットや数字、製品の宣伝も指摘する。',
  },
  'dev-en': {
    name: 'Dev log EN article draft',
    label: 'Dev log EN (dev.to)',
    folder: 'DevEn',
    cron: '40 6 * * *',
    cronLabel: '毎日 6:40',
    lang: 'en',
    queue: true,
    intent: true,
    footer: ARTICLE_FOOTER_EN,
    quality: { minWords: 1000, minSources: 2 },
    prompt: [
      'A dev log about Shelly, an AI terminal that runs on Android. It appears on dev.to for developers outside Japan. Write in plain, direct English.',
      'Rules for every step:',
      '- Rebuild the topic for an overseas reader. This is not a translation of a Japanese post: open with the problem they would recognize, and explain anything specific to Samsung, Knox or Japan.',
      '- Use only the commit hashes and points in the queue item. Invent no commits and no numbers. Anything the item marks as unconfirmed, in any language, is not a fact: do not state it as one.',
      '- Give any count with its date and branch. Never lead with line counts.',
      '- Keep then and now apart. Say the old design still exists only if the item or the research notes back it.',
      '- Position: "I don\'t write the code. I direct the AI — and nothing is called done until it works on real hardware." It was designed and verified on one Galaxy Z Fold6, and built with AI coding agents on the phone and a PC.',
      '- Use the name RYO ITABASHI once, then "I". Do not call Codex official.',
      '- No promotion in the body: no download or install pitch, no call to action. dev.to does not allow it.',
    ].join('\n'),
    researchInstruction:
      'Search the web for the background of the one topic in the queue item and write research notes from at least 3 separate sources. Prefer official documentation, specifications and primary sources, and article pages over journal index pages. For each source give concrete numbers, conclusions and limits, and what it does not establish. Copy the points and commit hashes of the item to the start of the notes unchanged. 4000 to 6000 characters.',
    writeInstruction: `Using the queue item and the research notes, write a technical post of 1200 to 2000 words. The first line is a heading starting with "# ". Go from problem to cause, fix and result, with commit hashes in short form. Mark outside facts with their Sources number [n]. Add a "## Known limits" section. ${ARTICLE_NO_SELF_TALK_EN} End with a "## My take" section holding only ${ARTICLE_MATERIAL_MISSING_MARKER}.`,
    reviewExtra: 'Flag a translated feel, then/now mix-ups, facts not in the item, and promotion.',
  },
  // Vintage: no listing links, no images, nothing that reads as an appraisal.
  'vintage-ja': {
    name: '古着 記事下書き',
    label: '古着（はてな）',
    folder: 'Vintage',
    cron: '0 7 * * *',
    cronLabel: '毎日 7:00',
    lang: 'ja',
    queue: true,
    intent: false,
    footer: `この記事は鑑定ではありません。特定の商品の真贋を鑑定・保証するものではありません。\n${ARTICLE_FOOTER_JA}`,
    extraLintTerms: ARTICLE_VINTAGE_LINT_TERMS,
    lintSources: true,
    quality: { minChars: 2500, minSources: 2 },
    reviewExtra: '真贋の断定、出品へのリンク、画像の指定、作品の絵柄の詳しい描写も指摘する。',
    prompt: [
      'ビンテージ古着の読み物シリーズ。媒体ははてなブログ、読者は映画Tやアニメ、古着が好きな人。日本語で書く。',
      '共通ルール:',
      '- 主役は服としての特徴と、作品や時代の背景。柄（著作物・商標）の説明は必要な範囲にとどめる。',
      '- 真贋を断定しない。ある品が本物だとも偽物だとも書かず、見るところを判断の材料として書く。',
      '- 出品へのリンクを貼らない。画像を使わない。写真の転載も、画像の指定も書かない。',
      '- 価格や相場は資料にあるものだけ書き、自分で確かめた値段のように書かない。',
      '- 海外の記事は全文を訳さず、自分の構成で書く。',
      '- 現物を見たように書かない。実物の確認は本人の仕事。',
    ].join('\n'),
    researchInstruction:
      'Webで検索し、項目のテーマひとつについて調査メモを作る。別々の資料を3件以上使い、作品の公開年や原作の背景、服の作りの見方を、資料ごとに分けて具体的な数値・結論・限界とともに書く。雑誌の目次ページより記事ページを選び、出品ページは資料にしない。4000〜6000字。',
    writeInstruction: `項目と調査メモをもとに、本文3000〜5000字の読み物を書く。1行目は「# 」で始まる見出し。事実には Sources の番号 [n] を付ける。真贋を断定せず、出品リンクも画像も入れない。${ARTICLE_NO_SELF_TALK_JA}最後に「## 本人の見解」の節を作り、本文は書かず ${ARTICLE_MATERIAL_MISSING_MARKER} とだけ書く。`,
  },
  'vintage-en': {
    name: 'Vintage EN article draft',
    label: 'Vintage EN (Substack)',
    folder: 'VintageEn',
    cron: '20 7 * * *',
    cronLabel: '毎日 7:20',
    lang: 'en',
    queue: true,
    intent: false,
    footer: `This is not an appraisal. Nothing here authenticates or guarantees any item.\n${ARTICLE_FOOTER_EN}`,
    extraLintTerms: ARTICLE_VINTAGE_LINT_TERMS,
    lintSources: true,
    quality: { minWords: 600, minSources: 2 },
    reviewExtra: 'Flag real-or-fake claims, listing links, images and detailed print descriptions.',
    prompt: [
      'A letter about vintage clothing in Japan, on Substack, for English readers who love film and anime tees. Write in plain English, from the point of view of someone in Japan. It is not a translation of a Japanese post.',
      'Rules for every step:',
      '- Lead with the garment and with the film, the era or the scene around it. Mention prints and logos only as far as the story needs.',
      '- Never say an item is authentic or fake. Describe what to look at, as things to weigh.',
      '- No links to listings. No images, no image suggestions.',
      '- Give prices only as the sources give them, never as prices you checked yourself.',
      '- Do not translate foreign articles whole. Use your own structure.',
      '- Do not write as if you had the item in hand. Checking the real thing is the owner\'s job.',
    ].join('\n'),
    researchInstruction:
      'Search the web for the one topic in the queue item and write research notes from at least 3 separate sources. Cover the release year or source material and how the garment is made, source by source, with concrete numbers, conclusions and limits. Prefer article pages over journal index pages, and do not use listing pages as sources. 4000 to 6000 characters.',
    writeInstruction: `Using the queue item and the research notes, write a letter of 800 to 1500 words. The first line is a heading starting with "# ". Mark facts with their Sources number [n]. Never say an item is authentic or fake, and add no listing links and no images. ${ARTICLE_NO_SELF_TALK_EN} End with a "## My take" section holding only ${ARTICLE_MATERIAL_MISSING_MARKER}.`,
  },
};

// Digest order and the streams it expects.
const ARTICLE_STREAM_ORDER: ArticleStream[] = ['ai-steam', 'dev-ja', 'dev-en', 'vintage-ja', 'vintage-en'];

// A function: agent-orchestration may still be loading when this module is.
const articleReviewInstruction = (cfg: ArticleStreamConfig): string => {
  const extra = cfg.reviewExtra ? `${cfg.lang === 'en' ? ' ' : ''}${cfg.reviewExtra}` : '';
  const body = cfg.lang === 'en'
    ? `The notes are the only evidence. Flag claims not in them, wrong numbers, overstatement, any [n] not pointing to the source, a journal index page as proof, and notes like "source unknown". Allow advice stating no fact, figure or cause.${extra} Ignore ${ARTICLE_MATERIAL_MISSING_MARKER}.`
    : `原文ページはあなたには見えないので、調査メモだけを根拠に下書きの主張を一つずつ照合する。調査メモにない主張、数値の違い、査読前後の取り違え、全文訳に近い箇所、言い切りすぎ、各 [n] がその主張を実際に載せている資料を指していないこと、雑誌の目次ページを根拠にしていること、「出典不明」のような注記を指摘する。事実・数値・因果を含まない助言には根拠を求めない。${extra}${ARTICLE_MATERIAL_MISSING_MARKER} は指摘しない。`
  return `${body}\n\n${REVIEW_OUTPUT_CONTRACT}`;
};
const articleReviseInstruction = (cfg: ArticleStreamConfig): string =>
  cfg.lang === 'en'
    ? `Apply every finding from the review and output only the full revised article, with no diff and no commentary. Keep the "# " title line. Delete a claim with no source; never add a note such as "source unknown". ${ARTICLE_NO_SELF_TALK_EN} Keep ${ARTICLE_MATERIAL_MISSING_MARKER} as it is.`
    : `査読の指摘をすべて反映し、修正後の記事全文だけを出力する。差分や説明は書かない。1行目の「# 」見出しは必ず残す。根拠のない主張は削り、「出典不明」のような注記は足さない。${ARTICLE_NO_SELF_TALK_JA}${ARTICLE_MATERIAL_MISSING_MARKER} はそのまま残す。`;

/**
 * One stream's daily draft agent:
 * [research, write, review1, revise1, review2, revise2, assemble], with
 * `queue-pop` first on a queued stream, run by the PlanSpec executor on the
 * cron (longform chain; Run now is refused). The chain ends in the draft
 * action: it saves to the vault and publishes nothing. autonomous:false keeps
 * the pinned HTTP engines and the local steps (an autonomous plan strips
 * Groq/Cerebras pins). The queue text only reaches the models as a carried
 * result: steps, engines, action and output path are all fixed here.
 */
export function buildArticlePipeline(stream: ArticleStream): PipelinePreset {
  const cfg = ARTICLE_STREAMS[stream];
  // `of` and `parts` count from the research step.
  const at = (k: number) => k + (cfg.queue ? 1 : 0);
  const review = articleReviewInstruction(cfg);
  const revise = articleReviseInstruction(cfg);
  const assemble: AgentLocalStepConfig = {
    kind: 'assemble',
    parts: [[at(1), at(3), at(5)]],
    stream,
    footer: cfg.footer,
    lintTerms: [...ARTICLE_LINT_TERMS, ...(cfg.extraLintTerms ?? [])],
    nameLint: ARTICLE_NAME_LINT,
    ...(cfg.lintSources ? { lintSources: true } : {}),
    quality: { ...cfg.quality, selfTalk: true },
  };
  const steps: AgentOrchestrationStep[] = [
    ...(cfg.queue
      ? [{ instruction: cfg.lang === 'en' ? 'Take the next topic from the queue (no model)' : 'キューから次のテーマを取る（モデルは使わない）', local: { kind: 'queue-pop' } as AgentLocalStepConfig }]
      : []),
    { instruction: cfg.researchInstruction, tool: stream === 'ai-steam' ? ARTICLE_ACADEMIC_RESEARCH_ENGINE : ARTICLE_RESEARCH_ENGINE, toolPinned: true },
    { instruction: cfg.writeInstruction, tool: ARTICLE_WRITER_ENGINE, toolPinned: true },
    { instruction: review, tool: ARTICLE_REVIEWER_ENGINE, toolPinned: true, handoff: { kind: 'review', of: [at(0), at(1)], round: 1 } },
    { instruction: revise, tool: ARTICLE_WRITER_ENGINE, toolPinned: true, handoff: { kind: 'revise', of: [at(1), at(2)], round: 1 } },
    { instruction: review, tool: ARTICLE_REVIEWER_ENGINE, toolPinned: true, handoff: { kind: 'review', of: [at(0), at(3)], round: 2 } },
    { instruction: revise, tool: ARTICLE_WRITER_ENGINE, toolPinned: true, handoff: { kind: 'revise', of: [at(3), at(4)], round: 2 } },
    { instruction: cfg.lang === 'en' ? 'Assemble the draft with frontmatter and Sources (no model)' : '記事を組み立てて、フロントマターと Sources を付ける（モデルは使わない）', local: assemble },
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

/**
 * The daily digest agent: [list-drafts, assemble], no model call anywhere. It
 * runs after the last stream has had time to finish: the vintage-en cron plus
 * the 30-minute chain budget, and a margin. It alone notifies on success (its
 * first lines are the notification). `tool` is required by an agent but is
 * never called; Gemini matches the streams, and a local tool would make native
 * start the local LLM for nothing.
 */
export function buildArticleDigestPipeline(): PipelinePreset {
  const listDrafts: AgentLocalStepConfig = {
    kind: 'list-drafts',
    streams: ARTICLE_STREAM_ORDER.map((stream) => {
      const cfg = ARTICLE_STREAMS[stream];
      return { folder: cfg.folder, label: cfg.label, ...(cfg.intent ? { intent: true } : {}) };
    }),
  };
  const save: AgentLocalStepConfig = {
    kind: 'assemble',
    parts: [[0]],
    stream: 'digest',
    footer: 'このノートは自動で作られます。投稿はしません。公開は本人が手で行います。',
    plain: true,
  };
  return {
    name: '記事ダイジェスト',
    prompt: '記事下書きの一覧',
    orchestration: {
      steps: [
        { instruction: 'きょうの下書きを一覧にする（モデルは使わない）', local: listDrafts },
        { instruction: '一覧をダイジェストとして保存する（モデルは使わない）', local: save },
      ],
      longform: true,
    },
    schedule: '0 8 * * *',
    scheduleLabel: '毎日 8:00',
    autonomous: false,
    tool: ARTICLE_RESEARCH_ENGINE,
    action: { type: 'draft' },
    output: { outputPath: `${ARTICLE_VAULT_DRAFTS}/${ARTICLE_DIGEST_FOLDER}/`, outputTemplate: '{date}-digest.md' },
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
