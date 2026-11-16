/**
 * lib/mcp-always-allow.ts — MCP "always allow" rules for TYPED operations
 * (DEFERRED.md「MCP の入口」 item 3).
 *
 * The store is native (McpAlwaysAllowStore.kt: Keystore-MAC'd prefs, re-keyed
 * on every write, anything unverifiable reads as NO rules) because the
 * headless MCP path must read it without RN. This file holds the pure helpers
 * (rule key, target normalization, the closed typed-op set, a strict status
 * parser that fails to empty, the match decision mirrored for display) and
 * thin wrappers that degrade to "no rules" on builds without the native
 * methods.
 *
 * Rules:
 *  - A rule names one client (principal), one TYPED op, one target. Raw ops
 *    (run_command, write_file) never get a rule: isTypedOp() is false for
 *    them, the native decode rejects them and the native add refuses them.
 *  - A target is a canonical, closed-alphabet key naming ONE resource
 *    (`<kind>:<id>`), never a pattern. An op whose effect depends on free-form
 *    arguments has no target (normalizeTarget returns null): it can't be
 *    always-allowed.
 *  - Only the MCP bridge adds rules, after a human "always allow" tap (not
 *    wired yet). Settings lists and revokes; it can never add.
 *  - Regenerating the MCP token removes every rule (see purge* below).
 */
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { MCP_PRINCIPAL_RE, type Sha256 } from '@/lib/mcp-request-auth';
import { logInfo, logWarn } from '@/lib/debug-logger';

/** Keep in step with McpAlwaysAllowStore.TYPED_OPS. */
export const TYPED_OPS = ['run_agent'] as const;
export type TypedOp = (typeof TYPED_OPS)[number];

export const MAX_RULES = 200;
export const MAX_LABEL_CHARS = 64;
export const ALWAYS_ALLOW_STATUS_VERSION = 1;

/** Same rule as AgentIngressTaint.AGENT_ID_RE / isValidIngressAgentId. Case-sensitive. */
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const TARGET_RES: Record<TypedOp, RegExp> = {
  run_agent: /^agent:[A-Za-z0-9_-]{1,128}$/,
};
const RULE_ID_RE = /^r_[0-9a-f]{16}$/;
const BIND_RE = /^[0-9a-f]{64}$/;
// Same set as lib/mcp-request-auth.ts UNSAFE_NAME_CHARS / McpAlwaysAllowStore.
// eslint-disable-next-line no-control-regex
const UNSAFE_LABEL_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/;
const RULE_KEYS = new Set(['id', 'principal', 'op', 'target', 'bind', 'label', 'createdAt', 'actionPolicyPin']);

export type AlwaysAllowRule = {
  id: string;
  principal: string;
  op: TypedOp;
  target: string;
  /** sha256 hex of the target's security-relevant definition; absent = any. */
  bind?: string;
  /** Display only, never used for matching. */
  label: string;
  createdAt: number;
  /** Present only after explicit consent to actions, pinned to the verified policy. */
  actionPolicyPin?: string;
};

export type AlwaysAllowStatus = {
  status: 'empty' | 'ok' | 'unreadable';
  rules: AlwaysAllowRule[];
};

const EMPTY: AlwaysAllowStatus = { status: 'empty', rules: [] };
const UNREADABLE: AlwaysAllowStatus = { status: 'unreadable', rules: [] };

export function isTypedOp(op: unknown): op is TypedOp {
  return typeof op === 'string' && (TYPED_OPS as readonly string[]).includes(op);
}

export function isValidAlwaysAllowTarget(op: unknown, target: unknown): boolean {
  return isTypedOp(op) && typeof target === 'string' && TARGET_RES[op].test(target);
}

/**
 * The canonical target a typed op's arguments name, or null when the op can't
 * be always-allowed (unknown / raw op, malformed arguments). Only identifying
 * arguments go into the target; free-form ones never do.
 */
export function normalizeTarget(op: unknown, args: unknown): string | null {
  if (!isTypedOp(op) || !args || typeof args !== 'object' || Array.isArray(args)) return null;
  switch (op) {
    case 'run_agent': {
      const agentId = (args as { agentId?: unknown }).agentId;
      return typeof agentId === 'string' && AGENT_ID_RE.test(agentId) ? `agent:${agentId}` : null;
    }
    default:
      return null;
  }
}

/** The unique key of a rule: principal ␀ op ␀ target. */
export function ruleKey(principal: string, op: string, target: string): string {
  return `${principal}\u0000${op}\u0000${target}`;
}

function isValidRule(r: AlwaysAllowRule): boolean {
  return (
    RULE_ID_RE.test(r.id)
    && MCP_PRINCIPAL_RE.test(r.principal)
    && isValidAlwaysAllowTarget(r.op, r.target)
    && (r.bind === undefined || BIND_RE.test(r.bind))
    && (r.actionPolicyPin === undefined || (r.bind !== undefined && (r.actionPolicyPin === 'absent' || BIND_RE.test(r.actionPolicyPin))))
    && r.label.length <= MAX_LABEL_CHARS
    && !UNSAFE_LABEL_CHARS.test(r.label)
    && Number.isSafeInteger(r.createdAt)
    && r.createdAt >= 0
  );
}

/**
 * Parses the native status JSON (mcpAlwaysAllowList / Remove). Strict, like
 * the native decode: anything malformed — a raw op, a bad field, an unknown
 * key, a duplicate id or key, too many rules — makes the whole result
 * `unreadable` with NO rules. Never throws.
 */
export function parseAlwaysAllowStatus(raw: unknown): AlwaysAllowStatus {
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return UNREADABLE;
    const { version, status, rules } = o as { version?: unknown; status?: unknown; rules?: unknown };
    if (version !== ALWAYS_ALLOW_STATUS_VERSION || !Array.isArray(rules) || rules.length > MAX_RULES) return UNREADABLE;
    if (status === 'unreadable') return UNREADABLE;
    if (status !== 'empty' && status !== 'ok') return UNREADABLE;
    const out: AlwaysAllowRule[] = [];
    const ids = new Set<string>();
    const keys = new Set<string>();
    for (const r of rules) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) return UNREADABLE;
      if (Object.keys(r).some((k) => !RULE_KEYS.has(k))) return UNREADABLE;
      const { id, principal, op, target, bind, label, createdAt, actionPolicyPin } = r as Record<string, unknown>;
      if (typeof id !== 'string' || typeof principal !== 'string' || typeof target !== 'string') return UNREADABLE;
      if (typeof label !== 'string' || typeof createdAt !== 'number' || !isTypedOp(op)) return UNREADABLE;
      if (bind !== undefined && typeof bind !== 'string') return UNREADABLE;
      const rule: AlwaysAllowRule = { id, principal, op, target, label, createdAt };
      if (bind !== undefined) rule.bind = bind as string;
      if (actionPolicyPin !== undefined) {
        if (typeof actionPolicyPin !== 'string') return UNREADABLE;
        rule.actionPolicyPin = actionPolicyPin;
      }
      if (!isValidRule(rule)) return UNREADABLE;
      const key = ruleKey(principal, op, target);
      if (ids.has(id) || keys.has(key)) return UNREADABLE;
      ids.add(id);
      keys.add(key);
      out.push(rule);
    }
    if (out.length === 0) return EMPTY;
    return { status: 'ok', rules: out };
  } catch {
    return UNREADABLE;
  }
}

/**
 * The match decision, mirrored from McpAlwaysAllowStore.findMatch (for
 * display and tests; the request path asks native). A rule with a bind
 * matches only that bind; one without matches any. Invalid inputs match
 * nothing.
 */
export function findAlwaysAllowMatch(
  rules: readonly AlwaysAllowRule[],
  principal: string,
  op: string,
  target: string,
  bind: string | null,
): AlwaysAllowRule | null {
  if (!MCP_PRINCIPAL_RE.test(principal) || !isValidAlwaysAllowTarget(op, target)) return null;
  if (bind !== null && !BIND_RE.test(bind)) return null;
  return rules.find((r) => r.principal === principal && r.op === op && r.target === target
    && (r.bind === undefined || r.bind === bind)) ?? null;
}

/** First 8 characters of the principal: the client ID shown in Settings. */
export function clientIdLabel(principal: string): string {
  return principal.slice(0, 8);
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * The principal scripts/shelly-mcp-server.js derives for a token
 * (createMcpHandler: sha256Hex("shelly-mcp-principal:" + token).slice(0, 32)).
 */
export async function mcpPrincipalForToken(token: string, sha256: Sha256): Promise<string> {
  const digest = await sha256(utf8(`shelly-mcp-principal:${token}`));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// ── Native wrappers ────────────────────────────────────────────────────────

/** Every rule as stored; `empty` on builds without the store. */
export async function listMcpAlwaysAllowRules(): Promise<AlwaysAllowStatus> {
  if (!TerminalEmulator.mcpAlwaysAllowList) return EMPTY;
  return parseAlwaysAllowStatus(await TerminalEmulator.mcpAlwaysAllowList().catch(() => null));
}

/** True only when native confirms a matching rule. False on any doubt. */
export async function mcpAlwaysAllowMatches(
  principal: string,
  op: string,
  target: string,
  bind: string | null,
): Promise<boolean> {
  if (!TerminalEmulator.mcpAlwaysAllowMatch) return false;
  if (!MCP_PRINCIPAL_RE.test(principal) || !isValidAlwaysAllowTarget(op, target)) return false;
  if (bind !== null && !BIND_RE.test(bind)) return false;
  try {
    return (await TerminalEmulator.mcpAlwaysAllowMatch(principal, op, target, bind)) === true;
  } catch {
    return false;
  }
}

export type AlwaysAllowAddResult = {
  ok: boolean;
  code: 'added' | 'replaced' | 'invalid' | 'full' | 'failed' | 'unavailable';
  id?: string;
};

/**
 * ONLY for the MCP bridge after a human "always allow" tap won the approval.
 * Never call it from Settings, chat, a file, an agent or anything an MCP
 * client controls.
 */
export async function addMcpAlwaysAllowRule(
  principal: string,
  op: string,
  target: string,
  bind: string | null,
  label: string,
  actionPolicyPin: string | null = null,
): Promise<AlwaysAllowAddResult> {
  if (!TerminalEmulator.mcpAlwaysAllowAdd) return { ok: false, code: 'unavailable' };
  if (!MCP_PRINCIPAL_RE.test(principal) || !isValidAlwaysAllowTarget(op, target)) return { ok: false, code: 'invalid' };
  if (bind !== null && !BIND_RE.test(bind)) return { ok: false, code: 'invalid' };
  try {
    const res = JSON.parse(await TerminalEmulator.mcpAlwaysAllowAdd(principal, op, target, bind, label, actionPolicyPin));
    const codes = ['added', 'replaced', 'invalid', 'full', 'failed'];
    const code = codes.includes(res?.code) ? res.code : 'failed';
    const ok = res?.ok === true && (code === 'added' || code === 'replaced') && typeof res.id === 'string';
    return ok ? { ok, code, id: res.id } : { ok: false, code: code === 'added' || code === 'replaced' ? 'failed' : code };
  } catch {
    return { ok: false, code: 'failed' };
  }
}

/** Settings revoke. `ok: false` when native did not confirm. */
export async function removeMcpAlwaysAllowRules(ids: string[]): Promise<AlwaysAllowStatus & { ok: boolean }> {
  if (!TerminalEmulator.mcpAlwaysAllowRemove) return { ...EMPTY, ok: false };
  try {
    const raw = await TerminalEmulator.mcpAlwaysAllowRemove(ids);
    const ok = (() => {
      try {
        return JSON.parse(raw)?.ok === true;
      } catch {
        return false;
      }
    })();
    logInfo('McpAlwaysAllow', `revoked ${ids.length} rule(s) ok=${ok}`);
    return { ...parseAlwaysAllowStatus(raw), ok };
  } catch (e) {
    logWarn('McpAlwaysAllow', 'revoke failed', e);
    return { ...(await listMcpAlwaysAllowRules()), ok: false };
  }
}

/**
 * Token cascade: keeps only `principal`'s rules; null removes every rule.
 * True when confirmed. A build without the native store has no rules to
 * remove, so that counts as confirmed; a native error or a malformed
 * principal does not.
 */
export async function purgeMcpAlwaysAllowRulesExcept(principal: string | null): Promise<boolean> {
  if (!TerminalEmulator.mcpAlwaysAllowPurgeExcept) return true;
  if (principal !== null && !MCP_PRINCIPAL_RE.test(principal)) return false;
  try {
    return (await TerminalEmulator.mcpAlwaysAllowPurgeExcept(principal)) === true;
  } catch {
    return false;
  }
}

/**
 * Token cascade, step 2 (after the new token is saved): removes any rule not
 * keyed to the new token's principal — e.g. one a call that raced the lock
 * added under the old token. Throws when not confirmed.
 */
export async function purgeMcpAlwaysAllowRulesForNewToken(token: string, sha256: Sha256): Promise<void> {
  const principal = await mcpPrincipalForToken(token, sha256);
  if (!(await purgeMcpAlwaysAllowRulesExcept(principal))) {
    throw new Error('could not confirm that always-allow rules of other MCP tokens were removed');
  }
}
