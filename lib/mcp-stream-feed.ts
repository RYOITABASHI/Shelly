/**
 * lib/mcp-stream-feed.ts — the pure half of the MCP typed op `put_stream_feed`
 * (launcher ingress C7): a supplier pushes the stream feed document (opaque
 * JSON v1 built from mail / SNS) inline, and Shelly stores it for the launcher
 * to read through its provider. Nothing else in Shelly ever reads it.
 *
 * The feed is ALWAYS external, tainted data. It never reaches a prompt, an
 * agent, a log, an audit line, chat or a repo; audit lines carry the sha256,
 * the byte count, the item count and a code only. The "Skip all approvals"
 * switch never applies to this op: only an always-allow rule for
 * (principal, put_stream_feed, `stream-feed`) or a human tap stores it.
 *
 * The validation below is the same, in the same order, in
 * scripts/shelly-mcp-server.js (pre-check before enqueueing) and the native
 * StreamFeedCore.kt (authoritative; it validates again before storing). The
 * first failure wins:
 *   1. unknown / missing / wrong-typed argument      → invalid_params
 *   2. UTF-8 bytes of feedJson > 49152                → too_large
 *   3. UTF-8 bytes != expectedBytes                   → size_mismatch
 *   4. sha256(UTF-8 feedJson) != expectedSha256       → digest_mismatch
 *   5. not a JSON object, or `v` is not the number 1  → invalid_feed
 *
 * Pure: no native module, no store, no timers, no logging.
 */
import { sha256Hex } from '@/lib/sha256';

export const STREAM_FEED_OP = 'put_stream_feed';
/** The op's one fixed always-allow target (McpAlwaysAllowStore TARGET_RES). */
export const STREAM_FEED_TARGET = 'stream-feed';
/** Upper bound on the feed's UTF-8 bytes; keeps the signed request under 64 KiB. */
export const STREAM_FEED_MAX_BYTES = 49152;

export const STREAM_FEED_VALIDATION_CODES = [
  'invalid_params',
  'too_large',
  'size_mismatch',
  'digest_mismatch',
  'invalid_feed',
] as const;
export type StreamFeedValidationCode = (typeof STREAM_FEED_VALIDATION_CODES)[number];

export type StreamFeedArgs = { feedJson: string; expectedSha256: string; expectedBytes: number };

export type StreamFeedValidation =
  | { ok: true; args: StreamFeedArgs; bytes: number; sha256: string; items?: number }
  | { ok: false; code: StreamFeedValidationCode; message: string };

const ARG_KEYS = ['feedJson', 'expectedSha256', 'expectedBytes'];
const SHA256_RE = /^[0-9a-f]{64}$/;

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * True when `s` has no lone UTF-16 surrogate. A lone surrogate has no UTF-8
 * encoding (node and Kotlin would substitute different bytes), so such a
 * feedJson is refused as a malformed argument rather than hashed.
 */
export function isWellFormedUtf16(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return false;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** UTF-8 byte length of a well-formed string (no allocation). */
export function utf8ByteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i += 1;
    } else n += 3;
  }
  return n;
}

function fail(code: StreamFeedValidationCode, message: string): StreamFeedValidation {
  return { ok: false, code, message };
}

/** The validation order shared with the script pre-check and StreamFeedCore.kt. */
export function validateStreamFeedArgs(args: unknown): StreamFeedValidation {
  // 1. arguments: exactly the three keys, each of its type.
  if (!isPlainRecord(args)) return fail('invalid_params', 'arguments must be an object');
  const keys = Object.keys(args);
  if (keys.length !== ARG_KEYS.length || !keys.every((k) => ARG_KEYS.includes(k))) {
    return fail('invalid_params', 'arguments must be exactly feedJson, expectedSha256 and expectedBytes');
  }
  const { feedJson, expectedSha256, expectedBytes } = args;
  if (typeof feedJson !== 'string' || !isWellFormedUtf16(feedJson)) {
    return fail('invalid_params', 'feedJson must be a string of valid Unicode text');
  }
  if (typeof expectedSha256 !== 'string' || !SHA256_RE.test(expectedSha256)) {
    return fail('invalid_params', 'expectedSha256 must be 64 lowercase hex characters');
  }
  if (typeof expectedBytes !== 'number' || !Number.isInteger(expectedBytes)
    || expectedBytes < 1 || expectedBytes > STREAM_FEED_MAX_BYTES) {
    return fail('invalid_params', `expectedBytes must be an integer from 1 to ${STREAM_FEED_MAX_BYTES}`);
  }
  // 2. size cap.
  const bytes = utf8ByteLength(feedJson);
  if (bytes > STREAM_FEED_MAX_BYTES) {
    return fail('too_large', `the feed is ${bytes} bytes; at most ${STREAM_FEED_MAX_BYTES} (send fewer items)`);
  }
  // 3. declared size.
  if (bytes !== expectedBytes) return fail('size_mismatch', `the feed is ${bytes} bytes, not expectedBytes`);
  // 4. digest.
  const sha256 = sha256Hex(feedJson);
  if (sha256 !== expectedSha256) return fail('digest_mismatch', 'sha256 of the feed does not match expectedSha256');
  // 5. shape: a JSON object with v === 1. Nothing else is interpreted.
  let doc: unknown;
  try {
    doc = JSON.parse(feedJson);
  } catch {
    return fail('invalid_feed', 'feedJson is not valid JSON');
  }
  if (!isPlainRecord(doc)) return fail('invalid_feed', 'the feed must be a JSON object');
  if (typeof doc.v !== 'number' || doc.v !== 1) return fail('invalid_feed', 'the feed must have "v": 1');
  const out: StreamFeedValidation = { ok: true, args: { feedJson, expectedSha256, expectedBytes }, bytes, sha256 };
  if (Array.isArray(doc.items)) out.items = doc.items.length;
  return out;
}

/** What native streamFeedPut answers (StreamFeedStore / McpTypedOpConsumer). */
export const STREAM_FEED_STORE_FAILURE_CODES = [
  ...STREAM_FEED_VALIDATION_CODES,
  'halted',
  'audit_failed',
  'store_failed',
] as const;
export type StreamFeedStoreFailureCode = (typeof STREAM_FEED_STORE_FAILURE_CODES)[number];

export type StreamFeedStoreResult =
  | { ok: true; sha256: string; bytes: number; receivedAt: number; items?: number }
  | { ok: false; code: StreamFeedStoreFailureCode };

/**
 * Parses native streamFeedPut's JSON answer. A success must name exactly the
 * sha256 and byte count that were asked for; anything malformed is null.
 */
export function parseStreamFeedStoreResult(raw: unknown, expected: { sha256: string; bytes: number }): StreamFeedStoreResult | null {
  if (typeof raw !== 'string') return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainRecord(v)) return null;
  if (v.ok === false) {
    return typeof v.code === 'string' && (STREAM_FEED_STORE_FAILURE_CODES as readonly string[]).includes(v.code)
      ? { ok: false, code: v.code as StreamFeedStoreFailureCode }
      : null;
  }
  if (v.ok !== true) return null;
  if (v.sha256 !== expected.sha256 || v.bytes !== expected.bytes) return null;
  if (typeof v.receivedAt !== 'number' || !Number.isSafeInteger(v.receivedAt) || v.receivedAt <= 0) return null;
  const out: StreamFeedStoreResult = { ok: true, sha256: expected.sha256, bytes: expected.bytes, receivedAt: v.receivedAt };
  if (v.items !== undefined) {
    if (typeof v.items !== 'number' || !Number.isSafeInteger(v.items) || v.items < 0) return null;
    out.items = v.items;
  }
  return out;
}
