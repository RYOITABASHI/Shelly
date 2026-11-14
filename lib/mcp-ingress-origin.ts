/**
 * lib/mcp-ingress-origin.ts — which terminal requests came in through MCP
 * (DEFERRED.md「MCP の入口（ingress）に外部入力の印（taint）を付ける」 Inc 2 / Inc 4).
 *
 * An MCP `run_command` runs an ordinary shell command, so `shelly agent add`
 * started by it looks like any other terminal request. Two signals, both in
 * RN memory only (pure module, no RN imports):
 *
 *  1. Marker: lib/mcp-server-bridge.ts prefixes an MCP command with
 *     `export SHELLY_INGRESS=mcp SHELLY_INGRESS_CLIENT=<principal>
 *     SHELLY_INGRESS_CALL=<callId>; `, and the `shelly agent` shim copies
 *     those into the request line as `:ingress=mcp.<principal>.<callId>`.
 *     The command can drop the variables, so the marker alone proves nothing;
 *     forging one only adds taint (harmless).
 *  2. Window: every approved MCP `run_command` records
 *     {callId, principal, start, end}. A request seen (drained, or found on
 *     disk when the command ends) inside [start, end + grace] counts as MCP —
 *     even with no marker. A request first seen later (a detached background
 *     process writing after the grace) is the known gap (DEFERRED.md).
 *
 * Classified requests are remembered by request id, and the draft parsed
 * from one carries the origin itself (ParsedAgentDraft.mcpIngress), so the
 * mark survives slot-fill turns. Only these requests are MCP-originated;
 * other terminal requests are not marked (owner rule 2026-11-14).
 */

export type McpIngressMarker = { kind: 'mcp'; principal: string; callId: string };

export type McpRequestOrigin = {
  principal: string;
  callId: string;
  via: 'marker' | 'window';
};

/** principal / callId in env, marker and the shim: no `.`, `:`, quotes or spaces. */
export const INGRESS_VALUE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MARKER_RE = /^ingress=mcp\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{1,64})$/;
/** How long after an MCP command ends its window still claims new requests. */
export const MCP_WINDOW_GRACE_MS = 60_000;
const MAX_WINDOWS = 64;
const MAX_ORIGINS = 1000;

/** Parses the optional last field of an agentadd / agentctl line. null = not a valid marker. */
export function parseIngressMarker(field: string): McpIngressMarker | null {
  const m = MARKER_RE.exec(field);
  return m ? { kind: 'mcp', principal: m[1], callId: m[2] } : null;
}

/** True when `field` looks like a marker attempt (valid or not). */
export function isIngressField(field: string): boolean {
  return field.startsWith('ingress=');
}

/** A value safe to put in the env prefix / marker; anything else becomes 'unknown'. */
export function safeIngressValue(value: unknown): string {
  return typeof value === 'string' && INGRESS_VALUE_RE.test(value) ? value : 'unknown';
}

/** The prefix put in front of an MCP run_command. Values are validated, so no quoting is needed. */
export function mcpIngressEnvPrefix(principal: string, callId: string): string {
  return `export SHELLY_INGRESS=mcp SHELLY_INGRESS_CLIENT=${safeIngressValue(principal)} SHELLY_INGRESS_CALL=${safeIngressValue(callId)}; `;
}

type ExecWindow = { callId: string; principal: string; start: number; end: number | null };

const windows: ExecWindow[] = [];
const originsByRequest = new Map<string, McpRequestOrigin>();

function prune(now: number): void {
  for (let i = windows.length - 1; i >= 0; i--) {
    const w = windows[i];
    if (w.end !== null && now - w.end > MCP_WINDOW_GRACE_MS) windows.splice(i, 1);
  }
  while (windows.length > MAX_WINDOWS) {
    // Drop the oldest finished window; an open one is never dropped.
    const idx = windows.findIndex((w) => w.end !== null);
    if (idx < 0) break;
    windows.splice(idx, 1);
  }
}

/** An approved MCP run_command is about to run. */
export function beginMcpExecWindow(callId: string, principal: string, now: number = Date.now()): void {
  prune(now);
  windows.push({ callId: safeIngressValue(callId), principal: safeIngressValue(principal), start: now, end: null });
}

/** The command finished (any outcome). */
export function endMcpExecWindow(callId: string, now: number = Date.now()): void {
  const id = safeIngressValue(callId);
  for (const w of windows) if (w.callId === id && w.end === null) w.end = now;
  prune(now);
}

/** The window covering time `t` (open, or ended at most the grace before), newest first. */
export function mcpWindowAt(t: number): { callId: string; principal: string } | null {
  for (let i = windows.length - 1; i >= 0; i--) {
    const w = windows[i];
    if (t >= w.start && (w.end === null || t <= w.end + MCP_WINDOW_GRACE_MS)) return { callId: w.callId, principal: w.principal };
  }
  return null;
}

function remember(reqId: string, origin: McpRequestOrigin): McpRequestOrigin {
  const prior = originsByRequest.get(reqId);
  if (prior) return prior;
  originsByRequest.set(reqId, origin);
  while (originsByRequest.size > MAX_ORIGINS) {
    originsByRequest.delete(originsByRequest.keys().next().value as string);
  }
  return origin;
}

/**
 * Classifies one terminal request (agent add or agent ctl) and remembers an
 * MCP origin under `reqId`. `times` are the moments the request was seen
 * (its own timestamp, the drain time); any of them inside a window counts.
 * Returns the origin, or null when it is not MCP-originated.
 */
export function classifyTerminalRequest(
  reqId: string,
  marker: McpIngressMarker | null | undefined,
  times: readonly number[],
): McpRequestOrigin | null {
  const known = originsByRequest.get(reqId);
  if (known) return known;
  if (marker) return remember(reqId, { principal: marker.principal, callId: marker.callId, via: 'marker' });
  for (const t of times) {
    const w = Number.isFinite(t) ? mcpWindowAt(t) : null;
    if (w) return remember(reqId, { principal: w.principal, callId: w.callId, via: 'window' });
  }
  return null;
}

/** Records a request found on disk while / right after an MCP command ran. */
export function noteRequestSeenInWindow(reqId: string, callId: string, principal: string): McpRequestOrigin {
  return remember(reqId, { principal: safeIngressValue(principal), callId: safeIngressValue(callId), via: 'window' });
}

export function mcpOriginForRequest(reqId: string | null | undefined): McpRequestOrigin | null {
  return reqId ? originsByRequest.get(reqId) ?? null : null;
}

/** Test hook. */
export function __resetMcpIngressOriginForTests(): void {
  windows.length = 0;
  originsByRequest.clear();
}
