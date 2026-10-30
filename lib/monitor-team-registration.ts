/**
 * lib/monitor-team-registration.ts — the MONITOR MAP "Register this team"
 * hand-off into the AI chat, and its outcome back to the MONITOR pane.
 *
 *   MonitorMap REGISTER → requestTeamRegistration(team)
 *     → draft built from the team (lib/monitor-team-draft.ts), stamped with a
 *       per-request token (ParsedAgentDraft.monitorTeamToken)
 *     → queued here (in memory) for ONE target AI pane, which is focused
 *       (lib/pane-focus.ts)
 *     → that AIPane claims it (takePendingTeamDraft(paneId)) and dispatches
 *       it with source 'monitor-team': the SAME summary + plain-chat "OK"
 *       confirm as `@agent` (always confirm-gated, never auto-registered)
 *     → the outcome comes back BY TOKEN, so chat patches ("make it 21:00"),
 *       which copy the draft and re-point the session's message id, cannot
 *       lose it:
 *         confirm (hooks/use-ai-pane-dispatch.ts confirmAgentDraft) →
 *           onTeamDraftConfirmed(token, createdAgentId). A null id (failed
 *           registration, a throwing confirm, or a 「今すぐ」 one-shot that ran
 *           and was discarded) ends the hand-off (idle).
 *         cancel (cancelAgentDraft) → onTeamDraftCancelled(token).
 *     → a draft that leaves the chat any other way (superseded by a newer
 *       `@agent` draft, conversation cleared, typed cancel on a patched
 *       bubble) is noticed by the session watcher below, and an unanswered
 *       draft times out — either way REGISTER is enabled again.
 *
 * Runtime-only (no persist, no files): a lost hand-off just means pressing
 * REGISTER again.
 */
import { create } from 'zustand';
import type { ParsedAgentDraft } from '@/lib/agent-nl-parser';
import type { Locale } from '@/lib/i18n';
import type { MonitorTeam } from '@/lib/monitor-team';
import { teamToAgentDraft } from '@/lib/monitor-team-draft';
import { ensurePaneByTab } from '@/lib/pane-focus';
import { useMultiPaneStore } from '@/hooks/use-multi-pane';
import { useAIPaneStore } from '@/store/ai-pane-store';
import { logInfo, logWarn } from '@/lib/debug-logger';

/** An unclaimed hand-off is dropped after this (same window as the widget
 *  ASK hand-off, store/ai-pane-store.ts EXTERNAL_PROMPT_STALE_MS). */
export const TEAM_DRAFT_STALE_MS = 2 * 60 * 1000;
/** A posted draft nobody answered stops blocking REGISTER after this. */
export const TEAM_CONFIRM_TIMEOUT_MS = 30 * 60 * 1000;

export type TeamRegistrationStatus = 'idle' | 'awaiting-confirm' | 'registered' | 'cancelled';

export interface PendingTeamDraft {
  draft: ParsedAgentDraft;
  /** Text handed to dispatch() (must be non-empty; never parsed). */
  text: string;
  createdAt: number;
  /** AI pane (slot id) that should claim it; undefined = any. */
  targetPaneId?: string;
}

interface TeamRegistrationState {
  pending: PendingTeamDraft | null;
  status: TeamRegistrationStatus;
  /** Token of the current hand-off (kept after it ends so a late confirm
   *  from the original bubble still lands). */
  token: string | null;
  /** The draft was posted in chat (the watcher only acts after this). */
  posted: boolean;
  postedAt: number;
  /** Team being / that was registered (MonitorPane shows it before a run). */
  team: MonitorTeam | null;
  agentId: string | null;
}

const initial = (): TeamRegistrationState => ({
  pending: null,
  status: 'idle',
  token: null,
  posted: false,
  postedAt: 0,
  team: null,
  agentId: null,
});

export const useMonitorTeamRegistration = create<TeamRegistrationState>(() => initial());

let tokenSeq = 0;
function newToken(now: number): string {
  tokenSeq += 1;
  return `mt-${now.toString(36)}-${tokenSeq}-${Math.random().toString(36).slice(2, 7)}`;
}

let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
function clearConfirmTimeout(): void {
  if (timeoutHandle) clearTimeout(timeoutHandle);
  timeoutHandle = null;
}

export type RequestTeamRegistrationResult = 'posted' | 'invalid' | 'no_pane';

/** Build the draft and hand it to the AI chat. 'invalid' = the team breaks
 *  validate(); 'no_pane' = no AI pane could be shown (layout full). */
export function requestTeamRegistration(
  team: MonitorTeam,
  locale: Locale,
  now: number = Date.now(),
): RequestTeamRegistrationResult {
  const built = teamToAgentDraft(team, locale);
  if ('errors' in built) {
    logInfo('MonitorRegister', `refused: invalid team (${built.errors[0].code})`);
    return 'invalid';
  }
  if (!built.ok) return 'invalid';
  if (!ensurePaneByTab('ai')) {
    logInfo('MonitorRegister', 'no room for an AI pane');
    return 'no_pane';
  }
  const mp = useMultiPaneStore.getState();
  const focused = mp.slots?.[mp.focusedSlot];
  const targetPaneId = focused?.tab === 'ai' ? focused.id : undefined;
  const token = newToken(now);
  const draft: ParsedAgentDraft = { ...built.value.draft, monitorTeamToken: token };
  clearConfirmTimeout();
  useMonitorTeamRegistration.setState({
    ...initial(),
    pending: { draft, text: draft.rawText, createdAt: now, ...(targetPaneId ? { targetPaneId } : {}) },
    status: 'awaiting-confirm',
    token,
    team,
  });
  ensureSessionWatcher();
  logInfo('MonitorRegister', `team draft queued (${draft.orchestrationSteps?.length ?? 1} steps)`);
  return 'posted';
}

/** Claim-and-clear (synchronous). Only the target pane (when one was
 *  recorded) can claim; any pane may claim an untargeted hand-off. */
export function takePendingTeamDraft(paneId?: string, now: number = Date.now()): PendingTeamDraft | null {
  const { pending } = useMonitorTeamRegistration.getState();
  if (!pending) return null;
  if (pending.targetPaneId && paneId !== undefined && pending.targetPaneId !== paneId) return null;
  useMonitorTeamRegistration.setState({ pending: null });
  if (now - pending.createdAt > TEAM_DRAFT_STALE_MS) {
    logWarn('MonitorRegister', 'team draft expired unclaimed — dropped');
    useMonitorTeamRegistration.setState({ status: 'idle', team: null, token: null });
    return null;
  }
  return pending;
}

/** The draft bubble is in the chat (dispatch's onPresetDraftPresented). */
export function markTeamDraftPosted(_messageId?: string, now: number = Date.now()): void {
  const s = useMonitorTeamRegistration.getState();
  if (s.status !== 'awaiting-confirm') return;
  useMonitorTeamRegistration.setState({ posted: true, postedAt: now });
  ensureSessionWatcher();
  clearConfirmTimeout();
  timeoutHandle = setTimeout(() => expireTeamDraft(), TEAM_CONFIRM_TIMEOUT_MS);
  // Never keep a (test) process alive for this timer alone.
  (timeoutHandle as { unref?: () => void }).unref?.();
}

/** Unanswered for TEAM_CONFIRM_TIMEOUT_MS: stop blocking REGISTER. A later
 *  OK on that bubble still registers (and is still reported by token). */
export function expireTeamDraft(): void {
  timeoutHandle = null;
  if (useMonitorTeamRegistration.getState().status === 'awaiting-confirm') {
    logInfo('MonitorRegister', 'team draft unanswered — REGISTER enabled again');
    useMonitorTeamRegistration.setState({ status: 'idle', pending: null });
  }
}

/** Confirm finished (registered, failed, ran-once-and-discarded, threw). */
export function onTeamDraftConfirmed(token: string, createdAgentId: string | null): void {
  const s = useMonitorTeamRegistration.getState();
  if (!s.token || s.token !== token) return;
  clearConfirmTimeout();
  if (createdAgentId) {
    useMonitorTeamRegistration.setState({ status: 'registered', agentId: createdAgentId, pending: null, posted: false });
    logInfo('MonitorRegister', `team registered as ${createdAgentId}`);
  } else {
    useMonitorTeamRegistration.setState({ status: 'idle', pending: null, posted: false });
    logInfo('MonitorRegister', 'team confirm ended without a registered agent');
  }
}

export function onTeamDraftCancelled(token: string): void {
  const s = useMonitorTeamRegistration.getState();
  if (!s.token || s.token !== token || s.status === 'registered') return;
  clearConfirmTimeout();
  useMonitorTeamRegistration.setState({ status: 'cancelled', pending: null, posted: false });
}

/** True while some AI conversation still awaits the confirm of `token`. */
function draftStillPending(token: string): boolean {
  const { conversations } = useAIPaneStore.getState();
  return Object.values(conversations).some((c) => c.pendingAgentSession?.draft?.monitorTeamToken === token);
}

/** Watcher step (exported for tests): a posted draft that no longer has a
 *  pending session anywhere (superseded / cleared / cancelled on a patched
 *  bubble) ends the hand-off. A confirm that is still in flight reports
 *  'registered' afterwards by token, which overrides this. */
export function reconcileTeamDraftSession(): void {
  const s = useMonitorTeamRegistration.getState();
  if (s.status !== 'awaiting-confirm' || !s.posted || !s.token) return;
  if (draftStillPending(s.token)) return;
  clearConfirmTimeout();
  logInfo('MonitorRegister', 'team draft left the chat (superseded or cleared)');
  useMonitorTeamRegistration.setState({ status: 'idle', posted: false });
}

let unsubscribeWatcher: (() => void) | null = null;
function ensureSessionWatcher(): void {
  if (unsubscribeWatcher) return;
  unsubscribeWatcher = useAIPaneStore.subscribe(() => reconcileTeamDraftSession());
}

/** MonitorPane switched to LIVE for the registered agent: keep agentId /
 *  team (the standby view reads them) but stop re-triggering the switch. */
export function acknowledgeTeamRegistration(): void {
  if (useMonitorTeamRegistration.getState().status === 'registered') {
    useMonitorTeamRegistration.setState({ status: 'idle' });
  }
}

export function resetTeamRegistration(): void {
  clearConfirmTimeout();
  useMonitorTeamRegistration.setState(initial());
}
