/**
 * Test helper: sign MCP queue requests the way scripts/shelly-mcp-server.js
 * does (DEFERRED.md MCP ingress Inc 2), with a fixed test key and node's
 * SHA-256. No realistic data: the principal is a fixed dummy hash.
 */
import * as nodeCrypto from 'crypto';
import { signMcpRequest, type Sha256 } from '@/lib/mcp-request-auth';

export const TEST_BRIDGE_KEY = 'a1'.repeat(32);
export const TEST_PRINCIPAL = '0123456789abcdef0123456789abcdef';

export const nodeSha256: Sha256 = async (d) => new Uint8Array(nodeCrypto.createHash('sha256').update(d).digest());

/** JSON text of a signed request file. receivedAt defaults to now: the RN
 *  side refuses requests older than 10 minutes (lib/mcp-request-auth.ts),
 *  so a fixed old date would never verify. Pass receivedAt to build a
 *  stale / future-dated request for the replay tests. */
export async function signedRequest(
  callId: string,
  tool: string,
  args: Record<string, unknown>,
  opts: { key?: string; principal?: string; clientName?: string; receivedAt?: string } = {},
): Promise<string> {
  const unsigned = {
    callId,
    tool,
    args,
    ingress: { kind: 'mcp', principal: opts.principal ?? TEST_PRINCIPAL, clientNameSelfReported: opts.clientName ?? 'test-client' },
    receivedAt: opts.receivedAt ?? new Date().toISOString(),
  };
  return JSON.stringify(await signMcpRequest(opts.key ?? TEST_BRIDGE_KEY, unsigned, nodeSha256));
}
