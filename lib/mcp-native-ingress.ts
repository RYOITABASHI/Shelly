/**
 * lib/mcp-native-ingress.ts — copies the MCP-origin facts of commands that
 * native ran headless ("MCP: Run without approval", McpRawToolConsumer.kt)
 * from native's persistent, Keystore-HMAC'd journal (McpNativeIngress.kt) into
 * lib/mcp-ingress-origin.ts, before agent requests are classified
 * (lib/agent-add-queue.ts drainAgentAddRequests, every pass). With it, a
 * `shelly agent add` / `confirm` written by a headless MCP command is marked
 * exactly as one written by an RN-run command — also after Shelly's process
 * died before RN drained it (the journal survives; native recovers a window
 * the dead process left open by recording every request that appeared since
 * it opened). The env marker needs nothing (native runs the same
 * SHELLY_INGRESS* prefix). The rest of the MCP-origin chain (agent marked
 * tainted at confirm, terminal confirm refused, tainted-agent limits, never
 * auto-approved by "Skip all approvals") is the existing RN code.
 *
 * Fail closed: when native has the call but the answer is not a verified
 * journal (`ok:false`, unparseable, a throw), every agent request classified
 * until the next good read is MCP-originated. Only a build without the native
 * call (web / tests) adds nothing.
 */
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { noteRequestSeenInWindow, setNativeMcpExecWindows, setNativeMcpTaintAll } from '@/lib/mcp-ingress-origin';

/** `<id>` (agent add) or `ctl-<id>` (agent confirm / reject), as lib/agent-add-queue.ts keys them.
 *  KEEP IN SYNC: McpRawToolDecision.kt agentRequestIds. */
const REQ_ID_RE = /^(?:ctl-)?[0-9]{10,16}-[0-9a-f]{8}$/;

/** Applies one native answer (exported for tests). Returns whether it was a verified journal. */
export function applyNativeMcpIngress(raw: string | null | undefined): boolean {
  let parsed: unknown = null;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const p = parsed && typeof parsed === 'object' ? (parsed as { ok?: unknown; windows?: unknown; requests?: unknown }) : null;
  if (!p || p.ok !== true || !Array.isArray(p.windows) || !Array.isArray(p.requests)) {
    setNativeMcpTaintAll(true);
    return false;
  }
  setNativeMcpExecWindows(p.windows.filter((w): w is Record<string, unknown> => !!w && typeof w === 'object') as never);
  for (const r of p.requests) {
    if (!r || typeof r !== 'object') continue;
    const { reqId, callId, principal } = r as Record<string, unknown>;
    if (typeof reqId !== 'string' || !REQ_ID_RE.test(reqId)) continue;
    noteRequestSeenInWindow(reqId, String(callId ?? ''), String(principal ?? ''));
  }
  setNativeMcpTaintAll(false);
  return true;
}

export async function syncNativeMcpIngress(): Promise<void> {
  if (typeof TerminalEmulator.getMcpNativeIngress !== 'function') return;
  let raw: string | null = null;
  try {
    raw = await TerminalEmulator.getMcpNativeIngress();
  } catch {
    raw = null;
  }
  applyNativeMcpIngress(raw);
}
