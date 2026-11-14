/**
 * lib/agent-ingress-taint.ts — per-agent "ingress taint" (DEFERRED.md P1
 * "MCP の入口（ingress）に外部入力の印（taint）を付ける", item 2, Inc 3).
 *
 * An agent created or changed by a request that came in through Shelly's MCP
 * server carries a mark; later increments refuse its CLI writes / external
 * sends without the owner. Inc 3 is storage only: nothing here refuses
 * anything yet, and nothing here asks the owner anything (no new prompts).
 *
 * The state is native (AgentIngressTaint.kt: Keystore-MAC'd prefs, re-keyed on
 * every write) so that the shell cannot edit or roll it back; deleting it from
 * the shell reads as "unreadable", which taints every agent (fail closed,
 * owner decision 2026-11-14). Status values:
 *   'empty'      fresh install, nothing tainted
 *   'ok'         verified, the listed agents are tainted
 *   'unreadable' alias/prefs missing, MAC mismatch, Keystore error: every agent tainted
 *   'overflow'   more marks than the store holds: every agent tainted (sticky)
 *   'unavailable' this build has no native store (see isAgentIngressTainted)
 * 'unreadable' and 'overflow' stay until the owner resets (resetAgentIngress).
 *
 * Who calls what (enforced by the callers, later increments):
 *   markAgentIngress    — the MCP ingress path only. INVARIANT for Inc 4: if it
 *                         returns ok:false, the MCP create/modify request must be
 *                         refused (never run it unmarked).
 *   clearAgentIngress / resetAgentIngress — the owner only (typed chat / Settings)
 *   removeAgentIngress  — ONLY the owner's explicit agent-delete path. Never a
 *                         sync / cleanup / reconcile step reacting to a missing
 *                         agent JSON (the shell can delete that JSON; the agent
 *                         recreated under the same id would be untainted).
 *
 * "MCP ever enabled": once an MCP token exists in SecureStore, a store with no
 * Keystore alias and no prefs reads 'unreadable', not 'empty' (deleting both is
 * not a way to untaint). MCPBridge.start also seals a verified empty state.
 * Audit lines are forgeable by the same uid and are never read to decide taint.
 * Every mark / clear / remove / reset writes one `kind: "ingress_taint"` line to
 * the agent's audit file natively (no secrets: agent id, action, source, the
 * principal hash).
 */
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { logWarn } from '@/lib/debug-logger';
import { getConnectorSecret } from '@/lib/secure-store';
import { MCP_TOKEN_CONNECTOR_ID, MCP_TOKEN_FIELD } from '@/lib/mcp-token';

export type AgentIngressSource = 'mcp';
export type AgentIngressStatusKind = 'empty' | 'ok' | 'unreadable' | 'overflow' | 'unavailable';

export type AgentIngressEntry = {
  agentId: string;
  source: AgentIngressSource;
  /** Truncated MCP token hash; '' when unknown. Never a token or a name. */
  principal: string;
  at: number;
};

export type AgentIngressStatus = {
  status: AgentIngressStatusKind;
  overflow: boolean;
  entries: AgentIngressEntry[];
};

/** The native methods (AgentIngressTaint.kt via TerminalEmulatorModule). Optional: older builds lack them. */
type IngressNative = {
  markAgentIngress?: (agentId: string, source: string, principal: string) => Promise<string>;
  isAgentIngressTainted?: (agentId: string, mcpEverEnabled: boolean) => Promise<boolean>;
  clearAgentIngress?: (agentId: string, mcpEverEnabled: boolean) => Promise<string>;
  removeAgentIngress?: (agentId: string, mcpEverEnabled: boolean) => Promise<string>;
  resetAgentIngress?: () => Promise<string>;
  getAgentIngressStatus?: (mcpEverEnabled: boolean) => Promise<string>;
};

const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const PRINCIPAL_RE = /^[A-Za-z0-9_.:-]{0,64}$/;
const STATUSES: ReadonlySet<string> = new Set(['empty', 'ok', 'unreadable', 'overflow']);

const UNAVAILABLE: AgentIngressStatus = { status: 'unavailable', overflow: false, entries: [] };
const UNREADABLE: AgentIngressStatus = { status: 'unreadable', overflow: false, entries: [] };

function native(): IngressNative {
  return (TerminalEmulator ?? {}) as unknown as IngressNative;
}

/**
 * Whether MCP has ever been enabled on this install: an MCP token exists in
 * SecureStore (lib/mcp-token.ts creates it the first time the server starts).
 * getConnectorSecret returns null on a read error, which reads as "never"; the
 * native seal written by MCPBridge.start still covers that case.
 */
export async function mcpEverEnabled(): Promise<boolean> {
  try {
    return !!(await getConnectorSecret(MCP_TOKEN_CONNECTOR_ID, MCP_TOKEN_FIELD));
  } catch {
    return true;
  }
}

export function isValidIngressAgentId(agentId: unknown): agentId is string {
  return typeof agentId === 'string' && AGENT_ID_RE.test(agentId);
}

/** Parses the native status JSON. Anything malformed reads as 'unreadable' (fail closed). */
export function parseAgentIngressStatus(raw: unknown): AgentIngressStatus {
  if (typeof raw !== 'string') return UNREADABLE;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return UNREADABLE;
  }
  if (!o || typeof o !== 'object') return UNREADABLE;
  const rec = o as Record<string, unknown>;
  if (typeof rec.status !== 'string' || !STATUSES.has(rec.status) || !Array.isArray(rec.entries)) return UNREADABLE;
  const entries: AgentIngressEntry[] = [];
  for (const e of rec.entries) {
    if (!e || typeof e !== 'object') return UNREADABLE;
    const r = e as Record<string, unknown>;
    if (
      !isValidIngressAgentId(r.agentId) ||
      r.source !== 'mcp' ||
      typeof r.principal !== 'string' ||
      !PRINCIPAL_RE.test(r.principal) ||
      typeof r.at !== 'number'
    ) {
      return UNREADABLE;
    }
    entries.push({ agentId: r.agentId, source: 'mcp', principal: r.principal, at: r.at });
  }
  return { status: rec.status as AgentIngressStatusKind, overflow: rec.overflow === true, entries };
}

/** Same rule as AgentIngressTaint.Snapshot.isTainted. 'unavailable' taints nothing (see below). */
export function statusTaints(s: AgentIngressStatus, agentId: string): boolean {
  switch (s.status) {
    case 'empty':
    case 'unavailable':
      return false;
    case 'ok':
      return s.entries.some((e) => e.agentId === agentId);
    default:
      return true;
  }
}

export async function agentIngressStatus(): Promise<AgentIngressStatus> {
  const fn = native().getAgentIngressStatus;
  if (typeof fn !== 'function') return UNAVAILABLE;
  try {
    return parseAgentIngressStatus(await fn.call(TerminalEmulator, await mcpEverEnabled()));
  } catch (e) {
    logWarn('AgentIngressTaint', `status failed: ${e instanceof Error ? e.name : 'error'}`);
    return UNREADABLE;
  }
}

/**
 * Whether runs of this agent must be treated as tainted.
 *
 * Choice for builds without the native store (documented, per the Inc 3 brief):
 *  - native `isAgentIngressTainted` present → its answer; if it throws → true.
 *  - absent but `getAgentIngressStatus` present → decided from the status (fail closed
 *    on anything but 'empty' / a verified list without this agent).
 *  - neither present → false. A build without the store also has no MCP path that
 *    could have marked anything (marking ships in the same build as the store), so
 *    "unavailable" means "never marked", not "could not read". Tainting every agent
 *    there would break all agents on web / tests / old native builds for no gain.
 * An invalid agent id is treated as tainted.
 */
export async function isAgentIngressTainted(agentId: string): Promise<boolean> {
  if (!isValidIngressAgentId(agentId)) return true;
  const n = native();
  if (typeof n.isAgentIngressTainted === 'function') {
    try {
      return (await n.isAgentIngressTainted.call(TerminalEmulator, agentId, await mcpEverEnabled())) !== false;
    } catch (e) {
      logWarn('AgentIngressTaint', `isTainted failed - treating as tainted: ${e instanceof Error ? e.name : 'error'}`);
      return true;
    }
  }
  if (typeof n.getAgentIngressStatus === 'function') return statusTaints(await agentIngressStatus(), agentId);
  return false;
}

export type AgentIngressWriteResult = { ok: boolean; status: AgentIngressStatus };

async function callWrite(
  name: 'markAgentIngress' | 'clearAgentIngress' | 'removeAgentIngress' | 'resetAgentIngress',
  args: (string | boolean)[],
): Promise<AgentIngressWriteResult> {
  const fn = native()[name] as ((...a: (string | boolean)[]) => Promise<string>) | undefined;
  if (typeof fn !== 'function') return { ok: false, status: UNAVAILABLE };
  try {
    const status = parseAgentIngressStatus(await fn.apply(TerminalEmulator, args));
    return { ok: true, status };
  } catch (e) {
    logWarn('AgentIngressTaint', `${name} failed: ${e instanceof Error ? e.name : 'error'}`);
    return { ok: false, status: await agentIngressStatus() };
  }
}

/**
 * The MCP ingress path: this agent was created or changed by an MCP request.
 * `principal` is the MCP principal hash (shelly-mcp-server.js), never the token.
 * ok:false when the build has no store, the arguments are invalid or the write
 * failed. INVARIANT: on ok:false the MCP create/modify request must be refused.
 */
export async function markAgentIngress(
  agentId: string,
  source: AgentIngressSource = 'mcp',
  principal = '',
): Promise<AgentIngressWriteResult> {
  if (!isValidIngressAgentId(agentId) || source !== 'mcp' || !PRINCIPAL_RE.test(principal)) {
    return { ok: false, status: await agentIngressStatus() };
  }
  return callWrite('markAgentIngress', [agentId, source, principal]);
}

/** Owner action only (typed chat / Settings). No effect while 'unreadable' — use resetAgentIngress. */
export async function clearAgentIngress(agentId: string): Promise<AgentIngressWriteResult> {
  if (!isValidIngressAgentId(agentId)) return { ok: false, status: await agentIngressStatus() };
  return callWrite('clearAgentIngress', [agentId, await mcpEverEnabled()]);
}

/** ONLY the owner's explicit agent-delete path (see the header): never a sync/cleanup reacting to a missing JSON. */
export async function removeAgentIngress(agentId: string): Promise<AgentIngressWriteResult> {
  if (!isValidIngressAgentId(agentId)) return { ok: false, status: await agentIngressStatus() };
  return callWrite('removeAgentIngress', [agentId, await mcpEverEnabled()]);
}

/** Owner action only: forget every mark (the way out of 'unreadable' / 'overflow'). */
export async function resetAgentIngress(): Promise<AgentIngressWriteResult> {
  return callWrite('resetAgentIngress', []);
}
