/**
 * lib/x-articles.ts — pure, host-testable helpers for X (Twitter) Articles
 * (long-form posts), the sibling of lib/x-oauth.ts.
 *
 * Same design contract as lib/x-oauth.ts: NO device-only imports, NO fetch, NO
 * expo-* modules, NO Date.now()/Math.random(). Everything here is a pure
 * function of its arguments so it can be fully verified in Jest on the host
 * (see __tests__/x-articles.test.ts). The caller (lib/agent-executor.ts's
 * dispatch_social_post) owns the actual HTTP request, the bearer token, and the
 * approval gate.
 *
 * Endpoints (docs.x.com/x-api/articles):
 *   POST https://api.x.com/2/articles/draft            -> { title, content_state }
 *   POST https://api.x.com/2/articles/{id}/publish
 *
 * SCOPE / KNOWN UNKNOWNS: X documents content_state only as "an object
 * containing blocks (text elements with types like unstyled) and entities" —
 * i.e. a DraftJS ContentState raw object. The full schema is effectively
 * undocumented, so this module deliberately emits the smallest DraftJS shape
 * that DraftJS's own convertFromRaw accepts:
 *   - block types: unstyled / header-one / header-two /
 *     unordered-list-item / ordered-list-item
 *   - entities: LINK only (the whole point of an Article for this app is that
 *     it carries its source URLs)
 *   - inlineStyleRanges: always empty — bold/italic/code markdown is NOT
 *     converted (out of scope; the markers are left as literal text).
 */

export interface DraftJsBlock {
  key: string;
  text: string;
  type: 'unstyled' | 'header-one' | 'header-two' | 'unordered-list-item' | 'ordered-list-item';
  depth: number;
  inlineStyleRanges: Array<{ offset: number; length: number; style: string }>;
  entityRanges: Array<{ offset: number; length: number; key: number }>;
  data: Record<string, unknown>;
}

export interface DraftJsEntity {
  type: 'LINK';
  mutability: 'MUTABLE';
  data: { url: string };
}

export interface DraftJsContentState {
  blocks: DraftJsBlock[];
  entityMap: Record<string, DraftJsEntity>;
}

export const X_ARTICLES_DRAFT_URL = 'https://api.x.com/2/articles/draft';

export function xArticlesPublishUrl(articleId: string): string {
  return `https://api.x.com/2/articles/${encodeURIComponent(articleId)}/publish`;
}

/** X does not document the Article title limit; clamp defensively so an
 *  over-long generated title can never be the reason a draft 400s. */
export const X_ARTICLE_TITLE_MAX = 100;

/** Loose-but-sufficient URL detection (same precision tier as the agent
 *  result-preview link scraping): scheme + non-whitespace run. Trailing
 *  sentence punctuation is trimmed back off the match below. */
const URL_RE = /https?:\/\/[^\s]+/g;

/** Characters that are almost never meaningful at the END of a pasted URL —
 *  stripped so "see https://x.com/a." does not link the trailing period.
 *  Includes the JP full-width stops that show up in Japanese article bodies. */
const URL_TRAILING_TRIM_RE = /[.,;:!?)\]}'"”』」）、。]+$/;

type BlockType = DraftJsBlock['type'];

interface PendingBlock {
  text: string;
  type: BlockType;
}

/** Classifies ONE line of markdown-ish source. Returns null when the line is
 *  ordinary prose (which then gets soft-wrapped into the surrounding
 *  paragraph). Only structural markers are understood — see SCOPE above. */
function classifyLine(line: string): PendingBlock | null {
  const headerTwo = /^##\s+(.*)$/.exec(line);
  if (headerTwo) return { text: headerTwo[1].trim(), type: 'header-two' };

  const headerOne = /^#\s+(.*)$/.exec(line);
  if (headerOne) return { text: headerOne[1].trim(), type: 'header-one' };

  const unordered = /^[-*+]\s+(.*)$/.exec(line);
  if (unordered) return { text: unordered[1].trim(), type: 'unordered-list-item' };

  const ordered = /^\d+[.)]\s+(.*)$/.exec(line);
  if (ordered) return { text: ordered[1].trim(), type: 'ordered-list-item' };

  return null;
}

/**
 * Converts plain text / light markdown into a DraftJS content_state.
 *
 * Rules:
 *  - Blank lines separate paragraphs.
 *  - Inside a paragraph, a structural line (#, ##, -/*, 1.) becomes its own
 *    block; consecutive prose lines are joined with a single space into one
 *    `unstyled` block (soft wraps are not preserved).
 *  - Every https?:// run in a block becomes a LINK entity (entityRanges on the
 *    block + an entry in entityMap).
 *  - Block keys are deterministic (`block-0`, `block-1`, …) and entity keys are
 *    a deterministic 0-based counter — no Date.now()/Math.random(), so the same
 *    input always yields a byte-identical result.
 *  - Empty / whitespace-only input yields exactly one empty `unstyled` block
 *    (never an empty blocks array, which DraftJS rejects).
 */
export function textToDraftJsContentState(text: string): DraftJsContentState {
  const normalized = (text ?? '').replace(/\r\n?/g, '\n');
  const pending: PendingBlock[] = [];

  for (const paragraph of normalized.split(/\n[ \t]*\n+/)) {
    let prose: string[] = [];
    const flushProse = () => {
      if (prose.length === 0) return;
      const joined = prose.join(' ').trim();
      if (joined) pending.push({ text: joined, type: 'unstyled' });
      prose = [];
    };

    for (const rawLine of paragraph.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const structural = classifyLine(line);
      if (structural) {
        flushProse();
        pending.push(structural);
      } else {
        prose.push(line);
      }
    }
    flushProse();
  }

  if (pending.length === 0) pending.push({ text: '', type: 'unstyled' });

  const entityMap: Record<string, DraftJsEntity> = {};
  let nextEntityKey = 0;

  const blocks: DraftJsBlock[] = pending.map((block, index) => {
    const entityRanges: DraftJsBlock['entityRanges'] = [];
    // Fresh regex state per block: URL_RE is /g, so lastIndex must not leak.
    URL_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = URL_RE.exec(block.text)) !== null) {
      const trimmed = match[0].replace(URL_TRAILING_TRIM_RE, '');
      if (!trimmed) continue;
      const key = nextEntityKey++;
      entityMap[String(key)] = { type: 'LINK', mutability: 'MUTABLE', data: { url: trimmed } };
      entityRanges.push({ offset: match.index, length: trimmed.length, key });
    }

    return {
      key: `block-${index}`,
      text: block.text,
      type: block.type,
      depth: 0,
      inlineStyleRanges: [],
      entityRanges,
      data: {},
    };
  });

  return { blocks, entityMap };
}

export interface BuildArticleDraftBodyParams {
  title: string;
  contentState: DraftJsContentState;
}

/** JSON string for the POST /2/articles/draft body. Returned as a string (not
 *  an object) so the caller can hand it straight to fetch's `body`. */
export function buildArticleDraftBody(params: BuildArticleDraftBodyParams): string {
  const title = (params.title ?? '').trim().slice(0, X_ARTICLE_TITLE_MAX);
  return JSON.stringify({ title, content_state: params.contentState });
}

export interface ArticleDraftResponse {
  articleId: string;
}

const ARTICLE_ID_KEYS = ['id', 'article_id', 'articleId'] as const;

function pickArticleId(source: unknown): string | null {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const obj = source as Record<string, unknown>;
  for (const key of ARTICLE_ID_KEYS) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    // X returns snowflake ids as strings, but a permissive JSON encoder
    // somewhere in the chain could hand back a number — accept it rather than
    // silently failing the publish step.
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

/** Defensive parse of the draft-creation response. The exact envelope is not
 *  fully documented, so both `{ "data": { "id": … } }` and a bare
 *  `{ "id": … }` (plus article_id/articleId spellings) are accepted. Anything
 *  else returns null — fail-closed, same convention as
 *  lib/x-oauth.ts's parseTokenResponse. */
export function parseArticleDraftResponse(raw: string): ArticleDraftResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const fromData = pickArticleId((parsed as Record<string, unknown>).data);
  const articleId = fromData ?? pickArticleId(parsed);
  return articleId ? { articleId } : null;
}
