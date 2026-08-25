/**
 * lib/agent-onboarding-nudge.ts
 *
 * Fable5 product-review item #7 (2026-08-25) — pure gating logic for the
 * one-time first-agent onboarding nudge shown in the AI Pane / companion
 * conversation. Extracted from components/panes/AIPane.tsx so the dedup rule
 * itself is unit-testable without rendering the full pane (same pattern as
 * lib/agent-schedule-readiness.ts's shouldShowScheduleReadinessNudge).
 *
 * This is deliberately a PLAIN CHAT MESSAGE gate, never a modal/wizard gate —
 * see CLAUDE.md's "旧 AuthWizard / WelcomeWizard は廃止" (the prior wizard
 * was removed on purpose) and this codebase's standing no-confirm-card rule.
 * The caller (AIPane.tsx) appends an ordinary assistant ChatMessage when this
 * returns true; there is no card state, no accept/dismiss UI beyond just
 * reading the chat like any other message.
 */

/**
 * true iff the first-agent onboarding nudge should be appended to this
 * pane's conversation right now:
 *  - the device hasn't already seen the nudge once (device-scoped, via
 *    AppSettings.agentOnboardingNudgeShown — mirrors
 *    scheduleReadinessNudgeShown's shape exactly), AND
 *  - the device has zero registered agents yet (once the user has ANY
 *    agent, they've already found the feature — the nudge would be noise),
 *    AND
 *  - this pane's conversation is genuinely empty (so the nudge reads as the
 *    companion's first word, not an interruption mid-conversation).
 */
export function shouldShowAgentOnboardingNudge(
  agentCount: number,
  nudgeAlreadyShown: boolean,
  existingMessageCount: number,
): boolean {
  return !nudgeAlreadyShown && agentCount === 0 && existingMessageCount === 0;
}
