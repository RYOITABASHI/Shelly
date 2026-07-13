/**
 * lib/notification-trigger.ts — pure free-text package-name parser for the
 * NOTIFY-001 `notificationTrigger` field. Extracted from AgentConfirmCard so it
 * can be reused (e.g. by a Sidebar edit UI for an existing agent) and
 * unit-tested without RN.
 *
 * Accepts a comma/newline-separated free-text list of Android package names,
 * validates each against the standard reverse-DNS package-name shape, and
 * dedupes while counting anything that fails validation as "skipped" so the
 * caller can surface a "N valid, M skipped" hint.
 */

/** NOTIFY-001 Increment 2: free-text, comma/newline-separated Android package names. */
export const ANDROID_PACKAGE_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

/** Parse a free-text package-name list into validated, deduplicated entries. */
export function parseNotificationTriggerPackages(raw: string): { valid: string[]; skippedCount: number } {
  const tokens = raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const seen = new Set<string>();
  const valid: string[] = [];
  let skippedCount = 0;
  for (const token of tokens) {
    if (ANDROID_PACKAGE_NAME_RE.test(token) && !seen.has(token)) {
      seen.add(token);
      valid.push(token);
    } else if (!seen.has(token)) {
      skippedCount += 1;
    }
  }
  return { valid, skippedCount };
}
