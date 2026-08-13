/**
 * hooks/use-skill-save-offer.ts — shared "save this run as a skill?" gate.
 *
 * Extracted from the Sidebar "Run now" flow (G3 Phase 2a) so the same gated,
 * user-visible save prompt also covers the one-shot `@agent` chat flow
 * (DEFERRED.md G3 Phase 2a item 1: one-shot is the most common conversation
 * path and previously never offered to distill a skill). Never silent —
 * always a human-confirmed Alert; the caller supplies the run's result
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
import type { AgentRouteDecision, AgentRunLog } from '@/store/types';
import type { AgentPlanSpecV1 } from '@/lib/agent-plan-spec';

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
export function shouldOfferSkillSave(
  params: Pick<SkillSaveOfferParams, 'status' | 'alreadySkillId'>
): boolean {
  if (params.alreadySkillId) return false;
  return params.status === 'success';
}

export function skillSaveMode(
  params: Pick<SkillSaveOfferParams, 'status' | 'alreadySkillId' | 'unattended'>
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

  React.useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
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
    });
    return () => subscription.remove();
  }, [t, runCommand, onSaved]);

  /**
   * Attended half of the self-improvement flow (skillImproveMode 'confirm'):
   * consume the body-change proposal updateReusedSkillFromRun staged for this
   * agent's just-finished run and put it to the user. Declining (or dismissing
   * — cancelable, same burst-of-runs escape hatch as the save offer) keeps
   * today's behavior: the metadata bump already landed, the body is untouched.
   * No-op when nothing was staged, so call sites can invoke unconditionally.
   */
  const offerSkillImprovement = React.useCallback((agentId: string) => {
    const proposal = consumeSkillImprovementProposal(agentId);
    if (!proposal || proposal.kind !== 'bump-with-learning' || !proposal.learning) return;
    Alert.alert(
      t('sidebar.skill_improve_title'),
      t('sidebar.skill_improve_body', {
        name: proposal.agentName ?? proposal.improved.name,
        note: proposal.learning.note,
      }),
      [
        {
          text: t('sidebar.skill_improve_yes'),
          onPress: () => {
            void persistSkillImprovement(runCommand, proposal)
              .then(() => onSaved?.())
              .catch((error) => {
                Alert.alert(
                  t('sidebar.skill_improve_failed_title'),
                  String((error as Error)?.message || error)
                );
              });
          },
        },
        { text: t('common.cancel'), style: 'cancel' },
      ],
      { cancelable: true },
    );
  }, [t, runCommand, onSaved]);

  const offerSkillSave = React.useCallback((params: SkillSaveOfferParams) => {
    const mode = skillSaveMode(params);
    if (mode === 'none') return;
    if (mode === 'auto') {
      void (async () => {
        try {
          await saveUnattendedSkillWithNotification(runCommand, {
            ...params,
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
    Alert.alert(
      t('sidebar.skill_save_title'),
      t('sidebar.skill_save_body', { name: params.name }),
      [
        {
          text: t('sidebar.skill_save_yes'),
          onPress: () => {
            void (async () => {
              try {
                await saveSkillWithoutConfirmation(runCommand, params);
                onSaved?.();
              } catch (error) {
                Alert.alert(t('sidebar.skill_save_failed_title'), String((error as Error)?.message || error));
              }
            })();
          },
        },
        { text: t('common.cancel'), style: 'cancel' },
      ],
      // 2026-08-09 on-device QA finding (docs/superpowers/DEFERRED.md): this
      // Alert fires after EVERY successful attended run (by design — it's
      // never silent), so during a burst of runs it repeatedly blocked all
      // other interaction. RN's Alert.alert defaults to `cancelable: false`
      // on Android unless explicitly opted in (same fact already documented
      // elsewhere in components/layout/Sidebar.tsx for a different dialog) —
      // without this, the ONLY way past it was to find and tap a button;
      // back-button / tap-outside did nothing. This doesn't change WHETHER
      // the prompt appears (still every successful run, still a real human
      // decision before a skill is persisted) — it only adds the same
      // escape hatch every other dismissible dialog in this app already has.
      { cancelable: true },
    );
  }, [t, runCommand, onSaved]);

  return { offerSkillSave, offerSkillImprovement };
}
