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
 *   - the notification [Approve] (device unlock; shelly:///closepaw-decision,
 *     handled here before any URL logging — the nonce is single use),
 *   - an in-app chat "OK": pending requests are posted into the Shelly chat
 *     as plain text (syncClosePawShellApprovalsToChat) and a typed confirm
 *     phrase resolves it (hooks/use-ai-pane-dispatch.ts),
 *   - `shelly closepaw confirm <reqId> <hash8>` from ChatGPT — refused when
 *     AppSettings.agentApproveFromChatGpt is OFF; followed by an audit
 *     notification and a chat record.
 * With the official ClosePaw nothing here runs (its own dialog stays the gate).
 */
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { useAIPaneStore, COMPANION_CONVERSATION_KEY } from '@/store/ai-pane-store';
import { useSettingsStore } from '@/store/settings-store';
import { tFor, type Locale } from '@/lib/i18n';
import { detectMessageLocale } from '@/lib/agent-slot-fill';
import { sanitizeClosePawGoal } from '@/lib/agent-intent-review';
import { agentAddSha256Hex } from '@/lib/agent-add-approval';
import { logInfo, logWarn } from '@/lib/debug-logger';
import type { AgentAddResult } from '@/lib/agent-add-queue';

export type ClosePawShellPending = { reqId: string; goal: string; hash8: string; expiresAt: number };

const REQ_ID_RE = /^[0-9]{10,16}-[0-9a-f]{8}$/;
const HASH8_RE = /^[0-9a-f]{8}$/;

/** Mirrors ClosePawShellApprovals.hash8 (native): first 8 hex of
 *  sha256("shelly-closepaw-shell-v1\n" + sanitized goal). */
export async function closePawShellHash8(goal: string): Promise<string> {
  return (await agentAddSha256Hex(`shelly-closepaw-shell-v1\n${sanitizeClosePawGoal(goal)}`)).slice(0, 8);
}

export function parseClosePawShellPendingList(raw: unknown): ClosePawShellPending[] {
  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (p): p is ClosePawShellPending =>
      !!p &&
      typeof p === 'object' &&
      REQ_ID_RE.test(String((p as ClosePawShellPending).reqId)) &&
      HASH8_RE.test(String((p as ClosePawShellPending).hash8)) &&
      typeof (p as ClosePawShellPending).goal === 'string',
  );
}

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
  const r = parseOutcome(await TerminalEmulator.resolveClosePawShellApproval(pending.reqId, decision, 'chat', pending.hash8).catch(() => null));
  logInfo('ClosePawShell', `chat ${decision} ${pending.reqId}: ${r.ok ? 'ok' : 'refused'}`);
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
  const r = parseOutcome(await TerminalEmulator.resolveClosePawShellApproval(reqId, decision, 'notification', nonce).catch(() => null));
  // Never log the nonce.
  logInfo('ClosePawShell', `notification ${decision} ${reqId}: ${r.ok ? 'ok' : 'refused'}`);
  note(r.ok ? tFor('en', decision === 'approve' ? 'closepaw.shell_approved_notification' : 'closepaw.shell_rejected_notification') : r.message);
}

/** `shelly closepaw confirm <reqId> <hash8>` / `shelly closepaw reject <reqId>`
 *  relayed through the agent ctl queue. */
export async function handleClosePawShellCtl(op: 'approve' | 'reject', reqId: string, hash8: string): Promise<AgentAddResult> {
  if (!TerminalEmulator.resolveClosePawShellApproval) {
    return { ok: false, code: 'failed', message: 'shelly closepaw: this build of Shelly cannot approve ClosePaw requests' };
  }
  if (op === 'approve' && useSettingsStore.getState().settings.agentApproveFromChatGpt === false) {
    return {
      ok: false,
      code: 'invalid',
      message:
        'shelly closepaw confirm: approving from ChatGPT is turned off in Shelly (Settings → Approve Agents from ChatGPT). Ask the user to approve it in Shelly or from its notification.',
    };
  }
  const r = parseOutcome(await TerminalEmulator.resolveClosePawShellApproval(reqId, op, 'chatgpt', hash8).catch(() => null));
  if (r.ok) {
    note(tFor('en', op === 'approve' ? 'closepaw.shell_approved_chatgpt' : 'closepaw.shell_rejected_chatgpt'));
    if (op === 'approve') {
      // The AI on the other side could have run the command itself: always
      // announce it (no Disable — a one-shot hand-off cannot be undone).
      await TerminalEmulator.postAgentAddAuditNotification?.(
        '',
        tFor('en', 'closepaw.shell_audit_title'),
        tFor('en', 'closepaw.shell_audit_body'),
        '',
      ).catch(() => false);
    }
  } else {
    logWarn('ClosePawShell', `chatgpt ${op} ${reqId} refused`);
  }
  return r;
}
