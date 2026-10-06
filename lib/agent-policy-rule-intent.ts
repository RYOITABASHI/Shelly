/**
 * lib/agent-policy-rule-intent.ts — POLICY-001 (C) natural-language custom
 * rules + the chat-side intents around the policy layer (list / revoke /
 * strict yes-no for the trust-ramp proposal).
 *
 * Flow (hooks/use-ai-pane-dispatch.ts): a rule-setting utterance
 * (detectPolicyRuleRequest) is converted into ONE structured rule from the
 * closed schema in lib/agent-action-policy.ts — deterministically
 * (parseRuleDeterministic) for common phrasings, else by a local-LLM pass
 * (extractPolicyRuleWithLlm, read-only use of lib/local-llm.ts's ollamaChat
 * with a decode-time JSON schema). Either way the candidate goes through
 * validatePolicyRule, which rejects anything that is not a TIGHTENING rule.
 * The interpretation is echoed back in plain chat text (describePolicyRule)
 * and only an explicit yes stores it. A parse failure stores nothing and
 * says so.
 *
 * Detection follows lib/agent-global-memory-intent.ts's asymmetry: a false
 * negative costs one rephrase, a false positive hijacks an ordinary chat turn,
 * so every detector here requires TWO independent markers and refuses
 * questions. Pure apart from the injectable LLM call.
 */
import {
  PolicyCapability,
  PolicyEffect,
  PolicyRule,
  PolicyRuleMatch,
  RuleValidation,
  normalizeDomain,
  validatePolicyRule,
} from '@/lib/agent-action-policy';
import { isConfirmPhrase } from '@/lib/agent-confirm-phrase';
import { isCancelPhrase } from '@/lib/agent-slot-fill';
import type { LocalLlmConfig, OllamaMessage } from '@/lib/local-llm';

// ─── Detection ───────────────────────────────────────────────────────────────

const QUESTION_RE = /[?？]\s*$|^(?:do|does|did|is|are|can|could|would|will|should|what|which|how|why|when|where)\b/i;

// Deliberately NOT a bare 「確認して」: that usually means "check this"
// (「保存できたか確認して」), not "ask me first". Every ask form below names the
// ordering ("before"/"first"/「から」), a standing adverb, or the listener.
const EFFECT_ASK_RE = /(?:必ず|絶対|いつも|毎回|事前に|先に|前に|常に)\s*(?:私に|僕に|俺に)?\s*(?:聞いて|聞くこと|聞くように|確認して|確認を取って|確認すること|確認するように|承認を取って)|(?:私に|僕に|俺に)(?:聞いて|確認して|確認を取って)|聞いてから|確認してから|確認を取ってから|聞かずに|確認せずに|承認なしに|勝手に|\balways\s+ask\b|\bask\s+(?:me\s+)?(?:first|before)\b|\bcheck\s+with\s+me\b|\bconfirm\s+with\s+me\b|\bwithout\s+(?:asking|confirmation|my\s+approval)\b|\bon\s+your\s+own\b|\brequire\s+(?:my\s+)?approval\b/i;
const EFFECT_DRAFT_RE = /下書き(?:まで|だけ|のみ|止まり|で止めて)|\bdrafts?\s+only\b|\bonly\s+(?:as\s+)?(?:a\s+)?drafts?\b|\bstop\s+at\s+(?:a\s+)?drafts?\b|\bjust\s+(?:a\s+)?drafts?\b/i;
const EFFECT_DENY_RE = /(?:しないで|しないこと|するな|させないで|禁止|しちゃダメ|してはいけない|ないで(?:ね|ください|下さい)?[。.!！]?$|ないこと)|\b(?:never|don'?t|do\s+not|must\s+not|forbid|forbidden|prohibit)\b/i;
/** A deny phrasing only counts as a STANDING rule with one of these. */
const STANDING_RE = /必ず|絶対|今後|これから|勝手に|常に|いつも|一切|以外|禁止|\b(?:never|always|from\s+now\s+on|ever|at\s+all|outside|except)\b/i;

/** Subjects a rule can be about. Order matters only for capability inference. */
const SUBJECT_RE = /操作|投稿|ポスト|ツイート|送信|送って|書き込|書かない|書いて|保存|編集|削除|消し|実行|コマンド|シェル|プッシュ|push|お金|支払|決済|購入|送金|課金|振込|メッセージ|DM|返信|メール|通信|アップロード|パスワード|秘密|鍵|\b(?:posts?|posting|tweets?|send|sending|write|writes|writing|save|edit|delete|run|running|execute|commands?|push|pay|payments?|purchases?|money|messages?|dms?|reply|replies|emails?|upload|network|secrets?|passwords?)\b/i;

/** Very common non-policy sentences that would otherwise trip the deny marker. */
const NON_POLICY_RE = /心配しないで|気にしないで|忘れないで|無理しないで|遠慮しないで|急がないで/;

export interface PolicyRuleRequest {
  text: string;
}

/**
 * Detect "set a policy rule" utterances: an effect marker (ask / draft-only /
 * deny) AND a subject marker, not a question. Returns null otherwise.
 */
export function detectPolicyRuleRequest(raw: string): PolicyRuleRequest | null {
  const text = (raw ?? '').trim();
  if (!text || text.startsWith('@') || text.length > 300) return null;
  if (QUESTION_RE.test(text)) return null;
  if (NON_POLICY_RE.test(text)) return null;
  if (detectPolicyListRequest(text) || detectPolicyRevokeRequest(text)) return null;
  const hasEffect =
    EFFECT_ASK_RE.test(text) || EFFECT_DRAFT_RE.test(text) || (EFFECT_DENY_RE.test(text) && STANDING_RE.test(text));
  if (!hasEffect) return null;
  if (!SUBJECT_RE.test(text)) return null;
  return { text };
}

const LIST_RE = /(?:許可|ルール|ポリシー|権限)(?:の)?(?:一覧|リスト|を見せて|見せて|を表示|表示して|を教えて|教えて|は何|って何がある|を確認)|\b(?:list|show)\s+(?:me\s+)?(?:my\s+|the\s+)?(?:policy\s+)?(?:rules|permissions|allow\s*rules|allows|policies)\b/i;

export function detectPolicyListRequest(raw: string): boolean {
  const text = (raw ?? '').trim();
  if (!text || text.startsWith('@') || text.length > 120) return false;
  return LIST_RE.test(text);
}

export interface PolicyRevokeRequest {
  /** 'latest' = the most recently added allow/rule; a number = 1-based index from the listing. */
  target: 'latest' | number;
  scope: 'allow' | 'rule' | 'any';
}

const REVOKE_VERB_RE = /取り消して|取り消し|取消して|撤回|解除して|解除|無効にして|消して|削除して|\b(?:revoke|remove|delete|undo|cancel|withdraw)\b/i;
const REVOKE_OBJECT_RE = /許可|ルール|ポリシー|権限|\b(?:permission|permissions|allow|allows|rule|rules|policy)\b/i;
const LATEST_RE = /さっき|今の|直前|最後|最新|\b(?:last|latest|previous|recent|that)\b/i;

export function detectPolicyRevokeRequest(raw: string): PolicyRevokeRequest | null {
  const text = (raw ?? '').trim();
  if (!text || text.startsWith('@') || text.length > 120) return null;
  if (!REVOKE_VERB_RE.test(text) || !REVOKE_OBJECT_RE.test(text)) return null;
  const scope: PolicyRevokeRequest['scope'] = /許可|権限|\b(?:permission|permissions|allow|allows)\b/i.test(text)
    ? 'allow'
    : /ルール|ポリシー|\b(?:rule|rules|policy)\b/i.test(text)
      ? 'rule'
      : 'any';
  const num = text.match(/(?:#|No\.?\s*|番号\s*)?([0-9０-９]{1,2})\s*(?:番目?|つ目)?/);
  if (num && /[0-9０-９]/.test(num[1]) && !LATEST_RE.test(text)) {
    const n = Number(num[1].replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)));
    if (n >= 1) return { target: n, scope };
  }
  return { target: 'latest', scope };
}

// ─── Strict yes / no ─────────────────────────────────────────────────────────

const EXTRA_YES = ['いいよ', 'いいです', 'うん', 'ええ', 'お願い', 'おねがい', 'ok!', 'yes please', 'sure', 'allow', 'allow it', '許可', '許可して', '許可する', 'それでいいよ', '確認なしでいい', '確認なしでいいよ', 'そうして'];
const NO_PHRASES = ['no', 'nope', 'no thanks', 'not now', "don't", 'dont', 'deny', 'いいえ', 'いや', 'だめ', 'ダメ', 'やだ', 'いらない', '不要', 'しない', 'やめとく', 'やめておく', '今はいい', 'まだいい', '聞いて', '毎回聞いて', 'このままで', 'このままでいい'];

/**
 * Whole-message classification for a pending yes/no question. 'yes' ONLY on
 * an exact match from the confirm vocabulary — never a substring, so "yes but
 * only for git status" or "OK, wait" stay 'unclear' and do nothing.
 */
export function classifyYesNo(raw: string): 'yes' | 'no' | 'unclear' {
  const t = (raw ?? '').trim().toLowerCase().replace(/[。.!！、,\s]+$/u, '');
  if (!t) return 'unclear';
  if (isCancelPhrase(t) || NO_PHRASES.includes(t)) return 'no';
  if (isConfirmPhrase(t) || EXTRA_YES.includes(t)) return 'yes';
  return 'unclear';
}

// ─── Deterministic parser ────────────────────────────────────────────────────

const CAPABILITY_PATTERNS: ReadonlyArray<[PolicyCapability, RegExp]> = [
  ['payment', /お金|支払|決済|購入|送金|課金|振込|振り込|買い物|\b(?:pay|payment|payments|purchase|purchases|money|checkout|billing|buy)\b/i],
  ['secret', /パスワード|秘密|鍵|トークン|認証情報|\b(?:secret|secrets|password|passwords|credential|credentials|api\s*keys?|token)\b/i],
  ['git-push', /プッシュ|\bgit\s+push\b|\bpush(?:es|ing)?\b/i],
  ['post', /投稿|ポスト|ツイート|ポストする|\b(?:post|posts|posting|tweet|tweets|publish)\b/i],
  ['message', /メッセージ|DM|返信|メール|\b(?:message|messages|dm|dms|reply|replies|email|emails)\b/i],
  ['fs-write', /書き込|書かない|書いて|保存|編集|削除|消さ|消し|\b(?:write|writes|writing|save|edit|modify|delete|remove)\b/i],
  ['network', /送信|通信|アップロード|外部に送|\b(?:send|sending|upload|network|internet)\b/i],
  ['exec', /実行|コマンド|シェル|\b(?:run|running|execute|command|commands|shell)\b/i],
];

const SERVICE_DOMAINS: ReadonlyArray<[RegExp, string]> = [
  [/(?:^|[^A-Za-z])X(?:へ|に|で|の|への|に対|$|[\s(（])|twitter|ツイッター|エックス/i, 'x.com'],
  [/slack|スラック/i, 'slack.com'],
  [/discord|ディスコード/i, 'discord.com'],
  [/bluesky|ブルースカイ|bsky/i, 'bsky.social'],
  [/github|ギットハブ/i, 'github.com'],
];

const EXPLICIT_DOMAIN_RE = /\b((?:[a-z0-9-]+\.)+[a-z]{2,24})\b/i;
const PATH_RE = /(~(?:\/[A-Za-z0-9_.\-/]*)?|\/[A-Za-z0-9_.\-/]+)/;
const OUTSIDE_JP_RE = /以外/;
const OUTSIDE_EN_RE = /\b(?:outside(?:\s+of)?|except|other\s+than|anywhere\s+but)\b/i;

export interface ParsedRuleCandidate {
  effect: PolicyEffect;
  match: PolicyRuleMatch;
}

function inferEffect(text: string): PolicyEffect | null {
  if (EFFECT_DRAFT_RE.test(text)) return 'draft_only';
  // 「勝手に投稿しないで」/"don't post on your own" = ask first, not a hard deny.
  if (EFFECT_ASK_RE.test(text)) return 'ask';
  if (EFFECT_DENY_RE.test(text) && STANDING_RE.test(text)) return 'deny';
  return null;
}

/**
 * Deterministic conversion for common phrasings. Returns a VALIDATED
 * candidate or null (the caller then tries the LLM, then gives up).
 */
export function parseRuleDeterministic(raw: string): ParsedRuleCandidate | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  const effect = inferEffect(text);
  if (!effect) return null;
  const match: PolicyRuleMatch = {};

  // Path scope first: "~/work以外には書き込まないで" / "don't write outside ~/work".
  const pathHit = text.match(PATH_RE);
  if (pathHit) {
    const p = pathHit[1].replace(/\/+$/, '') || pathHit[1];
    if (OUTSIDE_JP_RE.test(text) || OUTSIDE_EN_RE.test(text)) match.outsidePath = p;
    else match.pathPrefix = p;
  }

  for (const [cap, re] of CAPABILITY_PATTERNS) {
    if (re.test(text)) {
      match.capability = cap;
      break;
    }
  }
  // A path rule with no stated verb is about writing.
  if ((match.pathPrefix || match.outsidePath) && (!match.capability || !['fs-write', 'exec', 'read'].includes(match.capability))) {
    match.capability = 'fs-write';
  }

  for (const [re, domain] of SERVICE_DOMAINS) {
    if (re.test(text)) {
      match.domain = domain;
      break;
    }
  }
  if (!match.domain) {
    const d = text.match(EXPLICIT_DOMAIN_RE);
    if (d) {
      const nd = normalizeDomain(d[1]);
      // Don't read a filename ("notes.md") or the path we already took as a domain.
      if (nd && !/\.(?:md|txt|json|sh|js|ts|py|log|csv)$/i.test(nd) && !(pathHit && pathHit[1].includes(d[1]))) match.domain = nd;
    }
  }
  // "Xへの投稿" names a service, so the capability is at least `post`.
  if (match.domain && !match.capability) match.capability = 'post';

  if (!match.capability && !match.domain && !match.pathPrefix && !match.outsidePath) return null;
  const v = validatePolicyRule({ effect, match });
  return v.ok ? v.rule : null;
}

// ─── LLM pass ────────────────────────────────────────────────────────────────

export const POLICY_RULE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    effect: { type: 'string', enum: ['ask', 'deny', 'draft_only', 'none'] },
    capability: {
      type: 'string',
      enum: ['none', 'read', 'draft', 'notify', 'exec', 'fs-write', 'network', 'post', 'message', 'git-push', 'payment', 'secret'],
    },
    domain: { type: 'string' },
    pathPrefix: { type: 'string' },
    outsidePath: { type: 'string' },
    keywords: { type: 'array', items: { type: 'string' } },
  },
  required: ['effect'],
  additionalProperties: false,
};

const RULE_SYSTEM_PROMPT = `You convert ONE user safety rule for an autonomous phone agent into JSON.
Rules can only RESTRICT the agent. Output exactly one JSON object, no prose.
Fields:
- effect: "ask" (always ask the user first), "deny" (never do it), "draft_only" (stop at a draft, never send/post), or "none" if the text is not a restriction.
- capability: one of exec, fs-write, network, post, message, git-push, payment, secret, read, draft, notify, or "none".
- domain: a hostname like "x.com" when a service/site is named (X/Twitter => "x.com"), else omit.
- pathPrefix: a path the rule applies inside of ("~/work"), else omit.
- outsidePath: a path the rule applies OUTSIDE of ("write nowhere except ~/work" => "~/work"), else omit.
- keywords: up to 5 short lowercase words that identify the operation, else omit.
Never output "allow" or anything that grants permission.`;

export function buildPolicyRuleLlmMessages(utterance: string): OllamaMessage[] {
  return [
    { role: 'system', content: RULE_SYSTEM_PROMPT },
    { role: 'user', content: utterance.slice(0, 300) },
  ];
}

/** Parse + validate untrusted LLM output. Never throws; null on anything unusable. */
export function parsePolicyRuleLlmResponse(raw: string): ParsedRuleCandidate | null {
  if (!raw || !raw.trim()) return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  if (rec.effect === 'none' || typeof rec.effect !== 'string') return null;
  const match: Record<string, unknown> = {};
  if (typeof rec.capability === 'string' && rec.capability !== 'none') match.capability = rec.capability;
  for (const key of ['domain', 'pathPrefix', 'outsidePath'] as const) {
    if (typeof rec[key] === 'string' && (rec[key] as string).trim()) match[key] = rec[key];
  }
  if (Array.isArray(rec.keywords)) match.keywords = rec.keywords.slice(0, 5);
  // Anything else the model invented (e.g. an "allow" key) makes the payload
  // fail the closed schema below: copy only known keys, then validate.
  for (const key of Object.keys(rec)) {
    if (!['effect', 'capability', 'domain', 'pathPrefix', 'outsidePath', 'keywords'].includes(key)) return null;
  }
  const v: RuleValidation = validatePolicyRule({ effect: rec.effect, match });
  return v.ok ? v.rule : null;
}

export type PolicyChatFn = (
  config: LocalLlmConfig,
  messages: OllamaMessage[],
  timeoutMs?: number,
  externalSignal?: AbortSignal,
  maxTokens?: number,
  jsonSchema?: Record<string, unknown>,
) => Promise<{ success: boolean; content: string; error?: string }>;

/**
 * Deterministic first, then (optionally) the local LLM. Never throws: any
 * failure resolves to null, which the caller reports as "couldn't parse —
 * nothing was saved".
 */
export async function extractPolicyRule(
  utterance: string,
  llm: { config: LocalLlmConfig; enabled: boolean; chat?: PolicyChatFn } | null,
  timeoutMs = 15_000,
): Promise<{ candidate: ParsedRuleCandidate | null; via: 'deterministic' | 'llm' | 'none' }> {
  const det = parseRuleDeterministic(utterance);
  if (det) return { candidate: det, via: 'deterministic' };
  if (!llm || !llm.enabled || !llm.chat || !llm.config.baseUrl || !llm.config.model) return { candidate: null, via: 'none' };
  try {
    const res = await llm.chat(llm.config, buildPolicyRuleLlmMessages(utterance), timeoutMs, undefined, 200, POLICY_RULE_JSON_SCHEMA);
    if (!res.success || !res.content) return { candidate: null, via: 'none' };
    const parsed = parsePolicyRuleLlmResponse(res.content);
    return parsed ? { candidate: parsed, via: 'llm' } : { candidate: null, via: 'none' };
  } catch {
    return { candidate: null, via: 'none' };
  }
}

// ─── NL echo ─────────────────────────────────────────────────────────────────

const CAP_LABEL: Record<'en' | 'ja', Record<PolicyCapability, string>> = {
  en: {
    read: 'reading files',
    draft: 'saving drafts',
    notify: 'notifications',
    exec: 'running commands',
    'fs-write': 'writing files',
    network: 'sending data over the network',
    post: 'posting / sending externally',
    message: 'sending messages',
    'git-push': 'git push',
    payment: 'anything involving money',
    secret: 'touching secrets',
  },
  ja: {
    read: 'ファイルの読み取り',
    draft: '下書きの保存',
    notify: '通知',
    exec: 'コマンドの実行',
    'fs-write': 'ファイルへの書き込み',
    network: 'ネットワークへの送信',
    post: '投稿・外部への送信',
    message: 'メッセージの送信',
    'git-push': 'git push',
    payment: 'お金が絡む操作',
    secret: '秘密情報に触れる操作',
  },
};

/** One-line plain-language description of a rule (used for echo + listing). */
export function describePolicyRule(rule: Pick<PolicyRule, 'effect' | 'match'>, locale: 'en' | 'ja'): string {
  const m = rule.match;
  const subject = m.capability ? CAP_LABEL[locale][m.capability] : locale === 'ja' ? '副作用のある操作' : 'any side-effecting action';
  const kw = m.keywords && m.keywords.length ? m.keywords.map((k) => (locale === 'ja' ? `「${k}」` : `"${k}"`)).join(locale === 'ja' ? '' : ', ') : '';
  if (locale === 'ja') {
    const scope = [
      m.domain ? `${m.domain} への` : '',
      m.pathPrefix ? `${m.pathPrefix} 配下での` : '',
      m.outsidePath ? `${m.outsidePath} 以外の場所での` : '',
      kw ? `${kw}を含む` : '',
    ].join('');
    const target = `${scope}${subject}`;
    if (rule.effect === 'ask') return `${target}は、実行前に必ずあなたに確認します`;
    if (rule.effect === 'draft_only') return `${target}は下書きまでにして、実際の送信・投稿・実行はしません`;
    return `${target}は行いません（拒否）`;
  }
  const scope = [
    m.domain ? ` to ${m.domain}` : '',
    m.pathPrefix ? ` under ${m.pathPrefix}` : '',
    m.outsidePath ? ` outside ${m.outsidePath}` : '',
    kw ? ` mentioning ${kw}` : '',
  ].join('');
  const target = `${subject}${scope}`;
  if (rule.effect === 'ask') return `Always ask you before ${target}`;
  if (rule.effect === 'draft_only') return `Stop at a draft for ${target} — never actually send, post or run it`;
  return `Never do ${target} (deny)`;
}
