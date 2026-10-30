/**
 * lib/monitor-team-registration.ts — the MONITOR MAP "Register this team"
 * hand-off into the AI chat, and its outcome back to the MONITOR pane.
 *
 *   MonitorMap REGISTER → requestTeamRegistration(team)
 *     → draft built from the team (lib/monitor-team-draft.ts)
 *     → queued here (in memory) + the AI pane focused (lib/pane-focus.ts)
 *     → AIPane claims it (takePendingTeamDraft) and dispatches it with
 *       source 'monitor-team': the SAME summary + plain-chat "OK" confirm as
 *       `@agent` (always confirm-gated, never auto-registered)
 *     → the posted draft bubble's id is bound here (bindTeamDraftMessage)
 *     → the confirm / cancel (lib/agent-add-flow.ts onAgentDraftResolved)
 *       lands in onTeamDraftResolved → status 'registered' + agentId, which
 *       MonitorPane watches to switch to LIVE for that agent.
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
import { updateAgent } from '@/lib/agent-manager';
import { execCommand } from '@/hooks/use-native-exec';
import { logInfo, logWarn } from '@/lib/debug-logger';

/** An unclaimed hand-off is dropped after this (same window as the widget
 *  ASK hand-off, store/ai-pane-store.ts EXTERNAL_PROMPT_STALE_MS). */
export const TEAM_DRAFT_STALE_MS = 2 * 60 * 1000;

export type TeamRegistrationStatus = 'idle' | 'awaiting-confirm' | 'registered' | 'cancelled';

export interface PendingTeamDraft {
  draft: ParsedAgentDraft;
  /** Text handed to dispatch() (must be non-empty; never parsed). */
  text: string;
  createdAt: number;
}

interface TeamRegistrationState {
  pending: PendingTeamDraft | null;
  status: TeamRegistrationStatus;
  /** Draft bubble awaiting the chat confirm. */
  messageId: string | null;
  /** Team being / that was registered (MonitorPane shows it before a run). */
  team: MonitorTeam | null;
  agentId: string | null;
  requireActionApproval: boolean;
}

const initial = (): TeamRegistrationState => ({
  pending: null,
  status: 'idle',
  messageId: null,
  team: null,
  agentId: null,
  requireActionApproval: false,
});

export const useMonitorTeamRegistration = create<TeamRegistrationState>(() => initial());

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
  const { draft, requireActionApproval } = built.value;
  useMonitorTeamRegistration.setState({
    pending: { draft, text: draft.rawText, createdAt: now },
    status: 'awaiting-confirm',
    messageId: null,
    team,
    agentId: null,
    requireActionApproval,
  });
  if (!ensurePaneByTab('ai')) {
    useMonitorTeamRegistration.setState(initial());
    logInfo('MonitorRegister', 'no room for an AI pane');
    return 'no_pane';
  }
  logInfo('MonitorRegister', `team draft queued (${draft.orchestrationSteps?.length ?? 1} steps)`);
  return 'posted';
}

/** Claim-and-clear (synchronous, so exactly one mounted AI pane takes it). */
export function takePendingTeamDraft(now: number = Date.now()): PendingTeamDraft | null {
  const { pending } = useMonitorTeamRegistration.getState();
  if (!pending) return null;
  useMonitorTeamRegistration.setState({ pending: null });
  if (now - pending.createdAt > TEAM_DRAFT_STALE_MS) {
    logWarn('MonitorRegister', 'team draft expired unclaimed — dropped');
    useMonitorTeamRegistration.setState({ status: 'idle', team: null });
    return null;
  }
  return pending;
}

export function bindTeamDraftMessage(messageId: string): void {
  useMonitorTeamRegistration.setState({ messageId });
}

/** Called for EVERY draft confirm/cancel (lib/agent-add-flow.ts); only acts
 *  on the bound team draft. */
export function onTeamDraftResolved(
  messageId: string,
  state: 'confirmed' | 'cancelled' | string | undefined,
  createdAgentId: string | null,
): void {
  const s = useMonitorTeamRegistration.getState();
  if (!s.messageId || s.messageId !== messageId) return;
  if (state === 'confirmed' && createdAgentId) {
    useMonitorTeamRegistration.setState({ status: 'registered', agentId: createdAgentId, messageId: null });
    logInfo('MonitorRegister', `team registered as ${createdAgentId}`);
    if (s.requireActionApproval) {
      // Team-level collapse of per-node "ask before writing" (see
      // lib/monitor-team-draft.ts).
      void updateAgent(createdAgentId, { requireActionApproval: true }, async (cmd) => {
        const r = await execCommand(cmd, 30_000);
        if (r.exitCode !== 0) throw new Error(r.stderr || `exit ${r.exitCode}`);
        return r.stdout;
      }).catch((e) => logWarn('MonitorRegister', `approval setting not saved: ${e instanceof Error ? e.message : String(e)}`));
    }
    return;
  }
  if (state === 'cancelled') {
    useMonitorTeamRegistration.setState({ status: 'cancelled', messageId: null });
  }
}

/** MonitorPane switched to LIVE for the registered agent: keep agentId / team
 *  (the standby view reads them) but stop re-triggering the switch. */
export function acknowledgeTeamRegistration(): void {
  if (useMonitorTeamRegistration.getState().status === 'registered') {
    useMonitorTeamRegistration.setState({ status: 'idle' });
  }
}

export function resetTeamRegistration(): void {
  useMonitorTeamRegistration.setState(initial());
}
