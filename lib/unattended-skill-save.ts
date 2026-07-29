import * as Notifications from 'expo-notifications';
import { distillSkillFromRun, writeSkillRecipe } from '@/lib/agent-skills';
import type { AgentPlanSpecV1 } from '@/lib/agent-plan-spec';
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
