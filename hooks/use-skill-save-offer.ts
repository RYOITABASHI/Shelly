/**
 * hooks/use-skill-save-offer.ts — shared "save this run as a skill?" gate.
 *
 * Extracted from the Sidebar "Run now" flow (G3 Phase 2a) so the same gated,
 * user-visible save prompt also covers the one-shot `@agent` chat flow
 * (DEFERRED.md G3 Phase 2a item 1: one-shot is the most common conversation
 * path and previously never offered to distill a skill). Never silent —
 * attended runs get a plain chat-text offer the user answers by typing
 * (lib/skill-offer-chat.ts; 2026-11-02, replaced the Alert); unattended runs
 * keep the auto-save + notification. The caller supplies the run's result
 * directly (no store lookups here) so it works equally for a still-registered
 * scheduled agent (Sidebar) and an already-deleted ephemeral one-shot agent
 * (AI pane).
 */
import * as React from 'react';
import { Alert } from 'react-native';
import * as Notifications from 'expo-notifications';
import { useTranslation } from '@/lib/i18n';
import {
  deleteSkillRecipe,
  distillSkillFromRun,
  writeSkillRecipe,
} from '@/lib/agent-skills';
import {
  DELETE_SAVED_SKILL_ACTION,
  saveUnattendedSkillWithNotification,
} from '@/lib/unattended-skill-save';
import {
  REVERT_SKILL_IMPROVEMENT_ACTION,
  consumeSkillImprovementProposal,
  persistSkillImprovement,
  revertSkillImprovement,
} from '@/lib/skill-self-improve';
import {
  findSkillOfferChatKey,
  postSkillOfferLine,
  setPendingSkillOffer,
} from '@/lib/skill-offer-chat';
import type { AgentRouteDecision, AgentRunLog, AgentRunStep } from '@/store/types';
import { runSucceededInFull } from '@/lib/agent-run-success';
import { runHadBlockedAction } from '@/lib/agent-run-blocks';
import type { AgentPlanSpecV1 } from '@/lib/agent-plan-spec';

type TranslationFn = (key: string, params?: Record<string, string | number>) => string;
type NotificationResponseHandler = (response: Notifications.NotificationResponse) => void;

const notificationResponseHandlers = new Set<NotificationResponseHandler>();
let notificationResponseSubscription: Notifications.EventSubscription | null = null;

/**
 * Expo notification responses are process-global. Keep one native listener and
 * route each response to the most recently mounted hook instance, whose
 * runCommand/onSaved closures are current. Calling every hook subscriber would
 * apply a destructive notification action once per mounted UI surface.
 */
export function registerSkillNotificationResponseHandler(
  handler: NotificationResponseHandler,
): () => void {
  notificationResponseHandlers.add(handler);
  if (!notificationResponseSubscription) {
    notificationResponseSubscription = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const activeHandler = Array.from(notificationResponseHandlers).at(-1);
        activeHandler?.(response);
      },
    );
  }
  return () => {
    notificationResponseHandlers.delete(handler);
    if (notificationResponseHandlers.size === 0) {
      notificationResponseSubscription?.remove();
      notificationResponseSubscription = null;
    }
  };
}

export function buildSkillImprovementAlertMessage(
  translate: TranslationFn,
  name: string,
  note: string,
): string {
  const agentName = name.trim();
  const learningNote = note.trim();
  if (!agentName || !learningNote) return '';

  const message = translate('sidebar.skill_improve_body', {
    name: agentName,
    note: learningNote,
  });
  // Do not hand Android a translation result that lost its interpolated
  // runtime values: this confirmation is meaningful only when both are shown.
  if (message.trim() && message.includes(agentName) && message.includes(learningNote)) {
    return message;
  }
  return `${agentName}\n\n${learningNote}`;
}

export interface SkillSaveOfferParams {
  name: string;
  prompt: string;
  routeDecision?: AgentRouteDecision;
  timestamp?: number;
  /** Status of the run that produced this result. Only 'success' is offered. */
  status: AgentRunLog['status'] | undefined;
  /** Set when the source agent is already reusing a skill — skip re-offering. */
  alreadySkillId?: string;
  /** True only for an alarm/background fire with no observing human. */
  unattended?: boolean;
  /** Present for a successful multi-step orchestration run. */
  planSpec?: AgentPlanSpecV1;
  /** The run's per-step records (orchestrated runs). A skipped / failed /
   *  missing step means the run did not succeed in full — no offer
   *  (2026-10-31: offered after a run whose step 2 was SKIPPED). */
  steps?: ReadonlyArray<Pick<AgentRunStep, 'status'> & Partial<Pick<AgentRunStep, 'outputPreview'>>> | null;
  /** Agent.orchestration.steps.length, so an early-stopped chain is caught. */
  plannedStepCount?: number;
  /** The run's output preview / action results (lib/agent-run-success.ts). */
  outputPreview?: string;
  actionResults?: AgentRunLog['actionResults'] | null;
  /** 2026-11-01: the run's agent id + duration. When given, offerSkillSave
   *  reads the agent's driver / executor audit trail for this run's window
   *  and skips the offer if any action was declined / denied / refused
   *  (lib/agent-run-blocks.ts). */
  agentId?: string;
  durationMs?: number;
  /** Already-known audit result (skips the read). */
  blocked?: boolean;
  /** An explicit user tap ("Save as skill" button): when the audit trail shows
   *  a block, explain why nothing is offered instead of doing nothing. */
  explainWhenBlocked?: boolean;
  /** An explicit user tap ("Save as skill" button): save without asking
   *  again (the tap is the decision) and report the result in chat. */
  userRequested?: boolean;
  /** Conversation key (store/ai-pane-store.ts) to ask in — the pane that
   *  showed this run's result. Omitted: the focused / first AI pane. */
  chatKey?: string;
}

/** Audit-trail check for one run (false when there is nothing to read). */
export async function resolveRunBlocked(
  runCommand: (cmd: string) => Promise<string>,
  params: Pick<SkillSaveOfferParams, 'agentId' | 'timestamp' | 'durationMs' | 'blocked'>,
): Promise<boolean> {
  if (typeof params.blocked === 'boolean') return params.blocked;
  if (!params.agentId) return false;
  return runHadBlockedAction(runCommand, {
    agentId: params.agentId,
    timestamp: params.timestamp,
    durationMs: params.durationMs,
  });
}

export async function saveSkillWithoutConfirmation(
  runCommand: (cmd: string) => Promise<string>,
  params: SkillSaveOfferParams,
): Promise<string> {
  const recipe = distillSkillFromRun({
    name: params.name,
    taskText: params.prompt,
    prompt: params.prompt,
    routeDecision: params.routeDecision,
    timestamp: params.timestamp,
    planSpec: params.planSpec,
  });
  await writeSkillRecipe(runCommand, recipe);
  return recipe.id;
}

/**
 * Pure gate, kept side-effect-free so it is unit-testable without mocking
 * React/react-native: only a successful run of an agent that isn't already
 * reusing a skill gets offered.
 */
type SkillOfferGateParams = Pick<
  SkillSaveOfferParams,
  'status' | 'alreadySkillId' | 'steps' | 'plannedStepCount' | 'outputPreview' | 'actionResults' | 'blocked'
>;

export function shouldOfferSkillSave(params: SkillOfferGateParams): boolean {
  if (params.alreadySkillId) return false;
  return runSucceededInFull(params);
}

export function skillSaveMode(
  params: SkillOfferGateParams & Pick<SkillSaveOfferParams, 'unattended'>
): 'none' | 'confirm' | 'auto' {
  if (!shouldOfferSkillSave(params)) return 'none';
  return params.unattended === true ? 'auto' : 'confirm';
}

export function useSkillSaveOffer(opts: {
  runCommand: (cmd: string) => Promise<string>;
  /** Called after a successful save (e.g. Sidebar's loadSkills() to refresh the list). */
  onSaved?: () => void;
}) {
  const { t } = useTranslation();
  const { runCommand, onSaved } = opts;

  React.useEffect(() => registerSkillNotificationResponseHandler((response) => {
      const data = response.notification.request.content.data;
      if (response.actionIdentifier === DELETE_SAVED_SKILL_ACTION) {
        const skillId = data?.skillId;
        if (typeof skillId !== 'string') return;
        void deleteSkillRecipe(runCommand, skillId)
          .then(() => onSaved?.())
          .catch((error) => {
            Alert.alert(t('sidebar.skill_save_failed_title'), String((error as Error)?.message || error));
          });
        return;
      }
      // Self-improvement: post-hoc revert for an unattended auto-improvement —
      // the improvement-side mirror of the auto-save's one-tap delete above.
      if (response.actionIdentifier === REVERT_SKILL_IMPROVEMENT_ACTION) {
        const skillId = data?.skillId;
        const learningAt = data?.learningAt;
        if (typeof skillId !== 'string' || typeof learningAt !== 'string') return;
        void revertSkillImprovement(runCommand, skillId, learningAt)
          .then(() => onSaved?.())
          .catch((error) => {
            Alert.alert(t('sidebar.skill_improve_failed_title'), String((error as Error)?.message || error));
          });
      }
    }), [t, runCommand, onSaved]);

  /**
   * Attended half of the self-improvement flow (skillImproveMode 'confirm'):
   * consume the body-change proposal updateReusedSkillFromRun staged for this
   * agent's just-finished run and put it to the user. Declining (or dismissing
   * — cancelable, same burst-of-runs escape hatch as the save offer) keeps
   * today's behavior: the metadata bump already landed, the body is untouched.
   * No-op when nothing was staged, so call sites can invoke unconditionally.
   */
  // 2026-11-02 owner decision: the attended offers are asked as plain chat
  // text (lib/skill-offer-chat.ts), never an Alert. `chatKey` is the
  // conversation the run's result went to (the @agent pane); without it the
  // focused / first AI pane is used, and with no AI pane open the offer is
  // only logged.
  const offerSkillImprovement = React.useCallback((agentId: string, chatKey?: string) => {
    const proposal = consumeSkillImprovementProposal(agentId);
    if (!proposal || proposal.kind !== 'bump-with-learning' || !proposal.learning) return;
    const name = proposal.agentName ?? proposal.improved.name;
    const message = buildSkillImprovementAlertMessage(t, name, proposal.learning.note);
    if (!message) return;
    const key = chatKey ?? findSkillOfferChatKey();
    if (!postSkillOfferLine(key, `${message}\n\n${t('skill_offer.improve_reply_hint')}`) || !key) return;
    setPendingSkillOffer({
      kind: 'improve',
      chatKey: key,
      createdAt: Date.now(),
      apply: async () => {
        try {
          await persistSkillImprovement(runCommand, proposal);
          onSaved?.();
          postSkillOfferLine(key, t('skill_offer.improved', { name }));
        } catch (error) {
          postSkillOfferLine(key, t('skill_offer.improve_failed', { error: String((error as Error)?.message || error) }));
        }
      },
    });
  }, [t, runCommand, onSaved]);

  // Async only for the audit-trail read: resolves once the decision is made
  // (posting the offer is non-blocking). A caller about to delete the agent
  // (ephemeral one-shot) awaits it so the read sees the agent's live logs.
  const offerSkillSave = React.useCallback(async (params: SkillSaveOfferParams): Promise<void> => {
    // Cheap checks first: a run that fails them never needs the audit read.
    if (skillSaveMode(params) === 'none') return;
    const blocked = await resolveRunBlocked(runCommand, params);
    if (blocked) {
      if (params.explainWhenBlocked) {
        postSkillOfferLine(
          params.chatKey ?? findSkillOfferChatKey(),
          t('sidebar.skill_save_blocked_body', { name: params.name }),
        );
      }
      return;
    }
    const mode = skillSaveMode({ ...params, blocked });
    if (mode === 'none') return;
    if (mode === 'auto') {
      void (async () => {
        try {
          await saveUnattendedSkillWithNotification(runCommand, {
            ...params,
            blocked,
            unattended: true,
          }, {
            title: t('sidebar.skill_saved_title'),
            body: t('sidebar.skill_saved_body', { name: params.name }),
            deleteButton: t('sidebar.skill_save_delete'),
          });
          onSaved?.();
        } catch (error) {
          Alert.alert(t('sidebar.skill_save_failed_title'), String((error as Error)?.message || error));
        }
      })();
      return;
    }
    const key = params.chatKey ?? findSkillOfferChatKey();
    const save = async (): Promise<void> => {
      try {
        await saveSkillWithoutConfirmation(runCommand, params);
        onSaved?.();
        postSkillOfferLine(key, t('skill_offer.saved', { name: params.name }));
      } catch (error) {
        postSkillOfferLine(key, t('skill_offer.save_failed', { error: String((error as Error)?.message || error) }));
      }
    };
    // An explicit "Save as skill" tap is already the user's decision.
    if (params.userRequested) {
      await save();
      return;
    }
    // Every successful attended run gets one plain chat line (still never
    // silent, still a real human decision before a skill is persisted) — but
    // unlike the old Alert it never blocks the screen during a burst of runs
    // (2026-08-09 QA finding), and ignoring it is the "no".
    if (!postSkillOfferLine(key, t('skill_offer.save_ask', { name: params.name })) || !key) return;
    setPendingSkillOffer({ kind: 'save', chatKey: key, createdAt: Date.now(), apply: save });
  }, [t, runCommand, onSaved]);

  return { offerSkillSave, offerSkillImprovement };
}
