/**
 * lib/mcp-raw-gate.ts — the gate decision for one MCP run_command /
 * write_file, as a pure function of a JSON input. RN (lib/mcp-server-bridge.ts)
 * and the native headless path (McpRawToolConsumer.kt, through the bundled
 * scripts/mcp-raw-gate-entry.ts helper) make the same judgement from the
 * same TS: lib/mcp-ingress-gate.ts evaluateMcpCommand with gateCommandWithCwd
 * / gateWriteCommand, and the POLICY-001 rules parsed by parseUserPolicyFile.
 *
 * Input:
 *   { v: 1, tool: 'run_command', home, command, cwd?, policy: { text, sealOk } }
 *   { v: 1, tool: 'write_file',  home, paths: [realPath, sentPath?], policy }
 * `policy.text` is ~/.shelly/agents/policy.json (null when absent) and
 * `policy.sealOk` whether its bytes match the seal; a false seal makes the
 * rules unavailable, which escalates side effects but never refuses on its
 * own (as RN's loadUserPolicy). Output: { v: 1, refused, summary, rulesUnavailable }.
 * FAIL-CLOSED: anything malformed is refused.
 */
import { evaluateMcpCommand, gateCommandWithCwd, gateWriteCommand } from '@/lib/mcp-ingress-gate';
import { emptyUserPolicy, parseUserPolicyFile, type LoadedUserPolicy } from '@/lib/agent-user-policy-store';

/**
 * `rulesUnavailable`: the POLICY-001 rules could not be trusted (seal mismatch,
 * unparseable file). RN then escalates side effects to the approval tap; the
 * headless path has no tap, so it refuses instead.
 */
export type McpRawGateOut = { v: 1; refused: boolean; summary: string; rulesUnavailable: boolean };

export function refuseMcpRawGate(reason: string): McpRawGateOut {
  return { v: 1, refused: true, summary: `gate unavailable: ${reason}`, rulesUnavailable: true };
}

export function decideMcpRawGate(input: unknown): McpRawGateOut {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return refuseMcpRawGate('bad input');
  const i = input as Record<string, unknown>;
  if (i.v !== 1) return refuseMcpRawGate('bad version');
  const home = typeof i.home === 'string' ? i.home : '';
  if (!home.startsWith('/')) return refuseMcpRawGate('missing home');
  const p = i.policy && typeof i.policy === 'object' ? (i.policy as Record<string, unknown>) : null;
  if (!p || typeof p.sealOk !== 'boolean' || (p.text !== null && typeof p.text !== 'string')) return refuseMcpRawGate('missing policy');
  const policy: LoadedUserPolicy = p.sealOk ? parseUserPolicyFile((p.text as string | null) ?? '') : { data: emptyUserPolicy(), unavailable: true };

  if (i.tool === 'run_command') {
    const command = typeof i.command === 'string' ? i.command : '';
    if (!command.trim()) return refuseMcpRawGate('missing command');
    if (i.cwd !== undefined && i.cwd !== null && typeof i.cwd !== 'string') return refuseMcpRawGate('bad cwd');
    const cwd = typeof i.cwd === 'string' && i.cwd ? i.cwd : undefined;
    const g = evaluateMcpCommand(gateCommandWithCwd(command, cwd, home), home, policy);
    return { v: 1, refused: g.refused, summary: g.summary, rulesUnavailable: policy.unavailable };
  }
  if (i.tool === 'write_file') {
    const paths = Array.isArray(i.paths) ? i.paths : [];
    // paths[0] is the resolved real path; paths[1] (only when different) is
    // the path exactly as the client sent it, judged as RN judges it.
    if (paths.length < 1 || paths.length > 2 || !paths.every((x) => typeof x === 'string' && x.length > 0)) return refuseMcpRawGate('bad paths');
    if (!(paths[0] as string).startsWith('/')) return refuseMcpRawGate('bad paths');
    // As RN: judged as a worker's `tee -- <path>`, on where it really lands
    // and (when different) on the path as sent; any deny refuses.
    const gates = (paths as string[]).map((x) => evaluateMcpCommand(gateWriteCommand(x, home), home, policy));
    const denied = gates.find((g) => g.refused);
    const g = denied ?? gates[0];
    return { v: 1, refused: g.refused, summary: g.summary, rulesUnavailable: policy.unavailable };
  }
  return refuseMcpRawGate('unknown tool');
}

