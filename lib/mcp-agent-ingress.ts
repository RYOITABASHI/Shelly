/**
 * lib/mcp-agent-ingress.ts — marks agents created or changed by an
 * MCP-originated request (DEFERRED.md「MCP の入口（ingress）に外部入力の印（taint）を付ける」 Inc 4).
 *
 * An MCP `run_command` can only reach agent registration through
 * `shelly agent add` (the shim → lib/agent-add-queue.ts → the normal in-app
 * `@agent` flow with the owner's confirmation). There is no terminal path
 * that edits an existing agent: the add path refuses `edit` / `run` / `stop`
 * / `delete` and `shelly agent` has no edit sub-command, so a draft carrying
 * an MCP origin is always a new agent in practice; an edit target (Sidebar
 * edit session that somehow carries one) is marked the same way.
 *
 * Invariant (lib/agent-ingress-taint.ts): the mark is written BEFORE the
 * agent exists, under the id the agent will get; when markAgentIngress
 * returns ok:false the registration is refused and nothing is created.
 * Refusals are logged (and shown in the chat line of the draft), never a
 * new prompt or a blocking notification.
 */
import { markAgentIngress, type AgentIngressWriteResult } from '@/lib/agent-ingress-taint';
import { mcpOriginForRequest } from '@/lib/mcp-ingress-origin';
import { isAgentAddRequestId } from '@/lib/agent-add-queue';

export type McpAgentOrigin = { principal: string; callId: string };

const ORIGIN_VALUE_RE = /^[A-Za-z0-9_-]{1,64}$/;

function validOrigin(o: unknown): McpAgentOrigin | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  if (typeof r.principal !== 'string' || typeof r.callId !== 'string') return null;
  // A malformed stamp still means "MCP": keep the taint, drop the details.
  return {
    principal: ORIGIN_VALUE_RE.test(r.principal) ? r.principal : 'unknown',
    callId: ORIGIN_VALUE_RE.test(r.callId) ? r.callId : 'unknown',
  };
}

/**
 * The MCP origin of a draft: the stamp the dispatch put on it, or the
 * in-memory classification of its `shelly agent add` request id. Either one
 * suffices (union, fail closed).
 */
export function mcpOriginForDraft(
  ...drafts: ({ terminalRequestId?: string; mcpIngress?: unknown } | null | undefined)[]
): McpAgentOrigin | null {
  for (const d of drafts) {
    if (!d) continue;
    const stamped = d.mcpIngress !== undefined && d.mcpIngress !== null ? validOrigin(d.mcpIngress) ?? { principal: 'unknown', callId: 'unknown' } : null;
    if (stamped) return stamped;
    if (isAgentAddRequestId(d.terminalRequestId)) {
      const o = mcpOriginForRequest(d.terminalRequestId);
      if (o) return { principal: o.principal, callId: o.callId };
    }
  }
  return null;
}

/** A fresh id in createAgent's own format, not used by any existing agent. */
export function newAgentIdFor(existing: Iterable<string>, now: number = Date.now()): string {
  const taken = new Set(existing);
  let t = now;
  let id = `agent-${t.toString(36)}`;
  while (taken.has(id)) id = `agent-${(++t).toString(36)}`;
  return id;
}

export type McpAgentMarkResult =
  | { ok: true; marked: false }
  | { ok: true; marked: true; agentId: string; presetId?: string }
  | { ok: false; agentId: string; reason: string };

/**
 * Called by the confirm path right before the agent is persisted. No MCP
 * origin → nothing to do. Otherwise marks the edit target, or a pre-chosen
 * id for the new agent (returned as presetId; createAgent must use it).
 */
export async function markMcpAgentBeforePersist(params: {
  origin: McpAgentOrigin | null;
  editingAgentId?: string;
  existingAgentIds: Iterable<string>;
  now?: number;
  mark?: (agentId: string, source: 'mcp', principal: string) => Promise<AgentIngressWriteResult>;
}): Promise<McpAgentMarkResult> {
  if (!params.origin) return { ok: true, marked: false };
  const mark = params.mark ?? markAgentIngress;
  const presetId = params.editingAgentId ? undefined : newAgentIdFor(params.existingAgentIds, params.now);
  const agentId = params.editingAgentId ?? (presetId as string);
  // The principal is the MCP token hash; 'unknown' when the request did not
  // say (a window-only match always has one).
  const principal = ORIGIN_VALUE_RE.test(params.origin.principal) ? params.origin.principal : '';
  let res: AgentIngressWriteResult;
  try {
    res = await mark(agentId, 'mcp', principal);
  } catch (e) {
    return { ok: false, agentId, reason: e instanceof Error ? e.name : 'error' };
  }
  if (!res.ok) return { ok: false, agentId, reason: `mark failed (store ${res.status.status})` };
  return presetId ? { ok: true, marked: true, agentId, presetId } : { ok: true, marked: true, agentId };
}
