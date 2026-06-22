/**
 * lib/telegram-inbound.ts — Phase 3 inbound gateway: pure, offline-testable core.
 *
 * SECURITY MODEL (this module is the single authz + sanitization chokepoint):
 * - An inbound Telegram message is treated as exactly an `@agent <NL>` utterance.
 *   It is NEVER privileged: the poller pushes a confirm card into the app, and
 *   the human must tap Confirm on the device — which runs the SAME secret-guard /
 *   command-safety / tiered-approval pipeline as a locally typed utterance. An
 *   inbound request can therefore never be wider than a local one.
 * - Only messages from the SINGLE pre-authorized chat-id are accepted; everything
 *   else is dropped. We never surface or log the text of an unauthorized message
 *   (it must not become an information-leak channel) — only the rejection fact.
 * - The offset advances past unauthorized/bot/empty updates too, so they are
 *   acknowledged once and never re-fetched (no replay).
 *
 * All functions here are pure (no fetch/IO) so the authz + parsing logic is
 * deterministically unit-tested without a live Telegram connection.
 */

export interface TelegramChat {
  id?: number | string;
}
export interface TelegramFrom {
  is_bot?: boolean;
}
export interface TelegramMessage {
  message_id?: number;
  text?: string;
  chat?: TelegramChat;
  from?: TelegramFrom;
}
export interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
}
export interface TelegramGetUpdates {
  ok?: boolean;
  result?: TelegramUpdate[];
}

export interface InboundUtterance {
  updateId: number;
  text: string;
}
export interface ProcessResult {
  /** Authorized, sanitized utterances ready to become @agent confirm cards. */
  utterances: InboundUtterance[];
  /** The offset to request next (max seen update_id + 1), or null if none seen. */
  nextOffset: number | null;
}

/** Inbound text is bounded so a giant message can't bloat the prompt/UI. */
export const MAX_INBOUND_TEXT = 1000;

/**
 * Exact, trimmed string compare against the single authorized chat-id. The
 * chat-id is not a secret (it is in every message), but binding to exactly one
 * id means an attacker needs both the bot token AND the authorized id to act.
 */
export function isAuthorizedChat(
  chatId: number | string | undefined,
  authorizedChatId: string | undefined
): boolean {
  const incoming = String(chatId ?? '').trim();
  const authorized = String(authorizedChatId ?? '').trim();
  return authorized.length > 0 && incoming.length > 0 && incoming === authorized;
}

/**
 * Normalize an inbound message into an @agent utterance: strip an optional
 * leading "@agent" (inbound messages ARE @agent utterances), collapse, bound
 * length. Returns '' for empty/whitespace.
 */
export function normalizeInboundUtterance(text: string): string {
  return text
    .replace(/^\s*@agent\b\s*/i, '')
    .trim()
    .slice(0, MAX_INBOUND_TEXT);
}

/**
 * Filter a getUpdates response to authorized, non-bot, non-empty utterances and
 * compute the next long-poll offset. Pure. Unauthorized/bot/empty updates are
 * dropped but still advance the offset (acknowledged once, never replayed).
 */
export function processGetUpdates(
  response: TelegramGetUpdates | null | undefined,
  authorizedChatId: string | undefined,
  currentOffset: number | null
): ProcessResult {
  const updates = Array.isArray(response?.result) ? response!.result! : [];
  const utterances: InboundUtterance[] = [];
  let maxUpdateId = currentOffset != null ? currentOffset - 1 : Number.NEGATIVE_INFINITY;

  for (const update of updates) {
    if (typeof update?.update_id !== 'number') continue;
    if (update.update_id > maxUpdateId) maxUpdateId = update.update_id;

    const msg = update.message;
    if (!msg || msg.from?.is_bot) continue;
    // SINGLE authz chokepoint — drop anything not from the authorized chat.
    if (!isAuthorizedChat(msg.chat?.id, authorizedChatId)) continue;

    const text = typeof msg.text === 'string' ? normalizeInboundUtterance(msg.text) : '';
    if (!text) continue;
    utterances.push({ updateId: update.update_id, text });
  }

  const nextOffset = Number.isFinite(maxUpdateId) ? maxUpdateId + 1 : null;
  return { utterances, nextOffset };
}

/** Build the long-poll getUpdates URL (timeout=30 keeps the GET open server-side). */
export function buildGetUpdatesUrl(token: string, offset: number | null): string {
  const params = new URLSearchParams({
    timeout: '30',
    allowed_updates: JSON.stringify(['message']),
  });
  if (offset != null) params.set('offset', String(offset));
  return `https://api.telegram.org/bot${token}/getUpdates?${params.toString()}`;
}

/** True only when the channel is fully configured + enabled. */
export function isInboundConfigured(opts: {
  enabled?: boolean;
  token?: string;
  authorizedChatId?: string;
}): boolean {
  return !!opts.enabled && !!opts.token?.trim() && !!opts.authorizedChatId?.trim();
}
