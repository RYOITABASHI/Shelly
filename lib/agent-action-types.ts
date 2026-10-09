/**
 * lib/agent-action-types.ts
 *
 * Single source of truth for the agent action-approval type schema.
 *
 * Codex + Fable5 review (2026-08-29, Hermes Agent parity audit): this schema
 * is hand-duplicated across at least these places, and has already drifted
 * twice in ways that produced real bugs (social-post silently dropped by
 * AgentActionApprovalBridge.kt's parser for 5+ weeks; api-call the same):
 *   - app/_layout.tsx: AgentActionApprovalRequest.actionType type,
 *     parseActionApprovalRequest's allowlist, handleAgentActionConfirm's
 *     review-required deep-link bucket, the confirm-modal UI branches
 *   - modules/terminal-emulator/src/TerminalEmulatorModule.ts:
 *     readAgentActionApprovalRequest / notifyAgentActionApprovalNeeded's
 *     actionType union
 *   - modules/terminal-emulator/android/.../scouter/AgentActionApprovalBridge.kt:
 *     fromJson's actionType allowlist
 *   - modules/terminal-emulator/android/.../scouter/NotificationDispatcher.kt:
 *     the actionPhrase/body `when` branches and the requiresReview bucket
 *   - modules/terminal-emulator/android/.../AgentRuntime.kt: PLAN_EXECUTOR_ACTIONS
 *   - modules/terminal-emulator/android/src/main/assets/shelly-plan-executor.js:
 *     the two actionType allowlist checks (full list + unattended-safe subset)
 *
 * There is no codegen pipeline across TS/Kotlin/bundled-JS in this project,
 * so this file does NOT eliminate the duplication — it gives the duplication
 * a single canonical value to be checked against.
 * __tests__/agent-action-type-schema-parity.test.ts reads the other five
 * files as plain text, extracts their allowlists with the same regex
 * shape, and fails the moment any of them stops matching the lists below —
 * turning a silent multi-week drift into an immediate CI failure.
 *
 * When adding a new action type: add it here first, then to every list this
 * file's own doc comment enumerates above, then run the parity test — it
 * will tell you exactly which file(s) you still need to touch.
 */

/** Every action type any approval-request payload may carry. */
export const ALL_APPROVAL_ACTION_TYPES = [
  'draft',
  'notify',
  'webhook',
  'cli',
  'intent',
  'dm-reply',
  'api-call',
  'social-post',
  'browser-pane',
] as const;

export type ApprovalActionType = (typeof ALL_APPROVAL_ACTION_TYPES)[number];

/**
 * Action types that must always show the deep-link "Review" screen before
 * any accept/deny is possible — never a one-tap "Allow" straight from the
 * notification shade. Mirrors NotificationDispatcher.kt's `requiresReview`
 * and app/_layout.tsx's handleAgentActionConfirm review-required bucket.
 *
 * The dividing line (see NotificationDispatcher.kt's comment on this exact
 * bucket): a one-tap Allow calls AgentActionApprovalBridge.writeHumanReply
 * directly with no RN round trip, so any action type whose accept path
 * needs to actually DO something beyond that (fire an intent, send a DM,
 * click a browser element, or — social-post — irreversibly publish content
 * the user never saw resolved) must force the human through the full review
 * screen first.
 */
export const REVIEW_REQUIRED_ACTION_TYPES = [
  'cli',
  'intent',
  'dm-reply',
  'browser-pane',
  'social-post',
] as const;

/**
 * Action types a PlanSpec may dispatch unattended (no live human) at all,
 * subject to their own additional per-type gates (e.g. social-post also
 * requires SHELLY_SOCIAL_HOST_ALLOWLIST opt-in on top of being in this
 * list). Mirrors shelly-plan-executor.js's unattendedPreflightFailure
 * generic branch. Every action type NOT in this list is attended-only,
 * full stop.
 */
export const UNATTENDED_SAFE_ACTION_TYPES = [
  'draft',
  'notify',
  'webhook',
  'cli',
  'api-call',
] as const;

/**
 * Owner decision 2026-10-09 (option A): local-only action types that do NOT
 * need the per-run manual approval tap (AppSettings.defaultRequireActionApproval
 * / Agent.requireActionApproval) on an UNATTENDED run — a scheduled /
 * notification / boot fire where nobody is there to tap. Their effect never
 * leaves the device:
 *   - draft: a file write confined to the scoped output roots
 *     (agent-output / content-studio / configured vault / custom path);
 *   - notify: a local Android notification.
 * Every other action type keeps its existing unattended behavior. POLICY-001
 * (deny / draft_only / ask rules, flag SHELLY_AGENT_POLICY) is evaluated
 * first and still wins. Attended runs are unaffected — the tap still applies.
 *
 * Mirrors scripts/shelly-plan-executor.js's isUnattendedLocalOnlyAction and
 * the generated .sh executor's request_and_wait_approval (lib/agent-executor.ts);
 * __tests__/unattended-local-only-approval-parity.test.ts keeps all three in sync.
 */
export const UNATTENDED_LOCAL_ONLY_ACTION_TYPES = ['draft', 'notify'] as const;

export function isUnattendedLocalOnlyActionType(actionType: string): boolean {
  return (UNATTENDED_LOCAL_ONLY_ACTION_TYPES as readonly string[]).includes(actionType);
}

/**
 * Whether a run of this action type would wait on the per-run manual approval
 * tap. `requireApprovalTap` is the resolved approval mode (see
 * lib/agent-action-reversibility.ts's runWouldRequireApprovalTap). This only
 * covers the approval-MODE dimension; hard refusals (intent / dm-reply /
 * browser-pane unattended, social-post host opt-in) and POLICY-001 are
 * separate gates.
 */
export function runWaitsOnApprovalTap(
  actionType: string,
  requireApprovalTap: boolean,
  unattended: boolean,
): boolean {
  if (!requireApprovalTap) return false;
  if (unattended && isUnattendedLocalOnlyActionType(actionType)) return false;
  return true;
}
