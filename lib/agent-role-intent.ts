/**
 * lib/agent-role-intent.ts — agent roles (Inc A, WP2): the deterministic NL
 * grammar for creating / editing / listing / deleting / resetting roles.
 * Design: docs/superpowers/specs/2026-11-02-agent-roles-design.md §2.
 *
 * Pure: no store / RN imports. Detection only — nothing is ever saved here;
 * lib/agent-role-chat.ts echoes the interpretation and waits for the user's
 * typed confirm.
 *
 * Every intent needs TWO independent markers — a role noun (role / ロール /
 * <known word>役) AND an operation verb (make / create / change / delete … /
 * 作って / 変えて / 削除 …). Questions are never intents ("how do I make a
 * reviewer role?", 「レビュー役を作れますか」), nor is "the role of X",
 * "role-play", "role-based …" or a database/permission "role". Markers are
 * looked for in the user's own words only (quoted / fenced / blockquoted
 * text is dropped first, so pasted content cannot raise an intent).
 *
 * Extracted settings, each removed from the instructions:
 *   engine    the instrument phrase of a TOOL_MENTIONS tool ("using Claude
 *             Code", 「Codexで」, 「Codexを使う」); Antigravity is never an engine
 *             — naming it yields the `antigravity-refused` intent;
 *   level     detectRunWithoutApprovalLevel ("run fully without approval");
 *   workspace deriveWorkspaceRootFromText (`~/demo`) → fixed;
 *   autoAttach "(don't) attach … automatically" / 「自動で付け(ない)で」.
 * `handles` is derived from the role name (a known role word) and then the
 * instructions (classifyTaskKind, the delivery kind `publish` excluded).
 */
import {
  ROLE_NAME_MAX_CHARS,
  classifyTaskKind,
  isRoleKind,
  type AgentRoleWorkspace,
  type RoleEngine,
  type RoleKind,
  type RoleLevel,
} from '@/lib/agent-role-types';
import { TOOL_MENTIONS, matchToolMention } from '@/lib/agent-tool-mentions';
import {
  detectRunWithoutApprovalLevel,
  stripQuotedText,
  stripRunWithoutApprovalPhrases,
} from '@/lib/agent-run-without-approval';
import { deriveWorkspaceRootFromText } from '@/lib/agent-workspace-from-request';
import { mentionsAntigravityInstrument } from '@/lib/agent-antigravity';

/** Settings an edit can change. `workspaceInvalid` = the user named a path
 *  that cannot be a workspace (the chat says why; nothing is changed). */
export interface RoleChanges {
  engine?: RoleEngine;
  instructions?: string;
  workspace?: AgentRoleWorkspace;
  workspaceInvalid?: string;
  level?: RoleLevel;
  autoAttach?: boolean;
}

export type RoleIntent =
  | {
      kind: 'create';
      name: string;
      /** '' when the request did not say what the role does. */
      instructions: string;
      engine?: RoleEngine;
      handles: RoleKind[];
      workspace?: AgentRoleWorkspace;
      workspaceInvalid?: string;
      level?: RoleLevel;
      /** Explicit user choice; undefined = the default (reviewers ON). */
      autoAttach?: boolean;
    }
  /** `weak`: the target was named without the role noun ("don't attach the
   *  reviewer automatically", 「主役を…」) — the chat falls through to normal
   *  routing when no role by that name exists. */
  | { kind: 'edit'; target: string; changes: RoleChanges; weak?: boolean }
  | { kind: 'list' }
  | { kind: 'delete'; target: string; weak?: boolean }
  | { kind: 'reset' }
  | { kind: 'antigravity-refused' };

// ─── Vocabulary ────────────────────────────────────────────────────────────

/** Role words that make `<word>役` a role noun (「悪役」「主役」 are not). */
const JA_ROLE_WORDS: ReadonlyArray<{ word: string; kind: RoleKind }> = [
  { word: 'レビュアー', kind: 'review' },
  { word: 'レビュー', kind: 'review' },
  { word: '校正', kind: 'review' },
  { word: '検証', kind: 'review' },
  { word: '確認', kind: 'review' },
  { word: 'チェック', kind: 'review' },
  { word: 'テスト', kind: 'review' },
  { word: '実装', kind: 'implement' },
  { word: '開発', kind: 'implement' },
  { word: '修正', kind: 'implement' },
  { word: 'コーディング', kind: 'implement' },
  { word: 'プログラマー', kind: 'implement' },
  { word: 'プログラマ', kind: 'implement' },
  { word: 'エンジニア', kind: 'implement' },
  { word: '審査', kind: 'judge' },
  { word: '判定', kind: 'judge' },
  { word: '評価', kind: 'judge' },
  { word: '比較', kind: 'judge' },
  { word: '調査', kind: 'research' },
  { word: 'リサーチ', kind: 'research' },
  { word: '分析', kind: 'research' },
  { word: '執筆', kind: 'write' },
  { word: 'ライター', kind: 'write' },
  { word: '編集', kind: 'write' },
  { word: '要約', kind: 'summarize' },
  { word: 'まとめ', kind: 'summarize' },
  { word: '整理', kind: 'summarize' },
  { word: '翻訳', kind: 'translate' },
];
const JA_WORDS_SRC = JA_ROLE_WORDS.map((w) => w.word).join('|');

const EN_ROLE_WORDS: ReadonlyArray<{ re: RegExp; kind: RoleKind }> = [
  { re: /\b(?:reviewer|review|proofreader|checker|verifier|auditor|tester|qa)\b/i, kind: 'review' },
  { re: /\b(?:implementer|implementor|developer|coder|programmer|engineer|builder|fixer)\b/i, kind: 'implement' },
  { re: /\b(?:judge|referee|evaluator|comparer|arbiter)\b/i, kind: 'judge' },
  { re: /\b(?:researcher|research|investigator|analyst|scout)\b/i, kind: 'research' },
  { re: /\b(?:writer|author|editor|copywriter|drafter)\b/i, kind: 'write' },
  { re: /\b(?:summari[sz]er|digester)\b/i, kind: 'summarize' },
  { re: /\b(?:translator)\b/i, kind: 'translate' },
];

/** Name characters for a JA role name run (katakana, kanji, latin, digits). */
const JA_NAME_CH = '[ァ-ヿ㐀-鿿Ａ-Ｚａ-ｚA-Za-z0-9ー_-]';

// "role" as a noun of THIS feature: not "role of", "role in", "role-play",
// "role model", "role-based", "role column".
const EN_ROLE_NOUN_RE = /\broles?\b(?![-‐]|\s+(?:of|in|model|models|play(?:ing)?|based)\b)/i;
const JA_ROLE_NOUN_RE = new RegExp(`ロール(?!プレ|アウト|バック|ケーキ)|(?:${JA_WORDS_SRC})役(?!割|者|員|職)`);

// Database / access-control "roles" ("add an admin role to the users table").
const TECH_ROLE_CONTEXT_RE =
  /\b(?:table|column|database|db|schema|sql|users?|permissions?|rbac|iam|access|auth|discord|server|aws|gcp|kubernetes|k8s|postgres|mysql|ldap|jwt|token)\b|権限|テーブル|データベース|ユーザー/i;

const EN_QUESTION_START_RE =
  /^\s*(?:what|how|why|when|where|which|who|whom|whose|is|are|was|were|do(?!\s+not\b)|does|did|should|shall|may|might|has)\b/i;
const EN_POLITE_REQUEST_RE = /^\s*(?:please\s+)?(?:can|could|would|will)\s+(?:you|u)\b/i;
const EN_QUESTION_MODAL_RE = /^\s*(?:can|could|would|will)\s+(?:i|we)\b/i;
const QUESTION_MARK_END_RE = /[?？]\s*$/;
const JA_QUESTION_END_RE = /(?:ですか|ますか|でしょうか|ませんか|かな|のか|って何|とは|か)[。．!！]?\s*$/;

/** true when `text` (user's own words) reads as a question, not a request. */
export function isRoleQuestion(text: string): boolean {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (EN_POLITE_REQUEST_RE.test(t)) return false;
  if (EN_QUESTION_START_RE.test(t) || EN_QUESTION_MODAL_RE.test(t)) return true;
  if (QUESTION_MARK_END_RE.test(t)) return true;
  return JA_QUESTION_END_RE.test(t);
}

// ─── Engine (instrument) phrases ───────────────────────────────────────────

const JA_ENGINE_SUFFIX = String.raw`\s*(?:の?\s*api\s*)?(?:で(?!の|は|も)|を\s*(?:使って|使う|使い|使用して|使用する|用いて|用いる|利用して|利用する)|経由で)\s*[、,]?\s*`;
const EN_ENGINE_PREFIX = String.raw`\s*,?\s*\b(?:with|using|via|through|on)\s+(?:the\s+)?`;
const EN_ENGINE_USE = String.raw`\s*,?\s*\b(?:and\s+)?(?:to\s+)?use\s+(?:the\s+)?`;

const ENGINE_PHRASES: ReadonlyArray<{ re: RegExp; tool: RoleEngine }> = TOOL_MENTIONS.flatMap(({ re, tool }) => {
  const src = re.source;
  return [
    { re: new RegExp(`(?:${src})${JA_ENGINE_SUFFIX}`, 'i'), tool: tool as RoleEngine },
    { re: new RegExp(`${EN_ENGINE_PREFIX}(?:${src})(?:\\s+(?:cli|api))?\\b\\s*[,:]?`, 'i'), tool: tool as RoleEngine },
    { re: new RegExp(`${EN_ENGINE_USE}(?:${src})(?:\\s+(?:cli|api))?\\b\\s*[,:]?`, 'i'), tool: tool as RoleEngine },
  ];
});

function isRoleEngine(tool: unknown): tool is RoleEngine {
  const t = (tool as { type?: unknown } | null)?.type;
  return typeof t === 'string' && t !== 'auto' && t !== 'ab-article-eval';
}

/** The earliest engine instrument phrase in `text`, or null. */
export function findRoleEngine(text: string): { tool: RoleEngine; index: number; length: number } | null {
  let best: { tool: RoleEngine; index: number; length: number } | null = null;
  for (const { re, tool } of ENGINE_PHRASES) {
    const m = re.exec(text);
    if (!m || !isRoleEngine(tool)) continue;
    if (!best || m.index < best.index) best = { tool: { ...tool } as RoleEngine, index: m.index, length: m[0].length };
  }
  return best;
}

function stripEnginePhrases(text: string): string {
  let out = text;
  for (let i = 0; i < 4; i++) {
    const hit = findRoleEngine(out);
    if (!hit) break;
    out = `${out.slice(0, hit.index)} ${out.slice(hit.index + hit.length)}`;
  }
  return out;
}

const ANTIGRAVITY_TOKEN_RE = /\bantigravity\b|アンチグラビティ|\bagy\b/i;
const COMPARISON_WORDS_RE = /\bcompar(?:e|es|ed|ing|ison)\b|\bvs\.?(?=\s|$)|\bversus\b|比較|比べ|対決|どっち|どちら|違い/gi;
const ANTIGRAVITY_EDIT_RE =
  /\b(?:to|use|using|with|via)\s+(?:the\s+)?(?:antigravity|agy)\b|(?:antigravity|アンチグラビティ|agy)\s*(?:に|へ)\s*(?:変え|変更|切り替え|し)/i;

/** The request names Antigravity as the role's engine. */
function requestsAntigravity(text: string): boolean {
  if (!ANTIGRAVITY_TOKEN_RE.test(text)) return false;
  // A role's own instructions often compare things; the generic detector
  // ignores the whole text then, so look again without the comparison words.
  return (
    mentionsAntigravityInstrument(text) ||
    mentionsAntigravityInstrument(text.replace(COMPARISON_WORDS_RE, ' ')) ||
    ANTIGRAVITY_EDIT_RE.test(text)
  );
}

// ─── Other settings ────────────────────────────────────────────────────────

const PATH_TOKEN_RE = /(?:^|[^A-Za-z0-9._@+\-/~$:])((?:~|\$HOME|\$\{HOME\})\/[A-Za-z0-9._@+\-/]*|\/(?:data|sdcard|storage|tmp|system|etc|proc)[A-Za-z0-9._@+\-/]*)/;
const PATH_PHRASE_STRIP_RE =
  /\s*(?:(?:\b(?:in|at|under|inside|into)\s+(?:the\s+)?)?(?:\b(?:workspace|work(?:ing)?\s+dir(?:ectory)?|project\s+(?:dir(?:ectory)?|folder))\s*(?:is|=|:|to)?\s*)?|(?:ワークスペース|作業(?:フォルダ|ディレクトリ))\s*(?:は|を|:|：)?\s*)(?:~|\$HOME|\$\{HOME\})\/[A-Za-z0-9._@+\-/]*\s*(?:の中で|の中に|の中|で|に|内で)?/gi;
const REQUEST_WORKSPACE_RE =
  /\bworkspace\b[^.\n]{0,30}\b(?:request|per[- ]request)\b|\brequest(?:'s|’s)?\s+workspace\b|ワークスペースを?\s*(?:依頼|リクエスト)(?:ごと|に合わせ|から|で決め)/i;

function extractWorkspace(text: string): { workspace?: AgentRoleWorkspace; workspaceInvalid?: string } {
  if (REQUEST_WORKSPACE_RE.test(text)) return { workspace: { mode: 'request' } };
  const token = PATH_TOKEN_RE.exec(text);
  if (!token) return {};
  const derived = deriveWorkspaceRootFromText(text);
  return derived ? { workspace: { mode: 'fixed', path: derived } } : { workspaceInvalid: token[1] };
}

const LEVEL_OFF_RE =
  /\b(?:require|requires|ask\s+for|need|needs)\s+approvals?\b|\bturn\s+off\s+(?:run(?:ning)?\s+)?without\s+approval\b|\bwith\s+approvals?\b|承認(?:あり|を求め|が必要|を必要)|承認なしで実行を?(?:やめ|オフ|解除)/i;
const LEVEL_OFF_STRIP_RE = new RegExp(LEVEL_OFF_RE.source, 'gi');

function extractLevel(text: string): RoleLevel | undefined {
  const own = stripQuotedText(text);
  const level = detectRunWithoutApprovalLevel(own);
  if (level !== 'off') return level;
  return LEVEL_OFF_RE.test(own) ? 'off' : undefined;
}

const DETACH_EN_RE = /\b(?:don'?t|do\s+not|never|stop|no)\s+(?:auto[- ]?)?attach(?:ing)?\b(?:\s+(?:it|them|this))?(?:[^.\n]{0,40}?\bautomatically\b)?|\bno\s+auto[- ]?attach\b/i;
const ATTACH_EN_RE = /\b(?:always\s+)?(?:auto[- ]?)?attach(?:ing)?\b[^.\n]{0,40}?\bautomatically\b|\bauto[- ]?attach\b/i;
const DETACH_JA_RE = /(?:自動で|自動的に)\s*(?:付け|つけ|追加し|入れ)ない|自動(?:追加|付与)(?:は|を)?(?:しない|なし|オフ)/;
const ATTACH_JA_RE = /(?:自動で|自動的に)\s*(?:付け|つけ|追加し|入れ)(?:て|る)|自動(?:追加|付与)(?:する|して|あり|オン)/;
const AUTO_ATTACH_STRIP_RE =
  /\s*,?\s*(?:and\s+)?(?:(?:don'?t|do\s+not|never|stop|no)\s+)?(?:always\s+)?(?:auto[- ]?)?attach(?:ing)?\b(?:\s+(?:it|them|this))?(?:\s+(?:after|to)\s+(?:implementation|implement(?:er|ing)?\s*(?:steps?|work)?))?\s*(?:automatically)?|[、,]?\s*(?:自動で|自動的に)\s*(?:付け|つけ|追加し|入れ)(?:ない)?(?:で|て|る)(?:ください)?/gi;

function extractAutoAttach(text: string): boolean | undefined {
  const own = stripQuotedText(text);
  if (DETACH_EN_RE.test(own) || DETACH_JA_RE.test(own)) return false;
  if (ATTACH_EN_RE.test(own) || ATTACH_JA_RE.test(own)) return true;
  return undefined;
}

// ─── Text helpers ──────────────────────────────────────────────────────────

function tidy(s: string): string {
  return s
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/([぀-ヿ㐀-鿿]) (?=[぀-ヿ㐀-鿿])/g, '$1')
    .replace(/\s+([、。,.!?！？:;])/g, '$1')
    .replace(/^[\s、,。.:：;—–-]+|[\s、,;:：—–-]+$/g, '')
    .trim();
}

/** Everything that is a setting, not part of what the role does. */
function stripSettings(text: string): string {
  let out = stripRunWithoutApprovalPhrases(text);
  out = out.replace(LEVEL_OFF_STRIP_RE, ' ');
  out = stripEnginePhrases(out);
  out = out.replace(PATH_PHRASE_STRIP_RE, ' ');
  out = out.replace(AUTO_ATTACH_STRIP_RE, ' ');
  return tidy(out);
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function cleanName(raw: string): string | null {
  const name = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!name || /[\u0000-\u001f\u007f-\u009f]/.test(name)) return null;
  if (Array.from(name).length > ROLE_NAME_MAX_CHARS) return null;
  return name;
}

/** Comparison key for names: NFKC, case-folded, 役 / "role" suffix dropped. */
export function roleNameKey(name: string): string {
  return String(name ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*(?:role|ロール)$/i, '')
    .trim();
}

/** Task kinds a role handles: the name's role word first, then the instructions. */
export function deriveRoleHandles(name: string, instructions: string): RoleKind[] {
  const kinds: RoleKind[] = [];
  const add = (k: RoleKind | null | undefined) => {
    if (k && isRoleKind(k) && !kinds.includes(k)) kinds.push(k);
  };
  for (const w of JA_ROLE_WORDS) if (name.includes(w.word)) { add(w.kind); break; }
  if (!kinds.length) for (const w of EN_ROLE_WORDS) if (w.re.test(name)) { add(w.kind); break; }
  const fromInstructions = classifyTaskKind(instructions, { exclude: ['publish'] });
  add(fromInstructions === 'publish' ? null : (fromInstructions as RoleKind | null));
  return kinds;
}

// ─── Create ────────────────────────────────────────────────────────────────

// "make the reviewer role use Codex" is an edit: `the` / `my` never start a create.
const EN_CREATE_VERB = String.raw`\b(?:make|create|add|set\s+up|define|register)\s+(?:me\s+)?(?:(?:a|an|new|another|one)\s+)+`;
const EN_CREATE_RE = new RegExp(
  `${EN_CREATE_VERB}(?:(?!(?:the|my|your|this|that|role)\\b)([A-Za-z][\\w-]*(?:\\s+(?!role\\b)[A-Za-z][\\w-]*){0,2})\\s+)?role\\b(?![-‐]|\\s+(?:of|in|model|play(?:ing)?|based)\\b)`,
  'i',
);
const EN_NAME_AFTER_RE =
  /^\s*(?:(?:called|named)\s+)?(?:"([^"\n]{1,40})"|“([^”\n]{1,40})”|「([^」\n]{1,40})」)|^\s*(?:called|named)\s+([A-Za-z0-9][\w-]*(?:\s+[A-Z][\w-]*)*)/;
const EN_INSTRUCTION_LEAD_RE = /^(?:[\s,:;—–-]|\b(?:that|who|which|whose\s+job\s+is\s+to|to|for|and|it|should)\b)+/i;

function detectEnCreate(text: string): RoleIntent | null {
  const m = EN_CREATE_RE.exec(text);
  if (!m) return null;
  let name = m[1] ? capitalize(m[1].trim()) : '';
  let rest = text.slice(m.index + m[0].length);
  const after = EN_NAME_AFTER_RE.exec(rest);
  if (after) {
    const quoted = after[1] ?? after[2] ?? after[3] ?? after[4];
    if (quoted) {
      // "a reviewer role called X" — the explicit name wins.
      name = quoted.trim();
      rest = rest.slice(after.index + after[0].length);
    }
  }
  const clean = cleanName(name);
  if (!clean) return null;
  const level = extractLevel(text);
  const ws = extractWorkspace(text);
  const autoAttach = extractAutoAttach(text);
  const engine = findRoleEngine(text)?.tool;
  const instructions = tidy(stripSettings(rest).replace(EN_INSTRUCTION_LEAD_RE, ''));
  return {
    kind: 'create',
    name: clean,
    instructions: instructions ? capitalize(instructions) : '',
    ...(engine ? { engine } : {}),
    handles: deriveRoleHandles(clean, instructions),
    ...ws,
    ...(level !== undefined ? { level } : {}),
    ...(autoAttach !== undefined ? { autoAttach } : {}),
  };
}

// An engine phrase may sit between を and the verb (「審査役をローカルLLMで作って」);
// nothing else may (「実装役を使ってゲームを作って」 is a use, not a create).
const JA_TOOL_SRC = TOOL_MENTIONS.map(({ re }) => re.source).join('|');
const JA_CREATE_VERB = String.raw`\s*(?:を|として)\s*(?:(?:${JA_TOOL_SRC})\s*(?:で|を使って)\s*)?(?:新しく|新規に?)?\s*(?:作|つく|作成|追加|登録|定義|用意)`;
const JA_CREATE_RE = new RegExp(
  `(?:「([^」]{1,24})」\\s*(?:という)?\\s*(?:ロール|役)|(${JA_NAME_CH}*?(?:${JA_WORDS_SRC})役)(?:\\s*というロール)?|(${JA_NAME_CH}{1,24})\\s*というロール)${JA_CREATE_VERB}`,
  'i',
);
/** The quoted-name create form, checked on the raw text (the quote IS the name). */
const JA_QUOTED_NAME_CREATE_RE = new RegExp(`「[^」]{1,24}」\\s*(?:という)?\\s*(?:ロール|役)${JA_CREATE_VERB}`, 'i');

function detectJaCreate(text: string): RoleIntent | null {
  const m = JA_CREATE_RE.exec(text);
  if (!m) return null;
  const clean = cleanName((m[1] ?? m[2] ?? m[3] ?? '').trim());
  if (!clean) return null;
  const before = text.slice(0, m.index);
  // Past the verb's own tail (作って。/ 作成してください、) — the rest is more
  // of what the role does.
  const after = text.slice(m.index + m[0].length).replace(/^[ぁ-ん]*(?:ください)?[。．.!！、,\s]*/, '');
  const level = extractLevel(text);
  const ws = extractWorkspace(text);
  const autoAttach = extractAutoAttach(text);
  const engine = findRoleEngine(text)?.tool;
  const parts = [stripSettings(before), stripSettings(after)]
    .map((p) => p.replace(/^(?:で|を|に|は|、)+/, '').replace(/(?:という|の)$/, '').trim())
    .filter(Boolean);
  const instructions = tidy(parts.join('。'));
  return {
    kind: 'create',
    name: clean,
    instructions,
    ...(engine ? { engine } : {}),
    handles: deriveRoleHandles(clean, instructions),
    ...ws,
    ...(level !== undefined ? { level } : {}),
    ...(autoAttach !== undefined ? { autoAttach } : {}),
  };
}

// ─── Edit / delete / list / reset ──────────────────────────────────────────

const EN_TARGET = String.raw`(?:"([^"\n]{1,40})"|“([^”\n]{1,40})”|([A-Za-z0-9][\w-]*(?:\s+[A-Za-z0-9][\w-]*)?))`;
const EN_EDIT_RE = new RegExp(
  String.raw`\b(?:change|set|update|switch|make|modify|edit|move|turn)\s+(?:the\s+|my\s+)?(?:role\s+(?:called\s+|named\s+)?${EN_TARGET}|${EN_TARGET}\s+role)(?:'s|’s)?(?![-‐])\b`,
  'i',
);
const EN_ATTACH_TARGET_RE =
  /\b(?:(?:don'?t|do\s+not|never|stop)\s+)?(?:always\s+)?(?:auto[- ]?)?attach(?:ing)?\s+(?:the\s+)?(?:"([^"\n]{1,40})"|([A-Za-z0-9][\w-]*))(\s+role)?\s+automatically\b/i;
const EN_DELETE_RE = new RegExp(
  String.raw`\b(?:delete|remove|drop|forget)\s+(?:the\s+|my\s+)?(?:role\s+(?:called\s+|named\s+)?${EN_TARGET}|${EN_TARGET}\s+role)\b(?![-‐])`,
  'i',
);
const EN_LIST_RE = /^\s*(?:please\s+)?(?:list|show(?:\s+me)?|display)\s+(?:all\s+)?(?:of\s+)?(?:my\s+|the\s+)?(?:agent\s+)?roles\b(?!\s+(?:of|in|for)\b)/i;
const EN_RESET_RE = /\b(?:reset|clear|wipe)\s+(?:all\s+)?(?:of\s+)?(?:my\s+|the\s+)?(?:agent\s+)?roles?(?:\s+settings)?\b(?![-‐]|\s+(?:of|in|for|column|table)\b)/i;

const JA_TARGET = `(?:「([^」]{1,24})」\\s*(?:という)?\\s*(?:ロール|役)?|(${JA_NAME_CH}{1,24}?)(役|ロール))`;
const JA_EDIT_RE = new RegExp(
  `${JA_TARGET}\\s*(?:の\\s*(?:エンジン|ワークスペース|作業(?:フォルダ|ディレクトリ)|指示|内容|仕事|説明)\\s*)?(?:を|は)`,
);
const JA_CHANGE_VERB_RE = /(?:に|へ)\s*(?:変えて|変更|して|切り替え|設定)|変えて|変更して|付けないで|つけないで|付けて|つけて|追加しないで|で実行(?:して|に|する)|実行にして/;
const JA_DELETE_RE = new RegExp(`${JA_TARGET}\\s*(?:というロール)?\\s*を\\s*(?:削除|消して|消す|消去|なくして)`);
const JA_LIST_RE = /ロール(?:の)?一覧|ロール(?:を)?(?:一覧|全部|すべて|全て)?(?:見せて|表示して|教えて)|役割(?:の)?一覧/;
const JA_RESET_RE = /ロール(?:の)?(?:設定)?(?:を|の)?\s*(?:初期化|リセット)/;

function jaTargetName(m: RegExpExecArray): { target: string; weak: boolean } {
  if (m[1]) return { target: m[1].trim(), weak: false };
  const stem = (m[2] ?? '').trim();
  const suffix = m[3] ?? '';
  if (suffix === 'ロール') return { target: stem, weak: false };
  const known = JA_ROLE_WORDS.some((w) => stem.endsWith(w.word));
  return { target: `${stem}役`, weak: !known };
}

function enTargetName(m: RegExpExecArray, from: number): string {
  for (let i = from; i < from + 6; i++) if (m[i]) return m[i].trim();
  return '';
}

const EN_INSTRUCTIONS_CHANGE_RE = /\b(?:instructions?|prompt|job|task|description)\s+(?:to|:|=)\s*([\s\S]+)$/i;
const JA_INSTRUCTIONS_CHANGE_RE = /の\s*(?:指示|内容|仕事|説明)\s*を\s*「?([\s\S]+?)」?\s*(?:に|へ)\s*(?:変えて|変更|して)/;

function extractChanges(rest: string, whole: string): RoleChanges {
  const changes: RoleChanges = {};
  let remaining = rest;
  const instr = EN_INSTRUCTIONS_CHANGE_RE.exec(rest) ?? JA_INSTRUCTIONS_CHANGE_RE.exec(whole);
  if (instr) {
    const ins = tidy(stripSettings(instr[1]));
    if (ins) changes.instructions = ins;
    remaining = rest.replace(instr[0], ' ');
  }
  const engine = findRoleEngine(remaining)?.tool ?? matchToolMention(remaining);
  if (engine && isRoleEngine(engine)) changes.engine = { ...engine } as RoleEngine;
  const ws = extractWorkspace(remaining);
  if (ws.workspace) changes.workspace = ws.workspace;
  if (ws.workspaceInvalid) changes.workspaceInvalid = ws.workspaceInvalid;
  const level = extractLevel(remaining);
  if (level !== undefined) changes.level = level;
  const attach = extractAutoAttach(remaining);
  if (attach !== undefined) changes.autoAttach = attach;
  return changes;
}

function hasChanges(c: RoleChanges): boolean {
  return Object.keys(c).length > 0;
}

function detectEdit(text: string, own: string): RoleIntent | null {
  const en = EN_EDIT_RE.exec(text);
  if (en && EN_ROLE_NOUN_RE.test(own)) {
    const target = enTargetName(en, 1);
    const changes = extractChanges(text.slice(en.index + en[0].length), text);
    if (target && hasChanges(changes)) return { kind: 'edit', target, changes };
  }
  const attach = EN_ATTACH_TARGET_RE.exec(text);
  if (attach) {
    const target = (attach[1] ?? attach[2] ?? '').trim();
    const autoAttach = extractAutoAttach(text);
    if (target && autoAttach !== undefined && !/^(?:it|them|this|that)$/i.test(target)) {
      return { kind: 'edit', target, changes: { autoAttach }, weak: !attach[3] };
    }
  }
  const ja = JA_EDIT_RE.exec(text);
  if (ja) {
    const rest = text.slice(ja.index + ja[0].length);
    if (JA_CHANGE_VERB_RE.test(rest)) {
      const { target, weak } = jaTargetName(ja);
      const changes = extractChanges(rest, text);
      if (target && hasChanges(changes)) return { kind: 'edit', target, changes, weak };
    }
  }
  return null;
}

function detectDelete(text: string, own: string): RoleIntent | null {
  const en = EN_DELETE_RE.exec(text);
  if (en && EN_ROLE_NOUN_RE.test(own)) {
    const target = enTargetName(en, 1);
    if (target && !/^(?:all|every|my|the)$/i.test(target)) return { kind: 'delete', target };
  }
  const ja = JA_DELETE_RE.exec(text);
  if (ja) {
    const { target, weak } = jaTargetName(ja);
    if (target) return { kind: 'delete', target, weak };
  }
  return null;
}

// ─── Entry point ───────────────────────────────────────────────────────────

/**
 * The role operation the user's message asks for, or null. Pure.
 * Order: reset → list → Antigravity refusal → delete → edit → create.
 */
export function detectRoleIntent(raw: string): RoleIntent | null {
  // NFKC: full-width latin / digits / `～` read like their ASCII forms.
  const text = String(raw ?? '').normalize('NFKC').replace(/^\s*@agent\b\s*/i, '').trim();
  if (!text || text.length > 2000) return null;
  // The user's own words: quoted / fenced / blockquoted passages dropped.
  const own = stripQuotedText(text).trim();
  if (!own) return null;
  if (isRoleQuestion(own)) return null;
  const hasRoleNoun = EN_ROLE_NOUN_RE.test(own) || JA_ROLE_NOUN_RE.test(own);

  if (EN_RESET_RE.test(own) || JA_RESET_RE.test(own)) return { kind: 'reset' };
  if (EN_LIST_RE.test(own) || JA_LIST_RE.test(own)) return { kind: 'list' };

  const enCreate = EN_CREATE_RE.test(own);
  const jaCreate = JA_CREATE_RE.test(own) || JA_QUOTED_NAME_CREATE_RE.test(text);
  // "add an admin role to the users table" — a database / access role.
  if (TECH_ROLE_CONTEXT_RE.test(own) && enCreate && !jaCreate && !findRoleEngine(own)) return null;

  if (hasRoleNoun && requestsAntigravity(own)) {
    if (enCreate || jaCreate || EN_EDIT_RE.test(own) || JA_EDIT_RE.test(own)) return { kind: 'antigravity-refused' };
  }

  // Detection is gated on the user's own words; extraction reads the raw
  // text (a quoted name / instruction stays as typed).
  const del = EN_DELETE_RE.test(own) || JA_DELETE_RE.test(own) ? detectDelete(text, own) : null;
  if (del) return del;
  const editGate = EN_EDIT_RE.test(own) || EN_ATTACH_TARGET_RE.test(own) || JA_EDIT_RE.test(own);
  const edit = editGate ? detectEdit(text, own) : null;
  if (edit && !(enCreate || jaCreate)) return edit;

  if (enCreate) {
    const c = detectEnCreate(text);
    if (c) return c;
  }
  if (jaCreate) {
    const c = detectJaCreate(text);
    if (c) return c;
  }
  return edit;
}
