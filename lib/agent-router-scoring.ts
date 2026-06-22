/**
 * lib/agent-router-scoring.ts — Phase 2b Layer-2 scoring router.
 *
 * The hard guards (secret-guard, manual pin, autonomous policy) decide first and
 * ALWAYS win — this module is only consulted for `tool.type === 'auto'` agents,
 * AFTER those guards, to pick among candidate tools. It is deterministic and
 * fully OFFLINE: routing never makes a network call to decide whether to use the
 * network. Default bias is on-device-first — simple/short tasks stay local; only
 * genuinely heavy-reasoning / search / code tasks earn a cloud route, so this
 * never widens cloud usage beyond what the task needs.
 *
 * Pure + IO-free for unit tests.
 */
import type { ToolChoice } from '@/store/types';

export type TaskCategory = 'code' | 'research' | 'prose' | 'transform' | 'general';

export interface RouteSignals {
  category: TaskCategory;
  /** 0–1: how much heavy reasoning the task implies (length + complexity markers). */
  reasoningWeight: number;
  /** true when the task needs fresh/web/cited information. */
  needsSearch: boolean;
  /** the keyword that drove the category, if any (for the reason log). */
  keyword?: string;
}

export interface RouteCandidate {
  toolType: ToolChoice['type'];
  score: number;
}

export interface ScoredRoute {
  tool: ToolChoice;
  toolLabel: string;
  why: string;
  /** 'keyword' when a category keyword decided it, else 'scorer'. */
  guard: 'keyword' | 'scorer';
  keyword?: string;
  /** 0–1, from the gap between the top two candidates. */
  confidence: number;
  candidates: RouteCandidate[];
}

// Category keyword sets (kept local so the scorer is self-contained; suggestTool
// keeps its own copy for the legacy keyword path and other callers).
const CODE_KW = ['pr', 'pull request', 'issue', 'commit', 'repo', 'repository', 'code review', 'github', 'merge', 'コード', 'リポジトリ', 'バグ', 'デプロイ'];
// Genuine research only — NOT bare "news/latest" (those are a weak freshness
// signal via needsSearch, handled below). "summarize the news" must stay a
// transform task → on-device, not get routed to the paid deep-research backend.
const RESEARCH_KW = ['paper', 'research', 'study', 'evidence', 'journal', 'academic', 'cite', 'citation', '論文', '研究', '学術', '調べ', '出典', '引用', '文献'];
const PROSE_KW = ['article', 'essay', 'blog', 'draft', 'write', 'content', 'story', '記事', '下書き', 'ブログ', '執筆', '物語'];
const TRANSFORM_KW = ['summarize', 'summary', 'format', 'translate', 'rewrite', 'extract', '要約', 'まとめ', '整形', '翻訳', '書き直', '抽出', '箇条書き'];
const REASONING_KW = ['analyze', 'compare', 'evaluate', 'plan', 'design', 'reason', 'deep', 'why', 'strategy', '分析', '比較', '評価', '設計', '計画', '推論', '戦略', '考察', '精査'];

// Per-tool capability profile (static, hand-tuned). Scores are 0–1.
interface ToolProfile {
  tool: ToolChoice;
  affinity: Record<TaskCategory, number>;
  reasoning: number;
  search: number;
  /** on-device gets a standing bonus (free + private + low latency). */
  onDeviceBonus: number;
}

const TOOL_PROFILES: ToolProfile[] = [
  {
    tool: { type: 'local', model: 'Qwen3.5-0.8B-Q4_K_M' },
    affinity: { code: 0.25, research: 0.1, prose: 0.6, transform: 0.85, general: 0.55 },
    reasoning: 0.45,
    search: 0.05,
    // Standing bonus so simple/ambiguous tasks stay on-device (free + private),
    // but small enough that a genuinely heavy-reasoning task flips to cloud.
    onDeviceBonus: 0.12,
  },
  {
    tool: { type: 'cli', cli: 'codex' },
    affinity: { code: 0.95, research: 0.15, prose: 0.35, transform: 0.4, general: 0.4 },
    reasoning: 0.9,
    search: 0.15,
    onDeviceBonus: 0,
  },
  {
    tool: { type: 'perplexity', model: 'sonar-deep-research' },
    affinity: { code: 0.2, research: 0.95, prose: 0.5, transform: 0.3, general: 0.35 },
    reasoning: 0.9,
    search: 0.95,
    onDeviceBonus: 0,
  },
  {
    tool: { type: 'gemini-api' },
    affinity: { code: 0.7, research: 0.5, prose: 0.7, transform: 0.6, general: 0.6 },
    reasoning: 0.85,
    search: 0.4,
    onDeviceBonus: 0,
  },
];

/**
 * Match a keyword against the (lowercased) text. Latin/ASCII keywords match on a
 * WORD BOUNDARY so a short token like "pr" doesn't fire on "previous"/"approve"
 * (this bit orchestration's "# Results from previous steps" scaffolding). CJK
 * keywords have no word boundaries, so they match as a substring.
 */
function matchesKeyword(lower: string, kw: string): boolean {
  if (/[぀-ヿ一-鿿]/.test(kw)) return lower.includes(kw);
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(lower);
}

function hasAny(lower: string, kws: string[]): string | undefined {
  return kws.find((kw) => matchesKeyword(lower, kw));
}

/** Detect task signals deterministically from the prompt (offline). */
export function detectRouteSignals(prompt: string): RouteSignals {
  const lower = prompt.toLowerCase();
  const codeKw = hasAny(lower, CODE_KW);
  const researchKw = hasAny(lower, RESEARCH_KW);
  const proseKw = hasAny(lower, PROSE_KW);
  const transformKw = hasAny(lower, TRANSFORM_KW);

  // Priority mirrors the legacy keyword tiers: code > research > prose > transform.
  let category: TaskCategory = 'general';
  let keyword: string | undefined;
  if (codeKw) {
    category = 'code';
    keyword = codeKw;
  } else if (researchKw) {
    category = 'research';
    keyword = researchKw;
  } else if (proseKw) {
    category = 'prose';
    keyword = proseKw;
  } else if (transformKw) {
    category = 'transform';
    keyword = transformKw;
  }

  // Count distinct complexity markers (a single "analyze this" is light; several
  // markers — analyze + compare + strategy + plan — is clearly heavy reasoning),
  // plus length as a cheap proxy. One marker keeps a task on-device; a stack of
  // them flips a general task to cloud.
  const markerCount = REASONING_KW.filter((kw) => lower.includes(kw)).length;
  const lengthWeight = Math.min(prompt.length / 1500, 0.5);
  const reasoningWeight = Math.min(1, lengthWeight + markerCount * 0.3);
  const needsSearch = category === 'research' || /\b(latest|today|current|news)\b/.test(lower) || /最新|今日|現在|速報|ニュース/.test(prompt);

  return { category, reasoningWeight, needsSearch, keyword };
}

function scoreTool(profile: ToolProfile, signals: RouteSignals): number {
  const affinity = profile.affinity[signals.category];
  // A freshness word in an otherwise general task ("今日の天気") is a WEAK search
  // signal — don't let it push a trivial question to the expensive deep-research
  // backend. Only a genuine 'research' task earns the full search weight.
  const searchWeight = signals.needsSearch ? (signals.category === 'research' ? 1 : 0.4) : 0;
  // Weighted blend: category affinity dominates, reasoning + search modulate,
  // and on-device gets a standing bonus so ties go local (on-device-first).
  return (
    affinity * 0.5 +
    profile.reasoning * signals.reasoningWeight * 0.3 +
    profile.search * searchWeight * 0.25 +
    profile.onDeviceBonus
  );
}

const LABELS: Record<ToolChoice['type'], string> = {
  local: 'Local LLM',
  cli: 'Codex CLI',
  perplexity: 'Perplexity API',
  'gemini-api': 'Gemini API',
  cerebras: 'Cerebras',
  groq: 'Groq',
  'ab-article-eval': 'A/B Article Eval',
  auto: 'Auto',
};

/**
 * Score the candidate tools for a task and return the winner with a reason,
 * confidence (top-two gap), and the full candidate score list for the audit log.
 * Deterministic + offline.
 */
export function scoreRoutes(prompt: string): ScoredRoute {
  const signals = detectRouteSignals(prompt);
  const scored = TOOL_PROFILES.map((p) => ({ profile: p, score: scoreTool(p, signals) }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  const second = scored[1];
  const gap = top.score - (second?.score ?? 0);
  // Confidence from the separation between #1 and #2 (clamped, lightly scaled).
  const confidence = Math.max(0, Math.min(1, 0.5 + gap * 1.5));

  const candidates: RouteCandidate[] = scored.map((s) => ({
    toolType: s.profile.tool.type,
    score: Math.round(s.score * 100) / 100,
  }));

  // A category keyword that selected a NON-general category is a strong, legible
  // signal — surface it as the keyword guard; otherwise the scorer drove it.
  const keywordDrove = signals.category !== 'general' && signals.keyword;
  const why = keywordDrove
    ? `Layer-2 scorer: '${signals.category}' task (matched "${signals.keyword}") → ${LABELS[top.profile.tool.type]}; ${Math.round(confidence * 100)}% confidence over ${candidates.length} candidates.`
    : `Layer-2 scorer: general task (reasoning ${Math.round(signals.reasoningWeight * 100)}%${signals.needsSearch ? ', needs search' : ''}) → ${LABELS[top.profile.tool.type]}; ${Math.round(confidence * 100)}% confidence, on-device-first.`;

  return {
    tool: top.profile.tool,
    toolLabel: LABELS[top.profile.tool.type],
    why,
    guard: keywordDrove ? 'keyword' : 'scorer',
    keyword: keywordDrove ? signals.keyword : undefined,
    confidence,
    candidates,
  };
}
