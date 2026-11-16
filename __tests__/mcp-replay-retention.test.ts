/**
 * RN replay set (lib/mcp-request-auth.ts) — Codex re-gate 2026-11-15,
 * finding 5: an accepted callId must be remembered for its signed request's
 * whole validity window (never evicted by count), and a full set of live
 * entries refuses new requests instead of evicting one (fail closed).
 * Mirrors McpReplayGuard.kt.
 */
import {
  __resetMcpSeenCallIdsForTests,
  MCP_REPLAY_GUARD_CAPACITY,
  MCP_REPLAY_RETAIN_AFTER_RECEIVED_MS,
  McpReplaySet,
  recordMcpHandoffConsumed,
  verifyMcpRequest,
} from '@/lib/mcp-request-auth';
import { TEST_BRIDGE_KEY, nodeSha256, signedRequest } from './helpers/mcp-signed-request';

const T0 = Date.parse('2026-11-15T00:00:00.000Z');
const at = (ms: number) => new Date(ms).toISOString();

async function verify(callId: string, receivedAtMs: number, nowMs: number) {
  const parsed = JSON.parse(await signedRequest(callId, 'list_repos', {}, { receivedAt: at(receivedAtMs) }));
  return verifyMcpRequest(parsed, TEST_BRIDGE_KEY, nodeSha256, { fileName: `${callId}.json`, nowMs });
}

beforeEach(() => __resetMcpSeenCallIdsForTests());

describe('RN request replay set: retention for the full validity window', () => {
  it('a captured signed request re-presented after >1,000 intervening verified requests is still a replay', async () => {
    const captured = JSON.parse(await signedRequest('victim', 'run_agent', { agentId: 'a1' }, { receivedAt: at(T0) }));
    expect(await verifyMcpRequest(captured, TEST_BRIDGE_KEY, nodeSha256, { fileName: 'victim.json', nowMs: T0 })).toMatchObject({ ok: true });
    for (let i = 0; i < 1500; i++) {
      expect(await verify(`fill-${i}`, T0 + 1_000, T0 + 2_000)).toMatchObject({ ok: true });
    }
    expect(await verifyMcpRequest(captured, TEST_BRIDGE_KEY, nodeSha256, { fileName: 'victim.json', nowMs: T0 + 50_000 })).toEqual({
      ok: false,
      reason: 'replay',
    });
  });

  it('at capacity with every entry still live, a new request is refused (fail closed) and no live id is evicted', async () => {
    for (let i = 0; i < MCP_REPLAY_GUARD_CAPACITY; i++) {
      expect(await verify(`live-${i}`, T0, T0)).toMatchObject({ ok: true });
    }
    expect(await verify('one-too-many', T0 + 1_000, T0 + 1_000)).toEqual({ ok: false, reason: 'replay guard full' });
    // The oldest live ids are still remembered, so their captured requests stay refused.
    expect(await verify('live-0', T0, T0 + 2_000)).toEqual({ ok: false, reason: 'replay' });
    // Once the old entries' window is over they are pruned and new requests run again.
    const later = T0 + MCP_REPLAY_RETAIN_AFTER_RECEIVED_MS + 1;
    expect(await verify('after-window', later, later)).toMatchObject({ ok: true });
  });
});

describe('McpReplaySet (mirror of McpReplayGuard.kt)', () => {
  it('keys retention off the signed receivedAt; prunes only expired ids; fails closed when full', () => {
    const set = new McpReplaySet(2);
    expect(set.admit('a', T0, T0)).toBe(true);
    expect(set.admit('b', T0 + 60_000, T0)).toBe(true); // future-dated: kept longer
    expect(set.admit('c', T0, T0)).toBe(false);
    expect(set.has('a') && set.has('b')).toBe(true);
    const aGone = T0 + MCP_REPLAY_RETAIN_AFTER_RECEIVED_MS + 1;
    expect(set.admit('c', T0, aGone)).toBe(true);
    expect(set.has('a')).toBe(false);
    expect(set.has('b')).toBe(true);
    expect(set.admit('b', T0, aGone)).toBe(true); // already known: still true, expiry not shortened
    expect(set.size).toBe(2);
  });

  it('a consumed handoff is recorded once; a second consumption of the same callId is refused', () => {
    expect(recordMcpHandoffConsumed('h1', T0, T0)).toBe(true);
    expect(recordMcpHandoffConsumed('h1', T0, T0 + 1_000)).toBe(false);
  });
});
