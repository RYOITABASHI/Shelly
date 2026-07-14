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
import { useTranslation } from '@/lib/i18n';
import { distillSkillFromRun, writeSkillRecipe } from '@/lib/agent-skills';
import type { AgentRouteDecision, AgentRunLog } from '@/store/types';

export interface SkillSaveOfferParams {
  name: string;
  prompt: string;
  routeDecision?: AgentRouteDecision;
  timestamp?: number;
  /** Status of the run that produced this result. Only 'success' is offered. */
  status: AgentRunLog['status'] | undefined;
  /** Set when the source agent is already reusing a skill — skip re-offering. */
  alreadySkillId?: string;
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

export function useSkillSaveOffer(opts: {
  runCommand: (cmd: string) => Promise<string>;
  /** Called after a successful save (e.g. Sidebar's loadSkills() to refresh the list). */
  onSaved?: () => void;
}) {
  const { t } = useTranslation();
  const { runCommand, onSaved } = opts;

  const offerSkillSave = React.useCallback((params: SkillSaveOfferParams) => {
    if (!shouldOfferSkillSave(params)) return;
    Alert.alert(t('sidebar.skill_save_title'), t('sidebar.skill_save_body', { name: params.name }), [
      {
        text: t('sidebar.skill_save_yes'),
        onPress: () => {
          void (async () => {
            try {
              const recipe = distillSkillFromRun({
                name: params.name,
                taskText: params.prompt,
                prompt: params.prompt,
                routeDecision: params.routeDecision,
                timestamp: params.timestamp,
              });
              await writeSkillRecipe(runCommand, recipe);
              onSaved?.();
            } catch (error) {
              Alert.alert(t('sidebar.skill_save_failed_title'), String((error as Error)?.message || error));
            }
          })();
        },
      },
      { text: t('common.cancel'), style: 'cancel' },
    ]);
  }, [t, runCommand, onSaved]);

  return { offerSkillSave };
}
