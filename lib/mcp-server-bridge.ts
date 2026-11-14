/**
 * lib/mcp-server-bridge.ts — RN-side half of the MCP server's file-queue IPC.
 *
 * scripts/shelly-mcp-server.js runs as a separate Node process (spawned by
 * MCPBridge.kt) and can't reach RN's JS state directly, so it writes a
 * tool-call request file to $HOME/.shelly-mcp-queue/requests/<callId>.json
 * and polls for .../results/<callId>.json — the same file-queue IPC
 * pattern as lib/a2a-bridge.ts (see that file's header for the fuller
 * rationale; this is a near-duplicate poller, just dispatching to MCP
 * tools instead of A2A skills).
 *
 * The read-only tools are scoped to data the user already exposed through
 * Shelly's own UI (registered agents, Sidebar repo paths; terminal session
 * transcripts only with mcpReadTerminalEnabled). run_command / write_file
 * are gated by mcpExecEnabled, then by the agent gate as an untrusted
 * (tainted) request (lib/mcp-ingress-gate.ts: a deny — policy-write, the
 * strict agents-dir / shared_prefs form, CRITICAL, a POLICY-001 user deny
 * rule — is refused without asking), and then by an on-device approval tap
 * (requestApproval below) that a gate allow never skips. write_file is
 * checked on the real path (symlinks followed) before and after the tap.
 * Always decided HERE, never by the MCP peer; the node server also hides
 * the tools whose setting is off, but that is not relied on.
 *
 * Queue requests are authenticated (Inc 2): the server signs each one with
 * the per-start bridge key (lib/mcp-request-auth.ts); a file without a valid
 * MAC is dropped and logged, never run and never answered. Every verified
 * request is external (tainted) input; the approval modal says it came from
 * MCP, with the principal and the client's self-reported name. An approved
 * run_command runs with SHELLY_INGRESS* exported and inside a recorded window
 * (lib/mcp-ingress-origin.ts), so a `shelly agent add` it starts is marked.
 *
 * Protocol-era agnostic: this side only sees one request file per tool
 * call. Whether the peer is a legacy (initialize/session) client holding
 * one POST open, or a 2026-07-28 client that the server defers via MRTR
 * (InputRequiredResult + requestState retries), is handled entirely in
 * scripts/shelly-mcp-server.js — an MRTR retry re-attaches to the same
 * pending call and never writes a second request file, so the approval
 * modal can't be shown (or a command run) twice for one logical call.
 */

import * as FileSystem from 'expo-file-system/legacy';
import { useAgentStore } from '@/store/agent-store';
import { useSidebarStore } from '@/store/sidebar-store';
import { useSettingsStore } from '@/store/settings-store';
import { useTerminalStore } from '@/store/terminal-store';
import { useMcpApprovalStore } from '@/store/mcp-approval-store';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { execCommand } from '@/hooks/use-native-exec';
import { evaluateMcpCommand, gateCommandWithCwd, gateWriteCommand, resolveWriteTarget, shellQuote, type McpShellRunner } from '@/lib/mcp-ingress-gate';
import { getCachedUserPolicy, loadUserPolicy, type LoadedUserPolicy } from '@/lib/agent-user-policy-store';
import { logError, logInfo } from '@/lib/debug-logger';
import { verifyMcpRequest, type McpVerifiedRequest } from '@/lib/mcp-request-auth';
import { beginMcpExecWindow, endMcpExecWindow, mcpIngressEnvPrefix, noteRequestSeenInWindow } from '@/lib/mcp-ingress-origin';

const QUEUE_DIR = `${FileSystem.documentDirectory}home/.shelly-mcp-queue`;
const REQUESTS_DIR = `${QUEUE_DIR}/requests`;
const RESULTS_DIR = `${QUEUE_DIR}/results`;
const POLL_INTERVAL_MS = 500;

type McpIngress = McpVerifiedRequest['ingress'];

// The per-start bridge key (hooks/use-mcp-server-bridge.ts). null = the
// server is not running from this JS context: every request is refused.
let bridgeKey: string | null = null;

/** Set before each server start, cleared when it stops. Never logged. */
export function setMCPBridgeKey(key: string | null): void {
  bridgeKey = key;
}

const expoRequestSha256: Sha256 = async (data) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Crypto = require('expo-crypto');
  return new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, data));
};
let requestSha256: Sha256 = expoRequestSha256;

/** Test hook (Jest has no expo-crypto digest). */
export function __setMCPRequestSha256ForTests(fn: Sha256 | null): void {
  requestSha256 = fn ?? expoRequestSha256;
}

const EXEC_DISABLED_ERROR = 'exec/write tools are disabled (Settings → Agents → MCP: Allow exec/write)';

function execEnabled(): boolean {
  return useSettingsStore.getState().settings.mcpExecEnabled === true;
}

/** Bare (no file://) app home, the same form list_repos paths use. */
function homeDir(): string {
  return `${FileSystem.documentDirectory}home`.replace(/^file:\/\//, '');
}

const shellRunner: McpShellRunner = async (script) => {
  const r = await execCommand(script, 10_000);
  return { stdout: r.stdout, exitCode: r.exitCode };
};

/** POLICY-001 user rules for the gate. Loaded once (the app keeps the cache
 *  current when the rules change); a failed load means "rules unavailable",
 *  which escalates side effects but never refuses on its own. */
async function userPolicy(): Promise<LoadedUserPolicy | null> {
  const cached = getCachedUserPolicy();
  if (cached) return cached;
  try {
    return await loadUserPolicy(async (cmd) => (await execCommand(cmd, 10_000)).stdout);
  } catch {
    return null;
  }
}

type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

const APPROVAL_TIMEOUT_MS = 90_000;

/** Surfaces a McpApprovalModal request and waits for a tap or a timeout
 *  (auto-denied — fail closed, matching every other unattended-action gate
 *  in this codebase). See store/mcp-approval-store.ts for the queueing. */
function requestApproval(request: {
  kind: 'run_command' | 'write_file';
  summary: string;
  detail: string;
  riskLevel?: string;
  origin: McpIngress;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let settled = false;
    const settle = (approved: boolean) => {
      if (settled) return;
      settled = true;
      resolve(approved);
    };
    // On-device found 2026-09-17: a timeout used to only resolve this
    // promise, never touching the store — so the modal stayed stuck on
    // the timed-out request (still `current`) and every later call queued
    // silently behind it, invisible, each ticking down its own timer
    // instead of ever being shown. respond() here clears/advances the
    // store the same way a real tap would, so the queue can't back up.
    const timer = setTimeout(() => {
      settle(false);
      useMcpApprovalStore.getState().respond(id, false);
    }, APPROVAL_TIMEOUT_MS);
    useMcpApprovalStore.getState().enqueue({
      ...request,
      origin: { principal: request.origin.principal, clientNameSelfReported: request.origin.clientNameSelfReported },
      id,
      resolve: (approved) => {
        clearTimeout(timer);
        settle(approved);
      },
    });
  });
}

// Bumped by revokePendingMCPRequests() (MCP token regeneration). Every
// request captures the epoch it was read under; anything from an older
// epoch was accepted under a token that is no longer valid, so it must not
// run an approved exec/write or have its result written back.
let queueEpoch = 0;
const REVOKED_ERROR = 'cancelled: the MCP token was regenerated';

/**
 * Called while the regeneration lock is held, after the old server process
 * has exited and before the new one starts: deny/close every pending
 * approval (the modal closes), invalidate in-flight requests, and delete
 * the queue's request/result files so nothing accepted under the old token
 * is picked up later. The new server recreates both dirs on startup.
 */
export async function revokePendingMCPRequests(): Promise<void> {
  queueEpoch += 1;
  useMcpApprovalStore.getState().denyAll();
  await FileSystem.deleteAsync(REQUESTS_DIR, { idempotent: true });
  await FileSystem.deleteAsync(RESULTS_DIR, { idempotent: true });
  logInfo('MCPBridge', `revoked pending MCP requests (epoch=${queueEpoch})`);
}

const AGENT_REQUEST_FILE_RE = /^\.shelly-agent-(?:req|pending)-([0-9]{10,16}-[0-9a-f]{8})$/;

/** `shelly agent add` request ids currently in $HOME (req or pending). */
async function agentRequestIdsInHome(): Promise<Set<string> | null> {
  const names = await FileSystem.readDirectoryAsync(`${FileSystem.documentDirectory}home`).catch(() => null);
  if (!names) return null;
  const ids = new Set<string>();
  for (const n of names) {
    const m = AGENT_REQUEST_FILE_RE.exec(n);
    if (m) ids.add(m[1]);
  }
  return ids;
}

/**
 * Runs an approved MCP run_command with the ingress variables exported and
 * inside a recorded window: any `shelly agent add` request that appears in
 * $HOME while it runs is MCP-originated even if the command dropped the
 * variables (lib/mcp-ingress-origin.ts). Exported for tests.
 */
export async function runMcpCommand(
  full: string,
  timeoutMs: number,
  callId: string,
  ingress: McpIngress,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const before = await agentRequestIdsInHome();
  beginMcpExecWindow(callId, ingress.principal);
  try {
    return await execCommand(`${mcpIngressEnvPrefix(ingress.principal, callId)}${full}`, timeoutMs);
  } finally {
    const after = await agentRequestIdsInHome();
    if (after) {
      for (const reqId of after) {
        if (before && before.has(reqId)) continue;
        noteRequestSeenInWindow(reqId, callId, ingress.principal);
        logInfo('MCPBridge', `agent request ${reqId} appeared during MCP call ${callId}; marked as MCP-originated`);
      }
    }
    endMcpExecWindow(callId);
  }
}

async function callTool(
  tool: string,
  args: Record<string, unknown>,
  epoch: number,
  ingress: McpIngress,
  callId: string,
): Promise<ToolResult> {
  switch (tool) {
    case 'list_agents': {
      return { ok: true, data: agentSummaries() };
    }
    case 'list_repos': {
      return { ok: true, data: useSidebarStore.getState().repoPaths };
    }
    case 'read_terminal_output': {
      // Separate switch: the screen can show tokens or pasted secrets.
      if (useSettingsStore.getState().settings.mcpReadTerminalEnabled !== true) {
        return { ok: false, error: 'read_terminal_output is disabled (Settings → Agents → MCP: Allow reading terminal output)' };
      }
      // `sessions[].id` is the JS-logical id (`session-1`, `shelly-1-...`);
      // the native module keys transcripts by `nativeSessionId` instead
      // (`session-<timestamp>`) — passing the logical id straight through
      // throws "Session <native-id-from-some-other-session> not found" on
      // the native side. On-device found 2026-09-17 via a live MCP call.
      const { sessions, activeSessionId } = useTerminalStore.getState();
      const requestedId = typeof args.sessionId === 'string' && args.sessionId ? args.sessionId : activeSessionId;
      const session = sessions.find((s) => s.id === requestedId || s.nativeSessionId === requestedId);
      if (!session) {
        return { ok: false, error: `no such terminal session: ${requestedId}` };
      }
      const maxLines = typeof args.maxLines === 'number' ? args.maxLines : 200;
      try {
        const text = await TerminalEmulator.getTranscriptText(session.nativeSessionId, maxLines);
        return { ok: true, data: text };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    case 'git_status': {
      const targetPath = typeof args.path === 'string' ? args.path : '';
      const configured = useSidebarStore.getState().repoPaths;
      // Scoped to repos the user already added in the Sidebar — a remote
      // MCP client can't probe arbitrary filesystem paths through this
      // tool, only ones the user chose to expose through Shelly's own UI.
      if (!configured.includes(targetPath)) {
        return { ok: false, error: 'path is not a Shelly-configured repo (see list_repos)' };
      }
      try {
        const result = await execCommand(`cd ${shellQuote(targetPath)} && git status`, 10_000);
        if (result.exitCode !== 0) {
          return { ok: false, error: result.stderr || `git exited ${result.exitCode}` };
        }
        return { ok: true, data: result.stdout };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    case 'run_command': {
      if (!execEnabled()) {
        return { ok: false, error: EXEC_DISABLED_ERROR };
      }
      const command = typeof args.command === 'string' ? args.command : '';
      if (!command.trim()) {
        return { ok: false, error: 'command is required' };
      }
      const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : undefined;
      // Judge the command together with its `cd`, so a cwd of ~/.shelly/agents
      // counts (the home prefix is shown to the gate as GATE_HOME).
      const full = cwd ? `cd ${shellQuote(cwd)} && ${command}` : command;
      const gate = evaluateMcpCommand(gateCommandWithCwd(command, cwd, homeDir()), homeDir(), await userPolicy());
      if (epoch !== queueEpoch) return { ok: false, error: REVOKED_ERROR };
      if (gate.refused) {
        logInfo('MCPBridge', `run_command refused by the gate (${gate.summary})`);
        return { ok: false, error: `refused by Shelly's agent gate — ${gate.summary}` };
      }
      const approved = await requestApproval({
        kind: 'run_command',
        summary: `Run a command via MCP${cwd ? ` in ${cwd}` : ''}?`,
        detail: `${command}\n\nGate: ${gate.summary}`,
        riskLevel: gate.outcome?.verdict.dangerLevel,
        origin: ingress,
      });
      if (epoch !== queueEpoch) return { ok: false, error: REVOKED_ERROR };
      if (!approved) {
        return { ok: false, error: 'denied by user (or timed out waiting for a response)' };
      }
      // The setting may have been turned off while the modal was open.
      if (!execEnabled()) return { ok: false, error: EXEC_DISABLED_ERROR };
      try {
        const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 30_000;
        const result = await runMcpCommand(full, timeoutMs, callId, ingress);
        return { ok: true, data: { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode } };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    case 'write_file': {
      if (!execEnabled()) {
        return { ok: false, error: EXEC_DISABLED_ERROR };
      }
      const targetPath = typeof args.path === 'string' ? args.path : '';
      const content = typeof args.content === 'string' ? args.content : '';
      // repoPaths (from list_repos) are bare filesystem paths, never
      // file:// URIs — compare against the home dir with the scheme
      // stripped so the two match on the same footing.
      const home = homeDir();
      const allowedRoots = [home, ...useSidebarStore.getState().repoPaths];
      const resolved = await resolveWriteTarget(targetPath, allowedRoots, shellRunner);
      if (epoch !== queueEpoch) return { ok: false, error: REVOKED_ERROR };
      if ('error' in resolved) {
        logInfo('MCPBridge', `write_file refused (${resolved.error})`);
        return { ok: false, error: resolved.error };
      }
      const realPath = resolved.realPath;
      // Judged as the gate judges a worker's `tee -- <path>`, on both the
      // path as sent and where it really lands.
      const policy = await userPolicy();
      const gates = [evaluateMcpCommand(gateWriteCommand(realPath, home), home, policy)];
      if (realPath !== targetPath) gates.push(evaluateMcpCommand(gateWriteCommand(targetPath, home), home, policy));
      const denied = gates.find((g) => g.refused);
      if (epoch !== queueEpoch) return { ok: false, error: REVOKED_ERROR };
      if (denied) {
        logInfo('MCPBridge', `write_file refused by the gate (${denied.summary})`);
        return { ok: false, error: `refused by Shelly's agent gate — ${denied.summary}` };
      }
      const preview = content.length > 400 ? `${content.slice(0, 400)}\n… (${content.length} bytes total)` : content;
      const shownPath = realPath === targetPath ? realPath : `${targetPath}\n→ ${realPath}`;
      const approved = await requestApproval({
        kind: 'write_file',
        summary: `Write ${content.length} bytes to a file via MCP?`,
        detail: `${shownPath}\n\nGate: ${gates[0].summary}\n\n${preview}`,
        origin: ingress,
      });
      if (epoch !== queueEpoch) return { ok: false, error: REVOKED_ERROR };
      if (!approved) {
        return { ok: false, error: 'denied by user (or timed out waiting for a response)' };
      }
      if (!execEnabled()) return { ok: false, error: EXEC_DISABLED_ERROR };
      // A symlink swapped in while the modal was open must not redirect the
      // approved write: resolve again and require the same real path.
      const again = await resolveWriteTarget(targetPath, allowedRoots, shellRunner);
      if (epoch !== queueEpoch) return { ok: false, error: REVOKED_ERROR };
      if (!again.ok || again.realPath !== realPath) {
        return { ok: false, error: `refused: the target changed while waiting for approval${'error' in again ? ` (${again.error})` : ''}` };
      }
      try {
        // On-device found 2026-09-17: writeAsStringAsync needs a file://
        // URI — a bare path (what every MCP client naturally sends, and
        // what list_repos/git_status use elsewhere) throws "isn't writable".
        await FileSystem.writeAsStringAsync(`file://${realPath}`, content);
        return { ok: true, data: { path: realPath, bytes: content.length } };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    default:
      return { ok: false, error: `unknown tool: ${tool}` };
  }
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;

// Files currently being processed — see the note in drainOnce below for why
// this exists. Cleared as soon as a file's own processing settles.
const inFlightRequestFiles = new Set<string>();

async function processRequestFile(name: string): Promise<void> {
  const requestUri = `${REQUESTS_DIR}/${name}`;
  const epoch = queueEpoch;
  try {
    const raw = await FileSystem.readAsStringAsync(requestUri);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    // Only requests the server signed with this start's bridge key are MCP
    // calls; anything else in the queue dir (any same-uid process can write
    // there) is dropped without an answer. Taint is never read from the file:
    // every verified request is external input.
    const check = await verifyMcpRequest(parsed, bridgeKey, requestSha256);
    if ('reason' in check) {
      logError('MCPBridge', `rejected unauthenticated request file ${name} (${check.reason})`);
      return;
    }
    const request = check.request;
    if (epoch !== queueEpoch) return;
    const result = await callTool(request.tool, request.args, epoch, request.ingress, request.callId);
    if (epoch !== queueEpoch) {
      logInfo('MCPBridge', `dropped call ${request.callId} (token regenerated while it was pending)`);
      return;
    }
    const resultUri = `${RESULTS_DIR}/${request.callId}.json`;
    await FileSystem.writeAsStringAsync(resultUri, JSON.stringify(result));
    logInfo('MCPBridge', `answered call ${request.callId} (tool=${request.tool}, ok=${result.ok}, principal=${request.ingress.principal.slice(0, 8)})`);
  } catch (e) {
    logError('MCPBridge', `failed to process request file ${name}`, e);
  } finally {
    await FileSystem.deleteAsync(requestUri, { idempotent: true });
    inFlightRequestFiles.delete(name);
  }
}

async function drainOnce(): Promise<void> {
  const names = await FileSystem.readDirectoryAsync(REQUESTS_DIR).catch(() => null);
  if (!names || names.length === 0) return;

  await FileSystem.makeDirectoryAsync(RESULTS_DIR, { intermediates: true }).catch(() => {});

  // On-device found 2026-09-17: this used to `await callTool(...)` for each
  // file in a plain for-loop, so a single run_command/write_file call
  // sitting in its up-to-90s approval wait blocked the ENTIRE poll tick —
  // including read-only tools like list_repos that arrived afterward and
  // should have answered in milliseconds. Fire each file off without
  // awaiting it here so drainOnce (and the pollLoop tick that calls it)
  // stays fast; inFlightRequestFiles just stops a still-processing file
  // from being picked up again by the next tick before it's done.
  for (const name of names) {
    if (!name.endsWith('.json') || inFlightRequestFiles.has(name)) continue;
    inFlightRequestFiles.add(name);
    void processRequestFile(name);
  }
}

async function pollLoop(): Promise<void> {
  if (stopped) return;
  try {
    await drainOnce();
  } catch (e) {
    logError('MCPBridge', 'poll iteration failed', e);
  }
  if (!stopped) {
    pollTimer = setTimeout(pollLoop, POLL_INTERVAL_MS);
  }
}

export function startMCPPoller(): void {
  if (!stopped) return;
  stopped = false;
  void pollLoop();
}

export function stopMCPPoller(): void {
  stopped = true;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

// ── Snapshot for direct reads ────────────────────────────────────────────
//
// RN pauses JS timers while Shelly is in the background, so the poller
// above stops and queued tool calls hang. scripts/shelly-mcp-server.js
// answers list_agents / list_repos / git_status itself from this snapshot
// (see createDirectReadCallTool there). Store subscriptions fire on state
// changes without timers, so the file stays current. The HMAC key derives
// from the bearer token; the server ignores a snapshot it can't verify.

const SNAPSHOT_URI = `${QUEUE_DIR}/snapshot.json`;

export type McpSnapshotAgent = {
  id: string;
  name: string;
  enabled: boolean;
  schedule: unknown;
  autonomous: unknown;
};

export function agentSummaries(): McpSnapshotAgent[] {
  return useAgentStore.getState().agents.map((a) => ({
    id: a.id,
    name: a.name,
    enabled: a.enabled,
    schedule: a.schedule ?? null,
    autonomous: a.autonomous,
  }));
}

export function buildSnapshotBody(agents: McpSnapshotAgent[], repoPaths: string[]): string {
  return JSON.stringify({ v: 1, agents, repoPaths });
}

type Sha256 = (data: Uint8Array) => Promise<Uint8Array>;

const expoSha256: Sha256 = async (data) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Crypto = require('expo-crypto');
  return new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, data));
};

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** HMAC-SHA256 (RFC 2104) with key = SHA256("shelly-mcp-snapshot:" + token).
 *  Must match snapshotMac() in scripts/shelly-mcp-server.js. */
export async function signSnapshot(token: string, body: string, sha256: Sha256 = expoSha256): Promise<string> {
  const key = new Uint8Array(64);
  key.set(await sha256(utf8(`shelly-mcp-snapshot:${token}`)));
  const ipad = key.map((b) => b ^ 0x36);
  const opad = key.map((b) => b ^ 0x5c);
  const inner = await sha256(concat(ipad, utf8(body)));
  const mac = await sha256(concat(opad, inner));
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}

let snapshotToken: string | null = null;
let lastSnapshotBody = '';
let snapshotUnsubs: (() => void)[] = [];
let snapshotWrite: Promise<void> = Promise.resolve();

function publishSnapshot(): void {
  const token = snapshotToken;
  if (!token) return;
  const body = buildSnapshotBody(agentSummaries(), useSidebarStore.getState().repoPaths);
  if (body === lastSnapshotBody) return;
  lastSnapshotBody = body;
  snapshotWrite = snapshotWrite
    .then(async () => {
      if (snapshotToken !== token) return;
      const file = JSON.stringify({ body, mac: await signSnapshot(token, body) });
      await FileSystem.makeDirectoryAsync(QUEUE_DIR, { intermediates: true }).catch(() => {});
      const tmp = `${SNAPSHOT_URI}.tmp`;
      await FileSystem.writeAsStringAsync(tmp, file);
      await FileSystem.deleteAsync(SNAPSHOT_URI, { idempotent: true });
      await FileSystem.moveAsync({ from: tmp, to: SNAPSHOT_URI });
    })
    .catch(async (e) => {
      lastSnapshotBody = '';
      // Never leave an older, validly signed snapshot behind a failed write.
      await FileSystem.deleteAsync(SNAPSHOT_URI, { idempotent: true }).catch(() => {});
      logError('MCPBridge', 'snapshot write failed', e);
    });
}

export function startMCPSnapshotPublisher(token: string): void {
  stopMCPSnapshotPublisher({ keepFile: true });
  snapshotToken = token;
  lastSnapshotBody = '';
  publishSnapshot();
  snapshotUnsubs = [
    useAgentStore.subscribe(() => publishSnapshot()),
    useSidebarStore.subscribe(() => publishSnapshot()),
  ];
}

export function stopMCPSnapshotPublisher(opts: { keepFile?: boolean } = {}): void {
  for (const unsub of snapshotUnsubs) unsub();
  snapshotUnsubs = [];
  snapshotToken = null;
  lastSnapshotBody = '';
  if (!opts.keepFile) {
    snapshotWrite = snapshotWrite.then(() => FileSystem.deleteAsync(SNAPSHOT_URI, { idempotent: true })).catch(() => {});
  }
}
