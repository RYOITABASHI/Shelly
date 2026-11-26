/**
 * lib/launcher-approval.ts — RN half of launcher ingress Phase 2
 * (phase 2 fact sheet §1–§2, §5 D8; native: LauncherSubmissions.kt).
 *
 * A launcher submission that needs the owner's approval (`pending_approval`)
 * is decided here, later, within its 10-minute window:
 *  - Shelly comes to the foreground (hooks/use-launcher-approval.ts) or a
 *    poll while it is in front finds one → the OLDEST pending one is shown in
 *    the existing approval modal (store/mcp-approval-store.ts +
 *    components/McpApprovalModal.tsx), one at a time;
 *  - the owner picks one of the existing decisions: allow (`once`), always
 *    allow (`always`, writes the existing C3 rule natively) or deny (`deny`);
 *    native records it (audit line first) and the next oldest is shown;
 *  - closing the prompt decides nothing: the submission stays pending until
 *    its window ends (expiry is native), and no further prompt appears until
 *    Shelly comes to the foreground again or the owner reopens one from the
 *    inbox (P2-B2/B4).
 * Nothing is prompted while STOP-ALL is on (P2-A5). The inbox (read-only)
 * is components/LauncherInboxModal.tsx.
 *
 * The instruction text is the owner's own and is shown on the device only:
 * it is never logged here (ids are shortened, codes only).
 */
import { Platform, ToastAndroid } from 'react-native';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { logInfo, logWarn } from '@/lib/debug-logger';
import { t } from '@/lib/i18n';
import { useMcpApprovalStore, type McpApprovalDecision } from '@/store/mcp-approval-store';

const SUBMISSION_ID_RE = /^ls_[0-9a-f]{32}$/;
const CODE_RE = /^[a-z_]{1,32}$/;
const REASON_RE = /^[A-Za-z_]{1,32}$/;
const CORRELATION_REF_RE = /^[A-Za-z0-9._:/-]{1,256}$/;

/** Every state the inbox can show (`stale` is derived; `denied` is a synchronous refusal, from the audit log). */
export const LAUNCHER_INBOX_STATES = ['pending_approval', 'approved', 'consumed', 'stale', 'denied_by_user', 'expired', 'denied'] as const;
export type LauncherInboxState = (typeof LAUNCHER_INBOX_STATES)[number];

export type LauncherInboxItem = {
  kind: 'record' | 'denied';
  id?: string;
  state: LauncherInboxState;
  at: number;
  decidedAt?: number;
  consumedAt?: number;
  expiresAt?: number;
  /** Reason区分 (records: state-derived; denied: the launcher reason, e.g. STOP_ALL_ACTIVE). */
  reason?: string;
  /** Denied only: the audit code (e.g. `halted`). */
  code?: string;
  approvedVia?: 'rule' | 'approve_all' | 'user';
  correlationRef?: string;
  untrusted?: boolean;
  codePoints?: number;
};

export type LauncherInbox = { ok: boolean; now: number; halted: boolean; items: LauncherInboxItem[] };

const EMPTY_INBOX: LauncherInbox = { ok: false, now: 0, halted: false, items: [] };

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function isState(v: unknown): v is LauncherInboxState {
  return typeof v === 'string' && (LAUNCHER_INBOX_STATES as readonly string[]).includes(v);
}

/** One inbox item, or null when anything is off (dropped, never guessed). */
function parseItem(raw: unknown): LauncherInboxItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if ((o.kind !== 'record' && o.kind !== 'denied') || !isState(o.state) || !isNum(o.at)) return null;
  if ((o.kind === 'denied') !== (o.state === 'denied')) return null;
  const item: LauncherInboxItem = { kind: o.kind, state: o.state, at: o.at };
  if (o.id !== undefined) {
    if (typeof o.id !== 'string' || !SUBMISSION_ID_RE.test(o.id)) return null;
    item.id = o.id;
  }
  if (o.kind === 'record' && item.id === undefined) return null;
  for (const k of ['decidedAt', 'consumedAt', 'expiresAt', 'codePoints'] as const) {
    if (o[k] === undefined) continue;
    if (!isNum(o[k])) return null;
    item[k] = o[k] as number;
  }
  if (o.reason !== undefined) {
    if (typeof o.reason !== 'string' || !REASON_RE.test(o.reason)) return null;
    item.reason = o.reason;
  }
  if (o.code !== undefined) {
    if (typeof o.code !== 'string' || !CODE_RE.test(o.code)) return null;
    item.code = o.code;
  }
  if (o.approvedVia !== undefined) {
    if (o.approvedVia !== 'rule' && o.approvedVia !== 'approve_all' && o.approvedVia !== 'user') return null;
    item.approvedVia = o.approvedVia;
  }
  if (o.correlationRef !== undefined) {
    if (typeof o.correlationRef !== 'string' || !CORRELATION_REF_RE.test(o.correlationRef)) return null;
    item.correlationRef = o.correlationRef;
  }
  if (o.untrusted !== undefined) {
    if (typeof o.untrusted !== 'boolean') return null;
    item.untrusted = o.untrusted;
  }
  // Never any text in the inbox.
  if ('text' in o || 'instruction_text' in o) return null;
  return item;
}

/** LauncherSubmissionCore.inboxJson. Malformed items are dropped; a malformed document is an empty, not-ok inbox. Never throws. */
export function parseLauncherInbox(raw: unknown): LauncherInbox {
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return EMPTY_INBOX;
    const { v, now, halted, items } = o as Record<string, unknown>;
    if (v !== 1 || !isNum(now) || typeof halted !== 'boolean' || !Array.isArray(items)) return EMPTY_INBOX;
    const out: LauncherInboxItem[] = [];
    for (const it of items) {
      const p = parseItem(it);
      if (p) out.push(p);
    }
    return { ok: true, now, halted, items: out };
  } catch {
    return EMPTY_INBOX;
  }
}

export type LauncherPending = { ok: boolean; halted: boolean; ids: string[] };

/** LauncherSubmissionCore.pendingJson: oldest first. Never throws. */
export function parseLauncherPending(raw: unknown): LauncherPending {
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, halted: false, ids: [] };
    const { v, halted, ids } = o as Record<string, unknown>;
    if (v !== 1 || typeof halted !== 'boolean' || !Array.isArray(ids)) return { ok: false, halted: false, ids: [] };
    if (!ids.every((id) => typeof id === 'string' && SUBMISSION_ID_RE.test(id))) return { ok: false, halted: false, ids: [] };
    return { ok: true, halted, ids: ids as string[] };
  } catch {
    return { ok: false, halted: false, ids: [] };
  }
}

export type LauncherPrompt = {
  id: string;
  /** The owner's instruction, for the on-device prompt only. Never log it. */
  text: string;
  acceptedAt: number;
  expiresAt: number;
  untrusted: boolean;
  codePoints: number;
  correlationRef?: string;
};

/** LauncherSubmissionCore.promptJson. Null when anything is off. Never throws. */
export function parseLauncherPrompt(raw: unknown): LauncherPrompt | null {
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    const { v, id, text, acceptedAt, expiresAt, untrusted, codePoints, correlationRef } = o as Record<string, unknown>;
    if (v !== 1 || typeof id !== 'string' || !SUBMISSION_ID_RE.test(id)) return null;
    if (typeof text !== 'string' || text.length === 0) return null;
    if (!isNum(acceptedAt) || !isNum(expiresAt) || !isNum(codePoints) || typeof untrusted !== 'boolean') return null;
    const p: LauncherPrompt = { id, text, acceptedAt, expiresAt, untrusted, codePoints };
    if (correlationRef !== undefined) {
      if (typeof correlationRef !== 'string' || !CORRELATION_REF_RE.test(correlationRef)) return null;
      p.correlationRef = correlationRef;
    }
    return p;
  } catch {
    return null;
  }
}

export type LauncherDecisionResult = { ok: boolean; code: string; state?: string; rule?: 'added' | 'failed' };

export function parseLauncherDecisionResult(raw: unknown): LauncherDecisionResult {
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, code: 'failed' };
    const { ok, code, state, rule } = o as Record<string, unknown>;
    if (typeof ok !== 'boolean' || typeof code !== 'string' || !CODE_RE.test(code)) return { ok: false, code: 'failed' };
    const r: LauncherDecisionResult = { ok, code };
    if (typeof state === 'string' && isState(state)) r.state = state;
    if (rule === 'added' || rule === 'failed') r.rule = rule;
    return r;
  } catch {
    return { ok: false, code: 'failed' };
  }
}

/** Short, log-safe id label (never the text). */
export function submissionTag(id: string): string {
  return id.slice(0, 11);
}

/** Milliseconds left in the approval window (0 when past). */
export function remainingMs(expiresAt: number, now: number): number {
  return Math.max(0, expiresAt - now);
}

/** "m:ss" for the countdown. */
export function formatRemaining(ms: number): string {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── Native wrappers (fail to "nothing") ──────────────────────────────────

export async function fetchLauncherInbox(): Promise<LauncherInbox> {
  if (typeof TerminalEmulator.launcherSubmissionInbox !== 'function') return EMPTY_INBOX;
  try {
    return parseLauncherInbox(await TerminalEmulator.launcherSubmissionInbox());
  } catch {
    return EMPTY_INBOX;
  }
}

export async function fetchLauncherPending(): Promise<LauncherPending> {
  if (typeof TerminalEmulator.launcherSubmissionPending !== 'function') return { ok: false, halted: false, ids: [] };
  try {
    return parseLauncherPending(await TerminalEmulator.launcherSubmissionPending());
  } catch {
    return { ok: false, halted: false, ids: [] };
  }
}

export async function fetchLauncherPrompt(id: string): Promise<LauncherPrompt | null> {
  if (!SUBMISSION_ID_RE.test(id) || typeof TerminalEmulator.launcherSubmissionPrompt !== 'function') return null;
  try {
    return parseLauncherPrompt(await TerminalEmulator.launcherSubmissionPrompt(id));
  } catch {
    return null;
  }
}

/** The owner's decision, with one of the existing kinds only. */
export async function decideLauncherSubmission(id: string, decision: McpApprovalDecision): Promise<LauncherDecisionResult> {
  if (!SUBMISSION_ID_RE.test(id) || typeof TerminalEmulator.launcherSubmissionDecide !== 'function') return { ok: false, code: 'unavailable' };
  if (decision !== 'deny' && decision !== 'once' && decision !== 'always') return { ok: false, code: 'invalid' };
  try {
    return parseLauncherDecisionResult(await TerminalEmulator.launcherSubmissionDecide(id, decision));
  } catch {
    return { ok: false, code: 'failed' };
  }
}

// ── The prompt controller ────────────────────────────────────────────────

const DECISION_ERROR_CODES = ['not_pending', 'not_found', 'halted', 'registration_changed', 'audit_failed', 'store_failed'] as const;

/** The i18n message for a decision that was not recorded. */
export function decisionErrorMessage(code: string): string {
  return (DECISION_ERROR_CODES as readonly string[]).includes(code)
    ? t(`launcher_approval.err.${code}`)
    : t('launcher_approval.err.generic', { code });
}

function notify(message: string): void {
  try {
    if (Platform.OS === 'android') ToastAndroid.show(message, ToastAndroid.LONG);
  } catch {
    // a toast is best effort
  }
}

export type PromptTrigger = 'foreground' | 'poll' | 'next' | 'inbox';

/** Closed without a decision: no automatic prompt until the next foreground (or an inbox tap). */
let suppressedUntilForeground = false;
let checking = false;

/** True when a launcher prompt is shown or queued in the approval store. */
function launcherPromptOpen(): boolean {
  const { current, queue } = useMcpApprovalStore.getState();
  return current?.kind === 'submit_instruction' || queue.some((r) => r.kind === 'submit_instruction');
}

/** Test hook. */
export function __resetLauncherApprovalForTests(): void {
  suppressedUntilForeground = false;
  checking = false;
}

/**
 * Shows the oldest pending launcher submission (or [id], from the inbox) in
 * the approval modal, unless one is already shown, STOP-ALL is on, or the
 * owner closed the last prompt and Shelly has not come to the foreground
 * since. Returns whether a prompt was shown.
 */
export async function maybePromptLauncherSubmission(trigger: PromptTrigger, id?: string): Promise<boolean> {
  if (trigger === 'foreground' || trigger === 'inbox') suppressedUntilForeground = false;
  if (suppressedUntilForeground || checking || launcherPromptOpen()) return false;
  checking = true;
  try {
    const pending = await fetchLauncherPending();
    if (!pending.ok || pending.halted) return false;
    const target = id !== undefined ? (pending.ids.includes(id) ? id : null) : pending.ids[0] ?? null;
    if (!target) return false;
    const prompt = await fetchLauncherPrompt(target);
    if (!prompt || launcherPromptOpen()) return false;
    enqueuePrompt(prompt);
    logInfo('LauncherApproval', `prompt shown ${submissionTag(prompt.id)} (${trigger})`);
    return true;
  } finally {
    checking = false;
  }
}

function enqueuePrompt(prompt: LauncherPrompt): void {
  const requestId = `launcher-${prompt.id}-${Date.now()}`;
  let closedByExpiry = false;
  const store = useMcpApprovalStore.getState();
  // The window ends while it is shown: close it (no decision), native expires it.
  const timer = setTimeout(() => {
    closedByExpiry = true;
    useMcpApprovalStore.getState().dismiss(requestId);
  }, Math.max(0, prompt.expiresAt - Date.now()));
  store.enqueue({
    id: requestId,
    kind: 'submit_instruction',
    summary: '',
    detail: prompt.text,
    alwaysAllowable: { op: 'submit_instruction', targetLabel: 'hayato' },
    launcher: { submissionId: prompt.id, sentAt: prompt.acceptedAt, expiresAt: prompt.expiresAt, untrusted: prompt.untrusted },
    onDismiss: () => {
      clearTimeout(timer);
      if (!closedByExpiry) suppressedUntilForeground = true;
      else setTimeout(() => void maybePromptLauncherSubmission('next'), 0);
    },
    resolve: (decision) => {
      clearTimeout(timer);
      void decideLauncherSubmission(prompt.id, decision).then((r) => {
        if (r.ok) {
          logInfo('LauncherApproval', `decided ${submissionTag(prompt.id)} ${r.code}${r.rule ? ` rule=${r.rule}` : ''}`);
          if (r.rule === 'failed') notify(t('launcher_approval.err.rule_failed'));
        } else {
          logWarn('LauncherApproval', `decision not recorded ${submissionTag(prompt.id)} (${r.code})`);
          notify(decisionErrorMessage(r.code));
          // Not decided (e.g. STOP-ALL came on): it stays pending; no automatic re-prompt until the next foreground.
          if (r.code !== 'not_pending') suppressedUntilForeground = true;
        }
        // One at a time, oldest first.
        void maybePromptLauncherSubmission('next');
      });
    },
  });
}
