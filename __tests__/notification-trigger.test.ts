import { parseNotificationTriggerPackages, isEphemeralOneShot, resolveAppNameToPackage } from '@/lib/notification-trigger';

describe('parseNotificationTriggerPackages — free-text package allowlist parser', () => {
  it('parses a single valid package name', () => {
    expect(parseNotificationTriggerPackages('com.example.app')).toEqual({
      valid: ['com.example.app'],
      skippedCount: 0,
    });
  });

  it('parses multiple valid package names separated by commas', () => {
    expect(parseNotificationTriggerPackages('com.example.app,com.other.app')).toEqual({
      valid: ['com.example.app', 'com.other.app'],
      skippedCount: 0,
    });
  });

  it('parses multiple valid package names separated by newlines', () => {
    expect(parseNotificationTriggerPackages('com.example.app\ncom.other.app')).toEqual({
      valid: ['com.example.app', 'com.other.app'],
      skippedCount: 0,
    });
  });

  it('skips an invalid entry (containing a space) and counts it', () => {
    expect(parseNotificationTriggerPackages('not a package')).toEqual({
      valid: [],
      skippedCount: 1,
    });
  });

  it('skips only the invalid entry among a mix of valid and invalid', () => {
    expect(parseNotificationTriggerPackages('com.example.app,not a package')).toEqual({
      valid: ['com.example.app'],
      skippedCount: 1,
    });
  });

  it('dedupes a duplicate VALID package: appears once, does not increment skippedCount', () => {
    expect(parseNotificationTriggerPackages('com.example.app,com.example.app')).toEqual({
      valid: ['com.example.app'],
      skippedCount: 0,
    });
  });

  it('does NOT dedupe a duplicate INVALID token: `seen` is only populated on the valid branch, so each occurrence increments skippedCount', () => {
    expect(parseNotificationTriggerPackages('bad token,bad token')).toEqual({
      valid: [],
      skippedCount: 2,
    });
  });

  it('parses an empty string to no valid entries and no skips', () => {
    expect(parseNotificationTriggerPackages('')).toEqual({ valid: [], skippedCount: 0 });
  });

  it('filters out whitespace-only tokens before validation (not counted as skipped)', () => {
    expect(parseNotificationTriggerPackages('com.a,   ,com.b')).toEqual({
      valid: ['com.a', 'com.b'],
      skippedCount: 0,
    });
  });
});

describe('parseNotificationTriggerPackages — app-name alias fallback (on-device QA: "Gmail" reply)', () => {
  it('resolves a known app name to its package name (the confirmed on-device bug)', () => {
    expect(parseNotificationTriggerPackages('Gmail')).toEqual({
      valid: ['com.google.android.gm'],
      skippedCount: 0,
    });
  });

  it('resolves known app names case-insensitively', () => {
    expect(parseNotificationTriggerPackages('gmail')).toEqual({
      valid: ['com.google.android.gm'],
      skippedCount: 0,
    });
    expect(parseNotificationTriggerPackages('SLACK')).toEqual({
      valid: ['com.Slack'],
      skippedCount: 0,
    });
  });

  it('resolves a mix of known app names, comma-separated', () => {
    expect(parseNotificationTriggerPackages('Gmail, WhatsApp, LINE, Discord')).toEqual({
      valid: ['com.google.android.gm', 'com.whatsapp', 'jp.naver.line.android', 'com.discord'],
      skippedCount: 0,
    });
  });

  it('still fails an unknown app name with the original "answer with a package name" outcome', () => {
    expect(parseNotificationTriggerPackages('SomeRandomApp')).toEqual({
      valid: [],
      skippedCount: 1,
    });
  });

  it('does not let a real package name and its app-name alias double-count when both are given', () => {
    expect(parseNotificationTriggerPackages('com.whatsapp,WhatsApp')).toEqual({
      valid: ['com.whatsapp'],
      skippedCount: 0,
    });
  });
});

describe('resolveAppNameToPackage — small static alias table used as the fallback', () => {
  it('resolves an exact known app name', () => {
    expect(resolveAppNameToPackage('Gmail')).toBe('com.google.android.gm');
    expect(resolveAppNameToPackage('Slack')).toBe('com.Slack');
    expect(resolveAppNameToPackage('WhatsApp')).toBe('com.whatsapp');
    expect(resolveAppNameToPackage('LINE')).toBe('jp.naver.line.android');
    expect(resolveAppNameToPackage('Discord')).toBe('com.discord');
  });

  it('resolves a known app name embedded in extra words via substring match', () => {
    expect(resolveAppNameToPackage('the Slack app')).toBe('com.Slack');
  });

  it('returns undefined for an unknown app name', () => {
    expect(resolveAppNameToPackage('SomeRandomApp')).toBeUndefined();
  });

  it('returns undefined for an empty/whitespace-only token', () => {
    expect(resolveAppNameToPackage('')).toBeUndefined();
    expect(resolveAppNameToPackage('   ')).toBeUndefined();
  });

  it('does not let the short "x" alias false-positive-match an unrelated longer word', () => {
    expect(resolveAppNameToPackage('Xbox')).toBeUndefined();
  });

  it('still resolves a bare "X" exactly (Twitter/X rebrand)', () => {
    expect(resolveAppNameToPackage('X')).toBe('com.twitter.android');
  });
});

describe('isEphemeralOneShot — schedule=null must not discard a notification-triggered agent', () => {
  it('is true for a genuine one-shot: no schedule, no notification trigger', () => {
    expect(isEphemeralOneShot(null, null)).toBe(true);
    expect(isEphemeralOneShot(null, undefined)).toBe(true);
  });

  it('is false when a notification trigger is set, even with schedule=null (the confirmed bug)', () => {
    expect(isEphemeralOneShot(null, { packageNames: ['jp.naver.line.android'] })).toBe(false);
  });

  it('is false whenever a real cron schedule is set, regardless of notification trigger', () => {
    expect(isEphemeralOneShot('0 9 * * *', null)).toBe(false);
    expect(isEphemeralOneShot('0 9 * * *', { packageNames: ['jp.naver.line.android'] })).toBe(false);
  });
});
