/**
 * lib/agent-global-memory-intent.ts — pure detector for "remember this for
 * EVERY agent" (user-scope / `_global`) memory writes.
 *
 * ─── Why this is deliberately hard to trigger ────────────────────────────────
 *
 * A per-agent memory note that turns out to be wrong pollutes exactly one
 * agent's prompt. A `_global` note (lib/agent-memory.ts's GLOBAL_MEMORY_SCOPE)
 * is merged into the recall pool of EVERY agent — a wrong one degrades the
 * whole product at once, silently, on every future run. So the bar for a
 * global write is set far above the bar for an ordinary note, and it is set in
 * THREE independent places:
 *
 *   1. (here) Two required markers. The utterance must contain BOTH a
 *      memory-write marker (reused verbatim from lib/agent-nl-parser.ts's
 *      detectMemory — same negation handling as the per-agent path) AND an
 *      explicit ALL-AGENTS scope marker. Either one alone is not enough, so
 *      an ordinary "覚えておいて" note and an ordinary "全エージェントを止めて"
 *      command both fall through to their normal handlers untouched.
 *   2. (here) A non-trivial payload. After the scope phrasing is stripped out,
 *      what is left must be real content — not empty, not a bare demonstrative
 *      ("これ" / "this"), and not shorter than MIN_GLOBAL_NOTE_CHARS.
 *   3. (hooks/use-ai-pane-dispatch.ts) A mandatory human confirm turn. A hit
 *      here NEVER writes anything: it only posts a plain-language confirm
 *      question, and only an exact confirm phrase (lib/agent-confirm-phrase.ts,
 *      whole-message match) commits the write. This is not gated by
 *      `agentRegistrationRequireConfirm` — a global write is always confirmed,
 *      whatever the user's per-agent auto-registration preference is.
 *
 * The asymmetry is intentional: a FALSE NEGATIVE here costs the user one
 * rephrase ("全エージェントで覚えておいて" instead of "みんなで覚えておいて"),
 * while a FALSE POSITIVE costs every agent, every run, until someone notices.
 * When in doubt this module returns null.
 *
 * Pure and IO-free — no store, no filesystem, no i18n — so the whole
 * confidence bar is unit-testable offline.
 */
import { detectMemory } from '@/lib/agent-nl-parser';

/**
 * A question is never a write request ("do you remember what color I
 * picked?" must fall through to the normal chat handler, not be read as
 * "please remember what color I picked"). A trailing "?"/"？" alone misses
 * the common case of a casually-typed or voice-transcribed question with no
 * terminal punctuation at all — 2026-08-25 on-device finding: "do you
 * remember what color I decided to repaint my kitchen" (no "?") tripped
 * detectCompanionMemoryWrite's memory-write path purely because it contains
 * the word "remember". A leading question auxiliary/wh-word is a second,
 * independent signal that catches exactly that case. Per this module's own
 * asymmetry (false negatives are cheap, false positives are not): a benign
 * imperative that happens to start the same way ("Do remember to lock the
 * door") is an intentionally acceptable false negative here, same as an
 * unpunctuated question was already an accepted false negative for the
 * memory GATE itself before this fix — this only widens which inputs land
 * on the safe side of that same asymmetry.
 */
const QUESTION_LEAD_RE = /^(?:do|does|did|is|are|was|were|can|could|would|will|should|have|has|had)\b|^(?:what|who|whom|whose|which|when|where|why|how)\b/i;

function looksLikeQuestion(text: string): boolean {
  return /[?？]\s*$/.test(text) || QUESTION_LEAD_RE.test(text);
}

export interface GlobalMemoryWriteIntent {
  /** The fact/preference to store, with the scope phrasing stripped out. */
  text: string;
  /**
   * Always `preference`. A user-scope note is by definition a STANDING
   * instruction rather than an observation from one run, and that is exactly
   * how lib/agent-memory.ts's buildGlobalRecallContext labels the block it
   * renders ("Standing user preferences and facts"). Keeping the type fixed
   * also keeps the note id (a hash of agentId+type+text) stable, so
   * re-stating the same preference overwrites the same file instead of
   * accumulating near-duplicates across every agent's recall.
   */
  type: 'preference';
}

/**
 * Explicit "this applies to all of my agents" markers.
 *
 * Two rules keep these tight:
 *
 *  - The bare word "global"/"グローバル" is NOT a marker on its own.
 *    "remember to update the global config before deploying" would otherwise
 *    be read as a request to broadcast a note to every agent.
 *  - The scope phrase must read ADVERBIALLY — "for all agents", "全エージェント
 *    で" — not as the subject/object of the sentence. Without that,
 *    "remember that every agent needs a schedule" (a musing ABOUT agents) and
 *    「全エージェントの設定を覚えておいて」 (a note about their settings) would
 *    both trip the global path. Hence the required preposition / colon on the
 *    EN side and the required adverbial particle (で・に・には・は・でも・にも,
 *    never が・を・の) on the JP side.
 */
const GLOBAL_SCOPE_PATTERNS: RegExp[] = [
  // JP — 全/すべて/全部 + エージェント (+ optional 共通) + adverbial particle
  /(?:全|全て|すべて|ぜんぶ|全部)の?エージェント(?:共通)?(?:では|には|でも|にも|で|に|は)/,
  // JP — エージェント + 全員/全部/共通 + adverbial particle
  /エージェント(?:全員|全部|すべて|全て|共通)(?:では|には|でも|にも|で|に|は)/,
  // JP — どのエージェントでも / どのエージェントにも
  /どのエージェント(?:でも|にも)/,
  // JP — 共通の記憶 / 共通メモ (explicitly shared memory, no agent word needed)
  /共通の?(?:記憶|メモリ|メモ)/,
  // EN — for/across/to/in/with + all (my|the) agents
  /\b(?:for|across|to|in|with)\s+all\s+(?:my\s+|the\s+|of\s+my\s+|of\s+the\s+)?agents\b/i,
  // EN — for/across/to/in/with + every|each agent
  /\b(?:for|across|to|in|with)\s+(?:every|each)\s+agent\b/i,
  // EN — a colon makes it adverbial without a preposition ("all agents: …")
  /\ball\s+(?:my\s+|the\s+)?agents\s*[:：]/i,
  /\b(?:every|each)\s+agent\s*[:：]/i,
  // EN — agent-wide
  /\bagent[-\s]wide\b/i,
  // EN — global memory / shared memory / shared context
  /\bglobal\s+memory\b/i,
  /\bshared\s+(?:memory|context)\b/i,
];

/**
 * Scope phrasing removed from the extracted fact, so the stored note reads as
 * the preference itself ("返信は日本語で") rather than repeating the routing
 * instruction ("全エージェントで返信は日本語で"). Wider than
 * GLOBAL_SCOPE_PATTERNS on purpose — they also swallow the connecting particle
 * / preposition / "that", which would otherwise be left dangling.
 */
const SCOPE_STRIP_PATTERNS: RegExp[] = [
  /(?:全|全て|すべて|ぜんぶ|全部)の?エージェント(?:共通|全員|全部)?(?:に対して|について)?(?:では|には|でも|にも|で|に|は|も|が|の|を)?/g,
  /エージェント(?:全員|全部|すべて|全て|共通)(?:に対して|について)?(?:では|には|でも|にも|で|に|は|も|が|の|を)?/g,
  /どのエージェント(?:でも|にも|も)/g,
  /共通の?(?:記憶|メモリ|メモ)(?:として|には|に|では|で|は|を)?/g,
  /(?:\b(?:for|across|in|to|by|with)\s+)?\ball\s+(?:my\s+|the\s+|of\s+my\s+|of\s+the\s+)?agents\b\s*,?\s*(?:\bthat\b)?/gi,
  /(?:\b(?:for|across|in|to|by|with)\s+)?\b(?:every|each)\s+agent\b\s*,?\s*(?:\bthat\b)?/gi,
  /(?:\b(?:for|in|to)\s+)?\bagent[-\s]wide\b\s*,?\s*(?:\bthat\b)?/gi,
  /(?:\b(?:in|to|as)\s+)?\b(?:global\s+memory|shared\s+(?:memory|context))\b\s*,?\s*(?:\bthat\b)?/gi,
];

/**
 * Residues that parse as "content" but say nothing — a pronoun pointing at
 * something earlier in the conversation this parser cannot see. "これは全
 * エージェントで覚えておいて" is a perfectly natural sentence whose actual
 * payload lives in a previous message, so storing the literal "これ" would put
 * a meaningless line in every agent's prompt forever.
 */
const CONTENTLESS_RESIDUES = new Set([
  'これ', 'それ', 'あれ', 'この', 'その', 'あの',
  '今の', '今', 'さっき', 'さっきの', '上記', '以上', '上の',
  'this', 'that', 'it', 'the above', 'above', 'the following', 'them',
]);

/** Floor for a storable note. See the module doc: false negatives are cheap. */
export const MIN_GLOBAL_NOTE_CHARS = 4;

/**
 * "…として" / "…に" leftovers from a phrasing like 「エージェント共通の記憶と
 * して、◯◯をメモしておいて」, where the scope strip removes 「エージェント共通
 * の」 and leaves a dangling 「記憶として」 in front of the real payload.
 */
const LEADING_MEMORY_NOUN_RE = /^(?:記憶|メモリ|メモ)(?:として|には|に|は|で)?/;
/** Leading connectors/punctuation left behind after the scope phrase is cut. */
const LEADING_NOISE_RE = /^[\s:：,、。・…「」『』()（）\-–—]+/;
const TRAILING_NOISE_RE = /[\s、。「」『』]+$/;
/** Bare particles that can survive as the whole residue (e.g. "は" alone). */
const BARE_PARTICLE_RE = /^(?:は|を|も|が|に|で|の|と|へ|や|か)+$/;

function hasGlobalScopeMarker(text: string): boolean {
  return GLOBAL_SCOPE_PATTERNS.some((re) => re.test(text));
}

function stripScopePhrases(fact: string): string {
  let out = fact;
  for (const re of SCOPE_STRIP_PATTERNS) {
    // Every pattern is /g; reset lastIndex so a module-level regex reused
    // across calls can never skip a match on a later invocation.
    re.lastIndex = 0;
    out = out.replace(re, ' ');
  }
  return out
    .replace(/\s+/g, ' ')
    .replace(LEADING_NOISE_RE, '')
    .replace(LEADING_MEMORY_NOUN_RE, '')
    .replace(LEADING_NOISE_RE, '')
    .replace(TRAILING_NOISE_RE, '')
    .trim();
}

/** Apply the shared payload-quality bar after detectMemory extracts a fact. */
function buildGlobalMemoryWriteIntent(fact: string): GlobalMemoryWriteIntent | null {
  const stripped = stripScopePhrases(fact);
  if (!stripped) return null;
  if (BARE_PARTICLE_RE.test(stripped)) return null;
  const normalized = stripped.toLowerCase().replace(/[。、.!！]+$/, '').replace(/(?:は|を|も|が|に|で|の)$/, '');
  if (CONTENTLESS_RESIDUES.has(normalized)) return null;
  if (stripped.length < MIN_GLOBAL_NOTE_CHARS) return null;

  return { text: stripped, type: 'preference' };
}

/**
 * Detect an explicit "remember this for every agent" request.
 *
 * Returns null for everything else — including a plain per-agent "remember
 * that …" (no scope marker), a plain all-agents command with no memory marker,
 * a negated "I don't remember …", a question, and a scoped request whose
 * payload is empty or contentless. A null result means the caller must leave
 * the utterance to its normal handler; it must NEVER be treated as a weak hit.
 */
export function detectGlobalMemoryWrite(raw: string): GlobalMemoryWriteIntent | null {
  const text = (raw ?? '').trim();
  if (!text) return null;

  // Questions ("do you remember what all agents did?") are never write
  // requests. A polite question-form request ("…覚えておいて？") is a
  // tolerated false negative.
  if (looksLikeQuestion(text)) return null;

  // Gate 1a — explicit all-agents scope.
  if (!hasGlobalScopeMarker(text)) return null;

  // Gate 1b — a real memory-write marker, via the SAME detector the per-agent
  // path uses (negated "don't remember" forms already excluded there).
  const memory = detectMemory(text);
  if (!memory?.remember) return null;
  const fact = memory.rememberFact?.trim();
  if (!fact) return null;

  // Gate 2 — the payload must survive scope-stripping as real content.
  return buildGlobalMemoryWriteIntent(fact);
}

/**
 * Detect a memory-write request addressed directly to the Shelly companion.
 *
 * This deliberately omits detectGlobalMemoryWrite's explicit all-agents scope
 * gate: an unscoped AI-Pane-chat "remember this" is presumed to address the
 * Shelly persona, whose `_global` memory fans out through every agent via
 * agent-manager's applyMemoryAndSkills. It remains IDENTICALLY strict about
 * payload quality, including harmlessly stripping a scope phrase when one is
 * present. Like detectGlobalMemoryWrite, this pure detector writes NOTHING;
 * only the caller's mandatory confirm-then-write flow may commit the note.
 */
export function detectCompanionMemoryWrite(raw: string): GlobalMemoryWriteIntent | null {
  const text = (raw ?? '').trim();
  if (!text) return null;

  // Keep the same question guard as the stricter sibling. A polite
  // question-form request is an intentional false negative.
  if (looksLikeQuestion(text)) return null;

  const memory = detectMemory(text);
  if (!memory?.remember) return null;
  const fact = memory.rememberFact?.trim();
  if (!fact) return null;

  return buildGlobalMemoryWriteIntent(fact);
}
