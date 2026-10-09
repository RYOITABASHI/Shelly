/**
 * lib/agent-sources.ts — sourced-briefing core for orchestrated agent chains.
 *
 * 2026-10-09 on-device incident (build 2498): a 3-step chain ("search the web
 * with Perplexity for the top 3 on-device AI news stories → summarize them
 * with the local LLM → write a markdown briefing", action=draft) saved a
 * briefing with ZERO URLs and fabricated headlines. Perplexity's sources
 * live in sidecar response fields (`citations` / `search_results`), never in
 * the text we carried between steps, and the 500/1500-char text carry plus a
 * contract-free prompt let the small local model invent the rest.
 *
 * This module is the deterministic layer that fixes it, shared by BOTH
 * executors (the attended TS chain in lib/agent-manager.ts and — as a
 * byte-for-byte-in-behaviour JS port, parity-tested — the unattended
 * scripts/shelly-plan-executor.js):
 *
 *   1. parseResearchSources(): structured sources from a Perplexity (sonar /
 *      sonar-pro / sonar-deep-research) or grounded-Gemini response.
 *   2. absorbResearchStep(): merges a research step's sources into the
 *      chain-wide evidence (deduped by URL, capped, renumbered) and parses its
 *      list items, remapping the step's own [n] markers onto chain ids.
 *   3. renderStepEvidence(): the research directive (today's date, recency,
 *      structured-list request) or the strict sourcing contract + numbered
 *      Sources block for summarize/write steps — carried SEPARATELY from the
 *      truncated text carry.
 *   4. postProcessSourcedOutput(): never trust the LLM — drop uncited /
 *      ungrounded / duplicate items, renumber citations, append a
 *      programmatic "## Sources" section, and fall back to a deterministic
 *      template built from the research items when nothing survives.
 *
 * Every function here is pure (no IO, `now` injected) for unit tests.
 */

export interface ResearchSource {
  /** 1-based, chain-wide citation number. */
  id: number;
  title: string;
  url: string;
  date?: string;
}

export interface ResearchItem {
  title: string;
  summary: string;
  /** Chain-wide source ids this item is backed by (>= 1). */
  sourceIds: number[];
  date?: string;
}

export interface ChainEvidence {
  sources: ResearchSource[];
  items: ResearchItem[];
  /** Lower-cased research text + source titles — the groundedness corpus. */
  corpus: string;
}

export type SearchRecency = 'day' | 'week' | 'month';

export type StepEvidence =
  | { mode: 'research'; today: string; recency?: SearchRecency; count?: number }
  | { mode: 'synthesis'; sources: ResearchSource[]; items: ResearchItem[]; count?: number };

export interface ParsedSources {
  sources: ResearchSource[];
  /** indexMap[n] = position (1-based) in `sources` that the response's own
   *  [n] marker refers to, or 0 when that marker's source was dropped. */
  indexMap: number[];
}

export const MAX_CHAIN_SOURCES = 10;
export const MAX_CHAIN_ITEMS = 10;
export const MAX_EVIDENCE_CHARS = 3000;
const MAX_URL_CHARS = 500;
const MAX_SOURCE_TITLE_CHARS = 160;
const MAX_ITEM_TITLE_CHARS = 140;
const MAX_ITEM_SUMMARY_CHARS = 300;
const MAX_CORPUS_CHARS = 40000;

export const RESEARCH_REQUIREMENTS_MARKER = '# Research requirements';
export const SOURCING_CONTRACT_MARKER = '# Sourcing contract';
export const NO_SOURCES_MESSAGE =
  'No verifiable sources: the research step returned no source URLs, so no briefing was written (unsourced content is never saved).';

/** Perplexity model used for a "top N / latest news" list when the user did
 *  not explicitly ask for deep research. sonar-pro is a single search-backed
 *  completion (seconds, not the 5+ minutes sonar-deep-research took on
 *  device) and returns the same citations/search_results sidecar. */
export const PERPLEXITY_LIST_MODEL = 'sonar-pro';
export const PERPLEXITY_DEEP_MODEL = 'sonar-deep-research';

// ── intent detection ────────────────────────────────────────────────────────

const WEB_FACTS_RE =
  /\b(?:news|latest|recent(?:ly)?|today'?s?|this week|breaking|headlines?|current events|top\s+(?:\d{1,2}|three|five|ten)|search the web|web search|trending|announcements?)\b|ニュース|最新|最近|今日の|本日の|今週|動向|速報|トレンド|調べ|検索|リサーチ|論文/i;

/** True when the chain's request depends on real-world, current facts — the
 *  only chains where an unsourced result must never be saved. Deliberately
 *  NOT triggered by a bare "research"/"look up" (e.g. "research angle A" over
 *  local notes): the cue must be news/recency/web-search shaped. */
export function requiresWebFacts(text: string): boolean {
  return WEB_FACTS_RE.test(String(text || ''));
}

const RESEARCH_VERB_RE =
  /\b(?:search|look\s+up|research|find|collect|gather|browse|google|fetch\s+(?:the\s+)?(?:latest|news))\b|検索|調べ|集め|収集|リサーチ|探し|探して/i;

/** A non-final step that performs the web research (so it gets the research
 *  directive and its response's sources are captured). */
export function isResearchStep(instruction: string, toolType: string | undefined): boolean {
  if (toolType === 'perplexity') return true;
  return RESEARCH_VERB_RE.test(String(instruction || ''));
}

const DAY_RE = /\btoday\b|\bpast 24 hours\b|\blast 24 hours\b|今日|本日/i;
const WEEK_RE = /\bthis week\b|\bpast week\b|\blast 7 days\b|\blast week\b|今週|この1週間|1週間/i;
const MONTH_RE =
  /\b(?:latest|recent(?:ly)?|news|breaking|headlines?|trending|this month|top\s+(?:\d{1,2}|three|five|ten))\b|最新|最近|ニュース|速報|動向|今月/i;

/** Perplexity `search_recency_filter` implied by the request, if any. */
export function detectRecency(text: string): SearchRecency | undefined {
  const s = String(text || '');
  if (DAY_RE.test(s)) return 'day';
  if (WEEK_RE.test(s)) return 'week';
  if (MONTH_RE.test(s)) return 'month';
  return undefined;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/** "top 3", "3 stories", "3件", "three news items" → 3 (1..10), else undefined. */
export function requestedItemCount(text: string): number | undefined {
  const s = String(text || '');
  const patterns = [
    /\btop\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b/i,
    /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:(?:[a-z-]+\s+){0,3})(?:news|stories|items|articles|papers|headlines|updates|links|topics)\b/i,
    /上位\s*(\d{1,2})/,
    /(\d{1,2})\s*(?:件|本|つ|個|選)/,
  ];
  for (const re of patterns) {
    const m = re.exec(s);
    if (!m) continue;
    const raw = m[1].toLowerCase();
    const n = /^\d+$/.test(raw) ? parseInt(raw, 10) : NUMBER_WORDS[raw];
    if (n && n >= 1 && n <= MAX_CHAIN_ITEMS) return n;
  }
  return undefined;
}

const DEEP_RESEARCH_RE =
  /deep[\s-]?research|in[\s-]depth|comprehensive|thorough(?:ly)?|exhaustive|徹底的に調|詳しく調|深掘り|ディープリサーチ|網羅的/i;

/** Pick the Perplexity model for a research step. sonar-deep-research is
 *  kept ONLY when the request explicitly asks for deep research (or names
 *  that model); a default-routed deep model is swapped for sonar-pro, which
 *  is faster/cheaper and plenty for a "top N news" list. Any other model
 *  (sonar, sonar-pro, a user pin) is returned unchanged. */
export function choosePerplexityModel(model: string | undefined, requestText: string): string {
  const current = String(model || '').trim() || 'sonar';
  if (current !== PERPLEXITY_DEEP_MODEL) return current;
  return DEEP_RESEARCH_RE.test(String(requestText || '')) ? PERPLEXITY_DEEP_MODEL : PERPLEXITY_LIST_MODEL;
}

/** A composed step prompt minus the research directive block — which itself
 *  says "Today's date is …" and must not be read back as a "today" recency
 *  cue (or any other intent) by detectRecency / choosePerplexityModel. */
export function withoutResearchDirective(prompt: string): string {
  const s = String(prompt || '');
  const start = s.indexOf(RESEARCH_REQUIREMENTS_MARKER);
  if (start === -1) return s;
  const end = s.indexOf('# This step', start);
  return s.slice(0, start) + (end === -1 ? '' : s.slice(end));
}

/** Local calendar date as YYYY-MM-DD. */
export function localIsoDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// ── source parsing ──────────────────────────────────────────────────────────

function cleanUrl(raw: unknown): string | null {
  let s = String(raw ?? '').trim();
  s = s.replace(/^<|>$/g, '');
  s = s.replace(/[)\].,;:!?'"」』）]+$/, '');
  if (!/^https?:\/\/[^\s/?#.][^\s]*$/i.test(s)) return null;
  if (s.length > MAX_URL_CHARS) return null;
  return s;
}

/** Dedupe key: scheme-less, lower-cased host, no fragment, no trailing slash. */
export function urlKey(url: string): string {
  const s = String(url || '').trim().replace(/#.*$/, '');
  const m = /^https?:\/\/([^/?#]+)(.*)$/i.exec(s);
  if (!m) return s.toLowerCase();
  const host = m[1].toLowerCase().replace(/^www\./, '');
  const rest = m[2].replace(/\/+$/, '').replace(/\/(?=\?)/, '');
  return `${host}${rest}`;
}

function hostOf(url: string): string {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url);
  return m ? m[1].toLowerCase().replace(/^www\./, '') : url;
}

function cleanTitle(raw: unknown, url: string): string {
  const s = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[[\]]/g, '')
    .replace(/\*\*/g, '')
    .trim()
    .slice(0, MAX_SOURCE_TITLE_CHARS)
    .trim();
  return s || hostOf(url);
}

function cleanDate(raw: unknown): string | undefined {
  const s = String(raw ?? '').trim();
  if (!s) return undefined;
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (iso) return iso[1];
  return s.slice(0, 32);
}

interface RawSourceEntry {
  url: unknown;
  title?: unknown;
  date?: unknown;
}

/**
 * Normalize raw entries (in citation order) into deduped, capped sources.
 * `primaryCount` = how many leading entries correspond to the response's own
 * [1]..[n] markers (indexMap is built for those).
 */
function normalizeEntries(entries: RawSourceEntry[], primaryCount: number): ParsedSources {
  const sources: ResearchSource[] = [];
  const byKey = new Map<string, number>();
  const indexMap: number[] = [0];
  entries.forEach((entry, idx) => {
    const url = cleanUrl(entry.url);
    let pos = 0;
    if (url) {
      const key = urlKey(url);
      const existing = byKey.get(key);
      if (existing) {
        pos = existing;
        const src = sources[existing - 1];
        if (!src.date && entry.date) src.date = cleanDate(entry.date);
        if (src.title === hostOf(src.url) && entry.title) src.title = cleanTitle(entry.title, src.url);
      } else if (sources.length < MAX_CHAIN_SOURCES) {
        const src: ResearchSource = { id: sources.length + 1, title: cleanTitle(entry.title, url), url };
        const date = cleanDate(entry.date);
        if (date) src.date = date;
        sources.push(src);
        byKey.set(key, src.id);
        pos = src.id;
      }
    }
    if (idx < primaryCount) indexMap.push(pos);
  });
  return { sources, indexMap };
}

/**
 * Structured sources from a model response (raw JSON text or parsed object).
 * Shape-driven, never tool-gated:
 *   - Perplexity: `citations` (string[] — the order the content's [n] markers
 *     index into) and/or `search_results` ([{title,url,date,last_updated}]).
 *     When both are present citations define the order and search_results
 *     enrich title/date by URL; extra search_results are appended. When only
 *     search_results is present it defines the order.
 *   - Gemini grounding: candidates[0].groundingMetadata.groundingChunks[].web.
 * Deduped by URL, http(s) only, capped at MAX_CHAIN_SOURCES.
 */
export function parseResearchSources(raw: unknown): ParsedSources {
  let data: any = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return { sources: [], indexMap: [0] };
    }
  }
  if (!data || typeof data !== 'object') return { sources: [], indexMap: [0] };
  const searchResults: any[] = Array.isArray(data.search_results) ? data.search_results : [];
  const citations: any[] = Array.isArray(data.citations) ? data.citations : [];
  const meta = new Map<string, any>();
  for (const sr of searchResults) {
    const url = cleanUrl(sr && sr.url);
    if (url && !meta.has(urlKey(url))) meta.set(urlKey(url), sr);
  }
  const entries: RawSourceEntry[] = [];
  let primaryCount = 0;
  if (citations.length) {
    for (const c of citations) {
      const url = typeof c === 'string' ? c : c && c.url;
      const cleaned = cleanUrl(url);
      const m = cleaned ? meta.get(urlKey(cleaned)) : undefined;
      entries.push({
        url,
        title: (m && m.title) || (c && typeof c === 'object' ? c.title : undefined),
        date: (m && (m.date || m.last_updated)) || (c && typeof c === 'object' ? c.date : undefined),
      });
    }
    primaryCount = entries.length;
    for (const sr of searchResults) entries.push({ url: sr && sr.url, title: sr && sr.title, date: sr && (sr.date || sr.last_updated) });
  } else if (searchResults.length) {
    for (const sr of searchResults) entries.push({ url: sr && sr.url, title: sr && sr.title, date: sr && (sr.date || sr.last_updated) });
    primaryCount = entries.length;
  }
  const candidate = Array.isArray(data.candidates) ? data.candidates[0] : null;
  const chunks = candidate && candidate.groundingMetadata && Array.isArray(candidate.groundingMetadata.groundingChunks)
    ? candidate.groundingMetadata.groundingChunks
    : [];
  for (const chunk of chunks) {
    const web = chunk && chunk.web;
    if (web) entries.push({ url: web.uri, title: web.title });
  }
  return normalizeEntries(entries, primaryCount);
}

const SOURCES_HEADING_RE =
  /^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:sources?|references?|citations?|links|参考(?:文献|資料|リンク)?|出典|引用元|ソース)(?:\*\*)?\s*[:：]?\s*(?:\*\*)?\s*$/i;

/**
 * Sources from a TEXT result (the attended bash path, whose extract_ai_content
 * appends a "## Sources\n[1] Title — url" block, plus inline markdown links /
 * bare URLs). Numbered lines inside a Sources section build indexMap; other
 * URLs are appended unmapped.
 */
export function extractSourcesFromText(text: string): ParsedSources {
  const lines = String(text || '').split(/\r?\n/);
  const numbered: Array<{ n: number; entry: RawSourceEntry }> = [];
  const loose: RawSourceEntry[] = [];
  let inSources = false;
  for (const line of lines) {
    if (SOURCES_HEADING_RE.test(line)) {
      inSources = true;
      continue;
    }
    if (/^\s*#{1,6}\s/.test(line)) inSources = false;
    const numberedMatch = inSources ? /^\s*(?:[-*]\s*)?\[?(\d{1,3})[\].)]\s*(.*)$/.exec(line) : null;
    if (numberedMatch) {
      const rest = numberedMatch[2];
      const link = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/.exec(rest);
      const bare = /(https?:\/\/[^\s<>()"'\]]+)/.exec(rest);
      const url = link ? link[2] : bare ? bare[1] : '';
      if (url) {
        let title: string = link ? link[1] : rest.replace(bare ? bare[1] : '', '');
        title = title
          .replace(/[—–-]\s*\d{4}-\d{2}-\d{2}\s*$/, '')
          .replace(/\(\d{4}-\d{2}-\d{2}\)/, '')
          .replace(/\s*[—–-]\s*$/, '')
          .replace(/^\s*[—–-]\s*/, '')
          .replace(/\(\s*\)/g, '')
          .trim();
        const dateM = /\((\d{4}-\d{2}-\d{2})\)|[—–-]\s*(\d{4}-\d{2}-\d{2})\s*$/.exec(rest);
        numbered.push({ n: parseInt(numberedMatch[1], 10), entry: { url, title, date: dateM ? dateM[1] || dateM[2] : undefined } });
        continue;
      }
    }
    const linkRe = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
    let m: RegExpExecArray | null;
    const consumed: string[] = [];
    while ((m = linkRe.exec(line))) {
      loose.push({ url: m[2], title: m[1] });
      consumed.push(m[2]);
    }
    const bareRe = /(https?:\/\/[^\s<>()"'\]]+)/g;
    while ((m = bareRe.exec(line))) {
      if (consumed.indexOf(m[1]) === -1) loose.push({ url: m[1] });
    }
  }
  numbered.sort((a, b) => a.n - b.n);
  const maxN = numbered.length ? numbered[numbered.length - 1].n : 0;
  const entries: RawSourceEntry[] = [];
  // Primary entries laid out by their own number so indexMap[n] lines up even
  // when a number is skipped.
  for (let n = 1; n <= maxN; n++) {
    const hit = numbered.find((x) => x.n === n);
    entries.push(hit ? hit.entry : { url: '' });
  }
  return normalizeEntries(entries.concat(loose), maxN);
}

// ── text helpers ────────────────────────────────────────────────────────────

/** Remove model reasoning blocks (sonar-deep-research / reasoning models). */
export function stripReasoning(text: string): string {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '').trim();
}

/** Remove a "Sources"/"References"/"参考" section (heading through the next
 *  heading or end of text). Our own Sources section is appended later. */
export function stripSourcesSection(text: string): string {
  const lines = String(text || '').split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (SOURCES_HEADING_RE.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && /^\s*#{1,6}\s/.test(line)) skipping = false;
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\s+$/, '');
}

const CITATION_GROUP_RE = /\[(\d{1,3}(?:\s*[,，、]\s*\d{1,3})*)\](?!\()/g;

/** Rewrite every [n] / [n, m] marker via `map` (0 = drop that number). */
export function remapCitations(text: string, map: (n: number) => number): string {
  return String(text || '').replace(CITATION_GROUP_RE, (_all, group: string) => {
    const seen: number[] = [];
    for (const part of group.split(/[,，、]/)) {
      const mapped = map(parseInt(part.trim(), 10));
      if (mapped > 0 && seen.indexOf(mapped) === -1) seen.push(mapped);
    }
    return seen.map((n) => `[${n}]`).join('');
  });
}

function citationIds(text: string): number[] {
  const ids: number[] = [];
  const re = new RegExp(CITATION_GROUP_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    for (const part of m[1].split(/[,，、]/)) {
      const n = parseInt(part.trim(), 10);
      if (n > 0 && ids.indexOf(n) === -1) ids.push(n);
    }
  }
  return ids;
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'its', 'has', 'have', 'are', 'was', 'were', 'will', 'that', 'this',
  'new', 'about', 'over', 'more', 'than', 'their', 'they', 'what', 'which', 'when', 'how', 'why', 'via', 'per',
  'news', 'story', 'stories', 'item', 'summary', 'source', 'sources', 'date', 'top', 'latest', 'brief', 'briefing',
]);

function stem(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** Significant tokens: latin words (>= 3 chars, stemmed, no stopwords) and
 *  CJK character bigrams. */
export function significantTokens(text: string): string[] {
  const s = String(text || '').toLowerCase();
  const out: string[] = [];
  const latin = s.match(/[a-z0-9][a-z0-9.+-]*[a-z0-9+]|[a-z0-9]/g) || [];
  for (const w of latin) {
    if (w.length < 3 || STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
    out.push(stem(w));
  }
  const cjkRuns = s.match(/[぀-ヿ㐀-鿿豈-﫿]+/g) || [];
  for (const run of cjkRuns) {
    if (run.length === 1) continue;
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  sa.forEach((t) => {
    if (sb.has(t)) inter += 1;
  });
  return inter / (sa.size + sb.size - inter);
}

/** Fraction of `title`'s significant tokens found in the corpus token set;
 *  1 when the title has fewer than 2 tokens (too short to judge). */
function groundedness(title: string, corpusTokens: Set<string>): number {
  const tokens = Array.from(new Set(significantTokens(title)));
  if (tokens.length < 2) return 1;
  let hit = 0;
  for (const t of tokens) if (corpusTokens.has(t)) hit += 1;
  return hit / tokens.length;
}

// ── markdown units ──────────────────────────────────────────────────────────

interface HeadingUnit {
  kind: 'heading';
  level: number;
  text: string;
  line: string;
}
interface BodyUnit {
  kind: 'item' | 'para';
  marker: 'list' | 'section' | 'para';
  indent: number;
  lines: string[];
}
type Unit = HeadingUnit | BodyUnit;

const LIST_MARKER_RE = /^(\s*)(?:[-*+•]|\d{1,3}[.)])\s+/;

function parseUnits(text: string): Unit[] {
  const units: Unit[] = [];
  let cur: BodyUnit | null = null;
  let blank = false;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^\s*$/.test(line)) {
      blank = true;
      if (cur && cur.kind === 'para') cur = null;
      continue;
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      units.push({ kind: 'heading', level: h[1].length, text: h[2], line: line.trim() });
      cur = null;
      blank = false;
      continue;
    }
    const lm = LIST_MARKER_RE.exec(line);
    const indent = (/^(\s*)/.exec(line) as RegExpExecArray)[1].length;
    if (lm) {
      if (cur && cur.marker === 'list' && indent > cur.indent) {
        cur.lines.push(line);
      } else {
        cur = { kind: 'item', marker: 'list', indent, lines: [line] };
        units.push(cur);
      }
      blank = false;
      continue;
    }
    if (cur && cur.marker === 'list' && (!blank || indent > 0)) {
      cur.lines.push(line);
    } else if (cur && cur.kind === 'para' && !blank) {
      cur.lines.push(line);
    } else {
      cur = { kind: 'para', marker: 'para', indent, lines: [line] };
      units.push(cur);
    }
    blank = false;
  }
  // A heading (other than the leading title) followed ONLY by paragraphs up to
  // the next heading is a "section item": "### Apple ships X\nBody [1]".
  const out: Unit[] = [];
  let seenTitle = false;
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (u.kind === 'heading') {
      const before = out.some((x) => x.kind !== 'heading');
      if (!seenTitle && !before && u.level <= 2) {
        seenTitle = true;
        out.push(u);
        continue;
      }
      seenTitle = true;
      let j = i + 1;
      const paras: BodyUnit[] = [];
      while (j < units.length && units[j].kind === 'para') {
        paras.push(units[j] as BodyUnit);
        j++;
      }
      const nextIsBoundary = j >= units.length || units[j].kind === 'heading';
      if (paras.length && nextIsBoundary) {
        out.push({ kind: 'item', marker: 'section', indent: 0, lines: [u.line, ...paras.flatMap((p) => p.lines)] });
        i = j - 1;
        continue;
      }
      out.push(u);
      continue;
    }
    out.push(u);
  }
  return out;
}

function stripListMarker(line: string): string {
  return line.replace(LIST_MARKER_RE, '').replace(/^\s*#{1,6}\s+/, '');
}

function unitTitle(unit: BodyUnit): string {
  const first = stripListMarker(unit.lines[0] || '').trim();
  const bold = /\*\*([^*]+)\*\*/.exec(first) || /__([^_]+)__/.exec(first);
  let title = '';
  if (bold) title = bold[1];
  else if (unit.marker === 'section') title = first;
  else {
    const link = /\[([^\]]+)\]\(https?:\/\/[^)]+\)/.exec(first);
    if (link && first.indexOf(link[0]) <= 2) title = link[1];
    else title = first.split(/\s+[—–]\s+|\s+-\s+|[:：]\s|。|\.\s/)[0];
  }
  return title
    .replace(CITATION_GROUP_RE, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\d{1,3}[.)]\s*/, '')
    .replace(/[*_`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ITEM_TITLE_CHARS);
}

function contentWithoutScaffolding(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\(https?:\/\/[^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(CITATION_GROUP_RE, '')
    .replace(/\b(?:sources?|references?|url|link|date|published)\s*[:：]/gi, '')
    .replace(/[-*+•#>_`|\[\]()]/g, ' ')
    .replace(/\d{1,3}[.)]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const DATE_IN_TEXT_RE =
  /\b(\d{4}-\d{2}-\d{2})\b|\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\b|(\d{4}年\d{1,2}月\d{1,2}日)/;

// ── research absorption ─────────────────────────────────────────────────────

export function createChainEvidence(): ChainEvidence {
  return { sources: [], items: [], corpus: '' };
}

/**
 * Fold one research step's result into the chain evidence (mutates and
 * returns `evidence`). `parsed` comes from parseResearchSources (unattended,
 * raw JSON) or extractSourcesFromText (attended, text); inline links in the
 * research text are always added as extra sources. Returns the step's
 * carried text: reasoning + Sources section stripped and its own [n] markers
 * remapped onto chain-wide ids.
 */
export function absorbResearchStep(evidence: ChainEvidence, rawText: string, parsed: ParsedSources): string {
  const text = stripReasoning(rawText);
  const inline = extractSourcesFromText(stripSourcesSection(text));
  const localToChain = new Map<number, number>();
  const addSource = (src: ResearchSource): number => {
    const key = urlKey(src.url);
    const existing = evidence.sources.find((s) => urlKey(s.url) === key);
    if (existing) {
      if (!existing.date && src.date) existing.date = src.date;
      return existing.id;
    }
    if (evidence.sources.length >= MAX_CHAIN_SOURCES) return 0;
    const added: ResearchSource = { id: evidence.sources.length + 1, title: src.title, url: src.url };
    if (src.date) added.date = src.date;
    evidence.sources.push(added);
    return added.id;
  };
  parsed.sources.forEach((src) => localToChain.set(src.id, addSource(src)));
  inline.sources.forEach((src) => addSource(src));
  const markerMap = (n: number): number => {
    const pos = parsed.indexMap[n];
    if (pos) return localToChain.get(pos) || 0;
    return 0;
  };
  const carried = remapCitations(stripSourcesSection(text), markerMap);

  // Research items: list items / sections with at least one chain source.
  const urlToId = new Map<string, number>();
  evidence.sources.forEach((s) => urlToId.set(urlKey(s.url), s.id));
  for (const unit of parseUnits(carried)) {
    if (unit.kind === 'heading') continue;
    if (evidence.items.length >= MAX_CHAIN_ITEMS) break;
    const body = unit.lines.join('\n');
    const ids = citationIds(body).filter((n) => evidence.sources.some((s) => s.id === n));
    const urlRe = /https?:\/\/[^\s<>()"'\]]+/g;
    let m: RegExpExecArray | null;
    while ((m = urlRe.exec(body))) {
      const cleaned = cleanUrl(m[0]);
      const id = cleaned ? urlToId.get(urlKey(cleaned)) : undefined;
      if (id && ids.indexOf(id) === -1) ids.push(id);
    }
    if (!ids.length) continue;
    const title = unitTitle(unit);
    if (!title || significantTokens(title).length === 0) continue;
    // A section item's first line IS its title (the heading) — skip it.
    // "Source: [Site](url)" lines are citation scaffolding, not summary text.
    const bodyLines = (unit.marker === 'section' ? unit.lines.slice(1) : unit.lines).filter(
      (l, idx) =>
        (idx === 0 && unit.marker !== 'section') ||
        !/^\s*(?:[-*+•]\s*)?(?:\*\*)?(?:sources?|urls?|links?|citations?)(?:\*\*)?\s*[:：]/i.test(l),
    );
    const rest = bodyLines
      .map((l, idx) =>
        idx === 0 && unit.marker !== 'section'
          ? stripListMarker(l).replace(/\*\*[^*]+\*\*/, '').replace(/^\d{1,3}[.)]\s*/, '')
          : stripListMarker(l),
      )
      .join(' ');
    let summary = rest
      .replace(/\[([^\]]*)\]\(https?:\/\/[^)]+\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(CITATION_GROUP_RE, '')
      .replace(/\b(?:summary|sources?|url|link|date|published(?:\s+on)?|headline|title)\s*[:：]\s*/gi, '')
      .replace(new RegExp(DATE_IN_TEXT_RE.source, 'g'), '')
      .replace(/\(\s*\)/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s+([.,;:。、])/g, '$1')
      .replace(/^[\s:：—–-]+/, '')
      .trim();
    if (summary.startsWith(title)) summary = summary.slice(title.length).replace(/^[\s:：—–.-]+/, '');
    summary = summary.slice(0, MAX_ITEM_SUMMARY_CHARS).trim();
    const dateM = DATE_IN_TEXT_RE.exec(body);
    const item: ResearchItem = { title, summary, sourceIds: ids };
    if (dateM) item.date = dateM[1] || dateM[2] || dateM[3];
    const tokens = significantTokens(title);
    if (evidence.items.some((it) => jaccard(significantTokens(it.title), tokens) >= 0.8)) continue;
    evidence.items.push(item);
  }
  evidence.corpus = `${evidence.corpus}\n${carried}\n${evidence.sources.map((s) => s.title).join('\n')}`
    .toLowerCase()
    .slice(-MAX_CORPUS_CHARS);
  return carried;
}

// ── prompt evidence block ───────────────────────────────────────────────────

function recencyPhrase(recency: SearchRecency | undefined): string {
  if (recency === 'day') return 'published in the last 24 hours';
  if (recency === 'week') return 'published in the last 7 days';
  if (recency === 'month') return 'published in the last 30 days';
  return '';
}

/**
 * The block inserted between the carried results and "# This step":
 *  - research: today's date, recency window, structured-list request;
 *  - synthesis: numbered Sources + verified research items + the strict
 *    sourcing contract (always last, always intact).
 * Bounded to MAX_EVIDENCE_CHARS by dropping whole lines, never the contract.
 */
export function renderStepEvidence(evidence: StepEvidence): string {
  if (evidence.mode === 'research') {
    const window = recencyPhrase(evidence.recency);
    const count = evidence.count ? `up to ${evidence.count}` : 'the most relevant';
    const lines = [
      RESEARCH_REQUIREMENTS_MARKER,
      `- Today's date is ${evidence.today}.${window ? ` Only include items ${window}.` : ''}`,
      `- Search the web now and return a numbered list of ${count} items. For each item give: the exact headline as published, a 1-2 sentence factual summary, the publication date (YYYY-MM-DD), and the source URL, with a citation marker [n].`,
      '- Only include items that appear in your search results. If you find fewer, return fewer. Never guess names, products, numbers, or dates.',
    ];
    return `${lines.join('\n')}\n\n`;
  }
  const contractLines = [
    SOURCING_CONTRACT_MARKER,
    '- Use ONLY facts stated in the results and research items above. Do not add anything from memory.',
    '- Every item must end with a citation like [1] that matches the numbered Sources list.',
    `- ${evidence.count ? `Output at most ${evidence.count} items. ` : ''}If there are fewer verified items than requested, output fewer. Never invent items.`,
    '- Copy names of companies, products, models, and people exactly as written in the research. Do not change numbers or dates.',
    '- Do not write a Sources or References section; it is added automatically.',
  ];
  const contract = `${contractLines.join('\n')}\n\n`;
  const budget = MAX_EVIDENCE_CHARS - contract.length;
  let body = '';
  const append = (line: string): boolean => {
    if (body.length + line.length + 1 > budget) return false;
    body += `${line}\n`;
    return true;
  };
  append('# Sources (cite as [n])');
  for (const s of evidence.sources) {
    if (!append(`[${s.id}] ${s.title} — ${s.url}${s.date ? ` (${s.date})` : ''}`)) break;
  }
  if (evidence.items.length) {
    if (append('') && append('# Verified research items')) {
      evidence.items.forEach((it, idx) => {
        const cites = it.sourceIds.map((n) => `[${n}]`).join('');
        const summary = it.summary ? ` — ${it.summary}` : '';
        append(`${idx + 1}. ${it.title}${it.date ? ` (${it.date})` : ''}${summary} ${cites}`.slice(0, 600));
      });
    }
  }
  return `${body}\n${contract}`;
}

// ── output post-processing ──────────────────────────────────────────────────

export interface PostProcessOptions {
  /** Cap on kept items (the user's "top N"). */
  maxItems?: number;
  /** Renumber citations 1..k and append "## Sources" (final output). */
  finalize: boolean;
  /** Title used by the deterministic fallback when the output had none. */
  fallbackTitle?: string;
  /** Disable the deterministic fallback (used internally). */
  noFallback?: boolean;
}

export interface PostProcessResult {
  text: string;
  keptItems: number;
  droppedItems: number;
  usedFallback: boolean;
}

function escapeLinkText(s: string): string {
  return s.replace(/[[\]]/g, '').trim();
}

function escapeLinkUrl(s: string): string {
  return s.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\s/g, '%20');
}

/** Deterministic briefing built ONLY from research items (or, failing that,
 *  the source titles themselves). Every line is cited by construction. */
export function buildFallbackBriefing(evidence: ChainEvidence, opts: { maxItems?: number; title?: string }): string {
  const max = opts.maxItems || MAX_CHAIN_ITEMS;
  const lines: string[] = [];
  const title = (opts.title || '# Briefing').trim();
  lines.push(/^#/.test(title) ? title : `# ${title}`);
  lines.push('');
  let n = 0;
  if (evidence.items.length) {
    for (const it of evidence.items) {
      if (n >= max) break;
      n += 1;
      const cites = it.sourceIds.map((id) => `[${id}]`).join('');
      const date = it.date ? ` (${it.date})` : '';
      const summary = it.summary ? ` — ${it.summary}` : '';
      lines.push(`${n}. **${it.title}**${date}${summary} ${cites}`);
    }
  } else {
    for (const s of evidence.sources) {
      if (n >= max) break;
      n += 1;
      lines.push(`${n}. **${s.title}**${s.date ? ` (${s.date})` : ''} [${s.id}]`);
    }
  }
  return lines.join('\n');
}

/**
 * Never trust the LLM: keep only items that (a) cite >= 1 real source,
 * (b) have a title grounded in the research text, (c) are not near-duplicates
 * of an earlier kept item, up to maxItems. Unknown URLs are stripped from kept
 * items. With `finalize`, citations are renumbered in order of first use and a
 * programmatic "## Sources" section is appended. When nothing survives, the
 * deterministic fallback briefing is used instead.
 */
export function postProcessSourcedOutput(
  text: string,
  evidence: ChainEvidence,
  opts: PostProcessOptions,
): PostProcessResult {
  const sources = evidence.sources;
  const validIds = new Set(sources.map((s) => s.id));
  const urlToId = new Map<string, number>();
  sources.forEach((s) => urlToId.set(urlKey(s.url), s.id));
  const corpusTokens = new Set(significantTokens(evidence.corpus));
  const units = parseUnits(stripSourcesSection(stripReasoning(text)));

  const keptBodies: Array<{ unit: BodyUnit; lines: string[]; ids: number[]; tokens: string[] } | null> = [];
  const keep: boolean[] = [];
  let kept = 0;
  let dropped = 0;
  const keptMeta: Array<{ ids: number[]; tokens: string[]; textTokens: string[] }> = [];
  for (const unit of units) {
    if (unit.kind === 'heading') {
      keptBodies.push(null);
      keep.push(false);
      continue;
    }
    // Strip unknown URLs; convert a known bare URL into its citation.
    const lines = unit.lines.map((line) =>
      line
        .replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (all, label: string, url: string) => {
          const id = urlToId.get(urlKey(cleanUrl(url) || url));
          return id ? `${all} [${id}]` : label;
        })
        .replace(/(^|[\s(<])(https?:\/\/[^\s<>()"'\]]+)/g, (all, lead: string, url: string) => {
          const cleaned = cleanUrl(url);
          const id = cleaned ? urlToId.get(urlKey(cleaned)) : undefined;
          return id ? `${lead}${url} [${id}]` : lead;
        }),
    );
    const body = lines.join('\n');
    const ids = citationIds(body).filter((n) => validIds.has(n));
    const title = unitTitle({ ...unit, lines });
    const content = contentWithoutScaffolding(body);
    const titleTokens = significantTokens(title);
    let ok = ids.length > 0 && significantTokens(content).length >= 2;
    if (ok && evidence.corpus && groundedness(title, corpusTokens) < 0.5) ok = false;
    if (ok) {
      const textTokens = significantTokens(content);
      const dup = keptMeta.some(
        (k) =>
          (k.ids.some((id) => ids.indexOf(id) !== -1) && jaccard(k.tokens, titleTokens) >= 0.5) ||
          jaccard(k.tokens, titleTokens) >= 0.8 ||
          jaccard(k.textTokens, textTokens) >= 0.8,
      );
      if (dup) ok = false;
      else if (opts.maxItems && kept >= opts.maxItems) ok = false;
      if (ok) keptMeta.push({ ids, tokens: titleTokens, textTokens });
    }
    keptBodies.push({ unit, lines, ids, tokens: titleTokens });
    keep.push(ok);
    if (ok) kept += 1;
    else dropped += 1;
  }

  if (kept === 0) {
    if (opts.noFallback || !sources.length) {
      return { text: '', keptItems: 0, droppedItems: dropped, usedFallback: false };
    }
    const firstHeading = units.find((u) => u.kind === 'heading' && u.level <= 2) as HeadingUnit | undefined;
    const fallbackText = buildFallbackBriefing(evidence, {
      maxItems: opts.maxItems,
      title: firstHeading ? firstHeading.line : opts.fallbackTitle,
    });
    const rerun = postProcessSourcedOutput(fallbackText, { ...evidence, corpus: '' }, { ...opts, noFallback: true });
    return { text: rerun.text, keptItems: rerun.keptItems, droppedItems: dropped, usedFallback: true };
  }

  // Keep a heading when it is the leading title, or when a kept item follows
  // it before the next heading of the same or higher level.
  const keepHeading: boolean[] = units.map(() => false);
  units.forEach((u, idx) => {
    if (u.kind !== 'heading') return;
    if (idx === 0) {
      keepHeading[idx] = true;
      return;
    }
    for (let j = idx + 1; j < units.length; j++) {
      const v = units[j];
      if (v.kind === 'heading') {
        if (v.level <= u.level) break;
        continue;
      }
      if (keep[j]) {
        keepHeading[idx] = true;
        break;
      }
    }
  });

  // Renumber in order of first use.
  const order: number[] = [];
  if (opts.finalize) {
    units.forEach((_u, idx) => {
      const kb = keptBodies[idx];
      if (!kb || !keep[idx]) return;
      for (const id of citationIds(kb.lines.join('\n'))) {
        if (validIds.has(id) && order.indexOf(id) === -1) order.push(id);
      }
    });
  }
  const renumber = (n: number): number => {
    if (!validIds.has(n)) return 0;
    if (!opts.finalize) return n;
    return order.indexOf(n) + 1;
  };

  const blocks: string[] = [];
  let prevWasList = false;
  let listCounter = 0;
  units.forEach((u, idx) => {
    if (u.kind === 'heading') {
      if (keepHeading[idx]) {
        blocks.push(`\n${u.line}`);
        prevWasList = false;
        listCounter = 0;
      }
      return;
    }
    if (!keep[idx]) return;
    const kb = keptBodies[idx] as { lines: string[] };
    let lines = kb.lines.map((l) => remapCitations(l, renumber));
    if (u.marker === 'list' && /^\s*\d{1,3}[.)]/.test(lines[0])) {
      listCounter = prevWasList ? listCounter + 1 : 1;
      lines = [lines[0].replace(/^(\s*)\d{1,3}([.)])/, `$1${listCounter}$2`), ...lines.slice(1)];
    }
    const blockText = lines.join('\n').replace(/[ \t]+$/gm, '');
    if (u.marker === 'list' && prevWasList) blocks.push(blockText);
    else blocks.push(`\n${blockText}`);
    prevWasList = u.marker === 'list';
  });
  let out = blocks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (opts.finalize) {
    const lines = order.map((oldId, i) => {
      const s = sources.find((x) => x.id === oldId) as ResearchSource;
      return `- [${i + 1}] [${escapeLinkText(s.title) || hostOf(s.url)}](${escapeLinkUrl(s.url)})${s.date ? ` — ${s.date}` : ''}`;
    });
    out = `${out}\n\n## Sources\n\n${lines.join('\n')}\n`;
  }
  return { text: out, keptItems: kept, droppedItems: dropped, usedFallback: false };
}

/** Intermediate summarize step: keep the model's cited items (numbering
 *  unchanged — it is chain-wide), or replace an uncited answer with the
 *  deterministic research-item template so the next step still gets facts. */
export function enforceSourcedIntermediate(text: string, evidence: ChainEvidence, maxItems?: number): string {
  return postProcessSourcedOutput(text, evidence, { finalize: false, maxItems }).text;
}
