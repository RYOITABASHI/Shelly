/**
 * lib/agent-trust-ramp.ts — POLICY-001 (B) trust ramp, pure core.
 *
 * After the human has approved the SAME exact command N times (default 3)
 * with no denial in between, Shelly asks — in plain chat text, never a
 * card/modal (project rule) — whether exactly that command may run without
 * confirmation from now on. Only an explicit yes adds a scoped allow; a no or
 * an ambiguous reply adds nothing and suppresses re-asking for
 * TRUST_RAMP_SUPPRESS_MS.
 *
 * Key = `cli|<sha256(agentId, cli, exact normalised command)>|<agentId>`
 * (lib/agent-action-policy.ts trustKeyForDescriptor). Security review H1: the
 * key used to be the command CLASS, so an allow for `npm test` also matched
 * `npm test; python3 evil.py`. Now only the whitespace-normalised identical
 * command, from the same agent, can ever match.
 *
 * Never eligible (no counting, no offer, no allow): non-cli actions,
 * proactive-origin runs, CRITICAL/HIGH, secrets, payments, posting /
 * messaging / network / git push, read-only actions, and any command with
 * chaining / substitution / redirection characters or an interpreter /
 * trampoline head. The evaluator re-runs the SAME check at use time.
 *
 * Pure and IO-free; persistence lives in lib/agent-user-policy-store.ts.
 */
import {
  ActionDescriptor,
  PolicyRule,
  TRUST_RAMP_EXCLUDED_CAPABILITIES,
  describeApprovalRequest,
  normalizeTrustCommand,
  ruleMatches,
  trustKeyForDescriptor,
} from '@/lib/agent-action-policy';

export { TRUST_RAMP_EXCLUDED_CAPABILITIES };

export const TRUST_RAMP_THRESHOLD_DEFAULT = 3;
/** How long a declined/ambiguous offer silences re-asking for that class. */
export const TRUST_RAMP_SUPPRESS_MS = 7 * 24 * 60 * 60 * 1000;
/** Approvals older than this stop counting toward the threshold. */
export const TRUST_RAMP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_TRUST_ALLOWS = 50;
const MAX_COUNTERS = 200;

export interface TrustCounter {
  key: string;
  label: string;
  approvals: number;
  firstAt: number;
  lastAt: number;
  suppressedUntil?: number;
}

export interface TrustAllow {
  id: string;
  key: string;
  label: string;
  createdAt: number;
}

export interface TrustState {
  counters: Record<string, TrustCounter>;
  allows: TrustAllow[];
}

export const EMPTY_TRUST_STATE: TrustState = Object.freeze({ counters: {}, allows: [] }) as TrustState;

const KEY_RE = /^cli\|[0-9a-f]{64}\|[A-Za-z0-9_.-]{1,200}$/;

/** True for a syntactically valid exact-command trust key. */
export function isTrustKey(key: string): boolean {
  return KEY_RE.test(key);
}

/** The exact-command trust key, or null when this action may never be trust-ramped. */
export function trustKeyOf(desc: ActionDescriptor): string | null {
  return trustKeyForDescriptor(desc);
}

/** The exact command shown to the human (chat proposal + allow listing). */
export function trustCommandOf(desc: ActionDescriptor): string {
  const c = normalizeTrustCommand(desc.command);
  return c.length > 200 ? `${c.slice(0, 200)}…` : c;
}

/**
 * Security review L2: before a "yes" turns a pending proposal into an allow,
 * recompute the key from the proposal's own command + agent (as a user-origin
 * cli action) and require it to equal the stored key. A pending payload that
 * was tampered with in AsyncStorage, or whose command is no longer eligible,
 * grants nothing.
 */
export function verifyTrustProposal(pending: { key: string; command?: string; agentId?: string }): boolean {
  if (!isTrustKey(pending.key) || !pending.command || !pending.agentId) return false;
  const desc = describeApprovalRequest({ actionType: 'cli', command: pending.command, agentId: pending.agentId, origin: 'user' });
  return trustKeyForDescriptor(desc) === pending.key;
}

/** Label for the allow listing: the exact command plus the agent name. */
export function trustLabelOf(desc: ActionDescriptor, agentName?: string | null): string {
  const what = `\`${trustCommandOf(desc)}\``;
  return agentName ? `${what} (${agentName})` : what;
}

/** Validate a stored trust state; drop anything malformed. */
export function parseTrustState(raw: unknown): TrustState {
  const out: TrustState = { counters: {}, allows: [] };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  if (r.counters && typeof r.counters === 'object' && !Array.isArray(r.counters)) {
    for (const [key, v] of Object.entries(r.counters as Record<string, unknown>)) {
      if (!KEY_RE.test(key) || !v || typeof v !== 'object') continue;
      const c = v as Record<string, unknown>;
      const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
      const approvals = num(c.approvals);
      const firstAt = num(c.firstAt);
      const lastAt = num(c.lastAt);
      if (approvals === null || firstAt === null || lastAt === null) continue;
      const counter: TrustCounter = {
        key,
        label: typeof c.label === 'string' ? c.label.slice(0, 200) : key,
        approvals: Math.floor(approvals),
        firstAt,
        lastAt,
      };
      const sup = num(c.suppressedUntil);
      if (sup !== null && sup > 0) counter.suppressedUntil = sup;
      out.counters[key] = counter;
    }
  }
  if (Array.isArray(r.allows)) {
    for (const v of r.allows) {
      if (!v || typeof v !== 'object') continue;
      const a = v as Record<string, unknown>;
      if (typeof a.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(a.id)) continue;
      if (typeof a.key !== 'string' || !KEY_RE.test(a.key)) continue;
      // KEY_RE above only admits exact-command cli keys; old class-based keys
      // (pre security review H1) and any other kind are dropped here.
      if (out.allows.some((x) => x.key === a.key)) continue;
      out.allows.push({
        id: a.id,
        key: a.key,
        label: typeof a.label === 'string' ? a.label.slice(0, 200) : a.key,
        createdAt: typeof a.createdAt === 'number' && Number.isFinite(a.createdAt) ? a.createdAt : 0,
      });
      if (out.allows.length >= MAX_TRUST_ALLOWS) break;
    }
  }
  return out;
}

function pruneCounters(counters: Record<string, TrustCounter>): Record<string, TrustCounter> {
  const entries = Object.values(counters);
  if (entries.length <= MAX_COUNTERS) return counters;
  entries.sort((a, b) => b.lastAt - a.lastAt);
  const out: Record<string, TrustCounter> = {};
  for (const c of entries.slice(0, MAX_COUNTERS)) out[c.key] = c;
  return out;
}

export interface RecordOutcome {
  state: TrustState;
  key: string | null;
  /** True when the caller should now ask the trust-ramp question in chat. */
  offer: boolean;
}

/**
 * Record one human approval decision. A decline RESETS the class to zero
 * ("N times with no denials"). An accept increments; once the count reaches
 * `threshold`, `offer` is true unless an allow already exists, the class is
 * suppressed, or a user ask/deny rule covers the action (offering to skip a
 * confirmation the user explicitly asked for would be self-defeating).
 */
export function recordApprovalOutcome(
  state: TrustState,
  desc: ActionDescriptor,
  decision: 'accept' | 'decline',
  now: number,
  opts: { threshold?: number; rules?: readonly PolicyRule[]; homeDir?: string; label?: string } = {},
): RecordOutcome {
  const key = trustKeyOf(desc);
  if (!key) return { state, key: null, offer: false };
  const threshold = Math.max(1, Math.floor(opts.threshold ?? TRUST_RAMP_THRESHOLD_DEFAULT));
  const prev = state.counters[key];
  const counters = { ...state.counters };
  if (decision === 'decline') {
    counters[key] = {
      key,
      label: opts.label || prev?.label || key,
      approvals: 0,
      firstAt: now,
      lastAt: now,
      ...(prev?.suppressedUntil ? { suppressedUntil: prev.suppressedUntil } : {}),
    };
    return { state: { ...state, counters: pruneCounters(counters) }, key, offer: false };
  }
  const stale = !prev || now - prev.firstAt > TRUST_RAMP_WINDOW_MS;
  const next: TrustCounter = {
    key,
    label: opts.label || prev?.label || key,
    approvals: stale ? 1 : prev.approvals + 1,
    firstAt: stale ? now : prev.firstAt,
    lastAt: now,
    ...(prev?.suppressedUntil ? { suppressedUntil: prev.suppressedUntil } : {}),
  };
  counters[key] = next;
  const newState = { ...state, counters: pruneCounters(counters) };
  const alreadyAllowed = state.allows.some((a) => a.key === key);
  const suppressed = typeof next.suppressedUntil === 'number' && next.suppressedUntil > now;
  const coveredByRule = (opts.rules || []).some((r) => (r.effect === 'ask' || r.effect === 'deny' || r.effect === 'draft_only') && ruleMatches(r, desc, opts.homeDir || ''));
  const offer = next.approvals >= threshold && !alreadyAllowed && !suppressed && !coveredByRule && state.allows.length < MAX_TRUST_ALLOWS;
  return { state: newState, key, offer };
}

/** The user said no (or something unclear): silence this class for a while. */
export function suppressTrustOffer(state: TrustState, key: string, now: number): TrustState {
  const prev = state.counters[key];
  const counters = { ...state.counters };
  counters[key] = {
    key,
    label: prev?.label || key,
    approvals: 0,
    firstAt: now,
    lastAt: now,
    suppressedUntil: now + TRUST_RAMP_SUPPRESS_MS,
  };
  return { ...state, counters };
}

/** The user said an explicit yes: add the scoped allow. Idempotent per key. */
export function grantTrustAllow(state: TrustState, key: string, label: string, now: number, id: string): TrustState {
  if (!KEY_RE.test(key)) return state;
  if (state.allows.some((a) => a.key === key)) return state;
  if (state.allows.length >= MAX_TRUST_ALLOWS) return state;
  const counters = { ...state.counters };
  delete counters[key];
  return { counters, allows: [...state.allows, { id, key, label, createdAt: now }] };
}

/** Remove one allow by id; returns the removed entry (null if none). */
export function revokeTrustAllow(state: TrustState, id: string): { state: TrustState; removed: TrustAllow | null } {
  const removed = state.allows.find((a) => a.id === id) || null;
  if (!removed) return { state, removed: null };
  return { state: { ...state, allows: state.allows.filter((a) => a.id !== id) }, removed };
}
