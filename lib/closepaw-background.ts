/**
 * lib/closepaw-background.ts — RN side of the Shelly-trusted ClosePaw
 * variant's background entry (variant release shelly-v0.1.0-4+).
 *
 * Native owner: ClosePawHandoff.kt. When the installed ai.closepaw is the
 * pinned variant, ClosePawHandoff.launch() sends an explicit ORDERED
 * broadcast (ai.closepaw.action.SHELLY_RUN_GOAL → ShellyGoalReceiver) instead
 * of starting ClosePaw's activity, so ClosePaw runs the task on its Shizuku
 * virtual display without coming to the front. ClosePaw's result code maps to:
 *   1  → 'background'   (running on the virtual display)
 *   2  → 'main-display' (ClosePaw is controlling the screen)
 *   10–16 → a refusal, thrown natively as `CLOSEPAW_REFUSED:<wire>`
 *   0 / no answer within 5s → fall back to the activity launch
 *        ('launched' / 'notified', unchanged behavior).
 * Shelly never sends allow_main_display.
 *
 * This file keeps the code table in lockstep with ClosePawHandoff.Refusal
 * (asserted by __tests__/closepaw-background-entry.test.ts) and turns native
 * outcomes / errors into localized user-facing lines.
 */
import { useAIPaneStore, COMPANION_CONVERSATION_KEY } from '@/store/ai-pane-store';

export const CLOSEPAW_REFUSED_MARKER_PREFIX = 'CLOSEPAW_REFUSED:';

/** Native fireAgentIntent('closepaw') / launchDeferredClosePaw outcomes. */
export type ClosePawLaunchOutcome = 'launched' | 'notified' | 'background' | 'main-display';

export type ClosePawRefusal =
  | 'untrusted'
  | 'accessibility-off'
  | 'onboarding-incomplete'
  | 'overlay-missing'
  | 'no-credentials'
  | 'busy'
  | 'vd-unavailable';

/** ClosePaw ShellyGoalReceiver result code → refusal (mirrors ClosePawHandoff.Refusal). */
export const CLOSEPAW_REFUSAL_CODES: Readonly<Record<number, ClosePawRefusal>> = {
  10: 'untrusted',
  11: 'accessibility-off',
  12: 'onboarding-incomplete',
  13: 'overlay-missing',
  14: 'no-credentials',
  15: 'busy',
  16: 'vd-unavailable',
};

export type ClosePawBroadcastResult =
  | { kind: 'started'; outcome: 'background' | 'main-display' }
  | { kind: 'refused'; refusal: ClosePawRefusal }
  | { kind: 'fallback' };

/** Reference mapping of ClosePawHandoff.mapVariantResultCode. */
export function mapClosePawBroadcastResultCode(code: number): ClosePawBroadcastResult {
  if (code === 1) return { kind: 'started', outcome: 'background' };
  if (code === 2) return { kind: 'started', outcome: 'main-display' };
  const refusal = CLOSEPAW_REFUSAL_CODES[code];
  return refusal ? { kind: 'refused', refusal } : { kind: 'fallback' };
}

const REFUSALS = new Set<string>(Object.values(CLOSEPAW_REFUSAL_CODES));

/** The refusal carried by a native error (`CLOSEPAW_REFUSED:<wire>`), if any. */
export function closePawRefusalFromError(e: unknown): ClosePawRefusal | null {
  const message = (e as { message?: unknown } | null | undefined)?.message;
  if (typeof message !== 'string') return null;
  const at = message.indexOf(CLOSEPAW_REFUSED_MARKER_PREFIX);
  if (at < 0) return null;
  const wire = message.slice(at + CLOSEPAW_REFUSED_MARKER_PREFIX.length).match(/^[a-z-]+/)?.[0] ?? '';
  return REFUSALS.has(wire) ? (wire as ClosePawRefusal) : null;
}

/** Same, for a resolve()/launchDeferred code string. */
export function asClosePawRefusal(code: unknown): ClosePawRefusal | null {
  return typeof code === 'string' && REFUSALS.has(code) ? (code as ClosePawRefusal) : null;
}

export function closePawRefusalKey(refusal: ClosePawRefusal): string {
  return `closepaw.refused_${refusal.replace(/-/g, '_')}`;
}

/** i18n key for a successful hand-off outcome, or null for an unknown value. */
export function closePawOutcomeKey(outcome: unknown): string | null {
  switch (outcome) {
    case 'background':
      return 'closepaw.outcome_background';
    case 'main-display':
      return 'closepaw.outcome_main_display';
    case 'launched':
      return 'closepaw.outcome_launched';
    case 'notified':
      return 'closepaw.outcome_notified';
    default:
      return null;
  }
}

/** Plain-text assistant line in Shelly's companion chat. */
export function postClosePawChatLine(content: string): void {
  useAIPaneStore.getState().addMessage(COMPANION_CONVERSATION_KEY, {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    role: 'assistant',
    content,
    timestamp: Date.now(),
  });
}
