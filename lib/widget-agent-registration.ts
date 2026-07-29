/**
 * lib/widget-agent-registration.ts — Widget-ASK agent-registration policy
 * (2026-07-29, follow-up to the same-day widget ASK → `@agent …` handoff).
 *
 * The Scouter widget's ASK dialog hands a detected `@agent …` command to the
 * REAL AI-Pane registration flow (ScouterWidgetPromptActivity.sendAgentCommand
 * → shelly:///ai?widgetAgentCommand=1 → app/_layout.tsx → ai-pane-store
 * pendingExternalPrompt → AIPane claim effect → dispatch()). By default that
 * flow ends in the SAME in-app confirmation the user would get typing the
 * command into the AI Pane — the 2026-07-24 product-owner reversal
 * (store/settings-store.ts's agentRegistrationRequireConfirm doc comment)
 * deliberately made registration confirm-by-default after a no-confirm
 * default shipped three separate on-device bugs in one night. That default is
 * NOT changed here.
 *
 * What this module adds is a clearly-scoped, OFF-by-default opt-in
 * (AppSettings.widgetAgentRegistrationNoConfirm) that skips the interactive
 * confirmation step for WIDGET-ASK-ORIGINATED commands only:
 *
 *   - Scope: only a dispatch whose source is 'widget-ask'. `@agent` typed
 *     directly into the AI Pane keeps the global
 *     agentRegistrationRequireConfirm behavior untouched, always.
 *   - Mechanism: the skip rides the EXACT same auto-register fast path the
 *     global setting already uses (presentDraftForConfirmation →
 *     shouldAutoRegisterDraft → confirmAgentDraft in
 *     hooks/use-ai-pane-dispatch.ts) — no parallel registration API. All of
 *     that path's hard content gates therefore still apply even with the
 *     toggle ON: a draft with no fireable schedule, an ASSUMED value
 *     (hasDraftAssumptions — defaulted time / LLM-extracted field), or a
 *     high-risk action type (app-act / social-post / tool-pinned
 *     orchestration, via isAutoRegisterEligibleOnChatConfirm) still surfaces
 *     the normal in-app confirmation. "Never register an agent that will
 *     never fire" is a content classifier, not an approval-frequency knob —
 *     see lib/agent-plan-summary.ts.
 *   - Post-hoc visibility: because a no-confirm registration happens while
 *     the user is (typically) still on the home screen, the caller posts an
 *     immediate notification stating what got registered (name + schedule) —
 *     the same "act immediately, notify after" shape
 *     lib/unattended-skill-save.ts already uses for unattended skill saves.
 */

import * as Notifications from 'expo-notifications';
import { tFor, type Locale } from '@/lib/i18n';
import type { AppSettings } from '@/store/types';

/** Where a dispatched `@agent …` utterance physically came from. */
export type AgentRegistrationSource = 'ai-pane' | 'widget-ask';

/**
 * Single decision point for "does THIS registration need the interactive
 * confirm step?". Pure and strict-boolean (`=== true`, mirroring
 * lib/agent-action-reversibility.ts's handling of
 * agentOptimisticWorkspaceWrites) so a corrupted persisted value can only
 * ever fail CLOSED (toward requiring confirmation).
 *
 *   - source 'ai-pane' (or anything not 'widget-ask'): exactly the global
 *     agentRegistrationRequireConfirm setting, unchanged.
 *   - source 'widget-ask' + widgetAgentRegistrationNoConfirm === true: no
 *     confirm step (the auto-register fast path may fire, subject to its own
 *     hard gates — see module doc above).
 *   - source 'widget-ask' + toggle off/absent: same as 'ai-pane'. OFF truly
 *     changes nothing.
 */
export function resolveRegistrationConfirmRequirement(
  settings: Pick<AppSettings, 'agentRegistrationRequireConfirm' | 'widgetAgentRegistrationNoConfirm'>,
  source: AgentRegistrationSource,
): boolean {
  if (source === 'widget-ask' && settings.widgetAgentRegistrationNoConfirm === true) {
    return false;
  }
  return settings.agentRegistrationRequireConfirm === true;
}

/**
 * Notification copy for a widget-originated registration that completed
 * WITHOUT an interactive confirm step. Pure/testable; locale should be the
 * utterance's own language (detectMessageLocale on the draft's rawText — the
 * same per-message convention hooks/use-ai-pane-dispatch.ts already uses for
 * draft summaries, per lib/i18n's tFor doc comment).
 */
export function buildWidgetAgentRegisteredNotification(
  draft: { name: string; scheduleLabel: string },
  locale: Locale,
): { title: string; body: string } {
  return {
    title: tFor(locale, 'agents.widget_registered_title'),
    body: tFor(locale, 'agents.widget_registered_body', {
      name: draft.name,
      schedule: draft.scheduleLabel,
    }),
  };
}

/**
 * Post the immediate "registered from widget" notification. Best-effort:
 * callers fire-and-forget with a catch — a notification failure must never
 * fail (or roll back) the registration itself.
 */
export async function notifyWidgetAgentRegistered(
  draft: { name: string; scheduleLabel: string },
  locale: Locale,
): Promise<void> {
  const { title, body } = buildWidgetAgentRegisteredNotification(draft, locale);
  await Notifications.scheduleNotificationAsync({
    content: { title, body },
    trigger: null,
  });
}
