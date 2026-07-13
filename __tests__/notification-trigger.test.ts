import { parseNotificationTriggerPackages } from '@/lib/notification-trigger';

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
