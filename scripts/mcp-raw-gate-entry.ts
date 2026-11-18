/**
 * Entry for the bundled `shelly-mcp-raw-gate.js` node helper, used by the
 * native McpRawToolConsumer (headless MCP run_command / write_file with
 * "MCP: Run without approval" on). It runs EXACTLY the judgement RN makes in
 * lib/mcp-server-bridge.ts for the same calls (lib/mcp-ingress-gate.ts
 * evaluateMcpCommand + gateCommandWithCwd / gateWriteCommand, with the
 * POLICY-001 user rules parsed by parseUserPolicyFile), so the two paths can
 * not drift: there is one TS source.
 *
 * The native side never runs this from a file a shell can rewrite: it reads
 * the bundle from the APK assets and pipes it to `node -` on stdin, preceded
 * by one line `globalThis.__SHELLY_MCP_RAW_GATE_INPUT = <input JSON>;` (no
 * argv / env size limit, and nothing a same-uid process can swap between the
 * check and the run). Tests pass the same JSON as argv[2] instead:
 *   { v: 1, tool: 'run_command', home, command, cwd?, policy: { text, sealOk } }
 *   { v: 1, tool: 'write_file',  home, paths: [realPath, sentPath?], policy }
 * `policy.text` is ~/.shelly/agents/policy.json as native read it (null when
 * absent) and `policy.sealOk` whether its bytes match the native seal
 * (AgentPolicySeal) — a false seal makes the rules unavailable, which
 * escalates side effects but never refuses on its own, as in RN.
 *
 * Output (stdout, one JSON line): { v: 1, refused, summary, rulesUnavailable }.
 * FAIL-CLOSED: any parse error / missing field / exception → refused: true.
 * The caller refuses unless it gets exactly `refused: false` with exit 0.
 *
 * Do NOT hand-edit the bundle — regenerate with `pnpm build:mcp-raw-gate`.
 */
import { decideMcpRawGate, refuseMcpRawGate, type McpRawGateOut } from '@/lib/mcp-raw-gate';

// Runs unconditionally: this file is only ever the bundle entry (piped to
// `node -`, where require.main is not this module).
let out: McpRawGateOut;
try {
  const injected = (globalThis as { __SHELLY_MCP_RAW_GATE_INPUT?: unknown }).__SHELLY_MCP_RAW_GATE_INPUT;
  out = decideMcpRawGate(injected !== undefined ? injected : JSON.parse(process.argv[2] ?? ''));
} catch (e) {
  out = refuseMcpRawGate((e as Error)?.message ?? String(e));
}
process.stdout.write(JSON.stringify(out));
