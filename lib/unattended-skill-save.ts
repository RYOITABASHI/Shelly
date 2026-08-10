import * as Notifications from 'expo-notifications';
import {
  buildSkillRecipeMarkdown,
  distillSkillFromRun,
  readSkillRecipes,
  writeSkillRecipe,
} from '@/lib/agent-skills';
import type { AgentPlanSpecV1 } from '@/lib/agent-plan-spec';
import { scanForSecrets } from '@/lib/secret-guard';
import type { AgentRouteDecision, AgentRunLog } from '@/store/types';

export const SKILL_SAVED_NOTIFICATION_CATEGORY = 'skill-saved';
export const DELETE_SAVED_SKILL_ACTION = 'delete-saved-skill';

export interface UnattendedSkillSaveParams {
  name: string;
  prompt: string;
  routeDecision?: AgentRouteDecision;
  timestamp?: number;
  status: AgentRunLog['status'] | undefined;
  alreadySkillId?: string;
  unattended: true;
  planSpec?: AgentPlanSpecV1;
}

/** Save a successful unattended run and post a one-tap, post-hoc delete action. */
export async function saveUnattendedSkillWithNotification(
  runCommand: (cmd: string) => Promise<string>,
  params: UnattendedSkillSaveParams,
  notificationText: { title: string; body: string; deleteButton: string },
): Promise<string | null> {
  if (params.status !== 'success' || params.alreadySkillId) return null;
  const recipe = distillSkillFromRun({
    name: params.name,
    taskText: params.prompt,
    prompt: params.prompt,
    routeDecision: params.routeDecision,
    timestamp: params.timestamp,
    planSpec: params.planSpec,
  });
  // Idempotent by the recipe's own content-derived id (name+trigger, see
  // skillRecipeId in agent-skills.ts): a recurring schedule re-syncs the SAME
  // latest success on every periodic log-sync poll until the agent's NEXT
  // run, so without this check every poll would re-notify AND clobber a
  // curator-promoted recipe's successCount/lastUsed back to a fresh 1
  // (distillSkillFromRun always mints successCount: 1). The caller-supplied
  // params.alreadySkillId can't substitute for this: it only reflects
  // "this agent was created FROM an existing skill", never "this agent
  // already auto-saved one of its own" — checking disk directly is what
  // actually makes the auto-save (and its notification) a one-time event.
  const existingRecipes = await readSkillRecipes();
  if (existingRecipes.some((r) => r.id === recipe.id)) return null;
  if (scanForSecrets(buildSkillRecipeMarkdown(recipe)).hasSecret) {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Skill auto-save skipped',
        body: 'The recipe may contain a secret or personal information, so it was not saved automatically.',
      },
      trigger: null,
    });
    return null;
  }
  await writeSkillRecipe(runCommand, recipe);
  await Notifications.setNotificationCategoryAsync(SKILL_SAVED_NOTIFICATION_CATEGORY, [
    {
      identifier: DELETE_SAVED_SKILL_ACTION,
      buttonTitle: notificationText.deleteButton,
      // Deletion is handled by the app's JS notification-response listener.
      options: { opensAppToForeground: true },
    },
  ]);
  await Notifications.scheduleNotificationAsync({
    content: {
      title: notificationText.title,
      body: notificationText.body,
      categoryIdentifier: SKILL_SAVED_NOTIFICATION_CATEGORY,
      data: { skillId: recipe.id },
    },
    trigger: null,
  });
  return recipe.id;
}
