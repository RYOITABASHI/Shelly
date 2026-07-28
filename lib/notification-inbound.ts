/**
 * lib/notification-inbound.ts — NOTIFY-001 Increment 3: sender-gated
 * notification-text channel (generic on-device inbound channel).
 *
 * WHAT THIS IS (and what it deliberately is NOT):
 * - This is a BEST-EFFORT, Android-device-local channel: Shelly reacts to
 *   notifications that OTHER apps (LINE/Discord/Slack/...) post on THIS
 *   phone. It can only ever see what fits inside the notification (title +
 *   text/bigText — long messages are truncated by the posting app before we
 *   ever see them), and it can only reply while the source notification is
 *   still alive with a working RemoteInput (the existing `dm-reply` action).
 * - It is NOT a remote-reachability channel and must never grow into one:
 *   no server, no polling of any external inbox, no push registration. The
 *   product policy "Shelly does not chase remote messaging channels" is
 *   about reachability from OUTSIDE the phone; this reacts to an event that
 *   is already fully on-device, which is why it is allowed.
 *
 * SECURITY MODEL (mirrors lib/telegram-inbound.ts, whose authz core this
 * module reuses verbatim rather than reimplementing):
 * - Sender authorization is an EXACT, trimmed, case-sensitive string match
 *   (isAuthorizedChat from telegram-inbound) between the notification's
 *   sender display-name (EXTRA_TITLE) and one of the agent's pre-registered
 *   `notificationTrigger.authorizedSenders` entries. Empty/absent list =
 *   fail closed (no text is ever read or forwarded). Loosening this to a
 *   substring/fuzzy match would let ANY notification text launch an agent —
 *   never do that.
 * - The package allowlist (`notificationTrigger.packageNames`) gates FIRST:
 *   only notifications from the explicitly chosen app(s) are even considered,
 *   so "sender spoofing" requires the chosen messaging app itself to post a
 *   forged sender title. A sender name alone (matched across all apps) would
 *   be trivially spoofable by any installed app — that is why authorizedSenders
 *   only ever narrows a package match and never replaces it.
 * - Even an authorized sender's text stays UNTRUSTED DATA: the triggered run
 *   is tainted end-to-end (SHELLY_CAP_TAINTED=1, same as package-only
 *   triggers) and the text is injected into the agent prompt wrapped in an
 *   explicit "data, not instructions" preamble. Replying goes through the
 *   existing `dm-reply` action, which is never one-tap (in-app Review).
 *
 * The RUNTIME check lives in ShellyNotificationListener.kt (the dispatch is
 * native — it must work while the RN side is dead). This module is the
 * offline-testable spec of those semantics plus the registration-time parser;
 * __tests__/notify-listener/notification-channel-parity.test.ts string-gates
 * the Kotlin twin against drift.
 */

import { isAuthorizedChat, normalizeInboundUtterance, MAX_INBOUND_TEXT } from './telegram-inbound';

/** Same bound as the Telegram inbound channel (lib/telegram-inbound.ts). */
export const MAX_INBOUND_NOTIFICATION_TEXT = MAX_INBOUND_TEXT;

/** Sender display-names longer than this are rejected at registration time.
 *  Matches the 120-char title truncation already used by the DM-pairing
 *  candidate preview (ShellyNotificationListener.PairingCandidate). */
export const MAX_AUTHORIZED_SENDER_LENGTH = 120;

/**
 * THE authz decision for the notification channel. Reuses telegram-inbound's
 * isAuthorizedChat (exact, trimmed, non-empty, case-sensitive compare) per
 * entry — any exact match authorizes. Fail closed on an absent/empty list or
 * an empty sender title.
 *
 * Kotlin twin: ShellyNotificationListener.isAuthorizedSender — the two must
 * keep identical semantics (both compare UTF-16 strings for exact equality
 * after trimming; no case folding, no Unicode normalization — a sender name
 * in a different normalization form deliberately does NOT match).
 */
export function isAuthorizedNotificationSender(
  senderTitle: string | null | undefined,
  authorizedSenders: readonly string[] | null | undefined
): boolean {
  if (!Array.isArray(authorizedSenders) || authorizedSenders.length === 0) return false;
  return authorizedSenders.some((entry) => isAuthorizedChat(senderTitle ?? undefined, entry));
}

/**
 * Sanitize inbound notification text before it may reach an agent prompt:
 * strip C0/C1 control characters (except newline — multi-line bigText is
 * legitimate), then apply the SAME normalize step as the Telegram channel
 * (leading "@agent" strip + trim + MAX_INBOUND_TEXT bound). The control-char
 * strip is a notification-specific addition: third-party apps can put
 * arbitrary characters in a notification, unlike Telegram's JSON text field.
 *
 * Kotlin twin: ShellyNotificationListener.sanitizeInboundNotificationText.
 */
export function sanitizeInboundNotificationText(text: string | null | undefined): string {
  if (!text) return '';
  // eslint-disable-next-line no-control-regex
  const stripped = text.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, ' ');
  return normalizeInboundUtterance(stripped);
}

/**
 * Registration-time parser for the authorized-senders free-text field
 * (comma/newline separated), mirroring parseNotificationTriggerPackages'
 * shape so the UI can show the same "N valid, M skipped" hint. Entries are
 * trimmed and deduplicated; empty and over-long entries are skipped. No
 * character-class validation beyond length — sender display-names are
 * arbitrary human text (emoji, CJK, spaces are all legitimate).
 */
export function parseAuthorizedSenders(raw: string): { valid: string[]; skippedCount: number } {
  const tokens = raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const seen = new Set<string>();
  const valid: string[] = [];
  let skippedCount = 0;
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    if (token.length <= MAX_AUTHORIZED_SENDER_LENGTH) {
      valid.push(token);
    } else {
      skippedCount += 1;
    }
  }
  return { valid, skippedCount };
}
