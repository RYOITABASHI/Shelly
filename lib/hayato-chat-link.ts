/**
 * lib/hayato-chat-link.ts — `hayato://chat/<slug>` navigation requests.
 *
 * An owner-controlled launcher app fires `hayato://chat/<slug>` VIEW intents.
 * Shelly is the handler, but ONLY as a display + enqueue surface (D5 v1): the
 * link is a request to the owner's personal agent (an MCP client of Shelly) to
 * open a chat. Shelly validates it, appends it to a small bounded queue, and
 * shows a confirmation; the agent reads the queue through the read-only MCP
 * tool `read_chat_requests`.
 *
 * Security stance (S1-S4):
 *   - Any app can send a VIEW intent, so the sender is unknown. This module is
 *     pure data handling: it must never execute, approve, submit, start an
 *     agent or open a URL. (Pinned by __tests__/hayato-chat-deeplink.test.ts,
 *     which also pins that this file imports nothing at all.)
 *   - S1: the slug must match SLUG_RE AND be in the device-side slug table the
 *     owner enters in Settings. The table is empty by default, so every slug
 *     is "unresolved" until one is registered. Nothing owner-specific ships.
 *   - S2: the URI must be EXACTLY `hayato://chat/<one path segment>`: scheme
 *     and host are compared case-insensitively (Android lower-cases them), the
 *     slug segment is case-sensitive. No userinfo, port, query, fragment,
 *     trailing slash, extra segment, whitespace or percent-escape. Anything
 *     else is ignored silently (no notice, no queue entry).
 *   - Logs must not contain the raw URI or slug (attacker-controlled input).
 */

/** Slug shape. Same as the MCP server's read-side check. */
export const SLUG_RE = /^[a-z0-9-]{1,40}$/;
/** Device-side slug table cap. */
export const MAX_SLUG_TABLE = 32;
/** Queue cap; the oldest entries are dropped first. */
export const MAX_CHAT_REQUESTS = 20;
/** The same slug re-delivered within this window is dropped. */
export const REPEAT_WINDOW_MS = 3000;
/** Queue file, relative to the app's $HOME (read by scripts/shelly-mcp-server.js). */
export const CHAT_REQUESTS_DIR = '.shelly';
export const CHAT_REQUESTS_FILE = 'chat-requests.json';
/** A longer URI cannot be a valid link (prefix 14 + slug segment). */
const MAX_URI_CHARS = 128;

export type ChatRequest = { id: string; slug: string; ts: number };

export function isValidSlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG_RE.test(value);
}

/** Valid, de-duplicated, in order, at most MAX_SLUG_TABLE. Anything else is dropped. */
export function sanitizeSlugTable(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (isValidSlug(item) && !out.includes(item)) out.push(item);
    if (out.length >= MAX_SLUG_TABLE) break;
  }
  return out;
}

export type ParsedChatLink =
  | { kind: 'ignore' }
  /** Right shape; `slug` is still raw input (not yet validated). */
  | { kind: 'chat'; slug: string };

/**
 * Strict shape check. Returns `chat` only for exactly
 * `hayato://chat/<segment>` where the segment is non-empty and made of
 * characters that can never form a second path segment, query or fragment.
 */
export function parseHayatoChatLink(url: unknown): ParsedChatLink {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URI_CHARS) return { kind: 'ignore' };
  const m = /^hayato:\/\/chat\/([A-Za-z0-9._~-]+)$/i.exec(url);
  if (!m) return { kind: 'ignore' };
  return { kind: 'chat', slug: m[1] };
}

/** Cheap pre-check for the deep-link router: is this a `hayato:` URI at all? */
export function isHayatoSchemeUrl(url: unknown): boolean {
  return typeof url === 'string' && /^hayato:/i.test(url);
}

export type ChatLinkResolution =
  | { kind: 'ignore' }
  | { kind: 'unresolved' }
  | { kind: 'queue'; slug: string };

/** Parse + S1. `table` is the owner's device-side slug table. */
export function resolveHayatoChatLink(url: unknown, table: unknown): ChatLinkResolution {
  const parsed = parseHayatoChatLink(url);
  if (parsed.kind === 'ignore') return { kind: 'ignore' };
  if (!isValidSlug(parsed.slug)) return { kind: 'unresolved' };
  if (!sanitizeSlugTable(table).includes(parsed.slug)) return { kind: 'unresolved' };
  return { kind: 'queue', slug: parsed.slug };
}

/** Same slug within REPEAT_WINDOW_MS of the previous accepted one. */
export function isRepeat(last: { slug: string; ts: number } | null, slug: string, now: number): boolean {
  return !!last && last.slug === slug && now - last.ts >= 0 && now - last.ts < REPEAT_WINDOW_MS;
}

/** Entries as stored: only well-formed {id, slug, ts}, newest last, at most MAX_CHAT_REQUESTS. */
export function sanitizeChatRequests(value: unknown): ChatRequest[] {
  const entries = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as { entries?: unknown }).entries
    : null;
  if (!Array.isArray(entries)) return [];
  const out: ChatRequest[] = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const { id, slug, ts } = e as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) continue;
    if (!isValidSlug(slug)) continue;
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < 0) continue;
    out.push({ id, slug, ts });
  }
  return out.slice(-MAX_CHAT_REQUESTS);
}

/** Append one request, dropping the oldest beyond the cap. Pure. */
export function appendChatRequest(queue: ChatRequest[], slug: string, now: number, id: string): ChatRequest[] {
  return [...queue, { id, slug, ts: now }].slice(-MAX_CHAT_REQUESTS);
}

export function serializeChatRequests(queue: ChatRequest[]): string {
  return JSON.stringify({ version: 1, entries: queue });
}

export type ChatRequestIo = {
  read: () => Promise<string | null>;
  write: (text: string) => Promise<void>;
};

/**
 * Stateful enqueuer: serialises read-modify-write and drops an identical slug
 * repeated within REPEAT_WINDOW_MS. Resolves false when the request was a repeat.
 */
export function createChatRequestQueue(io: ChatRequestIo, newId: () => string, clock: () => number = Date.now) {
  let last: { slug: string; ts: number } | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  return {
    enqueue(slug: string): Promise<boolean> {
      const now = clock();
      if (!isValidSlug(slug) || isRepeat(last, slug, now)) return Promise.resolve(false);
      last = { slug, ts: now };
      const run = chain.then(async () => {
        let current: ChatRequest[] = [];
        try {
          const raw = await io.read();
          if (raw) current = sanitizeChatRequests(JSON.parse(raw));
        } catch {
          current = [];
        }
        await io.write(serializeChatRequests(appendChatRequest(current, slug, now, newId())));
        return true;
      });
      chain = run.catch(() => undefined);
      return run;
    },
  };
}
