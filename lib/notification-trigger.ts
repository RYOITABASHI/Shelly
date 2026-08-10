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

/**
 * 2026-08-10 on-device QA fix: the slot-fill question for this field
 * ("...or an app name like Slack") implies plain app names are accepted, but
 * until now only reverse-DNS package names ever matched
 * ANDROID_PACKAGE_NAME_RE — a reply of "Gmail" fell straight into "Sorry, I
 * didn't understand". There is no on-device installed-app lookup available
 * here (that would need a new permission-gated native API, out of scope for
 * this fix — see the module doc above), so this is a small static alias
 * table for the apps users are most likely to name, resolved case-
 * insensitively with a substring match. Anything NOT in this table still
 * falls through to the original "please answer with a package name" failure
 * — an explicit skip is safer than a silent wrong-app guess.
 */
export const APP_NAME_PACKAGE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  gmail: 'com.google.android.gm',
  slack: 'com.Slack',
  whatsapp: 'com.whatsapp',
  line: 'jp.naver.line.android',
  discord: 'com.discord',
  telegram: 'org.telegram.messenger',
  instagram: 'com.instagram.android',
  facebook: 'com.facebook.katana',
  messenger: 'com.facebook.orca',
  twitter: 'com.twitter.android',
  x: 'com.twitter.android',
  outlook: 'com.microsoft.office.outlook',
  teams: 'com.microsoft.teams',
  signal: 'org.thoughtcrime.securesms',
  wechat: 'com.tencent.mm',
});

/**
 * Resolve a plain app-name token (e.g. "Gmail") to its Android package name
 * via APP_NAME_PACKAGE_ALIASES, case-insensitive, allowing either side to be
 * a substring of the other (so "Slack app" or a stray "gmail" still match).
 * Returns undefined when nothing in the small static table matches — the
 * caller must NOT guess further than this.
 */
export function resolveAppNameToPackage(token: string): string | undefined {
  const normalized = token.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!normalized) return undefined;
  if (APP_NAME_PACKAGE_ALIASES[normalized]) return APP_NAME_PACKAGE_ALIASES[normalized];
  // Substring fallback only ("Slack app" -> "slackapp" contains "slack").
  // Skip aliases shorter than 3 chars here (e.g. "x") so a short alias can't
  // false-positive-match as a substring of an unrelated longer word (e.g.
  // "xbox"); a short alias can still resolve via the exact-match check above.
  for (const [alias, pkg] of Object.entries(APP_NAME_PACKAGE_ALIASES)) {
    if (alias.length < 3) continue;
    if (normalized.includes(alias) || alias.includes(normalized)) return pkg;
  }
  return undefined;
}

/**
 * Parse a free-text package-name list into validated, deduplicated entries.
 * Each token is first checked against the reverse-DNS package-name shape;
 * a token that fails that check falls back to resolveAppNameToPackage() (a
 * plain app name like "Gmail") before being counted as skipped.
 */
export function parseNotificationTriggerPackages(raw: string): { valid: string[]; skippedCount: number } {
  const tokens = raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const seen = new Set<string>();
  const valid: string[] = [];
  let skippedCount = 0;
  for (const token of tokens) {
    const resolved = ANDROID_PACKAGE_NAME_RE.test(token) ? token : resolveAppNameToPackage(token);
    if (resolved) {
      if (!seen.has(resolved)) {
        seen.add(resolved);
        valid.push(resolved);
      }
    } else if (!seen.has(token)) {
      skippedCount += 1;
    }
  }
  return { valid, skippedCount };
}

/**
 * A `schedule === null` agent is ambiguous: it could be a true one-shot (no
 * schedule, no trigger — run now and discard) or a notification-triggered
 * agent (no cron schedule because its trigger is an event, not a clock — must
 * be registered and wait, never run immediately or be discarded). Callers
 * that treat `schedule === null` alone as "ephemeral, run now and delete"
 * must gate on this instead, or a notification-triggered agent silently never
 * gets registered.
 */
export function isEphemeralOneShot(
  schedule: string | null,
  notificationTrigger: { packageNames: string[] } | null | undefined,
): boolean {
  return schedule === null && !notificationTrigger;
}
