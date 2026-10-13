/**
 * INTENT-001 modes:
 *  - 'launch'   — open another app by package name / URI (ACTION_VIEW).
 *  - 'share'    — hand text to the OS share sheet (ACTION_SEND).
 *  - 'closepaw' — ClosePaw hand-off, Phase 1 (2026-10-13): explicit-component
 *    intent to ai.closepaw/ai.closepaw.app.MainActivity with String extra
 *    "goal". The goal text is carried in the SAME `intentShareText` field the
 *    share mode uses, so the existing signed-approval canonicalization
 *    (lib/signed-approval/canonical.ts — intentMode + intentShareText are both
 *    canonical fields) already binds the approval to the exact mode + goal.
 *    ClosePaw returns no result to the caller, so a run that fires this mode
 *    ends as "handed off", never as success-with-result.
 */
export type AgentIntentMode = 'launch' | 'share' | 'closepaw';

export const AGENT_INTENT_MODES: readonly AgentIntentMode[] = ['launch', 'share', 'closepaw'];

export function isAgentIntentMode(value: unknown): value is AgentIntentMode {
  return typeof value === 'string' && (AGENT_INTENT_MODES as readonly string[]).includes(value);
}

export const CLOSEPAW_PACKAGE = 'ai.closepaw';
export const CLOSEPAW_ACTIVITY = 'ai.closepaw.app.MainActivity';
/** Hard cap (Unicode code points) on the goal handed to ClosePaw. Mirrored by
 *  TerminalEmulatorModule.kt's sanitizeClosePawGoal. */
export const CLOSEPAW_GOAL_MAX_CHARS = 2000;

// C0 controls (incl. \n \r \t), DEL, and C1 controls.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F]/g;

/**
 * Normalizes a ClosePaw goal: control characters become spaces, runs of
 * ASCII spaces collapse to one, leading/trailing spaces are dropped, and the
 * result is capped at CLOSEPAW_GOAL_MAX_CHARS code points. Deterministic and
 * idempotent; the native side applies the byte-identical rules, so the text
 * the human reviews (rendered through this function) is exactly the text
 * that is fired.
 */
export function sanitizeClosePawGoal(raw: string | null | undefined): string {
  const collapsed = String(raw ?? '')
    .replace(CONTROL_CHARS_RE, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/^ +| +$/g, '');
  const codePoints = Array.from(collapsed);
  if (codePoints.length <= CLOSEPAW_GOAL_MAX_CHARS) return collapsed;
  return codePoints.slice(0, CLOSEPAW_GOAL_MAX_CHARS).join('').replace(/ +$/g, '');
}

/** Error-message marker the native fireAgentIntent throws when ClosePaw is
 *  not installed (or not visible to Shelly). */
export const CLOSEPAW_NOT_INSTALLED_MARKER = 'CLOSEPAW_NOT_INSTALLED';
/** Native ClosePawHandoff.launch: Shelly is backgrounded (no activity start
 *  allowed) AND its notifications are off, so there is no route to ClosePaw. */
export const CLOSEPAW_BACKGROUND_BLOCKED_MARKER = 'CLOSEPAW_BACKGROUND_BLOCKED';

export function isClosePawNotInstalledError(e: unknown): boolean {
  const message = (e as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' && message.includes(CLOSEPAW_NOT_INSTALLED_MARKER);
}

export type ReviewedAgentIntent = {
  intentMode?: AgentIntentMode | null;
  intentTarget?: string | null;
  intentShareText?: string | null;
};

export type FireAgentIntent = (
  mode: AgentIntentMode,
  target: string,
  shareText?: string | null,
  // Native resolves null for launch/share and 'launched' | 'notified' for
  // closepaw (notified = posted a tap-to-continue notification because
  // Shelly could not start an activity from the background).
) => Promise<unknown>;

/** Fires the native side effect only from the human Review accept path. */
export async function fireReviewedAgentIntent(
  request: ReviewedAgentIntent,
  fireAgentIntent: FireAgentIntent,
): Promise<void> {
  const mode = request.intentMode ?? 'launch';
  if (mode === 'closepaw') {
    // Fire exactly the text the reviewer saw (closePawReviewLine renders the
    // same sanitizer). Target is meaningless for this mode.
    await fireAgentIntent('closepaw', '', sanitizeClosePawGoal(request.intentShareText));
    return;
  }
  await fireAgentIntent(
    mode,
    request.intentTarget ?? '',
    request.intentShareText ?? null,
  );
}

/** ClosePaw hand-offs are never auto-accepted, even when the runtime approval
 *  default is 'auto': the user must see "Hand off to ClosePaw: <goal>" first. */
export function intentRequiresHumanReview(request: ReviewedAgentIntent): boolean {
  return request.intentMode === 'closepaw';
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** The single review line shown for a ClosePaw hand-off request. */
export function closePawReviewLine(request: ReviewedAgentIntent, t: Translate): string {
  return t('agent_action_confirm_closepaw_handoff', { goal: sanitizeClosePawGoal(request.intentShareText) });
}

/** Plain-text run-log / chat line for a completed hand-off. */
export function closePawHandedOffMessage(goal: string | null | undefined): string {
  return `Handed off to ClosePaw (no result is returned): ${sanitizeClosePawGoal(goal)}`;
}
