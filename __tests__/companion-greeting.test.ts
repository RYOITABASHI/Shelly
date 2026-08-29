/**
 * __tests__/companion-greeting.test.ts
 *
 * Design 2-a ("welcome back" session-start greeting) + Design 2-b ("keep an
 * eye on X" watch-note preference), 2026-08-28 — Fable5 minimal-slice
 * proactivity pass. Covers the pure gate function's boundary conditions
 * (mirrors __tests__/agent-onboarding-nudge.test.ts's coverage of
 * shouldShowAgentOnboardingNudge — same shape, same precedent) plus
 * pickGreetingNote's watch-over-journal preference and buildCompanionGreetingText's
 * template selection / truncation.
 */
import {
  GREETING_MAX_NOTE_AGE_MS,
  buildCompanionGreetingText,
  hasShownCompanionGreetingThisProcess,
  markCompanionGreetingShown,
  pickGreetingNote,
  resetCompanionGreetingShownForTests,
  shouldShowCompanionGreeting,
  stripWatchPrefix,
  tryClaimCompanionGreetingAttempt,
} from '@/lib/companion-greeting';

describe('shouldShowCompanionGreeting', () => {
  it('shows on a genuine fresh-process case: a note exists, is brand new, conversation is non-empty, not shown yet', () => {
    expect(shouldShowCompanionGreeting(true, 0, 1, false)).toBe(true);
  });

  it('does not show when no journal/watch note exists at all', () => {
    expect(shouldShowCompanionGreeting(false, 0, 5, false)).toBe(false);
  });

  it('shows exactly at the 7-day boundary (inclusive)', () => {
    expect(shouldShowCompanionGreeting(true, GREETING_MAX_NOTE_AGE_MS, 1, false)).toBe(true);
  });

  it('does not show one ms past the 7-day boundary', () => {
    expect(shouldShowCompanionGreeting(true, GREETING_MAX_NOTE_AGE_MS + 1, 1, false)).toBe(false);
  });

  it('does not show for a negative age (clock skew / bad input) even though it is "within" the window numerically', () => {
    expect(shouldShowCompanionGreeting(true, -1, 1, false)).toBe(false);
  });

  it('does not show into a brand-new conversation with zero messages — that is the onboarding nudge\'s territory', () => {
    expect(shouldShowCompanionGreeting(true, 0, 0, false)).toBe(false);
  });

  it('does not show once already shown this process, even with an otherwise-eligible state', () => {
    expect(shouldShowCompanionGreeting(true, 0, 3, true)).toBe(false);
  });

  it('every disqualifying condition combined still resolves to false', () => {
    expect(shouldShowCompanionGreeting(false, GREETING_MAX_NOTE_AGE_MS + 1000, 0, true)).toBe(false);
  });
});

describe('module-level "shown this process" flag', () => {
  beforeEach(() => resetCompanionGreetingShownForTests());
  afterEach(() => resetCompanionGreetingShownForTests());

  it('starts false and flips true only after markCompanionGreetingShown', () => {
    expect(hasShownCompanionGreetingThisProcess()).toBe(false);
    markCompanionGreetingShown();
    expect(hasShownCompanionGreetingThisProcess()).toBe(true);
  });
});

describe('tryClaimCompanionGreetingAttempt (bug #169 regression)', () => {
  beforeEach(() => resetCompanionGreetingShownForTests());
  afterEach(() => resetCompanionGreetingShownForTests());

  it('the first caller in a process claims the attempt', () => {
    expect(tryClaimCompanionGreetingAttempt()).toBe(true);
  });

  it('a second concurrent caller (e.g. a racing effect run) is rejected even before markCompanionGreetingShown is ever called — this is the exact race that produced the duplicate greeting on-device', () => {
    expect(tryClaimCompanionGreetingAttempt()).toBe(true);
    expect(tryClaimCompanionGreetingAttempt()).toBe(false);
    expect(tryClaimCompanionGreetingAttempt()).toBe(false);
  });

  it('stays claimed even if the first caller ultimately shows nothing (no eligible note) — "at most once" beats "exactly once when eligible"', () => {
    expect(tryClaimCompanionGreetingAttempt()).toBe(true);
    // Caller decides not to show anything and never calls markCompanionGreetingShown.
    expect(hasShownCompanionGreetingThisProcess()).toBe(false);
    expect(tryClaimCompanionGreetingAttempt()).toBe(false);
  });

  it('resetCompanionGreetingShownForTests clears the claim flag too, simulating a fresh app process', () => {
    expect(tryClaimCompanionGreetingAttempt()).toBe(true);
    resetCompanionGreetingShownForTests();
    expect(tryClaimCompanionGreetingAttempt()).toBe(true);
  });
});

describe('pickGreetingNote', () => {
  const now = Date.parse('2026-08-28T00:00:00.000Z');
  const hoursAgo = (h: number) => new Date(now - h * 60 * 60 * 1000).toISOString();

  it('picks the newest journal note when there are no watch notes', () => {
    const picked = pickGreetingNote(
      [
        { text: 'old topic', created: hoursAgo(48) },
        { text: 'recent topic', created: hoursAgo(1) },
      ],
      [],
      now,
    );
    expect(picked?.text).toBe('recent topic');
    expect(picked?.isWatch).toBe(false);
  });

  it('prefers a fresh watch note over a fresher journal note', () => {
    const picked = pickGreetingNote(
      [{ text: 'journal topic', created: hoursAgo(1) }],
      [{ text: '[watch] the invoice', created: hoursAgo(2) }],
      now,
    );
    expect(picked?.isWatch).toBe(true);
    expect(picked?.text).toBe('[watch] the invoice');
  });

  it('falls back to the journal note when the only watch note is outside the recency window', () => {
    const eightDaysMs = 8 * 24 * 60 * 60 * 1000;
    const picked = pickGreetingNote(
      [{ text: 'journal topic', created: hoursAgo(1) }],
      [{ text: '[watch] stale', created: new Date(now - eightDaysMs).toISOString() }],
      now,
    );
    expect(picked?.isWatch).toBe(false);
    expect(picked?.text).toBe('journal topic');
  });

  it('returns null when both pools are empty or entirely outside the window', () => {
    expect(pickGreetingNote([], [], now)).toBeNull();
  });
});

describe('buildCompanionGreetingText', () => {
  const t = (key: string, params?: Record<string, string | number>) => {
    const templates: Record<string, string> = {
      'chat.companion_greeting': 'plain:{{topic}}',
      'chat.companion_greeting_watch': 'watch:{{topic}}',
    };
    let text = templates[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
      }
    }
    return text;
  };

  it('uses the plain template by default', () => {
    expect(buildCompanionGreetingText('some topic', t)).toBe('plain:some topic');
  });

  it('uses the watch template when isWatch is true, and strips the on-disk prefix from the topic', () => {
    expect(buildCompanionGreetingText('[watch] the invoice', t, true)).toBe('watch:the invoice');
  });

  it('truncates a long topic to ~60 chars with an ellipsis', () => {
    const long = 'x'.repeat(120);
    const result = buildCompanionGreetingText(long, t);
    expect(result.length).toBeLessThan(long.length);
    expect(result).toContain('…');
  });
});

describe('stripWatchPrefix', () => {
  it('removes the "[watch] " marker when present', () => {
    expect(stripWatchPrefix('[watch] check the invoice')).toBe('check the invoice');
  });

  it('leaves ordinary text untouched', () => {
    expect(stripWatchPrefix('check the invoice')).toBe('check the invoice');
  });
});
