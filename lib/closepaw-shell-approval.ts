/**
 * lib/closepaw-shell-approval.ts — RN side of the Shelly approval for
 * `shelly closepaw "<goal>"` when the Shelly-trusted ClosePaw variant is
 * installed (2026-10-14). Native owner: ClosePawShellApprovals.kt (pending
 * requests in process memory, notification [Approve]/[Reject], launch).
 *
 * The variant skips ClosePaw's own "External Goal" dialog for launches that
 * carry Shelly's caller token, so Shelly's approval is the only gate. The
 * shell command is typed by the user or by Codex driven from the ChatGPT
 * app, so it never fires directly; it fires only after:
 *   - the notification [Approve] (device unlock; since 2026-10-15 applied
 *     natively by ClosePawDecisionReceiver without opening Shelly — the
 *     shelly:///closepaw-decision handler below only serves notifications
 *     posted by older builds; the nonce is single use either way),
 *   - an in-app dedicated chat reply naming the request ("approve <hash8>" /
 *     "承認 <hash8>"): pending requests are posted into the Shelly chat as
 *     plain text (syncClosePawShellApprovalsToChat); a bare "OK" never counts
 *     (findClosePawChatReplyTarget, hooks/use-ai-pane-dispatch.ts).
 * `shelly closepaw confirm` from ChatGPT / the terminal is REFUSED for
 * approve (user decision 2026-10-14, option 3); `shelly closepaw reject` works.
 * With the official ClosePaw nothing here runs (its own dialog stays the gate).
 */
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { useAIPaneStore, COMPANION_CONVERSATION_KEY } from '@/store/ai-pane-store';
import { tFor, type Locale } from '@/lib/i18n';
import { detectMessageLocale } from '@/lib/agent-slot-fill';
import { logInfo, logWarn } from '@/lib/debug-logger';
import type { AgentAddResult } from '@/lib/agent-add-queue';
import { parseClosePawShellPendingList } from '@/lib/closepaw-shell-reply';
import { asClosePawRefusal, closePawOutcomeKey, closePawRefusalKey } from '@/lib/closepaw-background';
const REQ_ID_RE = /^[0-9]{10,16}-[0-9a-f]{8}$/;
export * from '@/lib/closepaw-shell-reply';

function parseOutcome(raw: unknown): AgentAddResult {
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (o && typeof o === 'object' && typeof (o as AgentAddResult).message === 'string') {
      const r = o as { ok?: unknown; message: string };
      return { ok: r.ok === true, code: r.ok === true ? 'sent' : 'invalid', message: r.message };
    }
  } catch {}
  return { ok: false, code: 'failed', message: 'shelly closepaw: Shelly could not resolve the request' };
}

/** Native resolve() code ('background' / 'main-display' / a refusal wire / …). */
function nativeCode(raw: unknown): string | null {
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const code = o && typeof o === 'object' ? (o as { code?: unknown }).code : null;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

/** Localized line for a variant background-entry outcome or refusal
 *  (ClosePawHandoff.sendVariantBroadcast), else null (keep the old text). */
export function closePawApprovalOutcomeLine(raw: unknown, locale: Locale): string | null {
  const code = nativeCode(raw);
  const refusal = asClosePawRefusal(code);
  if (refusal) return tFor(locale, closePawRefusalKey(refusal));
  if (code === 'background' || code === 'main-display') {
    const key = closePawOutcomeKey(code);
    return key ? tFor(locale, key) : null;
  }
  return null;
}

function note(content: string, extra: Record<string, unknown> = {}): void {
  useAIPaneStore.getState().addMessage(COMPANION_CONVERSATION_KEY, {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    role: 'assistant',
    content,
    timestamp: Date.now(),
    ...extra,
  });
}

function localeOf(goal: string): Locale {
  return detectMessageLocale(goal);
}

const postedToChat = new Set<string>();

/** While Shelly is active: post every pending request once into the chat as
 *  plain text (reply OK to approve / cancel to reject). */
export async function syncClosePawShellApprovalsToChat(): Promise<void> {
  if (!TerminalEmulator.listClosePawShellApprovals) return;
  const list = parseClosePawShellPendingList(await TerminalEmulator.listClosePawShellApprovals().catch(() => '[]'));
  for (const p of list) {
    if (postedToChat.has(p.reqId)) continue;
    postedToChat.add(p.reqId);
    note(tFor(localeOf(p.goal), 'closepaw.shell_approval_chat', { goal: p.goal, hash: p.hash8 }), {
      pendingClosePawShell: { reqId: p.reqId, hash8: p.hash8, createdAt: Date.now() },
    });
  }
}

/** Typed confirm/cancel reply to the chat line posted above. */
export async function resolveClosePawShellFromChat(
  pending: { reqId: string; hash8: string },
  decision: 'approve' | 'reject',
  locale: Locale,
): Promise<string> {
  if (!TerminalEmulator.resolveClosePawShellApproval) return tFor(locale, 'closepaw.shell_approval_unavailable');
  const raw = await TerminalEmulator.resolveClosePawShellApproval(pending.reqId, decision, 'chat', pending.hash8).catch(() => null);
  const r = parseOutcome(raw);
  logInfo('ClosePawShell', `chat ${decision} ${pending.reqId}: ${r.ok ? 'ok' : 'refused'}`);
  const outcomeLine = decision === 'approve' ? closePawApprovalOutcomeLine(raw, locale) : null;
  if (outcomeLine) return outcomeLine;
  return r.ok
    ? tFor(locale, decision === 'approve' ? 'closepaw.shell_approved_chat' : 'closepaw.shell_rejected_chat')
    : r.message;
}

/** shelly:///closepaw-decision?reqId&decision&nonce (notification action). */
export async function handleClosePawDecisionDeepLink(params: { reqId: unknown; decision: unknown; nonce: unknown }): Promise<void> {
  const reqId = typeof params.reqId === 'string' ? params.reqId : '';
  const decision = params.decision === 'approve' ? 'approve' : params.decision === 'reject' ? 'reject' : null;
  const nonce = typeof params.nonce === 'string' ? params.nonce : '';
  if (!REQ_ID_RE.test(reqId) || !decision || !TerminalEmulator.resolveClosePawShellApproval) return;
  const raw = await TerminalEmulator.resolveClosePawShellApproval(reqId, decision, 'notification', nonce).catch(() => null);
  const r = parseOutcome(raw);
  // Never log the nonce.
  logInfo('ClosePawShell', `notification ${decision} ${reqId}: ${r.ok ? 'ok' : 'refused'}`);
  const outcomeLine = decision === 'approve' ? closePawApprovalOutcomeLine(raw, 'en') : null;
  note(outcomeLine ?? (r.ok ? tFor('en', decision === 'approve' ? 'closepaw.shell_approved_notification' : 'closepaw.shell_rejected_notification') : r.message));
}

/** Shown when ChatGPT / the terminal tries to approve something that, with
 *  the trusted ClosePaw variant, must be approved on the phone. */
export const CLOSEPAW_DEVICE_APPROVAL_REQUIRED_MESSAGE =
  "shelly closepaw: this needs approval on the phone - ask the user to approve it in the Shelly notification (device unlock required) or by replying \"approve <hash>\" in Shelly's chat; it cannot be approved from ChatGPT or the terminal";

/** `shelly closepaw confirm <reqId> <hash8>` / `shelly closepaw reject <reqId>`
 *  relayed through the agent ctl queue. User decision (2026-10-14, option 3):
 *  approve is ALWAYS refused here (only the notification Approve with device
 *  unlock or the in-app dedicated reply may approve); reject is allowed. */
export async function handleClosePawShellCtl(op: 'approve' | 'reject', reqId: string, hash8: string): Promise<AgentAddResult> {
  if (op === 'approve') {
    void hash8;
    return { ok: false, code: 'invalid', message: CLOSEPAW_DEVICE_APPROVAL_REQUIRED_MESSAGE };
  }
  if (!TerminalEmulator.resolveClosePawShellApproval) {
    return { ok: false, code: 'failed', message: 'shelly closepaw: this build of Shelly cannot resolve ClosePaw requests' };
  }
  const r = parseOutcome(await TerminalEmulator.resolveClosePawShellApproval(reqId, 'reject', 'chatgpt', '').catch(() => null));
  if (r.ok) {
    note(tFor('en', 'closepaw.shell_rejected_chatgpt'));
  } else {
    logWarn('ClosePawShell', `chatgpt ${op} ${reqId} refused`);
  }
  return r;
}
