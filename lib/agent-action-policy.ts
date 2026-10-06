/**
 * lib/agent-action-policy.ts — POLICY-001 pure core: run origin, the closed
 * user-rule schema, and the single precedence evaluator shared by every
 * enforcement point.
 *
 * Three features live on top of this module (all behind AGENT_POLICY_ENV_FLAG,
 * default OFF, strangler pattern like SHELLY_CAP_BROKER / SHELLY_CAP_FS):
 *
 *   (A) Proactive runs are read-only. A run whose origin is an automatic
 *       trigger (schedule / notification / boot / event — or ANY origin we
 *       cannot positively identify) may read, summarize, draft and notify.
 *       Every side-effecting capability is escalated to the human (attended)
 *       or refused (unattended — there is nobody to ask).
 *   (B) Trust ramp (lib/agent-trust-ramp.ts). Scoped allow rules a human
 *       explicitly granted in chat after N clean approvals of one action class.
 *   (C) Natural-language custom rules (lib/agent-policy-rule-intent.ts). Rules
 *       can only TIGHTEN: the schema has no "allow" effect at all, and
 *       validatePolicyRule() rejects any payload that carries one.
 *
 * Precedence (evaluateActionPolicy) — first matching layer wins:
 *     deny / draft_only rules  >  proactive read-only  >  ask rules
 *       >  trust-ramp allows  >  existing defaults
 * so neither a trust-ramp allow nor any rule can ever loosen the proactive
 * floor, and a trust-ramp allow can never override a user's ask/deny rule.
 *
 * Enforcement points (each fails closed on its own):
 *   - Codex boundary gate: lib/agent-policy.ts decideAutoAnswer (bundled into
 *     shelly-gate-decide.js) — fine-grained, sees the literal command.
 *   - RN approval choke point: app/_layout.tsx drainAgentActionApprovalRequests
 *     — fine-grained, sees the full approval request; the only place a
 *     trust-ramp allow can auto-accept.
 *   - Executors (scripts/shelly-plan-executor.js + the generated .sh): coarse
 *     COMPILED rule lines (compilePolicyRuleLines below) + the proactive floor.
 *
 * Pure and IO-free (no store, no fs, no RN imports) so it is safe to bundle
 * into the Node gate helper and to unit-test exhaustively.
 */
import { checkCommandSafety, DangerLevel } from '@/lib/command-safety';
import { sha256Hex } from '@/lib/sha256';

/** .env key (synced from AppSettings.agentPolicyEngine) that turns the whole layer on. */
export const AGENT_POLICY_ENV_FLAG = 'SHELLY_AGENT_POLICY';
/** Env var native (AgentRuntime.kt) exports for every RUN_AGENT dispatch. */
export const RUN_ORIGIN_ENV = 'SHELLY_RUN_ORIGIN';
/** The user-policy file, relative to $HOME. The codex boundary gate already
 *  hard-denies any agent write to this exact path (agent-boundary-policy.ts
 *  'policy-write'), so it is the one place the agent cannot tamper with. */
export const USER_POLICY_RELATIVE_PATH = '.shelly/agents/policy.json';

// ─── (A) Run origin ──────────────────────────────────────────────────────────

/**
 * Where a run came from. `user` = an in-app "Run now" / `@agent` / chat-driven
 * run; `widget` = a home-screen widget tap (unattended — no Activity — but
 * still a deliberate human action). Everything else is PROACTIVE.
 */
export type RunOrigin = 'user' | 'widget' | 'schedule' | 'notification' | 'boot' | 'event';

export const RUN_ORIGINS: readonly RunOrigin[] = Object.freeze([
  'user',
  'widget',
  'schedule',
  'notification',
  'boot',
  'event',
]);

/** Origins a human deliberately initiated. Deliberately a short allowlist. */
const USER_INITIATED_ORIGINS: readonly RunOrigin[] = Object.freeze(['user', 'widget']);

/** Normalise an untrusted origin string. Anything unrecognised is 'unknown'. */
export function normalizeRunOrigin(raw: unknown): RunOrigin | 'unknown' {
  if (typeof raw !== 'string') return 'unknown';
  const v = raw.trim().toLowerCase();
  return (RUN_ORIGINS as readonly string[]).includes(v) ? (v as RunOrigin) : 'unknown';
}

/**
 * FAIL-CLOSED: only a positively identified user-initiated origin is
 * non-proactive. A missing env var (stale native build, a future caller that
 * forgot to set it), a typo, or a forged value all read as proactive.
 */
export function isProactiveOrigin(raw: unknown): boolean {
  const origin = normalizeRunOrigin(raw);
  return !(USER_INITIATED_ORIGINS as readonly string[]).includes(origin);
}

// ─── Capabilities ────────────────────────────────────────────────────────────

/**
 * Closed capability vocabulary for rules and action descriptors. `read`,
 * `draft` and `notify` are the read-only class (A); everything else is
 * side-effecting. `payment` and `secret` exist so rules can name them and so
 * the trust ramp can refuse them — they are never inferred as "safe".
 */
export type PolicyCapability =
  | 'read'
  | 'draft'
  | 'notify'
  | 'exec'
  | 'fs-write'
  | 'network'
  | 'post'
  | 'message'
  | 'git-push'
  | 'payment'
  | 'secret';

export const POLICY_CAPABILITIES: readonly PolicyCapability[] = Object.freeze([
  'read',
  'draft',
  'notify',
  'exec',
  'fs-write',
  'network',
  'post',
  'message',
  'git-push',
  'payment',
  'secret',
]);

export const READ_ONLY_CAPABILITIES: readonly PolicyCapability[] = Object.freeze(['read', 'draft', 'notify']);

/** Outbound sub-capabilities a `network` rule also covers. */
const NETWORK_SUBCAPS: readonly PolicyCapability[] = Object.freeze(['post', 'message', 'git-push']);

export function hasSideEffect(caps: readonly PolicyCapability[]): boolean {
  return caps.some((c) => !READ_ONLY_CAPABILITIES.includes(c));
}

// ─── (C) Rule schema ─────────────────────────────────────────────────────────

/** Tighten-only. There is intentionally no 'allow'. */
export type PolicyEffect = 'ask' | 'deny' | 'draft_only';
export const POLICY_EFFECTS: readonly PolicyEffect[] = Object.freeze(['ask', 'deny', 'draft_only']);

export interface PolicyRuleMatch {
  capability?: PolicyCapability;
  /** Hostname; matches itself and any subdomain ("x.com" matches "api.x.com"). */
  domain?: string;
  /** Applies to targets UNDER this path ("~" = the user's home). */
  pathPrefix?: string;
  /** Applies to targets NOT under this path ("~/work以外には書き込まないで"). */
  outsidePath?: string;
  /** Case-insensitive substrings of the command / preview / destination; OR-ed. */
  keywords?: string[];
}

export interface PolicyRule {
  id: string;
  effect: PolicyEffect;
  match: PolicyRuleMatch;
  /** The user's original utterance, kept for listing/revoking. Display only. */
  source: string;
  createdAt: number;
}

export const MAX_RULE_KEYWORDS = 12;
export const MAX_KEYWORD_LEN = 40;
export const MAX_RULE_SOURCE_LEN = 300;
const MATCH_KEYS = ['capability', 'domain', 'pathPrefix', 'outsidePath', 'keywords'] as const;
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// Keywords travel into the executors' compiled rule lines (pipe-delimited,
// one JSON string per line, parsed by bash `sed`), so the characters that
// would break that framing are rejected outright rather than escaped.
const KEYWORD_FORBIDDEN_RE = /[\u0000-\u001f\u007f"\\|`$]/;

export type RuleValidation =
  | { ok: true; rule: Omit<PolicyRule, 'id' | 'createdAt' | 'source'> }
  | { ok: false; reason: string };

/** Lowercase + strip scheme/path/"www." so "https://www.X.com/home" → "x.com". */
export function normalizeDomain(raw: string): string | null {
  let v = String(raw || '').trim().toLowerCase();
  if (!v) return null;
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  v = v.split(/[/?#:]/)[0] || '';
  v = v.replace(/^www\./, '').replace(/\.$/, '');
  return DOMAIN_RE.test(v) ? v : null;
}

/** Accepts "/abs", "~", "~/rel"; rejects relative, NUL and any ".." segment. */
export function normalizeRulePath(raw: string): string | null {
  let v = String(raw || '').trim();
  if (!v || v.includes('\0') || KEYWORD_FORBIDDEN_RE.test(v)) return null;
  if (v !== '~' && !v.startsWith('~/') && !v.startsWith('/')) return null;
  if (v.split('/').some((seg) => seg === '..')) return null;
  v = v.replace(/\/{2,}/g, '/');
  if (v.length > 1) v = v.replace(/\/+$/, '');
  return v || null;
}

/**
 * Validate an UNTRUSTED rule payload (LLM output, a hand-edited file, the
 * deterministic parser). Closed schema: unknown top-level or match keys,
 * any effect outside POLICY_EFFECTS (notably 'allow' / 'grant'), an empty
 * match, or malformed values all reject — nothing is "best-effort repaired"
 * into a weaker rule.
 */
export function validatePolicyRule(raw: unknown): RuleValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'rule is not an object' };
  const rec = raw as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (key !== 'effect' && key !== 'match') return { ok: false, reason: `unknown rule field "${key}"` };
  }
  const effect = rec.effect;
  if (typeof effect !== 'string' || !(POLICY_EFFECTS as readonly string[]).includes(effect)) {
    return { ok: false, reason: `effect must be one of ${POLICY_EFFECTS.join('/')} (rules can only tighten)` };
  }
  const m = rec.match;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, reason: 'match is not an object' };
  const mrec = m as Record<string, unknown>;
  for (const key of Object.keys(mrec)) {
    if (!(MATCH_KEYS as readonly string[]).includes(key)) return { ok: false, reason: `unknown match field "${key}"` };
  }
  const match: PolicyRuleMatch = {};
  if (mrec.capability !== undefined && mrec.capability !== null) {
    if (typeof mrec.capability !== 'string' || !(POLICY_CAPABILITIES as readonly string[]).includes(mrec.capability)) {
      return { ok: false, reason: 'unknown capability' };
    }
    match.capability = mrec.capability as PolicyCapability;
  }
  if (mrec.domain !== undefined && mrec.domain !== null && mrec.domain !== '') {
    if (typeof mrec.domain !== 'string') return { ok: false, reason: 'domain must be a string' };
    const d = normalizeDomain(mrec.domain);
    if (!d) return { ok: false, reason: 'domain is not a valid hostname' };
    match.domain = d;
  }
  for (const key of ['pathPrefix', 'outsidePath'] as const) {
    const v = mrec[key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string') return { ok: false, reason: `${key} must be a string` };
    const p = normalizeRulePath(v);
    if (!p) return { ok: false, reason: `${key} must be an absolute or ~/ path without ".."` };
    match[key] = p;
  }
  if (match.pathPrefix && match.outsidePath) return { ok: false, reason: 'pathPrefix and outsidePath are mutually exclusive' };
  if (mrec.keywords !== undefined && mrec.keywords !== null) {
    if (!Array.isArray(mrec.keywords)) return { ok: false, reason: 'keywords must be an array' };
    const kws: string[] = [];
    for (const kw of mrec.keywords) {
      if (typeof kw !== 'string') return { ok: false, reason: 'keyword must be a string' };
      const k = kw.trim().toLowerCase();
      if (!k) continue;
      if (k.length > MAX_KEYWORD_LEN || KEYWORD_FORBIDDEN_RE.test(k)) return { ok: false, reason: 'keyword is too long or has forbidden characters' };
      if (!kws.includes(k)) kws.push(k);
    }
    if (kws.length > MAX_RULE_KEYWORDS) return { ok: false, reason: `at most ${MAX_RULE_KEYWORDS} keywords` };
    if (kws.length) match.keywords = kws;
  }
  if (!match.capability && !match.domain && !match.pathPrefix && !match.outsidePath && !match.keywords) {
    return { ok: false, reason: 'rule matches nothing' };
  }
  // A path scope only makes sense for something that touches the filesystem.
  if ((match.pathPrefix || match.outsidePath) && match.capability && !['fs-write', 'exec', 'read'].includes(match.capability)) {
    return { ok: false, reason: 'path scopes only apply to fs-write/exec/read' };
  }
  return { ok: true, rule: { effect: effect as PolicyEffect, match } };
}

/** Parse a stored rule list, silently DROPPING invalid entries (never repairing). */
export function parseStoredRules(raw: unknown): PolicyRule[] {
  if (!Array.isArray(raw)) return [];
  const out: PolicyRule[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const v = validatePolicyRule({ effect: e.effect, match: e.match });
    if (!v.ok) continue;
    if (typeof e.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(e.id)) continue;
    out.push({
      id: e.id,
      effect: v.rule.effect,
      match: v.rule.match,
      source: typeof e.source === 'string' ? e.source.slice(0, MAX_RULE_SOURCE_LEN) : '',
      createdAt: typeof e.createdAt === 'number' && Number.isFinite(e.createdAt) ? e.createdAt : 0,
    });
  }
  return out;
}

// ─── Action descriptors ──────────────────────────────────────────────────────

/** Everything the evaluator needs to know about ONE proposed action. */
export interface ActionDescriptor {
  /** Action-approval type, or 'command' for a codex-proposed shell command. */
  kind: string;
  capabilities: PolicyCapability[];
  origin: RunOrigin | 'unknown';
  /** Lowercased destination hosts. */
  hosts: string[];
  /** Absolute / ~-relative target paths (cwd stands in when none are explicit). */
  paths: string[];
  /** Lowercased haystack for keyword rules (command + preview + destination). */
  text: string;
  dangerLevel: DangerLevel;
  /** Normalised command class ("git status", "npm test") — display/audit
   *  only. NEVER a trust key: a class groups `npm test` with
   *  `npm test; python3 evil.py` (security review H1). */
  commandClass: string;
  /** The exact command (cli / codex) or '' — what the trust ramp keys on. */
  command: string;
  /** Workspace/agent scope for the trust ramp. */
  scope: string;
}

// ─── Trust-ramp eligibility + exact-command key (security review H1) ─────────

/** Shell metacharacters that can chain, substitute, redirect, glob or expand
 *  (`* ? [ ] ~ !` too — review R2: a glob or `~`/history expansion means the
 *  executed argv is not the literal string that was approved). */
const TRUST_FORBIDDEN_CHARS_RE = /[;&|`$()<>\r\n\\{}*?[\]~!]/;
/** Only printable ASCII plus space/tab (review R1): any other whitespace or a
 *  non-ASCII lookalike could make two different commands normalise alike. */
const TRUST_NON_PLAIN_RE = /[^\x20-\x7e\t]/;
/** Heads that run other code (interpreters / trampolines / wrappers). */
const TRUST_TRAMPOLINE_HEADS = new Set([
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'csh', 'tcsh', 'ash',
  'python', 'python2', 'python3', 'pypy', 'pypy3', 'node', 'nodejs', 'deno', 'bun', 'npx', 'bunx',
  'make', 'gmake', 'env', 'eval', 'exec', 'xargs', 'su', 'sudo', 'doas', 'busybox', 'toybox',
  'perl', 'ruby', 'php', 'lua', 'luajit', 'tclsh', 'awk', 'gawk', 'mawk', 'nawk', 'sed',
  'nohup', 'timeout', 'nice', 'ionice', 'time', 'command', 'builtin', 'source', '.', 'watch',
  'ssh', 'script', 'expect', 'linker64', 'run-as', 'am', 'pm', 'cmd', 'sh.exe',
  'osascript', 'powershell', 'pwsh', 'chroot', 'unshare', 'nsenter', 'setsid', 'stdbuf', 'strace',
  // Review R3: build tools whose every invocation runs project-defined code
  // (build scripts, plugins) that can change between approvals.
  'gradle', 'gradlew', 'mvn', 'mvnw', 'ant', 'sbt', 'bazel', 'rake', 'just', 'task',
]);
/** Sub-commands that are themselves trampolines or run project-defined code
 *  ("pnpm dlx", "npm test" → package.json scripts, "git commit" → hooks). */
const TRUST_TRAMPOLINE_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  npm: ['exec', 'x', 'explore', 'test', 't', 'run', 'run-script', 'start', 'restart', 'stop', 'install-test', 'it'],
  pnpm: ['dlx', 'exec', 'x', 'test', 't', 'run', 'start'],
  yarn: ['dlx', 'exec', 'test', 'run', 'start', 'node'],
  cargo: ['run', 'test', 'bench', 'r', 't'],
  go: ['run', 'test', 'generate'],
  git: [
    '-c', '--config-env', '--exec-path', 'config', 'submodule', 'filter-branch', 'bisect',
    'commit', 'merge', 'rebase', 'pull', 'am', 'cherry-pick', 'revert', 'push', 'checkout', 'switch', 'worktree', 'gc',
  ],
});

/** Normalised command (the exact thing a trust key is a hash of): only runs
 *  of plain space/tab collapse (review R1). */
export function normalizeTrustCommand(command: string): string {
  return String(command || '').replace(/^[ \t]+|[ \t]+$/g, '').replace(/[ \t]+/g, ' ');
}

/**
 * True when an exact command may EVER be trust-ramped: no chaining /
 * substitution / redirection characters, no leading env assignment, and its
 * head is not an interpreter or trampoline (incl. `sed -i`, `find -exec`,
 * `git -c`, `pnpm dlx`). Conservative on purpose: false negatives only cost
 * the user one more approval tap.
 */
export function isTrustEligibleCommand(command: string): boolean {
  const c = normalizeTrustCommand(command);
  if (!c || c.length > 200) return false;
  if (TRUST_NON_PLAIN_RE.test(command) || TRUST_FORBIDDEN_CHARS_RE.test(command)) return false;
  const words = c.split(' ');
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) return false;
  const head = (words[0].split('/').pop() || '').toLowerCase();
  if (!head || words[0].includes('/')) return false; // a path-qualified binary could be anything
  if (TRUST_TRAMPOLINE_HEADS.has(head) || /^python\d/.test(head)) return false;
  const subs = TRUST_TRAMPOLINE_SUBCOMMANDS[head];
  // Flags compare case-sensitively (`git -C dir` is fine, `git -c k=v` is a
  // trampoline); sub-command words case-insensitively.
  const isSub = (w: string) =>
    w.startsWith('-')
      ? subs!.some((s) => s.startsWith('-') && (w === s || w.startsWith(`${s}=`) || (s.length === 2 && w.startsWith(s) && w.length > 2)))
      : subs!.includes(w.toLowerCase());
  if (subs && words.slice(1).some(isSub)) return false;
  if (head === 'find' && words.some((w) => /^-(?:exec|execdir|ok|okdir|delete|fprint)/.test(w))) return false;
  return true;
}

/** Capabilities the trust ramp must never auto-allow, whatever the count. */
export const TRUST_RAMP_EXCLUDED_CAPABILITIES: readonly PolicyCapability[] = Object.freeze([
  'payment',
  'secret',
  'post',
  'message',
  'network',
  'git-push',
]);

const TRUST_SCOPE_RE = /^[A-Za-z0-9_.-]{1,200}$/;

/**
 * The trust key for a descriptor — `cli|<sha256(agentId,cli,exactCommand)>|agentId`
 * — or null when it may never be trust-ramped. Single source of truth used
 * at COUNT time (lib/agent-trust-ramp.ts) and re-checked at USE time inside
 * evaluateActionPolicy.
 */
export function trustKeyForDescriptor(desc: ActionDescriptor): string | null {
  if (desc.kind !== 'cli') return null;
  if (isProactiveOrigin(desc.origin)) return null;
  if (desc.dangerLevel === 'CRITICAL' || desc.dangerLevel === 'HIGH') return null;
  if (!hasSideEffect(desc.capabilities)) return null;
  if (desc.capabilities.some((c) => TRUST_RAMP_EXCLUDED_CAPABILITIES.includes(c))) return null;
  if (!isTrustEligibleCommand(desc.command)) return null;
  if (!TRUST_SCOPE_RE.test(desc.scope || '')) return null;
  const hash = sha256Hex(`${desc.scope}\n${desc.kind}\n${normalizeTrustCommand(desc.command)}`);
  return `${desc.kind}|${hash}|${desc.scope}`;
}

const PAYMENT_HINT_RE = /(?:\b(?:pay|payment|purchase|checkout|invoice|stripe|paypal|billing|transfer|wire)\b|支払|決済|購入|送金|振込|振り込|課金|お金|代金|請求)/i;
const SECRET_HINT_RE = /(?:\.env\b|auth\.json|\.ssh\/|id_rsa|keystore|\b(?:api[_-]?key|token|secret|password|passwd)\b|パスワード|秘密鍵|トークン)/i;
const GIT_PUSH_RE = /\bgit\s+(?:-[^\s]+\s+)*push\b/;
const NETWORK_CMD_RE = /\b(?:curl|wget|nc|ncat|ssh|scp|sftp|rsync|ftp|telnet)\b/;
const NETWORK_SEND_FLAG_RE = /(?:\s-X\s*(?:POST|PUT|PATCH|DELETE)\b|\s--data(?:-[a-z]+)?\b|\s-d\s|\s-F\s|\s--form\b|\s-T\s|\s--upload-file\b)/i;
const FS_WRITE_RE = /(?:>>?|\s-(?:delete|exec|execdir|ok)\b|\b(?:rm|rmdir|mv|cp|mkdir|touch|tee|ln|chmod|chown|truncate|dd|install|unzip|tar)\b|\bsed\s+(?:-[a-zA-Z]*i|--in-place)|\bgit\s+(?:commit|checkout|reset|merge|rebase|clean|stash|add|rm|mv|apply|pull|clone)\b|\b(?:npm|pnpm|yarn)\s+(?:install|i|add|remove|uninstall|update|ci)\b|\bpip3?\s+install\b)/;
const PURE_READ_RE = /^\s*(?:cat|ls|pwd|echo|printf|head|tail|wc|grep|rg|find|stat|file|du|df|which|type|env|printenv|date|whoami|uname|tree|less|more|sort|uniq|cut|jq|git\s+(?:status|log|diff|show|branch|remote|rev-parse|ls-files|blame)|true|false)\b/;
const URL_HOST_RE = /\bhttps?:\/\/(\[[0-9a-fA-F:]+\]|[^/\s:'"`]+)/gi;
const PATH_TOKEN_RE = /(?:^|[\s='"(])((?:~|\/)[^\s'"`;|&<>()]*)/g;
const MULTI_WORD_TOOLS = new Set(['git', 'npm', 'pnpm', 'yarn', 'npx', 'docker', 'kubectl', 'gh', 'cargo', 'go', 'pip', 'pip3', 'python', 'python3', 'node', 'make', 'shelly']);

function extractHosts(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL_HOST_RE)) {
    const h = m[1].toLowerCase().replace(/^\[|\]$/g, '');
    if (h && !out.includes(h)) out.push(h);
  }
  return out;
}

function extractPathTokens(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(PATH_TOKEN_RE)) {
    const p = m[1];
    if (!p || p.startsWith('//')) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * Normalised command class: basename of the first word, plus the first
 * non-flag sub-command for multi-command tools. "git -C x push origin" →
 * "git push"; "/usr/bin/ls -la" → "ls". Leading `VAR=x` assignments and
 * `sudo`/`env` wrappers are skipped. Empty for an empty command.
 */
export function commandClassOf(command: string): string {
  const words = String(command || '').trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || words[i] === 'sudo' || words[i] === 'env' || words[i] === 'command')) i += 1;
  if (i >= words.length) return '';
  const head = (words[i].split('/').pop() || '').toLowerCase();
  if (!MULTI_WORD_TOOLS.has(head)) return head;
  for (let j = i + 1; j < words.length; j += 1) {
    const w = words[j];
    if (w.startsWith('-')) {
      // Flags with a separate value we know about ("git -C dir").
      if ((head === 'git' && (w === '-C' || w === '-c')) || w === '--prefix') j += 1;
      continue;
    }
    return `${head} ${w.toLowerCase().replace(/[^a-z0-9:_.-]/g, '')}`.trim();
  }
  return head;
}

/** Infer capabilities of a raw shell command. Conservative: unknown ⇒ exec. */
export function commandCapabilities(command: string): PolicyCapability[] {
  const c = String(command || '');
  const caps: PolicyCapability[] = [];
  const add = (cap: PolicyCapability) => {
    if (!caps.includes(cap)) caps.push(cap);
  };
  if (!c.trim()) return ['read'];
  if (GIT_PUSH_RE.test(c)) add('git-push');
  if (NETWORK_CMD_RE.test(c)) {
    add('network');
    if (NETWORK_SEND_FLAG_RE.test(c)) add('post');
  }
  if (PAYMENT_HINT_RE.test(c)) add('payment');
  if (SECRET_HINT_RE.test(c)) add('secret');
  if (FS_WRITE_RE.test(c)) add('fs-write');
  const compound = /[;&|`]|\$\(/.test(c);
  if (!caps.length && PURE_READ_RE.test(c) && !compound) return ['read'];
  // Anything that is not a recognised pure read is an executed side effect.
  add('exec');
  return caps;
}

function lowerHaystack(...parts: Array<string | null | undefined>): string {
  return parts.filter((p) => typeof p === 'string' && p).join('\n').toLowerCase();
}

/** Descriptor for a codex-proposed shell command (the boundary gate). */
export function describeCommandAction(opts: {
  command: string;
  origin: unknown;
  cwd?: string;
  scope?: string;
}): ActionDescriptor {
  const command = String(opts.command || '');
  const paths = extractPathTokens(command);
  if (!paths.length && opts.cwd) paths.push(opts.cwd);
  return {
    kind: 'command',
    capabilities: commandCapabilities(command),
    origin: normalizeRunOrigin(opts.origin),
    hosts: extractHosts(command),
    paths,
    text: lowerHaystack(command),
    dangerLevel: checkCommandSafety(command).level,
    commandClass: commandClassOf(command),
    command,
    scope: opts.scope || opts.cwd || '',
  };
}

/** The subset of an action-approval request (see app/_layout.tsx) we classify. */
export interface ApprovalRequestLike {
  agentId?: string | null;
  actionType: string;
  preview?: string | null;
  destinationHost?: string | null;
  command?: string | null;
  safetyLevel?: string | null;
  intentMode?: string | null;
  intentTarget?: string | null;
  intentShareText?: string | null;
  dmReplyText?: string | null;
  origin?: string | null;
}

/** Capabilities of an approval-request action type. Unknown type ⇒ exec (side effect). */
export function actionTypeCapabilities(actionType: string, details: { command?: string | null; intentMode?: string | null } = {}): PolicyCapability[] {
  switch (actionType) {
    case 'draft':
    case '__suppressed__':
      return ['draft'];
    case 'notify':
      return ['notify'];
    case 'webhook':
    case 'api-call':
      return ['network', 'post'];
    case 'social-post':
      return ['network', 'post'];
    case 'dm-reply':
      return ['network', 'message'];
    case 'intent':
      return details.intentMode === 'launch' ? ['exec'] : ['message'];
    case 'browser-pane':
      return ['network', 'post'];
    case 'cli': {
      const caps = commandCapabilities(details.command || '');
      // A cli action is always an executed process, even a "read" one.
      return caps.includes('exec') ? caps : [...caps.filter((c) => c !== 'read'), 'exec'];
    }
    default:
      return ['exec'];
  }
}

const DANGER_LEVELS: readonly DangerLevel[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'SAFE'];

export function describeApprovalRequest(req: ApprovalRequestLike): ActionDescriptor {
  const command = req.command || '';
  const caps = actionTypeCapabilities(req.actionType, { command, intentMode: req.intentMode });
  const text = lowerHaystack(req.preview, command, req.destinationHost, req.intentTarget, req.intentShareText, req.dmReplyText);
  // A draft / notification that merely MENTIONS money is still read-only
  // (it moves nothing); only a side-effecting action gains `payment`.
  if (PAYMENT_HINT_RE.test(text) && !caps.includes('payment') && hasSideEffect(caps)) caps.push('payment');
  const hosts = extractHosts(lowerHaystack(command, req.intentTarget));
  const dest = (req.destinationHost || '').trim().toLowerCase();
  if (dest && !hosts.includes(dest)) hosts.unshift(dest);
  const reported = DANGER_LEVELS.includes(req.safetyLevel as DangerLevel) ? (req.safetyLevel as DangerLevel) : 'SAFE';
  const computed = command ? checkCommandSafety(command).level : 'SAFE';
  // Take the WORSE of the executor-reported and recomputed level.
  const dangerLevel = DANGER_LEVELS.indexOf(computed) < DANGER_LEVELS.indexOf(reported) ? computed : reported;
  return {
    kind: req.actionType,
    capabilities: caps,
    origin: normalizeRunOrigin(req.origin),
    hosts,
    paths: extractPathTokens(command),
    text,
    dangerLevel,
    commandClass: req.actionType === 'cli' ? commandClassOf(command) : req.actionType === 'intent' ? `intent ${req.intentMode || ''}`.trim() : req.actionType,
    command: req.actionType === 'cli' ? command : '',
    scope: req.agentId || '',
  };
}

// ─── Matching ────────────────────────────────────────────────────────────────

function expandHome(p: string, homeDir: string): string {
  if (!homeDir) return p;
  if (p === '~') return homeDir;
  if (p.startsWith('~/')) return `${homeDir.replace(/\/+$/, '')}/${p.slice(2)}`;
  return p;
}

function lexicalNormalize(p: string): string {
  const abs = p.startsWith('/');
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length) out.pop();
      continue;
    }
    out.push(seg);
  }
  return (abs ? '/' : '') + out.join('/');
}

function isUnder(target: string, prefix: string, homeDir: string): boolean {
  const t = lexicalNormalize(expandHome(target, homeDir));
  const p = lexicalNormalize(expandHome(prefix, homeDir));
  if (!p || p === '/') return t.startsWith('/') || t === p;
  return t === p || t.startsWith(`${p}/`);
}

function capabilityMatches(ruleCap: PolicyCapability, caps: readonly PolicyCapability[]): boolean {
  if (caps.includes(ruleCap)) return true;
  if (ruleCap === 'network') return caps.some((c) => NETWORK_SUBCAPS.includes(c));
  return false;
}

function hostMatches(domain: string, hosts: readonly string[]): boolean {
  return hosts.some((h) => h === domain || h.endsWith(`.${domain}`));
}

/** AND across present match fields; keywords OR among themselves. */
export function ruleMatches(rule: Pick<PolicyRule, 'match'>, desc: ActionDescriptor, homeDir = ''): boolean {
  const m = rule.match;
  if (m.capability && !capabilityMatches(m.capability, desc.capabilities)) return false;
  if (m.domain && !hostMatches(m.domain, desc.hosts)) return false;
  if (m.pathPrefix && !desc.paths.some((p) => isUnder(p, m.pathPrefix!, homeDir))) return false;
  if (m.outsidePath) {
    // "Never write outside ~/work": only a mutating action can violate it, and
    // an action whose target we could not determine at all counts as outside
    // (fail-closed) — never as "inside".
    if (!hasSideEffect(desc.capabilities)) return false;
    if (desc.paths.length && desc.paths.every((p) => isUnder(p, m.outsidePath!, homeDir))) return false;
  }
  if (m.keywords && !m.keywords.some((k) => desc.text.includes(k))) return false;
  return true;
}

// ─── Evaluation ──────────────────────────────────────────────────────────────

export type PolicyDecision = 'deny' | 'draft_only' | 'ask' | 'allow' | 'default';
export type PolicyLayer = 'deny-rule' | 'proactive' | 'ask-rule' | 'trust-allow' | 'default' | 'disabled';

export interface PolicyVerdict {
  decision: PolicyDecision;
  layer: PolicyLayer;
  reason: string;
  ruleId?: string;
}

/** Minimal shape of a trust-ramp allow the evaluator consumes (see agent-trust-ramp.ts). */
export interface TrustAllowLike {
  id: string;
  key: string;
}

export interface PolicyState {
  enabled: boolean;
  rules: readonly PolicyRule[];
  trustAllows?: readonly TrustAllowLike[];
  /** Expands "~" in path rules. */
  homeDir?: string;
  /**
   * Set when the policy file could not be read/parsed while the flag is ON.
   * We cannot know what the user's rules say, so every side-effecting action
   * is escalated (ask) and no trust allow is honoured.
   */
  rulesUnavailable?: boolean;
}

/**
 * The single precedence evaluator. Returns 'default' when no layer has an
 * opinion, meaning "keep the existing behaviour of the caller's gate".
 * 'allow' is only ever produced by a trust-ramp allow, and only for a
 * user-initiated, non-CRITICAL/HIGH action with no matching user rule.
 */
export function evaluateActionPolicy(desc: ActionDescriptor, state: PolicyState): PolicyVerdict {
  if (!state.enabled) return { decision: 'default', layer: 'disabled', reason: 'policy engine disabled' };
  const homeDir = state.homeDir || '';
  const sideEffect = hasSideEffect(desc.capabilities);

  // 1. deny / draft_only rules — strongest effect among matches; deny > draft_only.
  let draftOnly: PolicyRule | null = null;
  for (const rule of state.rules) {
    if (rule.effect !== 'deny' && rule.effect !== 'draft_only') continue;
    if (!ruleMatches(rule, desc, homeDir)) continue;
    if (rule.effect === 'deny') return { decision: 'deny', layer: 'deny-rule', reason: `user rule: ${rule.source || rule.id}`, ruleId: rule.id };
    if (!draftOnly) draftOnly = rule;
  }
  // draft_only only constrains things that would leave the draft stage.
  if (draftOnly && sideEffect) {
    return { decision: 'draft_only', layer: 'deny-rule', reason: `user rule (draft only): ${draftOnly.source || draftOnly.id}`, ruleId: draftOnly.id };
  }

  // 2. proactive read-only floor.
  if (sideEffect && isProactiveOrigin(desc.origin)) {
    return { decision: 'ask', layer: 'proactive', reason: `proactive run (origin=${desc.origin}) may only read/draft/notify` };
  }

  // 3. ask rules.
  for (const rule of state.rules) {
    if (rule.effect !== 'ask') continue;
    if (!ruleMatches(rule, desc, homeDir)) continue;
    return { decision: 'ask', layer: 'ask-rule', reason: `user rule: ${rule.source || rule.id}`, ruleId: rule.id };
  }

  if (state.rulesUnavailable) {
    return sideEffect
      ? { decision: 'ask', layer: 'ask-rule', reason: 'user policy file unreadable — escalating (fail-closed)' }
      : { decision: 'default', layer: 'default', reason: 'read-only action' };
  }

  // 4. trust-ramp allows. Eligibility (origin, danger level, excluded
  // capabilities, no chaining / trampoline) AND the exact-command hash are
  // all recomputed HERE from the live descriptor at use time — a stored key
  // is only a lookup, never a grant on its own.
  if (sideEffect && state.trustAllows && state.trustAllows.length) {
    const key = trustKeyForDescriptor(desc);
    if (key) {
      const hit = state.trustAllows.find((a) => a.key === key);
      if (hit) return { decision: 'allow', layer: 'trust-allow', reason: `trust-ramp allow ${hit.id}`, ruleId: hit.id };
    }
  }

  return { decision: 'default', layer: 'default', reason: 'no policy opinion' };
}

// ─── Compiled rule lines for the executors ───────────────────────────────────

/** Action types that have side effects (everything except draft/notify). */
export const SIDE_EFFECT_ACTION_TYPES: readonly string[] = Object.freeze([
  'webhook',
  'cli',
  'intent',
  'dm-reply',
  'api-call',
  'social-post',
  'browser-pane',
]);

const ALL_POLICY_ACTION_TYPES: readonly string[] = Object.freeze(['draft', 'notify', ...SIDE_EFFECT_ACTION_TYPES]);

const CAPABILITY_ACTION_TYPES: Readonly<Record<PolicyCapability, readonly string[]>> = Object.freeze({
  read: [],
  draft: ['draft'],
  notify: ['notify'],
  exec: ['cli', 'intent'],
  'fs-write': ['cli'],
  network: ['webhook', 'api-call', 'social-post', 'dm-reply', 'browser-pane', 'intent'],
  post: ['webhook', 'api-call', 'social-post', 'browser-pane'],
  message: ['dm-reply', 'intent'],
  'git-push': ['cli'],
  payment: SIDE_EFFECT_ACTION_TYPES,
  secret: ['cli'],
});

/** Default keywords a bare `payment` rule implies at the (text-only) executor level. */
export const PAYMENT_KEYWORDS: readonly string[] = Object.freeze([
  'pay', 'payment', 'purchase', 'checkout', 'invoice', 'stripe', 'paypal', 'billing',
  '支払', '決済', '購入', '送金', '振込', '課金',
]);

/**
 * Compile rules into the coarse `effect|actionType|domain|keyword` lines the
 * executors evaluate (one rule may expand to several lines; a line with an
 * empty keyword matches without a keyword test). Coarsening is always in the
 * TIGHTER direction except one deliberate case: a path-scoped rule cannot be
 * evaluated precisely at the action level (the executor does not know which
 * paths a cli command touches), so it compiles to `ask:cli` — the human sees
 * the command — while the codex gate enforces the precise deny.
 */
export function compilePolicyRuleLines(rules: readonly PolicyRule[]): string[] {
  const out: string[] = [];
  const push = (line: string) => {
    if (!out.includes(line)) out.push(line);
  };
  for (const rule of rules) {
    const m = rule.match;
    const pathScoped = !!(m.pathPrefix || m.outsidePath);
    const effect: PolicyEffect = pathScoped ? 'ask' : rule.effect;
    // A rule with no capability ("anything mentioning X") applies to every
    // action type, drafts included — exactly like the TS evaluator (L4: the
    // executors must never be looser than the reference). draft_only still
    // exempts read-only types at evaluation time.
    let types: readonly string[] = m.capability ? CAPABILITY_ACTION_TYPES[m.capability] : ALL_POLICY_ACTION_TYPES;
    if (pathScoped) types = ['cli'];
    let keywords: readonly string[] = m.keywords && m.keywords.length ? m.keywords : [''];
    if (m.capability === 'payment' && !(m.keywords && m.keywords.length)) keywords = PAYMENT_KEYWORDS;
    if (m.capability === 'secret' && !(m.keywords && m.keywords.length)) types = ['cli'];
    for (const type of types) {
      for (const kw of keywords) push(`${effect}|${type}|${m.domain || ''}|${kw}`);
    }
  }
  return out;
}

/**
 * The executor-side evaluator over compiled lines, kept here as the reference
 * implementation the JS/bash twins are tested against
 * (__tests__/agent-action-policy-executor-parity.test.ts).
 */
export function evaluateCompiledLines(
  lines: readonly string[],
  actionType: string,
  host: string,
  text: string,
): PolicyEffect | '' {
  const h = (host || '').toLowerCase();
  const hay = (text || '').toLowerCase();
  let best: PolicyEffect | '' = '';
  const rank = (e: string) => (e === 'deny' ? 3 : e === 'draft_only' ? 2 : e === 'ask' ? 1 : 0);
  for (const line of lines) {
    const [effect, type, domain, kw] = line.split('|');
    if (!rank(effect) || type !== actionType) continue;
    if (domain && !(h === domain || h.endsWith(`.${domain}`))) continue;
    if (kw && !hay.includes(kw)) continue;
    if (rank(effect) > rank(best)) best = effect as PolicyEffect;
  }
  return best;
}
