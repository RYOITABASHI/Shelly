/**
 * lib/mcp-native-ingress.ts — copies the MCP-origin facts of commands that
 * native ran headless ("MCP: Run without approval", McpRawToolConsumer.kt →
 * McpNativeIngress.kt) into lib/mcp-ingress-origin.ts, before agent requests
 * are classified (lib/agent-add-queue.ts drainAgentAddRequests). With it, a
 * `shelly agent add` started by a headless MCP command is marked exactly as
 * one started by an RN-run command: the env marker needs nothing (native runs
 * the same SHELLY_INGRESS* prefix), the window and "appeared while it ran"
 * signals come from here. The rest of the MCP-origin chain (agent marked
 * tainted at confirm, terminal confirm refused, tainted-agent limits) is the
 * existing RN code and unchanged.
 *
 * Fail direction: an unreadable native answer just adds nothing (as RN's own
 * windows are lost on restart); the marker still marks.
 */
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { noteRequestSeenInWindow, setNativeMcpExecWindows } from '@/lib/mcp-ingress-origin';

const REQ_ID_RE = /^[0-9]{10,16}-[0-9a-f]{8}$/;

/** Applies one native snapshot (exported for tests). */
export function applyNativeMcpIngress(raw: string | null | undefined): void {
  if (typeof raw !== 'string') return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;
  const p = parsed as { windows?: unknown; requests?: unknown };
  if (Array.isArray(p.windows)) {
    setNativeMcpExecWindows(p.windows.filter((w): w is Record<string, unknown> => !!w && typeof w === 'object') as never);
  }
  if (Array.isArray(p.requests)) {
    for (const r of p.requests) {
      if (!r || typeof r !== 'object') continue;
      const { reqId, callId, principal } = r as Record<string, unknown>;
      if (typeof reqId !== 'string' || !REQ_ID_RE.test(reqId)) continue;
      noteRequestSeenInWindow(reqId, String(callId ?? ''), String(principal ?? ''));
    }
  }
}

export async function syncNativeMcpIngress(): Promise<void> {
  try {
    applyNativeMcpIngress(await TerminalEmulator.getMcpNativeIngress?.());
  } catch {
    // Adds nothing; see the module doc.
  }
}
