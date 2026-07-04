/**
 * lib/capability-envelope.ts — CAP-001 / SECRET-001 / HTTP-001 pure core.
 *
 * Phase 0 「床/substrate」of the L1/L2 Capability Catalog
 * (docs/superpowers/specs/2026-07-01-l1-l2-capability-catalog.md §3/§4). This is
 * the OFFLINE-TESTABLE brain of the capability broker; the runtime broker
 * (scripts/shelly-capability-broker.js) mirrors the constants below (the
 * `capability-broker-parity.test.ts` keeps them in lock-step, matching the
 * existing shelly-agent-driver asset-parity pattern).
 *
 * Strangler migration (§1/§8.2): the live `.sh` egress path stays green. The
 * broker is opt-in behind SHELLY_CAP_BROKER=1 and is inserted at the single
 * choke point every backend already funnels through (http_post_json /
 * http_get_text in agent-executor.ts). Nothing here changes behaviour unless the
 * flag is set.
 *
 * Three primitives, one seam:
 *  - HTTP-001: egress allowlist — no skill gets `*`; non-allowlist hosts gate.
 *  - SECRET-001: secret-by-reference — a skill passes an opaque `auth_ref`, never
 *    a value, and a ref is BOUND to exactly one host (a Perplexity ref can only
 *    authenticate api.perplexity.ai, so a mis-routed URL cannot exfiltrate it).
 *  - CAP-001: budget / loop-limit / redacted audit / taint-aware structural rule.
 */
import { redactSecrets } from '@/lib/redact-secrets';

/**
 * SECRET-001. An opaque handle a skill/backend passes to the broker. The broker
 * resolves `envVar` from ~/.shelly/agents/.env INSIDE itself and injects `header`
 * — the raw value never returns to the calling shell (the /proc same-uid leak the
 * spec §4.4 closes). A ref is bound to a single `host`: the broker refuses to
 * spend it against any other host, so a tainted/mis-built URL cannot redirect the
 * secret to an attacker.
 */
export interface AuthRefSpec {
  /** the opaque handle the skill passes (e.g. "perplexity") */
  ref: string;
  /** the .env variable the broker reads inside itself; never surfaced */
  envVar: string;
  /** header name the broker injects (e.g. "Authorization") */
  header: string;
  /** value prefix (e.g. "Bearer "); "" for bare-value headers like x-goog-api-key */
  scheme: string;
  /** the ONLY host this ref may authenticate to */
  host: string;
}

/**
 * The known secret references. Mirrors the concrete backends in
 * agent-executor.ts (perplexity / gemini-api / cerebras / groq). Each is bound to
 * its single upstream host. Keep in sync with the broker's AUTH_REFS.
 */
export const AUTH_REFS: Readonly<Record<string, AuthRefSpec>> = Object.freeze({
  perplexity: { ref: 'perplexity', envVar: 'PERPLEXITY_API_KEY', header: 'Authorization', scheme: 'Bearer ', host: 'api.perplexity.ai' },
  gemini: { ref: 'gemini', envVar: 'GEMINI_API_KEY', header: 'x-goog-api-key', scheme: '', host: 'generativelanguage.googleapis.com' },
  cerebras: { ref: 'cerebras', envVar: 'CEREBRAS_API_KEY', header: 'Authorization', scheme: 'Bearer ', host: 'api.cerebras.ai' },
  groq: { ref: 'groq', envVar: 'GROQ_API_KEY', header: 'Authorization', scheme: 'Bearer ', host: 'api.groq.com' },
});

/**
 * HTTP-001. Hosts an autonomous run may reach WITHOUT a human approval gate: the
 * curated model/search backends, loopback (local llama-server), and the
 * llama.cpp release infrastructure the on-device installer pulls from. Everything
 * else (user webhooks, arbitrary URLs a skill constructs) is non-allowlist and
 * must pass the approval gate — matching today's webhook behaviour, generalised.
 */
export const EGRESS_ALLOWLIST: readonly string[] = Object.freeze([
  'api.perplexity.ai',
  'generativelanguage.googleapis.com',
  'api.cerebras.ai',
  'api.groq.com',
  'api.github.com', // llama.cpp latest-release lookup
  'objects.githubusercontent.com', // GitHub release asset CDN
  'github.com', // GitHub release download redirects
  '127.0.0.1', // loopback local LLM
  'localhost',
]);

/** Loopback hosts are the only ones allowed over plain http. */
export const LOOPBACK_HOSTS: readonly string[] = Object.freeze(['127.0.0.1', 'localhost']);

/** Extract a lowercased hostname from a URL, or null if unparseable. */
export function hostFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.includes(host);
}

export function isAllowlistedHost(host: string): boolean {
  return EGRESS_ALLOWLIST.includes(host);
}

export type EgressDecision =
  | 'allow' // allowlisted host (and, if a secret is spent, host matches its ref binding)
  | 'approve' // non-allowlist host: human approval required, never auto
  | 'deny'; // structurally forbidden (bad URL / secret bound to a different host)

export type EgressSignal =
  | 'non-allowlist-host' // destination is not on the egress allowlist
  | 'secret-spend' // an auth_ref (secret) is being used on this request
  | 'tainted' // this run consumed untrusted input (§4 taint tracking)
  | 'ref-host-mismatch' // an auth_ref was spent against a host it is not bound to
  | 'insecure-scheme' // non-loopback plaintext / unparseable URL
  | 'tainted-secret-spend'; // untrusted input + a live secret, even to an allowlisted, correctly-bound host

export interface EgressVerdict {
  decision: EgressDecision;
  reason: string;
  signals: EgressSignal[];
}

/**
 * CAP-001 §4.3 — the single structural rule that cuts the exfil trifecta:
 *   a tainted run may not "spend a secret" or "send to a non-allowlist host"
 *   without a human approval.
 * We implement it as a classifier the broker consults before every egress:
 *  - Unparseable URL, or non-loopback plaintext → deny.
 *  - A secret (auth_ref) may only be spent against its bound host → else deny.
 *    This is a HARD deny (not approve): a Perplexity key must never leave for any
 *    host but api.perplexity.ai, regardless of what a human might click.
 *  - Non-allowlist host → approve (human gate); loud when a secret or taint is
 *    also present (the trifecta case).
 *  - Tainted input plus a live secret, even against an allowlisted and
 *    correctly-bound host → approve. Host-binding only guards WHERE a secret
 *    can go, not WHAT gets said with it — untrusted content could still direct
 *    the agent to spend a legitimate secret on an attacker-chosen payload at a
 *    legitimate destination (e.g. a poisoned notification tricking the agent
 *    into posting attacker text to our own Slack webhook).
 *  - Allowlist host with no boundary signal → allow.
 */
export function classifyEgress(opts: {
  url: string;
  authRef?: string | null;
  tainted?: boolean;
}): EgressVerdict {
  const signals: EgressSignal[] = [];
  const host = hostFromUrl(opts.url);
  const authRef = opts.authRef || null;
  const tainted = opts.tainted === true;

  let scheme: string | null = null;
  try {
    scheme = new URL(opts.url).protocol;
  } catch {
    scheme = null;
  }

  if (!host || scheme === null) {
    return { decision: 'deny', reason: 'unparseable URL', signals: ['insecure-scheme'] };
  }
  // Only loopback may use plaintext http; every remote host must be https.
  if (scheme !== 'https:' && !(scheme === 'http:' && isLoopbackHost(host))) {
    return { decision: 'deny', reason: `insecure scheme ${scheme} for host ${host}`, signals: ['insecure-scheme'] };
  }

  if (authRef) {
    signals.push('secret-spend');
    const spec = AUTH_REFS[authRef];
    if (!spec) {
      return { decision: 'deny', reason: `unknown auth_ref "${authRef}"`, signals };
    }
    if (host !== spec.host) {
      signals.push('ref-host-mismatch');
      return {
        decision: 'deny',
        reason: `auth_ref "${authRef}" is bound to ${spec.host}, not ${host}`,
        signals,
      };
    }
  }
  if (tainted) signals.push('tainted');

  if (!isAllowlistedHost(host)) {
    signals.push('non-allowlist-host');
    return {
      decision: 'approve',
      reason: `host ${host} is not on the egress allowlist`,
      signals,
    };
  }

  // Trifecta case even on an allowlisted, correctly-bound host: untrusted input
  // (taint) plus a live secret means the CONTENT of the request — not just its
  // destination — may be attacker-directed (e.g. a poisoned notification
  // tricking the agent into posting attacker-chosen text to a legitimate,
  // allowlisted Slack webhook using our own valid key). The host-binding check
  // above only guards where a secret can go, not what gets said with it.
  if (tainted && authRef) {
    signals.push('tainted-secret-spend');
    return {
      decision: 'approve',
      reason: `tainted input plus a live secret ("${authRef}") to ${host} requires human approval`,
      signals,
    };
  }

  return {
    decision: 'allow',
    reason: `host ${host} is allowlisted`,
    signals,
  };
}

/** CAP-001 budget — a run's egress is capped in both call count and wall time. */
export interface EnvelopeBudget {
  maxCalls: number;
  maxWallMs: number;
}

export const DEFAULT_BUDGET: EnvelopeBudget = Object.freeze({
  maxCalls: 40,
  maxWallMs: 10 * 60 * 1000,
});

export interface BudgetState {
  /** egress calls already made in this run (before the current one) */
  calls: number;
  /** epoch ms the run's envelope was opened */
  startedAtMs: number;
}

export interface BudgetVerdict {
  ok: boolean;
  reason?: string;
}

/** Fail-closed budget check: the NEXT call is only allowed if it stays in-budget. */
export function checkBudget(state: BudgetState, budget: EnvelopeBudget, nowMs: number): BudgetVerdict {
  if (state.calls >= budget.maxCalls) {
    return { ok: false, reason: `call budget exhausted (${state.calls}/${budget.maxCalls})` };
  }
  const elapsed = nowMs - state.startedAtMs;
  if (elapsed >= budget.maxWallMs) {
    return { ok: false, reason: `wall-time budget exhausted (${elapsed}ms/${budget.maxWallMs}ms)` };
  }
  return { ok: true };
}

/**
 * CAP-001 redacted audit. One line per egress attempt. Never carries a secret
 * value: only the auth_ref NAME, the host/path, and the verdict. `redactSecrets`
 * is applied to free-text fields (reason, error) as defence-in-depth in case an
 * upstream error body echoes a token.
 */
export interface EgressAuditEntry {
  ts: string;
  kind: 'http.request';
  method: string;
  host: string;
  path: string;
  authRef: string | null;
  tainted: boolean;
  decision: EgressDecision;
  signals: EgressSignal[];
  status?: number;
  ok?: boolean;
  reason?: string;
}

export function buildEgressAudit(opts: {
  ts: string;
  method: string;
  url: string;
  authRef?: string | null;
  tainted?: boolean;
  verdict: EgressVerdict;
  status?: number;
  ok?: boolean;
}): EgressAuditEntry {
  let host = '';
  let path = '';
  try {
    const u = new URL(opts.url);
    host = u.hostname.toLowerCase();
    path = u.pathname; // query dropped on purpose (may carry a key, e.g. ?key=…)
  } catch {
    host = '<unparseable>';
    path = '';
  }
  return {
    ts: opts.ts,
    kind: 'http.request',
    method: (opts.method || 'GET').toUpperCase(),
    host,
    path,
    authRef: opts.authRef || null,
    tainted: opts.tainted === true,
    decision: opts.verdict.decision,
    signals: opts.verdict.signals,
    status: opts.status,
    ok: opts.ok,
    reason: String(redactSecrets(opts.verdict.reason)),
  };
}
