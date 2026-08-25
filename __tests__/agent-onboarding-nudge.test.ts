/**
 * __tests__/agent-onboarding-nudge.test.ts
 *
 * Fable5 product-review item #7 (2026-08-25): onboarding friction was cited
 * as a "demand" blocker — even users who install the app have no guided path
 * to its differentiator (autonomous agents). This covers the two halves of
 * the fix:
 *
 *  1. shouldShowAgentOnboardingNudge (lib/agent-onboarding-nudge.ts) — the
 *     pure gate components/panes/AIPane.tsx consults before appending the
 *     one-time companion chat message. Mirrors
 *     __tests__/agent-schedule-readiness.test.ts's coverage of
 *     shouldShowScheduleReadinessNudge (same shape, same precedent).
 *
 *  2. The example utterances quoted in the nudge's i18n copy
 *     (lib/i18n/locales/en.ts / ja.ts 'chat.agent_onboarding_nudge') actually
 *     parse via the REAL lib/agent-nl-parser.ts parseAgentNL — this project's
 *     standing convention (see docs/superpowers/DEFERRED.md) is that every
 *     copy-pasteable example shown to a user must be checked against the
 *     actual NL parser, never invented/aspirational text.
 */
import { shouldShowAgentOnboardingNudge } from '@/lib/agent-onboarding-nudge';
import { parseAgentNL } from '@/lib/agent-nl-parser';
import en from '@/lib/i18n/locales/en';
import ja from '@/lib/i18n/locales/ja';

describe('shouldShowAgentOnboardingNudge', () => {
  it('shows on a genuinely fresh state: no agents, flag never shown, empty conversation', () => {
    expect(shouldShowAgentOnboardingNudge(0, false, 0)).toBe(true);
  });

  it('does not show once the device-scoped flag is already true, even with no agents', () => {
    expect(shouldShowAgentOnboardingNudge(0, true, 0)).toBe(false);
  });

  it('does not show once at least one agent is registered, even if the flag is still false', () => {
    expect(shouldShowAgentOnboardingNudge(1, false, 0)).toBe(false);
    expect(shouldShowAgentOnboardingNudge(3, false, 0)).toBe(false);
  });

  it('does not show into a conversation that already has messages (never interrupts mid-chat)', () => {
    expect(shouldShowAgentOnboardingNudge(0, false, 1)).toBe(false);
    expect(shouldShowAgentOnboardingNudge(0, false, 5)).toBe(false);
  });

  it('every disqualifying condition combined still resolves to false', () => {
    expect(shouldShowAgentOnboardingNudge(2, true, 4)).toBe(false);
  });
});

// The scheduler accepts ONLY these three cron shapes (lib/agent-scheduler.ts,
// same whitelist __tests__/agent-nl-parser.test.ts locks in). A non-null
// schedule outside this shape would silently never fire.
const WHITELIST_CRON = /^(\*\/\d+ \* \* \* \*|0 \*\/\d+ \* \* \*|\d+ \d+ \* \* \*|\d+ \d+ \* \* [0-6](,[0-6])*)$/;

describe('onboarding nudge example utterances actually parse (real parseAgentNL, not invented text)', () => {
  it('JP example embedded in chat.agent_onboarding_nudge parses to a confident daily 8am draft', () => {
    expect(ja['chat.agent_onboarding_nudge']).toContain('毎日8時にニュースをまとめて');

    const d = parseAgentNL('毎日8時にニュースをまとめて');
    expect(d.schedule).toBe('0 8 * * *');
    expect(d.schedule).toMatch(WHITELIST_CRON);
    expect(d.scheduleConfident).toBe(true);
    // Explicit digit time — not a resolved bare time-of-day-word guess, so
    // this never forces an extra "are you sure?" confirm round-trip purely
    // because of the schedule itself.
    expect(d.scheduleAssumed).toBeUndefined();
    expect(d.action.type).toBe('draft');
  });

  it('EN example embedded in chat.agent_onboarding_nudge parses to a confident daily 8am draft', () => {
    expect(en['chat.agent_onboarding_nudge']).toContain('every day at 8am, summarize the news');

    const d = parseAgentNL('every day at 8am, summarize the news');
    expect(d.schedule).toBe('0 8 * * *');
    expect(d.schedule).toMatch(WHITELIST_CRON);
    expect(d.scheduleConfident).toBe(true);
    expect(d.scheduleAssumed).toBeUndefined();
    expect(d.action.type).toBe('draft');
  });
});
