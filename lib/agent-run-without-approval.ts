/**
 * lib/agent-run-without-approval.ts — per-agent "承認なしで実行" (run without
 * approval), product owner request 2026-10-31.
 *
 * When ON for an agent, the RN approval choke points in app/_layout.tsx
 * (drainAgentEscalationRequests / drainAgentActionApprovalRequests) answer
 * the ROUTINE human asks of that agent's runs themselves, with the SAME
 * Keystore-signed reply the notification tap produces:
 *
 *   - CLI worker gate escalations (scripts/shelly-agent-driver.js
 *     gateCommandActions → "境界操作を許可しますか？") whose signals are only
 *     `leaves-root` and/or `write-or-exec` (ESCALATION_AUTO_SIGNALS) — e.g.
 *     reading ~/demo outside the project root. Signed via the native
 *     resolveAgentEscalationAutoApproval, which never mints a preapproval
 *     grant (so nothing outlives turning the option OFF).
 *   - per-run action approvals of the local-only types in
 *     AUTO_APPROVABLE_ACTION_TYPES (draft save / local notification).
 *
 * Never auto-answered, flag or not:
 *   - anything the gate already denied (command-safety CRITICAL, POLICY-001
 *     deny, policy-write …) — those never reach a human ask at all, the
 *     driver declines them before filing a request; and as defence in depth
 *     this module re-runs checkCommandSafety on the minted request and
 *     refuses CRITICAL / HIGH;
 *   - escalations carrying any other signal (network-send, secret-read,
 *     destructive, opaque-script-exec, indirect-exec, policy-write …), and
 *     commands that touch the app's own trust state (shared_prefs /
 *     no_backup / ~/.shelly/agents);
 *   - REVIEW_REQUIRED_ACTION_TYPES (cli / intent / dm-reply / browser-pane /
 *     social-post) and every outward-sending action (webhook / api-call),
 *     which stay on the human;
 *   - POLICY-001 `ask` / proactive-origin requests (the caller passes
 *     policyBlocksAutoAccept).
 *
 * Trust model: the flag is NOT a field of the agent definition. Agent
 * definitions live in ~/.shelly/agents/<id>.json, a file any same-uid agent
 * process (Codex / Claude Code Write/Edit/Bash) can rewrite, and agent-store
 * is rebuilt from those files at every launch — so a value there could be
 * raised by a run. The flag lives ONLY in the Android-Keystore-backed
 * expo-secure-store (same pattern as lib/agent-closepaw-preapproval.ts and
 * lib/agent-trust-allow-seal.ts): a run cannot produce a valid ciphertext,
 * and each entry's decrypted payload names its own agentId, so a ciphertext
 * cannot be moved onto another agent either. The only writers are the agent
 * detail toggle (Sidebar) and the typed-OK chat registration
 * (hooks/use-ai-pane-dispatch.ts confirmAgentDraftInner). The only readers
 * are the RN choke points. Residual (DEFERRED.md): a same-uid process could
 * restore an OLDER SecureStore blob (rollback to a time the flag was ON for
 * some agent); commands touching shared_prefs are refused auto-approval so a
 * run cannot do that through this option itself.
 */
import { checkCommandSafety } from '@/lib/command-safety';
import { REVIEW_REQUIRED_ACTION_TYPES } from '@/lib/agent-action-types';

const STORE_KEY = 'shelly_run_without_approval_v1';
const MAX_ENTRIES = 500;

export type RunWithoutApprovalVia = 'detail' | 'chat';

export type RunWithoutApprovalEntry = {
  agentId: string;
  enabledAt: number;
  via: RunWithoutApprovalVia;
};

export type RunWithoutApprovalStorage = {
  get: () => Promise<string | null>;
  set: (value: string) => Promise<void>;
};

let storage: RunWithoutApprovalStorage | null = null;
let cache: RunWithoutApprovalEntry[] | null = null;
const listeners = new Set<() => void>();

function getStorage(): RunWithoutApprovalStorage {
  if (storage) return storage;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const SecureStore = require('expo-secure-store');
  storage = {
    get: () => SecureStore.getItemAsync(STORE_KEY),
    set: (v: string) => SecureStore.setItemAsync(STORE_KEY, v),
  };
  return storage;
}

/** Test hook. */
export function __setRunWithoutApprovalStorageForTests(s: RunWithoutApprovalStorage | null): void {
  storage = s;
  cache = null;
}

function isEntry(v: unknown): v is RunWithoutApprovalEntry {
  const e = v as RunWithoutApprovalEntry | null;
  return !!e && typeof e.agentId === 'string' && e.agentId.length > 0 && typeof e.enabledAt === 'number'
    && (e.via === 'detail' || e.via === 'chat');
}

export async function loadRunWithoutApproval(): Promise<RunWithoutApprovalEntry[]> {
  if (cache) return cache;
  try {
    const raw = await getStorage().get();
    const parsed = raw ? JSON.parse(raw) : [];
    cache = Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    // Unreadable / undecryptable → fail closed: every agent OFF.
    cache = [];
  }
  return cache;
}

/** Default OFF: true only for an agent with a Keystore-backed entry. */
export async function isRunWithoutApprovalEnabled(agentId: string | null | undefined): Promise<boolean> {
  if (!agentId) return false;
  const list = await loadRunWithoutApproval();
  return list.some((e) => e.agentId === agentId);
}

/** Synchronous read of the loaded cache for UI labels (false until loaded). */
export function getRunWithoutApprovalCached(agentId: string): boolean {
  return !!cache && cache.some((e) => e.agentId === agentId);
}

export function subscribeRunWithoutApproval(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** User-only writer: the agent detail toggle or the typed-OK chat
 *  registration. Never called from anything an agent run can drive. */
export async function setRunWithoutApproval(
  agentId: string,
  enabled: boolean,
  via: RunWithoutApprovalVia,
  now: number = Date.now(),
): Promise<void> {
  if (!agentId) return;
  const list = (await loadRunWithoutApproval()).filter((e) => e.agentId !== agentId);
  const next = enabled ? [...list, { agentId, enabledAt: now, via }].slice(-MAX_ENTRIES) : list;
  await getStorage().set(JSON.stringify(next));
  cache = next;
  for (const fn of listeners) {
    try { fn(); } catch { /* listener errors never block the write */ }
  }
}

/** Deleting an agent drops its entry (an agent re-created later under the
 *  same id must not inherit it). */
export async function forgetRunWithoutApproval(agentId: string): Promise<void> {
  const list = await loadRunWithoutApproval();
  if (list.some((e) => e.agentId === agentId)) await setRunWithoutApproval(agentId, false, 'detail');
}

// ── Decisions (pure) ─────────────────────────────────────────────────────

/** Action types the option answers. Local-only (no data leaves the device):
 *  'draft' = file write inside the scoped output roots, 'notify' = a local
 *  Android notification. webhook / api-call are non-review today but send
 *  data off the device, so they deliberately keep the human tap. */
export const AUTO_APPROVABLE_ACTION_TYPES = ['draft', 'notify'] as const;

/** Gate signals an auto-answered escalation may carry — nothing else. */
export const ESCALATION_AUTO_SIGNALS: ReadonlySet<string> = new Set(['leaves-root', 'write-or-exec']);

/** Commands that touch the app's own trust / approval state are never
 *  auto-approved, even if the gate only called them leaves-root. */
const TRUST_STATE_PATH_RE = /shared_prefs|no_backup|\.shelly\/agents(?:\/|\b)|shelly-agent-(?:escalation|preapproval|action)/i;

export type AutoApproveVerdict = { ok: true } | { ok: false; reason: string };

export function actionAutoApprovable(
  request: { actionType?: string | null },
  opts: { enabled: boolean; policyBlocksAutoAccept?: boolean },
): AutoApproveVerdict {
  if (!opts.enabled) return { ok: false, reason: 'flag-off' };
  if (opts.policyBlocksAutoAccept) return { ok: false, reason: 'policy-ask' };
  const type = String(request.actionType ?? '');
  if ((REVIEW_REQUIRED_ACTION_TYPES as readonly string[]).includes(type)) return { ok: false, reason: 'review-required' };
  if (!(AUTO_APPROVABLE_ACTION_TYPES as readonly string[]).includes(type)) return { ok: false, reason: 'not-local-only' };
  return { ok: true };
}

export function escalationAutoApprovable(
  request: {
    command?: string | null;
    signals?: readonly string[] | null;
    state?: string | null;
    reason?: string | null;
  },
  opts: { enabled: boolean; policyBlocksAutoAccept?: boolean },
): AutoApproveVerdict {
  if (!opts.enabled) return { ok: false, reason: 'flag-off' };
  // POLICY-001 deny / draft_only / ask (evaluated by the caller in RN).
  if (opts.policyBlocksAutoAccept) return { ok: false, reason: 'policy-ask' };
  // A queued request belongs to a run that already declined and moved on.
  if (request.state) return { ok: false, reason: 'not-live' };
  // Only a gray verdict produced by the boundary classifier itself
  // (lib/agent-boundary-policy.ts: "boundary: <signals>"). A POLICY-001 ask
  // rule or the proactive read-only floor turns allow→gray with its own
  // reason prefix — the user asked to be asked there, so a human answers.
  if (!/^boundary: /.test(String(request.reason ?? ''))) return { ok: false, reason: 'not-boundary-gray' };
  const command = String(request.command ?? '').trim();
  if (!command) return { ok: false, reason: 'no-command' };
  const signals = Array.isArray(request.signals) ? request.signals.map((s) => String(s).trim()).filter(Boolean) : [];
  if (signals.length === 0) return { ok: false, reason: 'no-signals' };
  const foreign = signals.find((s) => !ESCALATION_AUTO_SIGNALS.has(s));
  if (foreign) return { ok: false, reason: `signal:${foreign}` };
  const safety = checkCommandSafety(command);
  if (safety.level === 'CRITICAL' || safety.level === 'HIGH') return { ok: false, reason: `safety:${safety.level}` };
  if (TRUST_STATE_PATH_RE.test(command)) return { ok: false, reason: 'trust-state-path' };
  return { ok: true };
}

/** NL draft: the user's own words ask for this option. Narrower than
 *  detectAutonomousIntent (lib/agent-nl-parser.ts): only explicit
 *  approval/confirmation phrases, with the same negation guard. */
const RUN_WITHOUT_APPROVAL_RE =
  /承認(?:は)?(?:なしで|なしに|無しで|不要で)|確認(?:は)?(?:なしで|無しで|不要で)|人の確認(?:は)?なし|許可(?:は)?(?:なしで|不要で)|without\s+(?:asking|approval|confirmation)|no\s+approvals?\b|skip\s+(?:the\s+)?approvals?/i;
const NEGATED_EN_RE = /\b(?:don'?t|do not|never|shouldn'?t|please don'?t)\b[^.!?]{0,40}\bwithout\b/i;
const NEGATED_JP_RE = /(?:承認|確認|許可)(?:は)?(?:なし|無し|不要)(?:で|に)?(?:は)?[^。！？]{0,15}(?:しないで|しては(?:い)?けない|ダメ|だめ|禁止)/;

export function detectRunWithoutApprovalIntent(text: string | null | undefined): boolean {
  const s = String(text ?? '');
  if (!s) return false;
  if (NEGATED_EN_RE.test(s) || NEGATED_JP_RE.test(s)) return false;
  return RUN_WITHOUT_APPROVAL_RE.test(s);
}

/** Display form of an auto-approved command for the audit line. */
export function auditCommandText(command: string, maxChars = 200): string {
  const redacted = String(command)
    .replace(/\b([A-Za-z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*=)([^\s'"`]+)/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(redacted);
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : redacted;
}

/** Visible audit trail: one line in the agent's own chat thread. */
export function postRunWithoutApprovalAuditLine(agentId: string, content: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { useAIPaneStore, agentThreadKey } = require('@/store/ai-pane-store');
    useAIPaneStore.getState().addMessage(agentThreadKey(agentId), {
      id: `rwa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'assistant',
      content,
      timestamp: Date.now(),
    });
  } catch {
    // best-effort; the driver audit log still records escalation_resolved
  }
}
