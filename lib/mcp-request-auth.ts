/**
 * lib/mcp-request-auth.ts — authenticates the MCP server's queue requests
 * (DEFERRED.md「MCP の入口（ingress）に外部入力の印（taint）を付ける」 Inc 2).
 *
 * Any process running as the app uid can drop a file into
 * $HOME/.shelly-mcp-queue/requests/. Only files signed with the bridge key
 * are MCP calls: RN generates the key in memory before it starts the server
 * (hooks/use-mcp-server-bridge.ts), MCPBridge.kt hands it to the node
 * process on its stdin (never env — /proc/<pid>/environ is readable by the
 * same uid — never argv, never logged), and scripts/shelly-mcp-server.js
 * signs every request it writes:
 *
 *   { callId, tool, args, ingress: { kind: 'mcp', principal, clientNameSelfReported }, receivedAt, mac }
 *   mac = hex(HMAC-SHA256(utf8(bridgeKey), canonicalJson(<the object without mac>)))
 *
 * canonicalJson must stay byte-identical to the server's canonicalJson
 * (key-sorted, JSON.stringify for leaves). Pure: the SHA-256 is injected so
 * Jest can run it without expo-crypto.
 */

export type Sha256 = (data: Uint8Array) => Promise<Uint8Array>;

/** Key-sorted JSON so the same object always signs the same. Mirrors
 *  canonicalJson() in scripts/shelly-mcp-server.js. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** HMAC-SHA256 (RFC 2104), hex. */
export async function hmacSha256Hex(key: Uint8Array, message: Uint8Array, sha256: Sha256): Promise<string> {
  const block = new Uint8Array(64);
  block.set(key.length > 64 ? await sha256(key) : key);
  const ipad = block.map((b) => b ^ 0x36);
  const opad = block.map((b) => b ^ 0x5c);
  const inner = await sha256(concat(ipad, message));
  return hex(await sha256(concat(opad, inner)));
}

/** The MAC the server attaches to a request (the request without `mac`). */
export function mcpRequestMac(bridgeKey: string, unsigned: Record<string, unknown>, sha256: Sha256): Promise<string> {
  return hmacSha256Hex(utf8(bridgeKey), utf8(canonicalJson(unsigned)), sha256);
}

/** 64 hex chars from 32 random bytes. */
export const MCP_BRIDGE_KEY_RE = /^[0-9a-f]{64}$/;
/** crypto.randomUUID() on the server; also used as the result file name. */
export const MCP_CALL_ID_RE = /^[0-9A-Za-z-]{1,64}$/;
/** shelly-mcp-server.js principal: sha256("shelly-mcp-principal:" + token)[:32]. */
export const MCP_PRINCIPAL_RE = /^[0-9a-f]{32}$/;
const MAC_RE = /^[0-9a-f]{64}$/;
const CLIENT_NAME_MAX = 64;
// Control, bidi and zero-width characters: the name is shown in the approval modal.
const UNSAFE_NAME_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g;

export type McpVerifiedRequest = {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  /** Who sent it. Every verified request is tainted (external input); the
   *  file carries no taint field and none would be read. */
  ingress: { kind: 'mcp'; principal: string; clientNameSelfReported: string };
};

export type McpRequestCheck = { ok: true; request: McpVerifiedRequest } | { ok: false; reason: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** The client name as shown: control/bidi characters removed, capped. */
export function cleanClientName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return Array.from(raw.replace(UNSAFE_NAME_CHARS, ' ').replace(/ {2,}/g, ' ').trim()).slice(0, CLIENT_NAME_MAX).join('');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** How long a signed request stays usable after the server wrote it.
 *  The server writes receivedAt when it writes the file and the poller
 *  reads it within a tick, so a legitimate request is never near the
 *  limit; anything older is a replayed copy. A small future tolerance
 *  covers a clock step, not a different device (same clock here). */
export const MCP_REQUEST_MAX_AGE_MS = 10 * 60 * 1000;
export const MCP_REQUEST_FUTURE_TOLERANCE_MS = 60 * 1000;
/** Accepted callIds, remembered so a copied file can't run twice. Capped:
 *  one entry per MCP call, oldest evicted first. */
const MAX_SEEN_CALL_IDS = 1000;
const seenCallIds = new Set<string>();

/** Test hook: forget every accepted callId (fresh state per test). */
export function __resetMcpSeenCallIdsForTests(): void {
  seenCallIds.clear();
}

function noteCallIdSeen(callId: string): void {
  seenCallIds.add(callId);
  while (seenCallIds.size > MAX_SEEN_CALL_IDS) {
    seenCallIds.delete(seenCallIds.values().next().value as string);
  }
}

export type VerifyMcpRequestOpts = {
  /** The request file's name; a verified request must be `${callId}.json`.
   *  Omitted by direct callers that verify a parsed body without a file. */
  fileName?: string;
  /** Clock for the freshness check (tests); Date.now() in production. */
  nowMs?: number;
};

/**
 * Verifies one parsed request file against the bridge key. Fails closed:
 * no key, a missing / malformed / wrong MAC, or a malformed field — and,
 * after the MAC: a file name that is not `${callId}.json`, a receivedAt
 * older than 10 minutes (or implausibly in the future), or a callId that
 * was already accepted (replay). A callId is recorded only once its
 * request fully verifies, so a refused file never consumes its id.
 */
export async function verifyMcpRequest(
  parsed: unknown,
  bridgeKey: string | null,
  sha256: Sha256,
  opts: VerifyMcpRequestOpts = {},
): Promise<McpRequestCheck> {
  if (!bridgeKey || !MCP_BRIDGE_KEY_RE.test(bridgeKey)) return { ok: false, reason: 'no bridge key' };
  if (!isPlainObject(parsed)) return { ok: false, reason: 'not an object' };
  const { mac, ...unsigned } = parsed;
  if (typeof mac !== 'string' || !MAC_RE.test(mac)) return { ok: false, reason: 'missing mac' };
  const expected = await mcpRequestMac(bridgeKey, unsigned, sha256);
  if (!timingSafeEqualHex(expected, mac)) return { ok: false, reason: 'bad mac' };
  const { callId, tool, args, ingress, receivedAt } = unsigned;
  if (typeof callId !== 'string' || !MCP_CALL_ID_RE.test(callId)) return { ok: false, reason: 'bad callId' };
  if (opts.fileName !== undefined && opts.fileName !== `${callId}.json`) return { ok: false, reason: 'bad file name' };
  const receivedMs = typeof receivedAt === 'string' ? Date.parse(receivedAt) : NaN;
  const nowMs = opts.nowMs ?? Date.now();
  if (
    !Number.isFinite(receivedMs) ||
    receivedMs > nowMs + MCP_REQUEST_FUTURE_TOLERANCE_MS ||
    nowMs - receivedMs > MCP_REQUEST_MAX_AGE_MS
  ) {
    return { ok: false, reason: 'stale request' };
  }
  if (seenCallIds.has(callId)) return { ok: false, reason: 'replay' };
  if (typeof tool !== 'string' || !tool) return { ok: false, reason: 'bad tool' };
  if (args !== undefined && !isPlainObject(args)) return { ok: false, reason: 'bad args' };
  if (!isPlainObject(ingress) || ingress.kind !== 'mcp') return { ok: false, reason: 'bad ingress' };
  if (typeof ingress.principal !== 'string' || !MCP_PRINCIPAL_RE.test(ingress.principal)) {
    return { ok: false, reason: 'bad principal' };
  }
  noteCallIdSeen(callId);
  return {
    ok: true,
    request: {
      callId,
      tool,
      args: (args as Record<string, unknown> | undefined) ?? {},
      ingress: { kind: 'mcp', principal: ingress.principal, clientNameSelfReported: cleanClientName(ingress.clientNameSelfReported) },
    },
  };
}

/** Test/helper: sign a request the way the server does. */
export async function signMcpRequest<T extends Record<string, unknown>>(
  bridgeKey: string,
  unsigned: T,
  sha256: Sha256,
): Promise<T & { mac: string }> {
  return { ...unsigned, mac: await mcpRequestMac(bridgeKey, unsigned, sha256) };
}
