/**
 * lib/agent-add-flow.ts — app-side glue for `shelly agent add` approvals
 * (2026-10-14). Pure policy lives in lib/agent-add-approval.ts (bindings,
 * risk tier, hash-prefix/nonce checks), lib/agent-add-queue.ts (wire format,
 * drain) and lib/agent-closepaw-preapproval.ts (one-approval ClosePaw seal);
 * this module connects them to the AI pane, the native notifications and the
 * shell-readable summary file.
 *
 * Flow:
 *   1. The drain hands `@agent <text>` to an AI pane (source
 *      'terminal-request', with its requestId). The normal NL flow parses it
 *      (including automatic ClosePaw routing of a UI-operation step —
 *      lib/agent-closepaw-routing.ts) and presents the draft for
 *      confirmation (always — terminal requests are never auto-registered).
 *   2. presentDraftForConfirmation calls onTerminalDraftPresented: a binding
 *      is created (exact draft hash, nonces), a plain chat line explains how
 *      it can be approved, the summary file
 *      `$HOME/.shelly-agent-summary-<reqId>.json` is written for
 *      `shelly agent add` / `shelly agent show` (incl. the definition-hash
 *      prefix, never a nonce), and the approval notification is posted with
 *      [Approve] (remote-approvable drafts, API 31+, device unlock required)
 *      [Review in Shelly] [Reject].
 *   3. A decision arrives from: the chat (typed OK / buttons — unchanged), a
 *      notification action (handleAgentAddDecisionDeepLink), or the ChatGPT
 *      conversation via `shelly agent confirm <reqId> <hash8>` /
 *      `shelly agent reject <reqId>` (handleAgentCtl, gated by
 *      AppSettings.agentApproveFromChatGpt). Every approval re-checks that the
 *      still-pending draft hashes to the bound definition, records the
 *      decision in the chat in plain text, then runs the SAME
 *      confirmAgentDraft(messageId, draftToConfirmedAgentDraft(draft)) the
 *      chat "OK" uses. A ChatGPT approval additionally posts an audit
 *      notification with a one-tap Disable. The shell never writes
 *      ~/.shelly/agents.
 *   4. onAgentDraftResolved (after EVERY confirm/cancel, any path) seals the
 *      ClosePaw pre-approval for a registered agent with a ClosePaw hand-off
 *      — the registration approval is the one approval for its runs.
 */
import * as FileSystem from 'expo-file-system/legacy';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { useAIPaneStore } from '@/store/ai-pane-store';
import { useAgentStore } from '@/store/agent-store';
import { useSettingsStore } from '@/store/settings-store';
import type { Agent, ChatMessage } from '@/store/types';
import type { ParsedAgentDraft } from '@/lib/agent-nl-parser';
import { tFor, type Locale } from '@/lib/i18n';
import { detectMessageLocale } from '@/lib/agent-slot-fill';
import { firstRunPassedNote, humanizeCronSchedule, toolSubstitutionKey } from '@/lib/agent-plan-summary';
import { describeDraftTool } from '@/lib/agent-tool-router';
import { execCommand } from '@/hooks/use-native-exec';
import { setAgentEnabled } from '@/lib/agent-manager';
import { logInfo, logWarn } from '@/lib/debug-logger';
import {
  agentAddSummaryFileName,
  isAgentAddRequestId,
  type AgentAddResult,
  type AgentCtlRequest,
} from '@/lib/agent-add-queue';
import {
  buildAgentAddSummary,
  closePawStepText,
  consumeAgentAddBinding,
  createAgentAddBinding,
  draftHashPrefix,
  findAgentAddBindingByMessage,
  getAgentAddBinding,
  isDraftStillBound,
  sweepAgentAddBindings,
  verifyAgentAddNotificationDecision,
  verifyAgentAddTextConfirm,
  type AgentAddBinding,
  type AgentAddSummary,
} from '@/lib/agent-add-approval';
import { handleClosePawShellCtl } from '@/lib/closepaw-shell-approval';
import { agentMatchesApprovedDraft, revokeClosePawPreapproval, sealClosePawPreapproval } from '@/lib/agent-closepaw-preapproval';

export type AgentAddPaneHandlers = {
  confirm: (messageId: string, draft: ParsedAgentDraft) => Promise<void>;
  cancel: (messageId: string) => void;
};

type ApprovalVia = 'chat' | 'notification' | 'chatgpt';

const handlers = new Map<string, AgentAddPaneHandlers>();
/** reqIds whose summary already records the final decision. */
const finalized = new Set<string>();
/** messageId → how the in-flight approval was given (for seal/audit). */
const approvalVia = new Map<string, ApprovalVia>();
/** agentId → single-use nonce of its audit notification's Disable action. */
const disableNonces = new Map<string, { nonce: string; expiresAt: number }>();
const DISABLE_NONCE_TTL_MS = 24 * 60 * 60 * 1000;

/** AIPane registers its confirm/cancel for its conversation key. */
export function registerAgentAddPaneHandlers(conversationKey: string, h: AgentAddPaneHandlers): () => void {
  handlers.set(conversationKey, h);
  return () => {
    if (handlers.get(conversationKey) === h) handlers.delete(conversationKey);
  };
}

const DECISION_READY_TIMEOUT_MS = 8_000;

export const AGENT_CLOSEPAW_DEVICE_APPROVAL_MESSAGE =
  "shelly agent confirm: this agent includes a ClosePaw step and the Shelly-trusted ClosePaw build is installed, so it must be approved on the phone - ask the user to tap Approve in the Shelly notification (device unlock required) or reply OK to the draft in Shelly's chat";

/** True when a ClosePaw step needs an on-phone approval: the Shelly-trusted
 *  variant is installed (no ClosePaw dialog). Fail-closed: unknown ⇒ true. */
async function closePawNeedsDeviceApproval(): Promise<boolean> {
  if (!TerminalEmulator.isClosePawTrustedVariantInstalled) return true;
  return (await TerminalEmulator.isClosePawTrustedVariantInstalled().catch(() => true)) !== false;
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
  return true;
}

function homeDir(): string {
  return `${FileSystem.documentDirectory}home`;
}

function newId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function randomHex(bytes: number): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Crypto = require('expo-crypto');
  return Array.from(Crypto.getRandomBytes(bytes) as Uint8Array, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function runShell(cmd: string): Promise<string> {
  const r = await execCommand(cmd, 120_000);
  if (r.exitCode !== 0) throw new Error(r.stderr || `exit ${r.exitCode}`);
  return r.stdout;
}

function draftLocale(draft: ParsedAgentDraft): Locale {
  return detectMessageLocale(String((draft as { rawText?: string }).rawText ?? draft.prompt ?? ''));
}

function scheduleText(draft: ParsedAgentDraft, locale: Locale): string {
  if (draft.schedule && draft.schedule !== 'once') {
    try {
      return humanizeCronSchedule(draft.schedule, locale);
    } catch {
      return draft.scheduleLabel || draft.schedule;
    }
  }
  return draft.scheduleLabel || (locale === 'ja' ? '未設定' : 'not set');
}

/** Live Autonomous Cloud consent (engine disclosure in the summary file). */
function liveCloudConsent(): boolean {
  return useSettingsStore.getState().settings.autonomousCloudConsent ?? false;
}

/** Engine disclosure for the `shelly agent add` summary (review L2). */
function toolSummary(draft: ParsedAgentDraft, locale: Locale): { label: string; pinned: boolean; note: string | null } {
  const d = describeDraftTool(draft, liveCloudConsent());
  const note = d.substitution
    ? tFor(locale, toolSubstitutionKey(d.substitution.reason), { from: d.substitution.from, to: d.substitution.to })
    : null;
  return { label: d.label, pinned: d.pinned, note };
}

function riskLabel(reason: string, locale: Locale): string {
  const key = `agents.terminal_request_risk.${reason.replace(/^action:.*/, 'action')}`;
  const type = reason.startsWith('action:') ? reason.slice('action:'.length) : '';
  return tFor(locale, key, { type });
}

function postNote(conversationKey: string, content: string, extra?: Partial<ChatMessage>): void {
  useAIPaneStore.getState().addMessage(conversationKey, {
    id: newId(),
    role: 'assistant',
    content,
    timestamp: Date.now(),
    ...(extra ?? {}),
  });
}

async function writeSummary(summary: AgentAddSummary): Promise<void> {
  const target = `${homeDir()}/${agentAddSummaryFileName(summary.requestId)}`;
  try {
    await FileSystem.writeAsStringAsync(`${target}.tmp`, JSON.stringify(summary));
    await FileSystem.moveAsync({ from: `${target}.tmp`, to: target });
  } catch (e) {
    logWarn('AgentAddFlow', `summary write failed for ${summary.requestId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function cancelNotification(): void {
  void TerminalEmulator.cancelAgentAddNotification?.().catch(() => undefined);
}

/**
 * Called by presentDraftForConfirmation for a terminal-originated draft that
 * now awaits confirmation. Never throws (best-effort; the in-chat
 * confirmation works regardless).
 */
export async function onTerminalDraftPresented(params: {
  /** The draft's OWN terminalRequestId (never a global "last request"). */
  reqId: string;
  conversationKey: string;
  messageId: string;
  draft: ParsedAgentDraft;
  fireable: boolean;
}): Promise<void> {
  try {
    const reqId = params.reqId;
    if (!isAgentAddRequestId(reqId) || params.draft.terminalRequestId !== reqId) return;
    sweepAgentAddBindings();
    // Never rebinds a decided / finalized / expired request (returns null).
    const binding = await createAgentAddBinding({
      reqId,
      conversationKey: params.conversationKey,
      messageId: params.messageId,
      draft: params.draft,
      fireable: params.fireable,
      isFinalized: (id) => finalized.has(id),
    });
    if (!binding) {
      logInfo('AgentAddFlow', `request ${reqId} is decided or expired; draft not bound`);
      return;
    }
    const locale = draftLocale(params.draft);
    const schedule = scheduleText(params.draft, locale);
    const risks = binding.riskReasons.map((r) => riskLabel(r, locale));
    const hash8 = draftHashPrefix(binding);
    const closePaw = closePawStepText(params.draft as never);

    // Chat: plain NL lines.
    const lines: string[] = [];
    // (An auto-routed step is already named in the draft summary itself.)
    if (closePaw && !params.draft.closePawRouting?.routed) {
      lines.push(tFor(locale, 'agents.terminal_request_closepaw_line', { step: closePaw }));
    }
    // ClosePaw step + Shelly-trusted variant: on-phone approval only.
    const textConfirmAllowed = !(closePaw && (await closePawNeedsDeviceApproval()));
    lines.push(
      binding.approvable
        ? tFor(locale, textConfirmAllowed ? 'agents.terminal_request_approvable_note' : 'agents.terminal_request_approvable_note_device', { hash: hash8 })
        : risks.length > 0
          ? tFor(locale, 'agents.terminal_request_review_only', { reasons: risks.join(', ') })
          : tFor(locale, 'agents.terminal_request_review_only_schedule'),
    );
    postNote(params.conversationKey, lines.join('\n\n'));

    await writeSummary(buildAgentAddSummary(binding, params.draft, schedule, 'parsed', { textConfirmAllowed, tool: toolSummary(params.draft, locale) }));

    // Notification (VISIBILITY_PRIVATE; public version is title-only).
    const body = [
      tFor(locale, 'agents.terminal_request_notif_name', { name: params.draft.name }),
      tFor(locale, 'agents.terminal_request_notif_schedule', { schedule }),
      tFor(locale, 'agents.terminal_request_notif_what', { what: String(params.draft.prompt ?? '').slice(0, 160) }),
      tFor(locale, 'agents.terminal_request_notif_actions', {
        actions: (params.draft.actions?.length ? params.draft.actions : [params.draft.action])
          .map((a) => (a?.type === 'intent' && a.intentMode ? `intent:${a.intentMode}` : a?.type ?? 'unknown'))
          .join(', '),
      }),
    ];
    if (closePaw) body.push(tFor(locale, 'agents.terminal_request_closepaw_line', { step: closePaw.slice(0, 200) }));
    const engineNote = toolSummary(params.draft, locale).note;
    if (engineNote) body.push(engineNote);
    if (risks.length > 0) body.push(tFor(locale, 'agents.terminal_request_notif_risky', { reasons: risks.join(', ') }));
    // Follow-up item 6 (2026-10-15): an in-app-only draft has NO Approve
    // action (native posts Review/Reject only); the body says plainly that
    // the user must open Shelly — tapping the notification opens the AI pane
    // with the draft.
    if (!binding.approvable) body.push(tFor(locale, 'agents.terminal_request_notif_confirm_in_shelly'));
    body.push(tFor(locale, 'agents.terminal_request_notif_hash', { hash: hash8 }));
    await TerminalEmulator.postAgentAddApprovalNotification?.(
      reqId,
      tFor(locale, 'agents.terminal_request_notif_title'),
      body.join('\n'),
      binding.approvable,
      binding.approveNonce ?? '',
      binding.rejectNonce,
    ).catch(() => false);
    // Never log nonces.
    logInfo('AgentAddFlow', `draft bound for ${reqId} (approvable=${binding.approvable}, risks=${binding.riskReasons.length}, closePaw=${!!closePaw})`);
  } catch (e) {
    logWarn('AgentAddFlow', `onTerminalDraftPresented failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function findPendingDraftMessage(binding: AgentAddBinding): ChatMessage | null {
  const msg = useAIPaneStore
    .getState()
    .getOrCreate(binding.conversationKey)
    .messages.find((m) => m.id === binding.messageId);
  if (!msg || !msg.agentDraft || msg.agentCardState !== 'pending') return null;
  return msg;
}

async function finalizeSummary(binding: AgentAddBinding, status: 'registered' | 'rejected', draft: ParsedAgentDraft | null): Promise<void> {
  if (finalized.has(binding.reqId)) return;
  finalized.add(binding.reqId);
  cancelNotification();
  if (draft) {
    const locale = draftLocale(draft);
    await writeSummary(buildAgentAddSummary(binding, draft, scheduleText(draft, locale), status, { tool: toolSummary(draft, locale) }));
  }
}

/** messageId → the agent id that confirm EXACTLY created (store diff in
 *  hooks/use-ai-pane-dispatch.ts's confirmAgentDraft; never a guess). */
const createdAgentByMessage = new Map<string, string>();

function createdAgentFor(messageId: string): Agent | null {
  const id = createdAgentByMessage.get(messageId);
  return id ? useAgentStore.getState().agents.find((a) => a.id === id) ?? null : null;
}

async function postChatGptAudit(conversationKey: string, messageId: string, draft: ParsedAgentDraft): Promise<void> {
  const locale = draftLocale(draft);
  const agent = createdAgentFor(messageId);
  postNote(conversationKey, tFor(locale, 'agents.terminal_request_chatgpt_audit_chat', { name: agent?.name ?? draft.name }));
  if (!agent) {
    // Never skip the audit: when the created agent could not be identified
    // exactly, still announce it (no Disable action — it would need an exact
    // agent id); the tap opens the agent list.
    await TerminalEmulator.postAgentAddAuditNotification?.(
      '',
      tFor(locale, 'agents.terminal_request_audit_title', { name: draft.name }),
      tFor(locale, 'agents.terminal_request_audit_body_no_disable', { name: draft.name }),
      '',
    ).catch(() => false);
    return;
  }
  const nonce = randomHex(16);
  disableNonces.set(agent.id, { nonce, expiresAt: Date.now() + DISABLE_NONCE_TTL_MS });
  await TerminalEmulator.postAgentAddAuditNotification?.(
    agent.id,
    tFor(locale, 'agents.terminal_request_audit_title', { name: agent.name }),
    tFor(locale, 'agents.terminal_request_audit_body', { name: agent.name }),
    nonce,
  ).catch(() => false);
}

/** Apply a verified decision through the pane's normal confirm/cancel. */
export async function applyAgentAddDecision(
  binding: AgentAddBinding,
  decision: 'approve' | 'reject',
  via: 'notification' | 'chatgpt',
): Promise<AgentAddResult> {
  const h = handlers.get(binding.conversationKey);
  const msg = findPendingDraftMessage(binding);
  if (!msg || !msg.agentDraft) {
    return { ok: false, code: 'invalid', message: 'shelly agent: that agent draft is no longer pending in Shelly' };
  }
  const draft = msg.agentDraft as ParsedAgentDraft;
  const locale = draftLocale(draft);
  if (!h) {
    return { ok: false, code: 'failed', message: "shelly agent: open Shelly's AI pane and approve the agent there" };
  }
  if (decision === 'approve') {
    if (!(await isDraftStillBound(binding, draft))) {
      postNote(binding.conversationKey, tFor(locale, 'agents.terminal_request_changed'));
      return { ok: false, code: 'invalid', message: 'shelly agent: the draft changed after it was shown; review it in Shelly' };
    }
    postNote(binding.conversationKey, tFor(locale, via === 'notification' ? 'agents.terminal_request_approved_notification' : 'agents.terminal_request_approved_chatgpt'));
    approvalVia.set(binding.messageId, via);
    try {
      await h.confirm(binding.messageId, draft);
    } finally {
      approvalVia.delete(binding.messageId);
    }
    const after = useAIPaneStore
      .getState()
      .getOrCreate(binding.conversationKey)
      .messages.find((m) => m.id === binding.messageId);
    if (after?.agentCardState === 'confirmed') {
      await finalizeSummary(binding, 'registered', draft);
      if (via === 'chatgpt') await postChatGptAudit(binding.conversationKey, binding.messageId, draft);
      // Follow-up item 7: tell the caller when the requested time already
      // passed before approval, so the first run is the NEXT occurrence.
      const created = createdAgentFor(binding.messageId);
      const timing = created && msg.timestamp
        ? firstRunPassedNote(created.schedule, msg.timestamp, Date.now(), 'en', created.startNotBefore)
            .replace(/Reply "now"[^.]*\./, 'To run it once right away, ask the user to reply "now" to the registration message in Shelly\'s chat.')
        : '';
      return {
        ok: true,
        code: 'sent',
        message: `Registered "${draft.name}" in Shelly. The user was notified and can disable it with one tap.${timing ? ` ${timing}` : ''}`,
      };
    }
    return { ok: false, code: 'failed', message: "shelly agent: registration did not complete; check Shelly's chat" };
  }
  postNote(binding.conversationKey, tFor(locale, via === 'notification' ? 'agents.terminal_request_rejected_notification' : 'agents.terminal_request_rejected_chatgpt'));
  h.cancel(binding.messageId);
  await finalizeSummary(binding, 'rejected', draft);
  return { ok: true, code: 'sent', message: 'Rejected — nothing was registered.' };
}

/** `shelly agent confirm <reqId> <hash8>` / `shelly agent reject <reqId>`. */
export async function handleAgentCtl(ctl: AgentCtlRequest): Promise<AgentAddResult> {
  if (ctl.op === 'closepaw-confirm') return handleClosePawShellCtl('approve', ctl.reqId, ctl.hashPrefix);
  if (ctl.op === 'closepaw-reject') return handleClosePawShellCtl('reject', ctl.reqId, '');
  if (ctl.op === 'reject') {
    const b = getAgentAddBinding(ctl.reqId);
    if (!b || b.consumed) return { ok: false, code: 'invalid', message: 'shelly agent reject: no pending request with that id' };
    // Same cold-start rule as the notification decision: only consume once
    // the pane handler and the pending draft are there, so a reject sent
    // while Shelly is still starting can simply be retried.
    const ready = await waitFor(() => handlers.has(b.conversationKey) && !!findPendingDraftMessage(b), DECISION_READY_TIMEOUT_MS);
    if (!ready) {
      return { ok: false, code: 'failed', message: "shelly agent reject: Shelly's AI pane is not ready yet; run the command again in a few seconds" };
    }
    if (b.consumed) return { ok: false, code: 'invalid', message: 'shelly agent reject: this request was already decided' };
    consumeAgentAddBinding(ctl.reqId);
    return applyAgentAddDecision(b, 'reject', 'chatgpt');
  }
  // User decision (2026-10-14, option 3): a draft with a ClosePaw step can't
  // be approved by ChatGPT/terminal text while the Shelly-trusted ClosePaw
  // variant (no ClosePaw dialog) is installed — checked BEFORE verification
  // so the refusal neither consumes the request nor counts as an attempt.
  {
    const pendingBinding = getAgentAddBinding(ctl.reqId);
    const pendingMsg = pendingBinding ? findPendingDraftMessage(pendingBinding) : null;
    const pendingDraft = (pendingMsg?.agentDraft as ParsedAgentDraft | undefined) ?? null;
    if (pendingDraft && closePawStepText(pendingDraft as never) && (await closePawNeedsDeviceApproval())) {
      return { ok: false, code: 'invalid', message: AGENT_CLOSEPAW_DEVICE_APPROVAL_MESSAGE };
    }
  }
  const allowed = useSettingsStore.getState().settings.agentApproveFromChatGpt !== false;
  const check = verifyAgentAddTextConfirm(ctl.reqId, ctl.hashPrefix, { allowed });
  if ('reason' in check) {
    const message = (() => {
      switch (check.reason) {
        case 'disabled':
          return 'shelly agent confirm: approving agents from ChatGPT is turned off in Shelly (Settings → Approve Agents from ChatGPT). Ask the user to approve it in Shelly or from its notification.';
        case 'unknown':
          return 'shelly agent confirm: no pending request with that id (or Shelly was restarted); run shelly agent add again';
        case 'used':
          return 'shelly agent confirm: this request was already decided';
        case 'expired':
          return 'shelly agent confirm: the request expired (10 minutes); run shelly agent add again';
        case 'high-risk':
          return `shelly agent confirm: this agent includes steps that need review in Shelly itself (${check.binding?.riskReasons.join(', ')}); it cannot be approved from here`;
        case 'not-approvable':
          return 'shelly agent confirm: this draft has no confirmed schedule yet; finish and approve it in Shelly itself';
        case 'locked':
          return 'shelly agent confirm: too many mismatched attempts; approve or reject the agent in Shelly itself';
        case 'rate-limited':
          return 'shelly agent confirm: wait a few seconds before trying again';
        default:
          return `shelly agent confirm: the definition hash does not match the summary that was shown (${check.attemptsLeft ?? 0} attempt(s) left). Run: shelly agent show ${ctl.reqId}`;
      }
    })();
    return { ok: false, code: 'invalid', message };
  }
  return applyAgentAddDecision(check.binding, 'approve', 'chatgpt');
}

/** Notification action deep link: shelly:///agent-add-decision?reqId&decision&nonce.
 *  Never logs the nonce. */
export async function handleAgentAddDecisionDeepLink(params: {
  reqId: unknown;
  decision: unknown;
  nonce: unknown;
}): Promise<void> {
  const reqId = typeof params.reqId === 'string' ? params.reqId : '';
  const decision = params.decision === 'approve' ? 'approve' : params.decision === 'reject' ? 'reject' : null;
  const nonce = typeof params.nonce === 'string' ? params.nonce : '';
  if (!reqId || !decision) return;
  // Verify WITHOUT consuming first: on a cold start / while the AI pane is
  // still mounting, the pane handler or the pending draft may not exist yet,
  // and consuming then would burn the user's single-use tap for nothing.
  const check = verifyAgentAddNotificationDecision(reqId, decision, nonce, Date.now(), { consume: false });
  if ('reason' in check) {
    logWarn('AgentAddFlow', `notification ${decision} for ${reqId} refused (${check.reason})`);
    await surfaceDecisionProblem(reqId, decision, check.reason === 'not-approvable' ? 'review_only' : 'refused');
    return;
  }
  const binding = check.binding;
  const ready = await waitFor(() => handlers.has(binding.conversationKey) && !!findPendingDraftMessage(binding), DECISION_READY_TIMEOUT_MS);
  if (!ready) {
    logWarn('AgentAddFlow', `notification ${decision} for ${reqId}: pane/draft not ready; not consumed`);
    await surfaceDecisionProblem(reqId, decision, 'not_ready');
    return;
  }
  // Re-verify and consume atomically now that the target exists.
  const final = verifyAgentAddNotificationDecision(reqId, decision, nonce);
  if ('reason' in final) {
    logWarn('AgentAddFlow', `notification ${decision} for ${reqId} refused on consume (${final.reason})`);
    await surfaceDecisionProblem(reqId, decision, 'refused');
    return;
  }
  const result = await applyAgentAddDecision(final.binding, decision, 'notification');
  logInfo('AgentAddFlow', `notification ${decision} for ${reqId}: ${result.ok ? 'done' : result.message}`);
  if (!result.ok) await surfaceDecisionProblem(reqId, decision, 'failed');
}

/**
 * Follow-up item 6 (2026-10-15, on-device): a notification Approve that could
 * not be applied (in-app-only draft, stale nonce, AI pane not ready,
 * registration failed) used to be logged only — the user tapped Approve,
 * nothing visible happened, and the scheduled time passed unregistered. Every
 * such outcome now posts a localized chat note on the draft AND a visible
 * notification telling the user to open Shelly and confirm the draft there.
 */
async function surfaceDecisionProblem(
  reqId: string,
  decision: 'approve' | 'reject',
  kind: 'review_only' | 'refused' | 'not_ready' | 'failed',
): Promise<void> {
  const b = getAgentAddBinding(reqId);
  const msg = b ? findPendingDraftMessage(b) : null;
  const draft = (msg?.agentDraft as ParsedAgentDraft | undefined) ?? null;
  const locale: Locale = draft ? draftLocale(draft) : 'en';
  // Review Low: a stale / failed REJECT must not claim "not registered yet,
  // confirm in Shelly" — the user wanted to discard it.
  const key = decision === 'reject' ? 'agents.terminal_request_decision_reject_failed' : `agents.terminal_request_decision_${kind}`;
  const titleKey = decision === 'reject' ? 'agents.terminal_request_decision_reject_title' : 'agents.terminal_request_decision_title';
  const name = draft?.name ?? '';
  if (b) postNote(b.conversationKey, tFor(locale, key, { name }));
  try {
    const Notifications = await import('expo-notifications');
    await Notifications.scheduleNotificationAsync({
      content: {
        title: tFor(locale, titleKey),
        body: tFor(locale, key, { name }),
        data: { agentAddReqId: reqId, decision },
      },
      trigger: null,
    });
  } catch (e) {
    logWarn('AgentAddFlow', `decision-problem notification failed for ${reqId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Audit notification's Disable: shelly:///agent-add-disable?agentId&nonce. */
export async function handleAgentAddDisableDeepLink(params: { agentId: unknown; nonce: unknown }): Promise<void> {
  const agentId = typeof params.agentId === 'string' ? params.agentId : '';
  const nonce = typeof params.nonce === 'string' ? params.nonce : '';
  const record = disableNonces.get(agentId);
  if (!record || record.expiresAt < Date.now() || !/^[0-9a-f]{32}$/.test(nonce) || record.nonce !== nonce) {
    logWarn('AgentAddFlow', `audit disable for ${agentId || '(none)'} refused`);
    return;
  }
  disableNonces.delete(agentId);
  try {
    await setAgentEnabled(agentId, false, runShell);
    await revokeClosePawPreapproval(agentId).catch(() => undefined);
    const agent = useAgentStore.getState().agents.find((a) => a.id === agentId);
    postNote('__companion__', tFor(detectMessageLocale(agent?.name ?? ''), 'agents.terminal_request_disabled', { name: agent?.name ?? agentId }));
    logInfo('AgentAddFlow', `agent ${agentId} disabled from the audit notification`);
  } catch (e) {
    logWarn('AgentAddFlow', `audit disable failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Called after ANY confirm/cancel of a draft (chat OK, buttons, card,
 * notification, ChatGPT). (1) A registered agent with a ClosePaw hand-off
 * gets its pre-approval sealed — the registration approval is the one
 * approval for its runs (lib/agent-closepaw-preapproval.ts). (2) A bound
 * terminal request is consumed, its notification removed and the summary
 * records the outcome.
 */
export function onAgentDraftResolved(conversationKey: string, messageId: string, createdAgentId: string | null = null): void {
  const msg = useAIPaneStore
    .getState()
    .getOrCreate(conversationKey)
    .messages.find((m) => m.id === messageId);
  const state = msg?.agentCardState;
  const draft = (msg?.agentDraft as ParsedAgentDraft) ?? null;
  if (state === 'confirmed' && createdAgentId) createdAgentByMessage.set(messageId, createdAgentId);
  if (state === 'confirmed' && draft && closePawStepText(draft as never) && createdAgentId) {
    const agent = useAgentStore.getState().agents.find((a) => a.id === createdAgentId) ?? null;
    // Seal only the EXACT agent this confirm created, and only when its
    // ClosePaw goal / prompt / steps are the ones the user approved (an
    // edited card registers without a seal → per-run Review stays).
    const via = approvalVia.get(messageId) ?? 'chat';
    // User decision (2026-10-14, option 3): a ChatGPT/terminal text approval
    // never pre-approves a ClosePaw step (only an on-phone approval does).
    if (agent && via !== 'chatgpt' && agentMatchesApprovedDraft(agent, draft)) {
      void sealClosePawPreapproval(agent, via)
        .then((sealed) => {
          if (sealed) logInfo('AgentAddFlow', `ClosePaw hand-off pre-approved for ${agent.id} (via ${via})`);
        })
        .catch((e) => logWarn('AgentAddFlow', `ClosePaw pre-approval seal failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
  const b = findAgentAddBindingByMessage(conversationKey, messageId);
  if (!b) return;
  if (state !== 'confirmed' && state !== 'cancelled') return;
  consumeAgentAddBinding(b.reqId);
  void finalizeSummary(b, state === 'confirmed' ? 'registered' : 'rejected', draft);
}
