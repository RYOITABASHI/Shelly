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
  /** The signed `receivedAt` (epoch ms): when the server wrote the request. */
  receivedAtMs: number;
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
/** Extra time a callId is kept past the end of its request's validity. */
export const MCP_REPLAY_SAFETY_MARGIN_MS = 5_000;
/** A callId is kept until signed receivedAt + this (never evicted earlier). */
export const MCP_REPLAY_RETAIN_AFTER_RECEIVED_MS = MCP_REQUEST_MAX_AGE_MS + MCP_REPLAY_SAFETY_MARGIN_MS;
/** Far above what a client can produce in one window; mirrors McpReplayGuard.DEFAULT_CAPACITY. */
export const MCP_REPLAY_GUARD_CAPACITY = 4096;

/**
 * Replay set mirroring McpReplayGuard.kt (native typed-op consumer). Every
 * id it admits is remembered until the signed request it came from can no
 * longer pass the freshness check — `receivedAt + MCP_REQUEST_MAX_AGE_MS +
 * MCP_REPLAY_SAFETY_MARGIN_MS`, keyed by the signed receivedAt, not by when
 * it was seen — and never evicted by count. When `capacity` entries are all
 * still inside their window a new id is NOT admitted (fail closed): evicting
 * a live entry would make its captured request replayable. A wall clock
 * moved backwards only lengthens retention.
 */
export class McpReplaySet {
  /** id -> the moment it may be forgotten. */
  private readonly expiresAt = new Map<string, number>();

  constructor(private readonly capacity: number = MCP_REPLAY_GUARD_CAPACITY) {}

  get size(): number {
    return this.expiresAt.size;
  }

  has(id: string): boolean {
    return this.expiresAt.has(id);
  }

  /** Forgets only the ids whose request can no longer be fresh at nowMs. */
  prune(nowMs: number): void {
    for (const [id, until] of this.expiresAt) if (until < nowMs) this.expiresAt.delete(id);
  }

  /** Remembers id (signed receivedAt receivedAtMs). True when remembered now
   *  (or already was); false when the set is full of live entries. */
  admit(id: string, receivedAtMs: number, nowMs: number): boolean {
    const until = receivedAtMs + MCP_REPLAY_RETAIN_AFTER_RECEIVED_MS;
    const known = this.expiresAt.get(id);
    if (known !== undefined) {
      if (until > known) this.expiresAt.set(id, until);
      return true;
    }
    this.prune(nowMs);
    if (this.expiresAt.size >= this.capacity) return false;
    this.expiresAt.set(id, until);
    return true;
  }

  clear(): void {
    this.expiresAt.clear();
  }
}

/** Accepted callIds, so a copied (or captured and restored) file can't run twice. */
const seenCallIds = new McpReplaySet();
/** callIds whose handoff token was consumed; a restored token file never revives one. */
const consumedHandoffs = new McpReplaySet();

/** Test hook: forget every accepted callId and consumed handoff (fresh state per test). */
export function __resetMcpSeenCallIdsForTests(): void {
  seenCallIds.clear();
  consumedHandoffs.clear();
}

/** Test hook: forget accepted callIds only, keeping the consumed-handoff
 *  record — isolates the handoff record in the replay tests. */
export function __forgetMcpCallIdsOnlyForTests(): void {
  seenCallIds.clear();
}

/**
 * Records that the handoff token for callId (signed receivedAt receivedAtMs)
 * was consumed. False when it already was consumed — a restored token file
 * must not be honoured — or when the record is full of live entries (fail
 * closed). Synchronous, so check and record cannot interleave.
 */
export function recordMcpHandoffConsumed(callId: string, receivedAtMs: number, nowMs: number = Date.now()): boolean {
  if (consumedHandoffs.has(callId)) return false;
  return consumedHandoffs.admit(callId, receivedAtMs, nowMs);
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
 * was already accepted (replay; kept until its request can no longer be
 * fresh), or a full replay set (fail closed). A callId is recorded only
 * once its request fully verifies, so a refused file never consumes its id.
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
  // Remembered for the request's whole validity window; at capacity with
  // every entry still live, refuse rather than evict (fail closed).
  if (!seenCallIds.admit(callId, receivedMs, nowMs)) return { ok: false, reason: 'replay guard full' };
  return {
    ok: true,
    request: {
      callId,
      tool,
      args: (args as Record<string, unknown> | undefined) ?? {},
      ingress: { kind: 'mcp', principal: ingress.principal, clientNameSelfReported: cleanClientName(ingress.clientNameSelfReported) },
      receivedAtMs: receivedMs,
    },
  };
}

/**
 * Handoff token (PR 6, headless typed ops). A typed-op request reaches RN's
 * requests/ only when the native McpTypedOpConsumer hands it over; native
 * then writes `handoffs/<callId>` = hex(HMAC-SHA256(utf8(bridgeKey),
 * utf8("shelly-mcp-handoff-v1:" + callId))) (McpTypedOpDecision.handoffToken).
 * RN runs a typed op from requests/ only with that token, consuming it first,
 * so a same-uid copy of a signed run_agent request dropped into requests/
 * while native owns (or already ran) the original is never run a second time.
 */
export const MCP_HANDOFF_DOMAIN = 'shelly-mcp-handoff-v1:';

export function mcpHandoffToken(bridgeKey: string, callId: string, sha256: Sha256): Promise<string> {
  return hmacSha256Hex(utf8(bridgeKey), utf8(`${MCP_HANDOFF_DOMAIN}${callId}`), sha256);
}

/** Constant-time check of a handoff token file's content. */
export async function verifyMcpHandoffToken(
  token: unknown,
  bridgeKey: string | null,
  callId: string,
  sha256: Sha256,
): Promise<boolean> {
  if (!bridgeKey || !MCP_BRIDGE_KEY_RE.test(bridgeKey)) return false;
  if (typeof token !== 'string') return false;
  const t = token.trim();
  if (!MAC_RE.test(t)) return false;
  return timingSafeEqualHex(await mcpHandoffToken(bridgeKey, callId, sha256), t);
}

/** Test/helper: sign a request the way the server does. */
export async function signMcpRequest<T extends Record<string, unknown>>(
  bridgeKey: string,
  unsigned: T,
  sha256: Sha256,
): Promise<T & { mac: string }> {
  return { ...unsigned, mac: await mcpRequestMac(bridgeKey, unsigned, sha256) };
}

// -- Lock-screen approvals (owner decision 2026-11-29) --
//
// For update_pipeline_config / update_delivery_script / stage_install, the
// native lock-screen approval (McpLockScreenApprovalActivity.kt) records an
// approval the owner gave on the lock screen (after the keyguard was
// dismissed) as `lock-approvals/<callId>` =
// `<expiresAtMs>.<hex HMAC(bridgeKey, domain + callId + ":" + tool + ":" + expiresAtMs)>`
// (McpLockScreenApproval.kt). RN accepts it instead of showing its dialog
// only when it verifies for this callId and tool, has not expired, does not
// outlive the request's approval deadline, and was not used before (the file
// is deleted before the check and the callId recorded).
export const MCP_LOCK_APPROVAL_DOMAIN = 'shelly-mcp-lock-approval-v1:';
const LOCK_APPROVAL_RE = /^([0-9]{13})\.([0-9a-f]{64})$/;

export function mcpLockApprovalMac(bridgeKey: string, callId: string, tool: string, expiresAtMs: number, sha256: Sha256): Promise<string> {
  return hmacSha256Hex(utf8(bridgeKey), utf8(`${MCP_LOCK_APPROVAL_DOMAIN}${callId}:${tool}:${expiresAtMs}`), sha256);
}

/** Constant-time check of a lock-approval file's content (single use is the caller's: delete + record). */
export async function verifyMcpLockApproval(
  content: unknown,
  bridgeKey: string | null,
  callId: string,
  tool: string,
  deadlineMs: number,
  nowMs: number,
  sha256: Sha256,
): Promise<boolean> {
  if (!bridgeKey || !MCP_BRIDGE_KEY_RE.test(bridgeKey)) return false;
  if (typeof content !== 'string') return false;
  const m = LOCK_APPROVAL_RE.exec(content.trim());
  if (!m) return false;
  const expiresAtMs = Number(m[1]);
  if (!Number.isSafeInteger(expiresAtMs) || nowMs >= expiresAtMs || !(expiresAtMs <= deadlineMs)) return false;
  return timingSafeEqualHex(await mcpLockApprovalMac(bridgeKey, callId, tool, expiresAtMs, sha256), m[2]);
}

/** Records that the lock-screen approval for callId was used. False when it already was. */
export function recordMcpLockApprovalConsumed(callId: string, receivedAtMs: number, nowMs: number = Date.now()): boolean {
  const key = `lock:${callId}`;
  if (consumedHandoffs.has(key)) return false;
  return consumedHandoffs.admit(key, receivedAtMs, nowMs);
}
