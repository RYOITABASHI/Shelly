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
 * transcripts only with mcpReadTerminalEnabled), non-identifying device
 * status (device_status), and — only with mcpDiagnosticsEnabled — Shelly's
 * own redacted log lines (read_logs) and its settings with every
 * secret-named setting withheld (get_settings). Nothing here writes a
 * setting: MCP has no settings-write tool. run_command / write_file
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
import { getDebugLogEntries } from '@/lib/debug-log-buffer';
import { redactSecretsText } from '@/lib/redact-secrets';
import { verifyMcpRequest, type McpVerifiedRequest } from '@/lib/mcp-request-auth';
import { beginMcpExecWindow, endMcpExecWindow, MCP_SHELLY_LAZY_FN, mcpIngressEnvPrefix, noteRequestSeenInWindow } from '@/lib/mcp-ingress-origin';

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

const DIAGNOSTICS_DISABLED_ERROR = 'is disabled (Settings → Agents → MCP: Allow diagnostics)';

function diagnosticsEnabled(): boolean {
  return useSettingsStore.getState().settings.mcpDiagnosticsEnabled === true;
}

// ── Redaction for diagnostics output ─────────────────────────────────────
//
// redactSecretsText (lib/redact-secrets.ts) only knows a list of key
// formats. Text leaving the device over MCP gets these extra, shape-based
// passes too (Codex review, 2026-11-15): credentials in URLs, Bearer /
// Basic headers, secret-named key=value / key: value / JSON fields, and
// Telegram bot tokens. Over-redacting a log line is the safe direction.
// `pass[-_.]?w` also catches pass-word / pass_word / pass.word (2026-11-15
// Codex review); `pwd` and `passphrase` are listed on their own.
const SECRET_NAME = '[A-Za-z0-9_.-]*(?:token|key|secret|pass[-_.]?w|pwd|passphrase|credential|auth|cookie|bearer|session|signature)[A-Za-z0-9_.-]*';
const MCP_EXTRA_REDACTIONS: Array<[RegExp, string]> = [
  // scheme://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1<redacted>@'],
  // "secretName": "value"
  [new RegExp(`("${SECRET_NAME}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'gi'), '$1"<redacted>"'],
  // Authorization: Bearer xxx / Basic xxx
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 <redacted>'],
  // Cookie: / Set-Cookie: — the whole header value to end of line (every
  // pair after the first `;` too). Runs before the key=value pass so that
  // pass sees `<redacted>` and leaves it.
  [/\b((?:Set-)?Cookie[ \t]*:[ \t]*)(?!<redacted)[^\r\n]*/gi, '$1<redacted>'],
  // secretName=value (query strings, env lines) and secretName: value
  // (headers). The value is a single- or double-quoted string (an
  // unterminated quote runs to end of line) or a bare run of characters.
  // The lookahead skips only a quoted value that is exactly a redaction
  // marker (an earlier pass's whole output, e.g. the JSON pass above) —
  // a value that merely STARTS with a marker (a known-format key that
  // redactSecretsText replaced, with more secret text after it) is still
  // consumed whole (Codex re-review, 2026-11-15).
  [new RegExp(`\\b(${SECRET_NAME})(\\s*[=:]\\s*)(?!['"]<redacted(?::[^'">]*)?>['"])(?:'[^'\\r\\n]*'?|"(?:[^"\\\\\\r\\n]|\\\\.)*"?|[^\\s&"',;#)]+)`, 'gi'), '$1$2<redacted>'],
  // Telegram bot token (123456789:AA…), including inside a URL path
  // (…/bot123456789:AA…/…): there the digits follow a letter, so a leading
  // \b would never match — anchor on the start or a non-digit instead.
  [/(^|[^\d])\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, '$1<redacted:bot token>'],
];

/** redactSecretsText plus the shape-based passes above. Exported for tests. */
export function redactForMcp(text: string): string {
  let out = redactSecretsText(text);
  for (const [re, replacement] of MCP_EXTRA_REDACTIONS) out = out.replace(re, replacement);
  return out;
}

// ── read_logs ────────────────────────────────────────────────────────────

export const READ_LOGS_DEFAULT_LIMIT = 200;
export const READ_LOGS_MAX_LIMIT = 1000;
export const READ_LOGS_DEFAULT_BYTES = 32 * 1024;
/** Hard cap on the text read_logs returns, whatever the caller asks for. */
export const READ_LOGS_MAX_BYTES = 64 * 1024;
const LOGCAT_TIMEOUT_MS = 10_000;
// logcat holds whatever any code in the process printed, so only these
// Shelly tags are read (`-s` silences every other tag), and ReactNativeJS
// only for lines debug-logger wrote (`[Shelly][`). Every line is redacted
// again here. AndroidRuntime is limited to errors (this process's crashes).
export const LOGCAT_TAGS = [
  'ReactNativeJS:V',
  'AndroidRuntime:E',
  'MCPBridge:V',
  'HomeInitializer:V',
  'LibExtractor:V',
  'ShellyExec:V',
  'ShellyPTY:V',
  'TerminalEmulator:V',
  'TerminalSessionService:V',
  'AgentRuntime:V',
  'DeviceStatusBridge:V',
  'AppInfoSnapshot:V',
];

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Newest `limit` lines, then oldest lines dropped until the joined text fits
 * in `maxBytes` (a single line longer than that is cut). Exported for tests.
 */
export function capLogLines(lines: string[], limit: number, maxBytes: number): { text: string; returned: number; truncated: boolean } {
  let picked = lines.slice(-limit);
  let truncated = picked.length < lines.length;
  let size = 0;
  const kept: string[] = [];
  for (let i = picked.length - 1; i >= 0; i--) {
    const add = utf8Length(picked[i]) + (kept.length ? 1 : 0);
    if (size + add > maxBytes) {
      truncated = true;
      if (kept.length === 0) {
        // Cut the newest line itself (by characters, then re-check bytes).
        let cut = picked[i].slice(0, maxBytes);
        while (utf8Length(cut) > maxBytes) cut = cut.slice(0, -1);
        kept.unshift(cut);
      }
      break;
    }
    size += add;
    kept.unshift(picked[i]);
  }
  picked = kept;
  return { text: picked.join('\n'), returned: picked.length, truncated };
}

/** Keeps the Shelly lines of `logcat -v threadtime` output, redacted. Exported for tests. */
export function filterLogcatLines(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('--------- beginning of')) continue;
    // threadtime: "MM-DD HH:MM:SS.mmm  PID  TID L TAG     : message"
    const m = /^\S+\s+\S+\s+\d+\s+\d+\s+[VDIWEF]\s+(.+?)\s*:\s(.*)$/.exec(line);
    if (!m) continue;
    const tag = m[1];
    if (tag === 'ReactNativeJS' && !m[2].startsWith('[Shelly][') && !m[2].startsWith("'[Shelly][")) continue;
    if (!LOGCAT_TAGS.some((t) => t.slice(0, t.indexOf(':')) === tag)) continue;
    out.push(redactForMcp(line));
  }
  return out;
}

async function readLogs(args: Record<string, unknown>): Promise<ToolResult> {
  const source = args.source === undefined ? 'app' : args.source;
  if (source !== 'app' && source !== 'logcat') return { ok: false, error: 'source must be "app" or "logcat"' };
  const limit = clampInt(args.limit, READ_LOGS_DEFAULT_LIMIT, 1, READ_LOGS_MAX_LIMIT);
  const maxBytes = clampInt(args.maxBytes, READ_LOGS_DEFAULT_BYTES, 256, READ_LOGS_MAX_BYTES);
  let lines: string[];
  if (source === 'app') {
    // Already redacted when logged (lib/debug-logger.ts); redacted again in
    // case a pattern was added since.
    lines = getDebugLogEntries().map((e) => redactForMcp(`${new Date(e.ts).toISOString()} ${e.level.toUpperCase()} ${e.line}`));
  } else {
    // Own-process logcat: an app may read its own uid's log without
    // READ_LOGS. Fetch more than `limit` because the tag filter drops lines.
    try {
      const r = await execCommand(`logcat -d -v threadtime -t ${Math.min(limit * 4, 4000)} -s ${LOGCAT_TAGS.join(' ')}`, LOGCAT_TIMEOUT_MS);
      if (r.exitCode !== 0) {
        return { ok: false, error: `logcat is not readable from the app (exit ${r.exitCode}): ${redactForMcp((r.stderr || '').slice(0, 300))}` };
      }
      lines = filterLogcatLines(r.stdout);
    } catch (e) {
      return { ok: false, error: `logcat is not readable from the app: ${redactForMcp(e instanceof Error ? e.message : String(e))}` };
    }
  }
  const capped = capLogLines(lines, limit, maxBytes);
  return { ok: true, data: { source, lines: capped.returned, truncated: capped.truncated, text: capped.text } };
}

// ── get_settings ─────────────────────────────────────────────────────────

/** Setting names whose values are never returned (case-insensitive substring).
 *  A superset of token|key|secret|password|credential, including the
 *  pass-word / pass_word / pwd / passphrase spellings: over-withholding a
 *  harmless setting is the safe direction. */
export const SETTINGS_DENYLIST_RE = /token|key|secret|pass[\s_.-]*w|pwd|passphrase|credential|auth|cookie|bearer/i;
const SETTINGS_MAX_DEPTH = 8;

/**
 * Settings with every secret-named key withheld, at any depth (a nested
 * object such as a per-provider config is filtered the same way). String
 * values are also passed through redactForMcp (URL credentials, secret-named
 * query parameters, key formats). Exported for tests.
 */
export function redactSettingsForMcp(settings: unknown): { settings: Record<string, unknown>; withheldKeys: string[] } {
  const withheld: string[] = [];
  const walk = (value: unknown, pathPrefix: string, depth: number): unknown => {
    if (typeof value === 'string') return redactForMcp(value);
    if (value === null || typeof value !== 'object') {
      return typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' ? undefined : value;
    }
    if (depth >= SETTINGS_MAX_DEPTH) return '[omitted: too deep]';
    if (Array.isArray(value)) return value.map((v, i) => walk(v, `${pathPrefix}[${i}]`, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const keyPath = pathPrefix ? `${pathPrefix}.${k}` : k;
      if (SETTINGS_DENYLIST_RE.test(k)) {
        withheld.push(keyPath);
        continue;
      }
      const w = walk(v, keyPath, depth + 1);
      if (w !== undefined) out[k] = w;
    }
    return out;
  };
  const result = walk(settings, '', 0);
  return { settings: result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : {}, withheldKeys: withheld.sort() };
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
    return await execCommand(`${mcpIngressEnvPrefix(ingress.principal, callId)}${MCP_SHELLY_LAZY_FN}${full}`, timeoutMs);
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
    case 'device_status': {
      // Reached only when the server had no verified snapshot (it answers
      // from the snapshot otherwise): capture a fresh reading right now.
      const device = await captureDeviceSection();
      if (!device) return { ok: false, error: 'device status is not available from this build of Shelly' };
      return { ok: true, data: { ...device, ageMs: 0, stale: false } };
    }
    case 'read_logs': {
      if (!diagnosticsEnabled()) return { ok: false, error: `read_logs ${DIAGNOSTICS_DISABLED_ERROR}` };
      return readLogs(args);
    }
    case 'get_settings': {
      if (!diagnosticsEnabled()) return { ok: false, error: `get_settings ${DIAGNOSTICS_DISABLED_ERROR}` };
      return { ok: true, data: redactSettingsForMcp(useSettingsStore.getState().settings) };
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
    // every verified request is external input. The file name is part of
    // the check: a signed body copied under another name is a replay.
    const check = await verifyMcpRequest(parsed, bridgeKey, requestSha256, { fileName: name });
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
// answers list_agents / list_repos / git_status / device_status itself from
// this snapshot (see createDirectReadCallTool there). Store subscriptions
// fire on state changes without timers, so the file stays current. The HMAC
// key derives from the bearer token; the server ignores a snapshot it can't
// verify.
//
// The `device` section is the one part that is not store state: it is read
// from native Android APIs (TerminalEmulator.getDeviceStatus →
// DeviceStatusBridge.mcpDeviceStatus) by refreshMCPDeviceSnapshot(), which
// runs when the publisher starts, and — wired in
// hooks/use-mcp-server-bridge.ts — on every AppState change to active or
// background and every DEVICE_REFRESH_MS while Shelly is open. In the
// background nothing refreshes it (JS is paused), so the reading taken as
// Shelly left the screen is what the server serves, with its capturedAt,
// ageMs and stale (> DEVICE_STALE_AFTER_MS) made explicit.

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

export function buildSnapshotBody(agents: McpSnapshotAgent[], repoPaths: string[], device?: McpDeviceSection | null): string {
  return JSON.stringify(device ? { v: 1, agents, repoPaths, device } : { v: 1, agents, repoPaths });
}

/** Must match DEVICE_STALE_AFTER_MS in scripts/shelly-mcp-server.js. */
export const DEVICE_STALE_AFTER_MS = 15 * 60_000;
/** Foreground refresh period for the snapshot's device section. */
export const DEVICE_REFRESH_MS = 5 * 60_000;
const DEVICE_SECTIONS = ['battery', 'thermal', 'memory', 'storage', 'app', 'uptime'] as const;
const DEVICE_SECTION_MAX_CHARS = 4096;

export type McpDeviceSection = {
  capturedAt: string;
} & Partial<Record<(typeof DEVICE_SECTIONS)[number], Record<string, unknown> | null>>;

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Shapes the native reading into the snapshot's device section: a
 * capturedAt plus each known section as an object or null (unknown keys
 * dropped). null when the reading is unusable. Exported for tests.
 */
export function deviceSectionFromNative(raw: unknown): McpDeviceSection | null {
  if (!isPlainRecord(raw)) return null;
  const capturedAtMs = typeof raw.capturedAtMs === 'number' && Number.isFinite(raw.capturedAtMs) ? raw.capturedAtMs : NaN;
  if (!Number.isFinite(capturedAtMs)) return null;
  const out: McpDeviceSection = { capturedAt: new Date(capturedAtMs).toISOString() };
  for (const key of DEVICE_SECTIONS) {
    const v = raw[key];
    if (isPlainRecord(v) && JSON.stringify(v).length <= DEVICE_SECTION_MAX_CHARS) out[key] = v;
    else out[key] = null;
  }
  return out;
}

async function captureDeviceSection(): Promise<McpDeviceSection | null> {
  // Optional: an older native build lacks it.
  if (!TerminalEmulator || typeof TerminalEmulator.getDeviceStatus !== 'function') return null;
  try {
    return deviceSectionFromNative(await TerminalEmulator.getDeviceStatus());
  } catch (e) {
    logError('MCPBridge', 'device status capture failed', e);
    return null;
  }
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

let snapshotSha256: Sha256 = expoSha256;

/** Test hook (Jest has no expo-crypto digest). */
export function __setMCPSnapshotSha256ForTests(fn: Sha256 | null): void {
  snapshotSha256 = fn ?? expoSha256;
}

let snapshotToken: string | null = null;
let lastSnapshotBody = '';
// Last good device reading; kept across publisher restarts (it is not
// token-bound) so a token regeneration doesn't blank it.
let lastDevice: McpDeviceSection | null = null;
let snapshotUnsubs: (() => void)[] = [];
let snapshotWrite: Promise<void> = Promise.resolve();

function publishSnapshot(): void {
  const token = snapshotToken;
  if (!token) return;
  const body = buildSnapshotBody(agentSummaries(), useSidebarStore.getState().repoPaths, lastDevice);
  if (body === lastSnapshotBody) return;
  lastSnapshotBody = body;
  snapshotWrite = snapshotWrite
    .then(async () => {
      if (snapshotToken !== token) return;
      const file = JSON.stringify({ body, mac: await signSnapshot(token, body, snapshotSha256) });
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

/**
 * Re-reads the device section and republishes the snapshot. A failed read
 * keeps the previous reading (its capturedAt shows its age). No-op while the
 * publisher is stopped.
 */
export async function refreshMCPDeviceSnapshot(): Promise<void> {
  if (!snapshotToken) return;
  const device = await captureDeviceSection();
  if (!snapshotToken) return;
  if (device) lastDevice = device;
  publishSnapshot();
}

export function startMCPSnapshotPublisher(token: string): void {
  stopMCPSnapshotPublisher({ keepFile: true });
  snapshotToken = token;
  lastSnapshotBody = '';
  publishSnapshot();
  void refreshMCPDeviceSnapshot();
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
