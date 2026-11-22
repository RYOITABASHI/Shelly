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
 *
 * Typed operations (run_agent / get_run_result, mcpTypedOpsEnabled): see
 * runAgentTool below for the deny order (plan "typed MCP operations",
 * section (b)) and lib/mcp-typed-ops.ts for the pure parts. A run_agent
 * always-allow rule is written only after the explicit action-consent tap.
 * New rules bind both the definition and RN-evaluated sealed policy snapshot;
 * native verifies them again at acceptance and start. Legacy rules remain
 * dialog-only. See docs/mcp-agent-action-consent.md.
 * This is the foreground path: it still needs RN to drain the queue.
 * run_command / write_file arrive here only by the native McpRawToolConsumer's
 * handoff (with a single-use token) while "MCP: Run without approval" is off;
 * with it on, native runs them headless after the same gate (lib/mcp-raw-gate.ts).
 */

import * as FileSystem from 'expo-file-system/legacy';
import { useAgentStore } from '@/store/agent-store';
import { useSidebarStore } from '@/store/sidebar-store';
import { useSettingsStore } from '@/store/settings-store';
import { useTerminalStore } from '@/store/terminal-store';
import { useMcpApprovalStore, type McpApprovalDecision, type McpApprovalRequest } from '@/store/mcp-approval-store';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { execCommand } from '@/hooks/use-native-exec';
import { evaluateMcpCommand, gateCommandWithCwd, gateWriteCommand, resolveWriteTarget, shellQuote, type McpShellRunner } from '@/lib/mcp-ingress-gate';
import { getCachedUserPolicy, getCachedUserPolicyPin, loadUserPolicy, type LoadedUserPolicy } from '@/lib/agent-user-policy-store';
import { t } from '@/lib/i18n';
import { logError, logInfo } from '@/lib/debug-logger';
import { getDebugLogEntries } from '@/lib/debug-log-buffer';
import { redactSecretsText } from '@/lib/redact-secrets';
import { recordMcpHandoffConsumed, verifyMcpHandoffToken, verifyMcpRequest, type McpVerifiedRequest } from '@/lib/mcp-request-auth';
import {
  addMcpAlwaysAllowRule,
  findAlwaysAllowMatch,
  listMcpAlwaysAllowRules,
  mcpAlwaysAllowMatches,
  normalizeTarget,
  purgeMcpAlwaysAllowRulesExcept,
} from '@/lib/mcp-always-allow';
import {
  agentBindingHash,
  buildRunResultResponse,
  classifyRunAgentDeny,
  declaredActions,
  findIdempotentTicket,
  isTerminalRunState,
  liveRunCount,
  MAX_LIVE_RUNS_PER_PRINCIPAL,
  parseRunTicket,
  parseRunTicketList,
  RUN_OUTPUT_MAX_BYTES,
  RUN_RESULT_POLL_MS,
  TYPED_OPS_DISABLED_MESSAGE,
  TYPED_REQUEST_DEADLINE_MS,
  validateGetRunResultArgs,
  validateRunAgentArgs,
  type McpRunTicket,
  type TypedOpErrorCode,
  type TypedOpRefusal,
} from '@/lib/mcp-typed-ops';
import type { Agent } from '@/store/types';
import { beginMcpExecWindow, endMcpExecWindow, MCP_SHELLY_LAZY_FN, mcpIngressEnvPrefix, noteRequestSeenInWindow } from '@/lib/mcp-ingress-origin';
import { turnOffMcpSkipApproval } from '@/lib/mcp-skip-approval';
import { isApproveAllWithoutAskingOn, turnOffApproveAll } from '@/lib/approve-all-without-asking';

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

/**
 * run_command / write_file reach RN only by the native McpRawToolConsumer's
 * handoff, which it makes only while the native "MCP: Run without approval"
 * switch is OFF (with it ON, native runs the call itself, headless, after the
 * same gate). So here the tap is always asked: the mcpSkipApproval setting is
 * only a mirror of that native switch (lib/mcp-skip-approval.ts) and is not
 * read here.
 */
async function approveRawTool(
  request: Omit<ApprovalRequestInput, 'alwaysAllowable'>,
  _callId: string,
): Promise<McpApprovalDecision> {
  return requestApproval(request);
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

// ── read_agent_audit / read_article_history (queue fallback) ─────────────
//
// The MCP server answers these itself from a verified snapshot
// (scripts/shelly-mcp-server.js readAgentAudit / readArticleHistory); this is
// the fallback when it has none. Same caps, validation and answer shape —
// the constants must match the server's.

export const AUDIT_TAIL_READ_BYTES = 256 * 1024;
export const AUDIT_DEFAULT_LIMIT = 50;
export const AUDIT_MAX_LIMIT = 500;
export const AUDIT_DEFAULT_BYTES = 32 * 1024;
const AUDIT_MIN_BYTES = 256;
export const AUDIT_MAX_BYTES = 64 * 1024;
export const ARTICLE_HISTORY_READ_MAX_BYTES = 64 * 1024;
const AUDIT_AGENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ARTICLE_HISTORY_STREAM_RE = /^[a-z0-9-]{1,40}$/;
const AGENT_LOGS_PARTS = ['.shelly', 'agents', 'logs'];
const AGENT_LOG_READ_TIMEOUT_MS = 10_000;
// Must match scripts/shelly-mcp-server.js (see projectAuditLine there).
const ARTICLE_HISTORY_MAX_ENTRIES = 30;
const ARTICLE_HISTORY_TITLE_MAX_CHARS = 160;
const ARTICLE_HISTORY_URL_MAX_CHARS = 500;
export const AUDIT_STRING_KEYS: ReadonlySet<string> = new Set(['ts', 'kind', 'event', 'agentId', 'status', 'actionType', 'toolType', 'target', 'code', 'effect', 'origin', 'phase', 'engine', 'folder', 'file', 'verified', 'swallowed', 'round', 'stepIndex', 'durationMs']);
export const AUDIT_SCALAR_KEYS: ReadonlySet<string> = new Set(['stepIndex', 'durationMs', 'round', 'bytes', 'schemaVersion', 'exitCode', 'attempt', 'attempts', 'count', 'recorded', 'swallowed', 'draftPresent', 'unattended', 'halted', 'ok', 'lines', 'restarts', 'stepsRun', 'score', 'minScore', 'overall']);
const HISTORY_URL_CHARS_RE = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
const HISTORY_URL_HOST_RE = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;
const AUDIT_REASON_CODE_RE = /^[a-z0-9_-]{1,40}$/;
const AUDIT_STRING_MAX_CHARS = 200;
const AUDIT_PROBLEMS_MAX = 20;

function isPlainJsonObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Redacted, then cut to `max` code points (never a secret cut in half first). */
function cleanAuditString(v: string, max: number): string {
  const cps = Array.from(redactForMcp(v));
  return cps.length <= max ? cps.join('') : cps.slice(0, max).join('');
}

/**
 * One audit JSONL line projected to explicit allowlists: numbers and booleans
 * only under AUDIT_SCALAR_KEYS / AUDIT_STRING_KEYS; strings only under
 * AUDIT_STRING_KEYS (capped, redacted); `reason` only when it is a code;
 * `problems` only as an array of strings. Every other key is dropped and only
 * counted (`omittedCount`), never named. Unparseable or non-object lines
 * become { unparsed: true }. Pure; must match the server's. Exported for tests.
 */
export function projectAuditLine(line: string): Record<string, unknown> {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return { unparsed: true };
  }
  if (!isPlainJsonObject(obj)) return { unparsed: true };
  const out: Record<string, unknown> = {};
  let omittedCount = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') && (AUDIT_SCALAR_KEYS.has(k) || AUDIT_STRING_KEYS.has(k))) {
      out[k] = v;
    } else if (typeof v === 'string' && AUDIT_STRING_KEYS.has(k)) {
      out[k] = cleanAuditString(v, AUDIT_STRING_MAX_CHARS);
    } else if (k === 'reason' && typeof v === 'string' && AUDIT_REASON_CODE_RE.test(v)) {
      out[k] = v;
    } else if (k === 'problems' && Array.isArray(v) && v.every((p) => typeof p === 'string')) {
      out[k] = (v as string[]).slice(0, AUDIT_PROBLEMS_MAX).map((p) => cleanAuditString(p, AUDIT_STRING_MAX_CHARS));
    } else {
      omittedCount += 1;
    }
  }
  if (omittedCount) out.omittedCount = omittedCount;
  return out;
}

/**
 * scheme://host[:port]/path of an http(s) URL — no userinfo (everything up to
 * the last `@` of the authority is dropped), query or fragment — redacted, or
 * ''. Any character outside printable ASCII URL characters gives ''. Pure;
 * must match the server's. Exported for tests.
 */
export function articleHistoryUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > ARTICLE_HISTORY_URL_MAX_CHARS || !HISTORY_URL_CHARS_RE.test(raw)) return '';
  const m = /^(https?):\/\/([^/?#]*)([^?#]*)/i.exec(raw);
  if (!m) return '';
  const host = m[2].slice(m[2].lastIndexOf('@') + 1);
  if (!HISTORY_URL_HOST_RE.test(host)) return '';
  return redactForMcp(`${m[1].toLowerCase()}://${host}${m[3]}`);
}

export type ProjectedArticleHistory = { version: number | null; entries: { title: string; url: string; date: string }[] };

/**
 * The executor's article history ({version, entries:[{title, url, date}]}),
 * projected to exactly those fields; null when the shape is not that. Pure;
 * must match the server's. Exported for tests.
 */
export function projectArticleHistory(parsed: unknown): ProjectedArticleHistory | null {
  if (!isPlainJsonObject(parsed) || !Array.isArray(parsed.entries)) return null;
  const entries = (parsed.entries as unknown[]).filter(isPlainJsonObject).slice(-ARTICLE_HISTORY_MAX_ENTRIES).map((e) => ({
    title: typeof e.title === 'string' ? cleanAuditString(e.title, ARTICLE_HISTORY_TITLE_MAX_CHARS) : '',
    url: articleHistoryUrl(e.url),
    date: typeof e.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.date) ? e.date : '',
  }));
  return { version: typeof parsed.version === 'number' && Number.isFinite(parsed.version) ? parsed.version : null, entries };
}

/**
 * Shell script that prints one status line — `missing`, `refused`, or
 * `ok <size>` followed by the last `tailBytes` bytes of the file — for
 * <home>/<dirs...>/<name>. Refuses a symlinked or non-directory component and
 * a file that is a symlink, not regular, or has more than one link. The file
 * is opened once (fd 3) and never reopened by name: its /proc/$$/fd/3 link
 * must equal the physical path (`cd -P` of home + the parts), and the link
 * count, size and bytes all come from that descriptor, so a rename of a
 * parent directory between the checks and the open is caught. No
 * /proc/$$/fd → refused. A FIFO swapped in after the `-f` test would block
 * the shell's open (`3<` has no non-blocking form in bash/mksh); that is
 * bounded by AGENT_LOG_READ_TIMEOUT_MS on execCommand, which kills the
 * script and answers an error. Every interpolated value is shell-quoted (and
 * already validated by the caller). Exported for tests.
 */
export function agentLogReadScript(home: string, dirs: string[], name: string, tailBytes: number): string {
  return [
    `h=$(cd -P -- ${shellQuote(home)} 2>/dev/null && pwd -P) || { echo missing; exit 0; }`,
    'd="$h"',
    `for p in ${dirs.map(shellQuote).join(' ')}; do d="$d/$p"; if [ -L "$d" ]; then echo refused; exit 0; fi; if [ ! -e "$d" ]; then echo missing; exit 0; fi; if [ ! -d "$d" ]; then echo refused; exit 0; fi; done`,
    `f="$d/"${shellQuote(name)}`,
    'if [ -L "$f" ]; then echo refused; exit 0; fi',
    'if [ ! -e "$f" ]; then echo missing; exit 0; fi',
    'if [ ! -f "$f" ]; then echo refused; exit 0; fi',
    'if [ ! -d "/proc/$$/fd" ]; then echo refused; exit 0; fi',
    '{',
    '  w=$(readlink "/proc/$$/fd/3") || { echo refused; exit 0; }',
    '  [ "$w" = "$f" ] || { echo refused; exit 0; }',
    '  [ -f "/proc/$$/fd/3" ] || { echo refused; exit 0; }',
    '  n=$(stat -L -c %h "/proc/$$/fd/3") || { echo refused; exit 0; }',
    '  [ "$n" = 1 ] || { echo refused; exit 0; }',
    '  s=$(stat -L -c %s "/proc/$$/fd/3") || { echo refused; exit 0; }',
    '  echo "ok $s"',
    `  tail -c ${Math.max(1, Math.floor(tailBytes))} <&3`,
    '  exit 0',
    '} 3< "$f"',
    'echo refused',
  ].join('\n');
}

type AgentLogRead = { missing: true } | { error: string } | { size: number; body: string };

async function readAgentLogFile(dirs: string[], name: string, tailBytes: number): Promise<AgentLogRead> {
  let r: { stdout: string; stderr: string; exitCode: number };
  try {
    r = await execCommand(agentLogReadScript(homeDir(), dirs, name, tailBytes), AGENT_LOG_READ_TIMEOUT_MS);
  } catch {
    return { error: 'the file could not be read' };
  }
  if (r.exitCode !== 0) return { error: 'the file could not be read' };
  const out = r.stdout || '';
  const nl = out.indexOf('\n');
  const head = (nl < 0 ? out : out.slice(0, nl)).trim();
  if (head === 'missing') return { missing: true };
  const m = /^ok (\d+)$/.exec(head);
  if (!m) return { error: 'refused: not a regular single-link file' };
  return { size: Number(m[1]), body: nl < 0 ? '' : out.slice(nl + 1) };
}

async function readAgentAuditTool(args: Record<string, unknown>): Promise<ToolResult> {
  const agentId = typeof args.agentId === 'string' ? args.agentId : '';
  if (!AUDIT_AGENT_ID_RE.test(agentId)) return { ok: false, error: 'agentId must be an agent id from list_agents' };
  if (!agentSummaries().some((a) => a.id === agentId)) return { ok: false, error: 'agentId is not a registered agent (see list_agents)' };
  const limit = clampInt(args.limit, AUDIT_DEFAULT_LIMIT, 1, AUDIT_MAX_LIMIT);
  const maxBytes = clampInt(args.maxBytes, AUDIT_DEFAULT_BYTES, AUDIT_MIN_BYTES, AUDIT_MAX_BYTES);
  const read = await readAgentLogFile([...AGENT_LOGS_PARTS, agentId], 'plan-executor-audit.jsonl', AUDIT_TAIL_READ_BYTES);
  if ('missing' in read) return { ok: false, error: `no audit log for agent ${agentId} yet (it has not run through the plan executor)` };
  if ('error' in read) return { ok: false, error: read.error };
  const partial = read.size > AUDIT_TAIL_READ_BYTES;
  let text = read.body;
  if (partial) {
    const nl = text.indexOf('\n');
    text = nl < 0 ? '' : text.slice(nl + 1);
  }
  const lines = text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.stringify(projectAuditLine(l)));
  const capped = capLogLines(lines, limit, maxBytes);
  return { ok: true, data: { agentId, lines: capped.returned, truncated: capped.truncated || partial, text: capped.text, untrusted: true } };
}

async function readArticleHistoryTool(args: Record<string, unknown>): Promise<ToolResult> {
  const stream = typeof args.stream === 'string' ? args.stream : '';
  if (!ARTICLE_HISTORY_STREAM_RE.test(stream)) return { ok: false, error: 'stream must match ^[a-z0-9-]{1,40}$' };
  const read = await readAgentLogFile(AGENT_LOGS_PARTS, `article-history-${stream}.json`, ARTICLE_HISTORY_READ_MAX_BYTES + 1);
  if ('missing' in read) return { ok: false, error: `no article history for stream ${stream}` };
  if ('error' in read) return { ok: false, error: read.error };
  if (read.size > ARTICLE_HISTORY_READ_MAX_BYTES || utf8Length(read.body) > ARTICLE_HISTORY_READ_MAX_BYTES) {
    return { ok: false, error: `refused: article history is larger than ${ARTICLE_HISTORY_READ_MAX_BYTES} bytes` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.body);
  } catch {
    return { ok: false, error: 'the article history is not valid JSON' };
  }
  const history = projectArticleHistory(parsed);
  if (!history) return { ok: false, error: 'the article history is not in the expected format' };
  return { ok: true, data: { stream, history, untrusted: true } };
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

/** `code` (typed ops only) is shown by the server as `Error: [<code>] <message>`. */
type ToolResult = { ok: true; data: unknown } | { ok: false; error: string; code?: TypedOpErrorCode | 'digest_changed' | 'read_failed' };

const DEFAULT_APPROVAL_TIMEOUT_MS = 90_000;
let approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS;

/** Test hook: a shorter approval timeout (null restores the default). */
export function __setMCPApprovalTimeoutForTests(ms: number | null): void {
  approvalTimeoutMs = ms ?? DEFAULT_APPROVAL_TIMEOUT_MS;
}

type ApprovalRequestInput = {
  kind: McpApprovalRequest['kind'];
  summary: string;
  detail: string;
  riskLevel?: string;
  origin: McpIngress;
  /** Typed ops only: offers "always allow". Raw tools never pass it. */
  alwaysAllowable?: { op: string; targetLabel: string };
};

/** Surfaces a McpApprovalModal request and waits for a tap or a timeout
 *  (auto-denied — fail closed, matching every other unattended-action gate
 *  in this codebase). See store/mcp-approval-store.ts for the queueing. */
async function requestApproval(request: Omit<ApprovalRequestInput, 'alwaysAllowable'>): Promise<McpApprovalDecision> {
  return (await requestApprovalDetailed(request)).decision;
}

/** requestApproval plus whether the answer was the timeout (exactly one
 *  resolution wins: a tap after the timeout is a no-op). */
function requestApprovalDetailed(
  request: ApprovalRequestInput,
  timeoutMs: number = approvalTimeoutMs,
): Promise<{ decision: McpApprovalDecision; timedOut: boolean }> {
  return new Promise((resolve) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let settled = false;
    const settle = (decision: McpApprovalDecision, timedOut = false) => {
      if (settled) return;
      settled = true;
      resolve({ decision, timedOut });
    };
    // On-device found 2026-09-17: a timeout used to only resolve this
    // promise, never touching the store — so the modal stayed stuck on
    // the timed-out request (still `current`) and every later call queued
    // silently behind it, invisible, each ticking down its own timer
    // instead of ever being shown. respond() here clears/advances the
    // store the same way a real tap would, so the queue can't back up.
    const timer = setTimeout(() => {
      settle('deny', true);
      useMcpApprovalStore.getState().respond(id, 'deny');
    }, Math.max(0, Math.min(approvalTimeoutMs, timeoutMs)));
    useMcpApprovalStore.getState().enqueue({
      ...request,
      origin: { principal: request.origin.principal, clientNameSelfReported: request.origin.clientNameSelfReported },
      id,
      resolve: (decision) => {
        clearTimeout(timer);
        settle(decision);
      },
    });
  });
}

// Startup, shutdown and token revocation invalidate work from older queue epochs.
let queueEpoch = 0;
const REVOKED_ERROR = 'cancelled: pending MCP requests were revoked';

function invalidateStageInstalls(clearLatest: boolean): boolean {
  try {
    const invalidated = TerminalEmulator.invalidateStageInstalls?.(clearLatest);
    if (invalidated === false) logError('MCPBridge', 'stage install invalidation failed');
    return invalidated === true;
  } catch {
    logInfo('MCPBridge', 'retrying stage install invalidation without arguments');
    try {
      if (TerminalEmulator.invalidateStageInstalls?.() === false) {
        logError('MCPBridge', 'stage install invalidation failed');
      }
    } catch {
      logError('MCPBridge', 'stage install invalidation failed');
    }
  }
  return false;
}

/** Confirms the native durable clear. The legacy fallback is best-effort. */
export async function clearLatestStageInstallResultConfirmed(): Promise<boolean> {
  return invalidateStageInstalls(true);
}

/** Reset and verify both omission switches, even when one reset fails. */
export async function resetMcpOmissionSwitches(): Promise<void> {
  const reason = 'MCP token changed';
  const resets = await Promise.allSettled([turnOffMcpSkipApproval(reason), turnOffApproveAll(reason)]);
  const failures = resets.flatMap((result) => result.status === 'rejected' ? [String(result.reason)] : []);
  if (failures.length) throw new Error(failures.join('; '));
}

/**
 * Deny pending approvals, invalidate in-flight work and clear the file queue.
 * Principal changes also clear the last installation result, reset both
 * omission switches, cancel live tickets and purge every always-allow rule.
 */
export async function revokePendingMCPRequests(opts: { tokenRevoked?: boolean } = {}): Promise<void> {
  await beginMCPRequestRevocation(opts)();
}

/** Invalidate approvals now, then finish queue cleanup under the server lock. */
export function beginMCPRequestRevocation(opts: { tokenRevoked?: boolean } = {}): () => Promise<void> {
  const tokenRevoked = opts.tokenRevoked === true;
  const failures: string[] = [];
  async function attempt(label: string, step: () => void | Promise<void>): Promise<void> {
    try {
      await step();
    } catch (error) {
      failures.push(`${label}: ${String(error)}`);
    }
  }

  const epoch = ++queueEpoch;
  if (!invalidateStageInstalls(tokenRevoked)) {
    failures.push(tokenRevoked
      ? 'could not confirm that the latest stage install result was cleared'
      : 'could not confirm that pending stage installs were invalidated');
  }
  // Both operations run immediately, before the caller waits for the lock.
  const denied = attempt('denying MCP approvals', () => useMcpApprovalStore.getState().denyAll());
  const waitsAborted = attempt('aborting MCP result waits', abortRunResultWaits);
  return async () => {
    await Promise.all([denied, waitsAborted]);
    for (const dir of [REQUESTS_DIR, RESULTS_DIR, HANDOFFS_DIR]) {
      await attempt(`deleting ${dir}`, () => FileSystem.deleteAsync(dir, { idempotent: true }));
    }
    if (tokenRevoked) {
      await attempt('resetting omission switches', resetMcpOmissionSwitches);
      await attempt('cancelling run_agent tickets', cancelLiveRunTickets);
      await attempt('purging MCP rules', async () => {
        if (!(await purgeMcpAlwaysAllowRulesExcept(null))) {
          throw new Error('could not confirm that the MCP always-allow rules were removed');
        }
      });
    }
    if (failures.length) throw new Error(failures.join('; '));
    logInfo('MCPBridge', `revoked pending MCP requests (epoch=${epoch})`);
  };
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
  /** Signed request deadline where the tool has one. */
  deadlineMs: number = Number.POSITIVE_INFINITY,
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
    case 'read_agent_audit': {
      // Reached only when the server had no verified snapshot.
      return readAgentAuditTool(args);
    }
    case 'read_article_history': {
      return readArticleHistoryTool(args);
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
      const decision = await approveRawTool({
        kind: 'run_command',
        summary: `Run a command via MCP${cwd ? ` in ${cwd}` : ''}?`,
        detail: `${command}\n\nGate: ${gate.summary}`,
        riskLevel: gate.outcome?.verdict.dangerLevel,
        origin: ingress,
      }, callId);
      if (epoch !== queueEpoch) return { ok: false, error: REVOKED_ERROR };
      // Raw tools never offer "always allow" (no alwaysAllowable); a stray
      // 'always' is treated as 'once'. Rule writing is not done here.
      if (decision === 'deny') {
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
      const decision = await approveRawTool({
        kind: 'write_file',
        summary: `Write ${content.length} bytes to a file via MCP?`,
        detail: `${shownPath}\n\nGate: ${gates[0].summary}\n\n${preview}`,
        origin: ingress,
      }, callId);
      if (epoch !== queueEpoch) return { ok: false, error: REVOKED_ERROR };
      // Raw tools never offer "always allow" (no alwaysAllowable); a stray
      // 'always' is treated as 'once'. Rule writing is not done here.
      if (decision === 'deny') {
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
    case 'stage_install':
      return stageInstallTool(args, epoch, ingress, callId, deadlineMs);
    case 'stage_install_result':
      return stageInstallResultTool(epoch, ingress);
    case 'run_agent':
      return runAgentTool(args, epoch, ingress, deadlineMs);
    case 'get_run_result':
      return getRunResultTool(args, epoch, ingress);
    default:
      return { ok: false, error: `unknown tool: ${tool}` };
  }
}

async function stageInstallResultTool(epoch: number, ingress: McpIngress): Promise<ToolResult> {
  const audit = async (code: string): Promise<void> => {
    try {
      const ok = await TerminalEmulator.appendMcpIngressAudit?.(null, JSON.stringify({
        kind: 'mcp_stage_install_result', event: 'mcp_stage_install_result', principal: ingress.principal, code,
      }));
      if (ok) return;
    } catch {
      // The read can still be returned if the audit sink is unavailable.
    }
    logError('MCPBridge', `stage_install_result audit line not written (${code})`);
  };
  const refuseRevoked = async (): Promise<ToolResult> => {
    await audit('revoked');
    return { ok: false, error: REVOKED_ERROR, code: 'revoked' };
  };

  if (epoch !== queueEpoch) return refuseRevoked();
  let outcome;
  try {
    const getLastResult = TerminalEmulator.getLastStageInstallResult;
    if (typeof getLastResult === 'function') {
      outcome = await getLastResult.call(TerminalEmulator);
    }
  } catch {
    // Native bindings can throw synchronously or reject the read.
  }
  if (epoch !== queueEpoch) return refuseRevoked();
  if (!outcome) {
    await audit('read_failed');
    return { ok: false, error: 'could not read the latest stage install result', code: 'read_failed' };
  }
  const data = outcome.status === 'failure'
    ? { ...outcome, message: redactForMcp(outcome.message) }
    : outcome;
  await audit(data.status);
  return { ok: true, data };
}

const STAGE_INSTALL_WAIT_MS = 150_000;
let stageInstallWaitMs = STAGE_INSTALL_WAIT_MS;

export function __setStageInstallWaitForTests(ms: number | null): void {
  stageInstallWaitMs = ms ?? STAGE_INSTALL_WAIT_MS;
}

async function stageInstallTool(
  args: Record<string, unknown>, epoch: number, ingress: McpIngress, callId: string, approvalDeadline: number,
): Promise<ToolResult> {
  const audit = async (code: string): Promise<void> => {
    // Fixed fields only. APK paths, digests and installer messages stay out of the audit.
    try {
      const ok = await TerminalEmulator.appendMcpIngressAudit?.(null, JSON.stringify({
        kind: 'mcp_stage_install', event: 'mcp_stage_install', principal: ingress.principal, code,
      }));
      if (!ok) logError('MCPBridge', `stage_install audit line not written (${code})`);
    } catch {
      logError('MCPBridge', `stage_install audit line not written (${code})`);
    }
  };
  const refuse = async (code: string, error: string): Promise<ToolResult> => {
    await audit(code);
    return code === 'digest_changed' || code === 'revoked'
      ? { ok: false, error, code }
      : { ok: false, error };
  };
  const timeout = async (): Promise<ToolResult> => {
    await audit('timeout');
    return { ok: true, data: { status: 'timeout' } };
  };

  if (!execEnabled()) return refuse('disabled', EXEC_DISABLED_ERROR);
  const { path, expectedSha256 } = args;
  if (typeof path !== 'string' || !path.startsWith('/') || !/\.apk$/i.test(path) || /[\x00-\x1f\x7f]/.test(path)) {
    return refuse('invalid_path', 'path must be an absolute .apk file path without control characters');
  }
  if (path.split('/').includes('..')) return refuse('invalid_path', 'path must not contain ".."');
  if (expectedSha256 !== undefined && (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSha256))) {
    return refuse('invalid_digest', 'expectedSha256 must be 64 lowercase hex digits');
  }

  try {
    const resolved = await TerminalEmulator.resolveStageInstallPath(path, approvalDeadline);
    if (epoch !== queueEpoch) return refuse('revoked', REVOKED_ERROR);
    if (Date.now() >= approvalDeadline) return timeout();
    if ('error' in resolved) {
      if (resolved.code === 'timeout') return timeout();
      return refuse('invalid_path', redactForMcp(resolved.error));
    }
    await audit('approval_requested');
    if (epoch !== queueEpoch) return refuse('revoked', REVOKED_ERROR);
    if (Date.now() >= approvalDeadline) return timeout();
    if (!execEnabled()) return refuse('disabled', EXEC_DISABLED_ERROR);
    // The omission switches are implemented by the native raw/agent consumers.
    // This signed RN queue operation always requests a tap through the raw approval path.
    const approvalExpiresAt = Date.now() + approvalTimeoutMs;
    const decision = await approveRawTool({
      kind: 'stage_install',
      summary: t('mcp.approval_stage_install'),
      detail: resolved.path,
      origin: ingress,
    }, callId);
    if (epoch !== queueEpoch) return refuse('revoked', REVOKED_ERROR);
    if (decision === 'deny' || Date.now() >= approvalExpiresAt) return refuse('denied', 'denied by user (or timed out waiting for a response)');
    if (!execEnabled()) return refuse('disabled', EXEC_DISABLED_ERROR);

    const deadline = Date.now() + stageInstallWaitMs;
    // Native revalidates the canonical path and hashes the exact bytes it will
    // install before creating a session.
    const generation = TerminalEmulator.stageInstallGeneration();
    const install = await TerminalEmulator.stageInstallApk(
      resolved.path, resolved.sha256, expectedSha256 ?? null, deadline, generation,
    );
    if (epoch !== queueEpoch || ('error' in install && install.code === 'revoked')) {
      return refuse('revoked', REVOKED_ERROR);
    }
    if ('error' in install) {
      if (install.code === 'timeout') return timeout();
      return refuse(install.code ?? 'staging_failed', redactForMcp(install.error));
    }

    let data: Record<string, unknown> = { ...install, status: 'timeout' };
    let delay = 0;
    while (true) {
      if (epoch !== queueEpoch) return refuse('revoked', REVOKED_ERROR);
      // The installer dialog can stop RN's JS timers while Shelly is
      // backgrounded. Use a short native delay between reads.
      const outcome = await TerminalEmulator.getStageInstallResult(install.sessionId, delay);
      if (outcome.status === 'success' || outcome.status === 'failure') {
        data = outcome.status === 'success' ? { ...install, status: 'success' } : {
          ...install, status: 'failure', statusCode: outcome.statusCode, message: redactForMcp(outcome.message),
        };
        break;
      }
      if (outcome.status === 'user_action_required') data = { ...install, status: outcome.status };
      delay = Math.min(POLL_INTERVAL_MS, deadline - Date.now());
      if (delay <= 0) break;
    }
    await audit(String(data.status));
    return { ok: true, data };
  } catch {
    return refuse('native_error', 'could not stage the APK or read its install result');
  }
}

// ── Typed operations: run_agent / get_run_result ─────────────────────────

const AGENTS_DIR = `${FileSystem.documentDirectory}home/.shelly/agents`;

function typedOpsEnabled(): boolean {
  return useSettingsStore.getState().settings.mcpTypedOpsEnabled === true;
}

function refuse(r: TypedOpRefusal): ToolResult {
  return { ok: false, error: r.message, code: r.code };
}

const DISABLED: TypedOpRefusal = { code: 'disabled', message: TYPED_OPS_DISABLED_MESSAGE };
const REVOKED: TypedOpRefusal = { code: 'revoked', message: REVOKED_ERROR };
const UNKNOWN_AGENT: TypedOpRefusal = { code: 'unknown_agent', message: 'no enabled agent with that id (see list_agents)' };
const UNKNOWN_HANDLE: TypedOpRefusal = { code: 'unknown_handle', message: 'no run with that handle for this client' };
const EXPIRED: TypedOpRefusal = { code: 'approval_timeout', message: 'the request expired before the run could start' };
/** Room left after a dialog for the launch and the result write. */
const DIALOG_DEADLINE_MARGIN_MS = 2_000;

/**
 * Step 4: the agent must be in the store AND in ~/.shelly/agents/<id>.json
 * with a matching id and enabled — the check native AgentRuntime.isAgentEnabled
 * makes. Null otherwise (unreadable counts as missing).
 */
async function resolveRunAgentTarget(agentId: string): Promise<Agent | null> {
  const agent = useAgentStore.getState().agents.find((a) => a.id === agentId);
  if (!agent || agent.enabled !== true) return null;
  const raw = await FileSystem.readAsStringAsync(`${AGENTS_DIR}/${agentId}.json`).catch(() => null);
  if (typeof raw !== 'string') return null;
  try {
    const onDisk = JSON.parse(raw);
    if (!onDisk || onDisk.id !== agentId || onDisk.enabled !== true) return null;
  } catch {
    return null;
  }
  return agent;
}

/** STOP-ALL: the store flag or the `.halted` sentinel. An unreadable sentinel counts as halted. */
async function stopAllActive(): Promise<boolean> {
  if (useAgentStore.getState().halted) return true;
  try {
    const info = await FileSystem.getInfoAsync(`${AGENTS_DIR}/.halted`);
    return info.exists === true;
  } catch {
    return true;
  }
}

/** isAgentIngressTainted (true when the mark store is unreadable / overflows,
 *  and on any error). Required lazily: lib/agent-ingress-taint pulls in
 *  expo-secure-store, which the bridge's other callers never need. */
async function agentIngressTainted(agentId: string): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { isAgentIngressTainted } = require('@/lib/agent-ingress-taint') as typeof import('@/lib/agent-ingress-taint');
    return (await isAgentIngressTainted(agentId)) !== false;
  } catch {
    return true;
  }
}

/** Steps 5–7 for `agent` (re-run after the dialog too). Writes the taint audit line. */
async function runAgentDenyCheck(agentId: string, agent: Agent, ingress: McpIngress) {
  const halted = await stopAllActive();
  // Only consulted when not halted (classify checks halted first anyway).
  const tainted = halted ? false : await agentIngressTainted(agentId);
  const policy = halted || tainted ? null : await userPolicy();
  // Synchronously after the policy itself: the file state it was read from.
  const policyPin = policyPinFor(policy);
  const result = classifyRunAgentDeny({
    agentId,
    agent,
    halted,
    tainted,
    policy,
    homeDir: homeDir(),
  });
  if (result.refusal?.code === 'tainted') {
    await appendTypedOpAudit(agentId, {
      kind: 'ingress_tainted_refused',
      event: 'mcp_run_agent',
      agentId,
      principal: ingress.principal,
      code: 'tainted',
    });
  }
  return { ...result, policyPin };
}

/**
 * The policy.json state a deny check used, for native's launch grant: the
 * file's sha256, 'absent' when it did not exist, null when unknown (not read,
 * unreadable, or hash and content not tied to each other). For an agent that declares actions native refuses to
 * accept / start the run unless the file on disk is still exactly this.
 */
function policyPinFor(policy: LoadedUserPolicy | null): string | null {
  // Only the pin of this very snapshot (the loader sets both together).
  if (!policy || policy !== getCachedUserPolicy()) return null;
  return getCachedUserPolicyPin();
}

/** Writes one fixed, short audit line through native (IngressAuditWriter.kt). Best effort. */
async function appendTypedOpAudit(
  agentId: string | null,
  line: { kind: 'ingress_tainted_refused' | 'mcp_typed_op_refused'; event: 'mcp_run_agent'; agentId?: string; principal: string; code: TypedOpErrorCode },
): Promise<void> {
  if (typeof TerminalEmulator.appendMcpIngressAudit !== 'function') {
    logError('MCPBridge', `audit line not written (no native writer): ${line.kind} ${line.code}`);
    return;
  }
  try {
    const ok = await TerminalEmulator.appendMcpIngressAudit(agentId, JSON.stringify(line));
    if (!ok) logError('MCPBridge', `audit line not written: ${line.kind} ${line.code}`);
  } catch (e) {
    logError('MCPBridge', `audit line not written: ${line.kind} ${line.code}`, e);
  }
}

/** Step 9: someone can answer a dialog only while Shelly is in the foreground. */
function appIsForeground(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppState } = require('react-native');
    return AppState?.currentState === 'active';
  } catch {
    return false;
  }
}

function showToast(key: string, fallback: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ToastAndroid } = require('react-native');
    let text = fallback;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      text = require('@/lib/i18n').t(key);
    } catch {
      // keep the fallback
    }
    ToastAndroid?.show?.(text, ToastAndroid.LONG);
  } catch {
    // no toast on this platform
  }
}

type RandomBytes = (n: number) => Uint8Array;
const expoRandomBytes: RandomBytes = (n) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-crypto').getRandomBytes(n);
};
let randomBytes: RandomBytes = expoRandomBytes;

/** Test hook (Jest has no expo-crypto). */
export function __setMCPRandomBytesForTests(fn: RandomBytes | null): void {
  randomBytes = fn ?? expoRandomBytes;
}

function newRunHandle(): string {
  const b = randomBytes(16);
  if (!b || b.length !== 16) throw new Error('random handle generation failed');
  return `mr_${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
}

// Same set as McpAlwaysAllowStore / lib/mcp-always-allow.ts UNSAFE_LABEL_CHARS.
// eslint-disable-next-line no-control-regex
const UNSAFE_LABEL_CHARS_G = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g;

/** The agent name as a rule label: unsafe characters replaced, at most 64 characters. */
function ruleLabel(name: string): string {
  return Array.from(name.replace(UNSAFE_LABEL_CHARS_G, ' ')).slice(0, 64).join('');
}

async function listRunTickets(principal: string): Promise<McpRunTicket[] | null> {
  if (typeof TerminalEmulator.listMcpRunTickets !== 'function') return null;
  try {
    return parseRunTicketList(await TerminalEmulator.listMcpRunTickets(principal));
  } catch {
    return null;
  }
}

async function readRunTicket(handle: string): Promise<McpRunTicket | null> {
  if (typeof TerminalEmulator.readMcpRunTicket !== 'function') return null;
  try {
    const raw = await TerminalEmulator.readMcpRunTicket(handle);
    return typeof raw === 'string' ? parseRunTicket(raw) : null;
  } catch {
    return null;
  }
}

async function cancelLiveRunTickets(): Promise<void> {
  const cancelled = await TerminalEmulator.cancelMcpRunTickets?.(null);
  if (typeof cancelled !== 'number' || cancelled < 0) {
    throw new Error('could not confirm that live run_agent tickets were cancelled');
  }
  logInfo('MCPBridge', `cancelled ${cancelled} live run_agent ticket(s) (MCP token revoked)`);
}

function existingRunResult(t: McpRunTicket, agentId: string): ToolResult {
  if (t.agentId !== agentId) {
    return refuse({ code: 'invalid_params', message: 'requestId was already used for another agent' });
  }
  return { ok: true, data: { runHandle: t.handle, agentId: t.agentId, state: t.state, requestId: t.requestId, existing: true, untrusted: true } };
}

// One check-then-launch section per principal at a time: the requestId
// lookup, the busy count and the ticket write must not interleave between
// two concurrent calls (drainOnce runs request files concurrently).
const launchLocks = new Map<string, Promise<void>>();

async function withLaunchLock<T>(principal: string, fn: () => Promise<T>): Promise<T> {
  const prev = launchLocks.get(principal) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => {
    release = r;
  });
  const tail = prev.then(() => mine);
  launchLocks.set(principal, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (launchLocks.get(principal) === tail) launchLocks.delete(principal);
  }
}

/**
 * How a run_agent call was authorized: a tap on the dialog (once / always), or
 * the always-allow rule `ruleId` (for `target`) without a tap. A rule-based
 * authorization is re-matched at the execution boundary, and native re-checks
 * the same rule under its ticket lock and again when the run actually starts.
 */
type RunAuthorization = { via: 'dialog' } | { via: 'rule'; ruleId: string; target: string; actionPolicyPin?: string };

const RULE_GONE: TypedOpRefusal = {
  code: 'target_changed',
  message: 'the always-allow rule no longer applies (removed, changed or the safety rules became unreadable); call run_agent again',
};

/**
 * Step 11: requestId idempotency, the busy limit, then the native launch.
 * `approvedBind` is the binding the tap or the rule approved: right before the
 * launch (after every await of this path) the setting, the target, the deny
 * classes 5–7 and the binding are checked once more, so an agent edited,
 * marked or stopped while the rule lookup / lock / ticket list was pending
 * never starts under the earlier authorization. A rule-based `authorization`
 * must still be rule-eligible and the very same rule must still match.
 */
async function launchRunAgent(
  agentId: string,
  requestId: string | null,
  epoch: number,
  ingress: McpIngress,
  approvedBind: string,
  deadlineMs: number,
  authorization: RunAuthorization,
): Promise<ToolResult> {
  return withLaunchLock(ingress.principal, async () => {
    if (epoch !== queueEpoch) return refuse(REVOKED);
    const tickets = await listRunTickets(ingress.principal);
    if (!tickets) return refuse({ code: 'launch_failed', message: 'run tickets are not readable on this build of Shelly' });
    if (requestId) {
      const existing = findIdempotentTicket(tickets, ingress.principal, requestId, Date.now());
      if (existing) {
        logInfo('MCPBridge', `run_agent requestId repeated; returning the existing run (principal=${ingress.principal.slice(0, 8)})`);
        return existingRunResult(existing, agentId);
      }
    }
    if (liveRunCount(tickets, ingress.principal) >= MAX_LIVE_RUNS_PER_PRINCIPAL) {
      return refuse({ code: 'busy', message: `this client already has ${MAX_LIVE_RUNS_PER_PRINCIPAL} runs queued or running; poll get_run_result and retry later` });
    }
    if (typeof TerminalEmulator.runAgentForMcp !== 'function') {
      return refuse({ code: 'launch_failed', message: 'run_agent is not available on this build of Shelly' });
    }
    let handle: string;
    try {
      handle = newRunHandle();
    } catch {
      return refuse({ code: 'launch_failed', message: 'could not create a run handle' });
    }
    // Execution boundary: re-validate everything the approval relied on.
    if (!typedOpsEnabled()) return refuse(DISABLED);
    const current = await resolveRunAgentTarget(agentId);
    if (!current) return refuse(UNKNOWN_AGENT);
    const denyNow = await runAgentDenyCheck(agentId, current, ingress);
    if (denyNow.refusal) return refuse(denyNow.refusal);
    if ((await agentBindingHash(current, requestSha256)) !== approvedBind) {
      return refuse({ code: 'target_changed', message: 'the agent was edited before the run could start; call run_agent again' });
    }
    if (authorization.via === 'rule') {
      // No tap: the run rests on the rule alone. It must still be allowed to
      // (policy readable and verified when the agent declares actions) and the
      // same rule must still match this principal, target and binding.
      if (!denyNow.ruleEligible) return refuse(RULE_GONE);
      if (!(await mcpAlwaysAllowMatches(ingress.principal, 'run_agent', authorization.target, approvedBind))) return refuse(RULE_GONE);
      const still = findAlwaysAllowMatch((await listMcpAlwaysAllowRules()).rules, ingress.principal, 'run_agent', authorization.target, approvedBind);
      if (!still || still.id !== authorization.ruleId || still.actionPolicyPin !== authorization.actionPolicyPin || (authorization.actionPolicyPin !== undefined && authorization.actionPolicyPin !== denyNow.policyPin)) return refuse(RULE_GONE);
    }
    // Last check, synchronous with the native call below (no await in
    // between): the store must still hold the very object that was just
    // validated (updateAgent replaces it, so an edit during the awaits above
    // shows up here), the setting must still be on, STOP-ALL off, epoch same.
    const finalStore = useAgentStore.getState();
    if (epoch !== queueEpoch) return refuse(REVOKED);
    if (!typedOpsEnabled()) return refuse(DISABLED);
    if (finalStore.halted) return refuse({ code: 'halted', message: 'all agents are stopped (STOP-ALL is on)' });
    if (finalStore.agents.find((a) => a.id === agentId) !== current) {
      return refuse({ code: 'target_changed', message: 'the agent was edited before the run could start; call run_agent again' });
    }
    // The client stops waiting at the signed deadline: never start a run after it.
    if (Date.now() > deadlineMs) return refuse(EXPIRED);
    let sent = false;
    try {
      // The native call is issued synchronously here, before the first await.
      // Native re-checks the deadline, the binding and (rule-based) the rule
      // under its ticket lock (the call may wait there), keeps them with the
      // ticket and checks them again when the service actually starts the run.
      const nativeDeadline = Number.isFinite(deadlineMs) ? deadlineMs : null;
      const ruleId = authorization.via === 'rule' ? authorization.ruleId : null;
      sent = (await TerminalEmulator.runAgentForMcp(agentId, handle, ingress.principal, requestId, nativeDeadline, approvedBind, ruleId, denyNow.policyPin)) === true;
    } catch (e) {
      logError('MCPBridge', 'run_agent launch failed', e);
    }
    if (!sent) return refuse({ code: 'launch_failed', message: 'the run could not be started' });
    logInfo('MCPBridge', `run_agent started ${agentId} (principal=${ingress.principal.slice(0, 8)})`);
    const data: Record<string, unknown> = { runHandle: handle, agentId, state: 'accepted', untrusted: true };
    if (requestId) data.requestId = requestId;
    return { ok: true, data };
  });
}

/**
 * run_agent, in the order of the plan's section (b). Each step refuses or
 * falls through; the always-allow rule (step 8) is consulted only after every
 * deny class (1–7), and the run itself starts in exactly one place (step 11).
 */
function actionConsentText(): string {
  // Lazy, like agentIngressTainted: read-only/raw callers do not load native UI modules.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { t } = require('@/lib/i18n') as typeof import('@/lib/i18n');
  return t('mcp.agent_action_consent');
}

async function runAgentTool(
  args: Record<string, unknown>,
  epoch: number,
  ingress: McpIngress,
  deadlineMs: number = Number.POSITIVE_INFINITY,
): Promise<ToolResult> {
  // 1. setting
  if (!typedOpsEnabled()) return refuse(DISABLED);
  // 2. arguments (strict)
  const parsed = validateRunAgentArgs(args);
  if ('refusal' in parsed) return refuse(parsed.refusal);
  const { agentId, requestId } = parsed.args;
  // 3. epoch
  if (epoch !== queueEpoch) return refuse(REVOKED);
  // 4. target
  const agent = await resolveRunAgentTarget(agentId);
  if (!agent) return refuse(UNKNOWN_AGENT);
  // 5–7. STOP-ALL, taint (audited), policy / CRITICAL — never rescued by a rule.
  const deny = await runAgentDenyCheck(agentId, agent, ingress);
  if (deny.refusal) {
    logInfo('MCPBridge', `run_agent refused (${deny.refusal.code})`);
    return refuse(deny.refusal);
  }
  if (epoch !== queueEpoch) return refuse(REVOKED);
  // A repeated requestId returns the existing run without a dialog (checked
  // again under the launch lock).
  if (requestId) {
    const tickets = await listRunTickets(ingress.principal);
    const existing = tickets ? findIdempotentTicket(tickets, ingress.principal, requestId, Date.now()) : null;
    if (existing) return existingRunResult(existing, agentId);
  }
  const target = normalizeTarget('run_agent', { agentId });
  if (!target) return refuse({ code: 'invalid_params', message: 'agentId is not a valid target' });
  const bind = await agentBindingHash(agent, requestSha256);
  // 8. always-allow rule (only after every deny class; not when the policy
  // rules are unreadable and the agent declares side effects).
  // The rule must be identifiable (its id is carried into the launch and
  // re-matched there); a match whose id can't be listed is not used.
  if (deny.ruleEligible && (await mcpAlwaysAllowMatches(ingress.principal, 'run_agent', target, bind))) {
    const rule = findAlwaysAllowMatch((await listMcpAlwaysAllowRules()).rules, ingress.principal, 'run_agent', target, bind);
    if (rule && (rule.actionPolicyPin === undefined || rule.actionPolicyPin === deny.policyPin)) {
      logInfo('MCPBridge', `always-allow rule ${rule.id} matched run_agent ${agentId} (principal=${ingress.principal.slice(0, 8)})`);
      return launchRunAgent(agentId, requestId, epoch, ingress, bind, deadlineMs, { via: 'rule', ruleId: rule.id, target, actionPolicyPin: rule.actionPolicyPin });
    }
    logError('MCPBridge', `always-allow rule matched run_agent ${agentId} but could not be listed; asking instead`);
  }
  // 8b. The master switch "Skip all approvals" (Settings only): answered as
  // a one-time 'once' — no always-allow rule is written, and the launch
  // re-runs every deny class (STOP-ALL, taint, policy / CRITICAL) and the
  // binding check. The run stays marked as external input (writes, sends
  // and actions refused), exactly as after a tap.
  if (await isApproveAllWithoutAskingOn()) {
    logInfo('MCPBridge', `run_agent ${agentId} auto-approved once (approveAllWithoutAsking, principal=${ingress.principal.slice(0, 8)})`);
    return launchRunAgent(agentId, requestId, epoch, ingress, bind, deadlineMs, { via: 'dialog' });
  }
  // 9. nobody to ask: refuse at once, never queue a dialog in the background.
  if (!appIsForeground()) {
    await appendTypedOpAudit(agentId, { kind: 'mcp_typed_op_refused', event: 'mcp_run_agent', agentId, principal: ingress.principal, code: 'not_attended' });
    logInfo('MCPBridge', `run_agent refused (not_attended) ${agentId}`);
    return refuse({ code: 'not_attended', message: 'Shelly is not in the foreground on the phone and no always-allow rule matches; nobody can approve this now' });
  }
  // 10. dialog (three buttons when a rule may be written), never longer than
  // the client waits (a late answer would start a run nobody receives).
  const dialogBudgetMs = Math.min(approvalTimeoutMs, deadlineMs - Date.now() - DIALOG_DEADLINE_MARGIN_MS);
  if (!(dialogBudgetMs > 0)) return refuse(EXPIRED);
  const actions = declaredActions(agent).map((a) => a.type).join(', ') || 'none';
  const { decision, timedOut } = await requestApprovalDetailed({
    kind: 'run_agent',
    summary: `Run agent "${agent.name}" via MCP?`,
    detail: `Agent: ${agent.name} (${agentId})\nDeclared actions: ${actions}\n\n${actionConsentText()}`,
    origin: ingress,
    alwaysAllowable: deny.ruleEligible && deny.policyPin !== null ? { op: 'run_agent', targetLabel: ruleLabel(agent.name) } : undefined,
  }, dialogBudgetMs);
  if (epoch !== queueEpoch) return refuse(REVOKED);
  if (decision === 'deny') {
    return timedOut
      ? refuse({ code: 'approval_timeout', message: 'nobody answered the approval on the phone in time' })
      : refuse({ code: 'denied_by_user', message: 'denied on the phone' });
  }
  if (!typedOpsEnabled()) return refuse(DISABLED);
  const again = await resolveRunAgentTarget(agentId);
  if (!again) return refuse(UNKNOWN_AGENT);
  const denyAgain = await runAgentDenyCheck(agentId, again, ingress);
  if (denyAgain.refusal) return refuse(denyAgain.refusal);
  if ((await agentBindingHash(again, requestSha256)) !== bind) {
    return refuse({ code: 'target_changed', message: 'the agent was edited while the approval was open; call run_agent again' });
  }
  if (epoch !== queueEpoch) return refuse(REVOKED);
  if (decision === 'always' && denyAgain.policyPin !== deny.policyPin) {
    return refuse({ code: 'target_changed', message: 'the safety policy changed while the approval was open; call run_agent again' });
  }
  if (decision === 'always' && deny.ruleEligible && denyAgain.ruleEligible && deny.policyPin !== null && denyAgain.policyPin === deny.policyPin) {
    const added = await addMcpAlwaysAllowRule(ingress.principal, 'run_agent', target, bind, ruleLabel(agent.name), denyAgain.policyPin);
    if (added.ok) {
      logInfo('MCPBridge', `always-allow rule ${added.id} ${added.code} for run_agent ${agentId} (principal=${ingress.principal.slice(0, 8)})`);
      if (added.id) return launchRunAgent(agentId, requestId, epoch, ingress, bind, deadlineMs, { via: 'rule', ruleId: added.id, target, actionPolicyPin: denyAgain.policyPin });
    } else {
      logError('MCPBridge', `always-allow rule not saved (${added.code}); running once`);
      showToast('mcp.always_allow_not_saved', 'The "always allow" rule could not be saved. The agent runs this once.');
    }
  }
  // 11. execute (exactly once).
  return launchRunAgent(agentId, requestId, epoch, ingress, bind, deadlineMs, { via: 'dialog' });
}

// get_run_result long-poll waits. Each one is a single cleared setTimeout;
// abortRunResultWaits ends them all (poller stop, token revoke) so no timer
// outlives its request.
const runResultWaits = new Set<() => void>();
// Bumped by abortRunResultWaits: a get_run_result whose generation is older
// stops waiting even if the abort landed while it was reading the ticket.
let runResultGeneration = 0;

function pollSleep(ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (aborted: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      runResultWaits.delete(abort);
      resolve(aborted);
    };
    const abort = () => finish(true);
    const timer = setTimeout(() => finish(false), Math.max(0, ms));
    runResultWaits.add(abort);
  });
}

function abortRunResultWaits(): void {
  runResultGeneration += 1;
  for (const abort of [...runResultWaits]) abort();
}

async function getRunResultTool(args: Record<string, unknown>, epoch: number, ingress: McpIngress): Promise<ToolResult> {
  if (!typedOpsEnabled()) return refuse(DISABLED);
  const parsed = validateGetRunResultArgs(args);
  if ('refusal' in parsed) return refuse(parsed.refusal);
  const { runHandle, waitMs, maxBytes } = parsed.args;
  if (epoch !== queueEpoch) return refuse(REVOKED);
  const deadline = Date.now() + waitMs;
  const generation = runResultGeneration;
  let stopWaiting = stopped;
  for (;;) {
    const ticket = await readRunTicket(runHandle);
    if (generation !== runResultGeneration || stopped) stopWaiting = true;
    if (epoch !== queueEpoch) return refuse(REVOKED);
    // Another client's handle reads exactly like a missing one.
    if (!ticket || ticket.principal !== ingress.principal || ticket.handle !== runHandle) return refuse(UNKNOWN_HANDLE);
    const left = deadline - Date.now();
    if (isTerminalRunState(ticket.state) || left <= 0 || stopWaiting) {
      let output: string | null = null;
      if (ticket.outputFile && typeof TerminalEmulator.readMcpRunOutput === 'function') {
        output = await TerminalEmulator.readMcpRunOutput(runHandle, RUN_OUTPUT_MAX_BYTES).catch(() => null);
      }
      if (epoch !== queueEpoch) return refuse(REVOKED);
      return { ok: true, data: buildRunResultResponse(ticket, typeof output === 'string' ? output : null, maxBytes, redactForMcp) };
    }
    if (await pollSleep(Math.min(RUN_RESULT_POLL_MS, left))) stopWaiting = true;
    if (generation !== runResultGeneration || stopped) stopWaiting = true;
  }
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;

// Files currently being processed — see the note in drainOnce below for why
// this exists. Cleared as soon as a file's own processing settles.
const inFlightRequestFiles = new Set<string>();

/** Typed ops arrive in requests/ only through the native consumer's handoff. */
const TYPED_REQUEST_TOOLS: ReadonlySet<string> = new Set(['run_agent']);
/** So do raw tools (McpRawToolConsumer, scripts/shelly-mcp-server.js RAW_REQUEST_TOOLS). */
const RAW_REQUEST_TOOLS: ReadonlySet<string> = new Set(['run_command', 'write_file']);
export const HANDOFFS_DIR = `${QUEUE_DIR}/handoffs`;

/**
 * Reads and deletes handoffs/<callId>; true only for this bridge key's token
 * that was not consumed before. Deleting the file alone is not consumption:
 * a same-uid process can copy the token and restore it, so every consumed
 * token is also recorded in memory (recordMcpHandoffConsumed) for the whole
 * validity window of its signed request, and a restored copy is refused.
 */
async function consumeHandoffToken(callId: string, receivedAtMs: number): Promise<boolean> {
  const uri = `${HANDOFFS_DIR}/${callId}`;
  let token: string | null = null;
  try {
    token = await FileSystem.readAsStringAsync(uri);
  } catch {
    return false;
  }
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    return false; // not consumed: refuse rather than leave it reusable
  }
  if (!(await verifyMcpHandoffToken(token, bridgeKey, callId, requestSha256))) return false;
  return recordMcpHandoffConsumed(callId, receivedAtMs);
}

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
    let deadlineMs = Number.POSITIVE_INFINITY;
    if (request.tool === 'stage_install') {
      // Leave the rest of the server's 260s queue wait for approval and install.
      deadlineMs = request.receivedAtMs + 15_000;
    } else if (RAW_REQUEST_TOOLS.has(request.tool)) {
      // A raw tool reaches requests/ only by the native raw consumer's handoff
      // (it routes ONCE per callId: run natively, or hand here). Its token is
      // consumed first, so a copied signed request (native owns or ran the
      // original) is never run here too. No deadline: as before, the call
      // waits for the tap.
      if (!(await consumeHandoffToken(request.callId, request.receivedAtMs))) {
        logError('MCPBridge', `rejected raw request file ${name} (no valid handoff token)`);
        return;
      }
    } else if (TYPED_REQUEST_TOOLS.has(request.tool)) {
      // A typed op reaches requests/ only by the native consumer's handoff
      // (PR 6). Its single-use token is consumed first, so a copied signed
      // request (native owns or ran the original) is never run here.
      if (!(await consumeHandoffToken(request.callId, request.receivedAtMs))) {
        logError('MCPBridge', `rejected typed request file ${name} (no valid handoff token)`);
        return;
      }
      deadlineMs = request.receivedAtMs + TYPED_REQUEST_DEADLINE_MS;
      // Stranded handoff: the client gave up; never run it late.
      if (Date.now() > deadlineMs) {
        logError('MCPBridge', `dropped expired typed request file ${name}`);
        return;
      }
    }
    if (epoch !== queueEpoch) return;
    const token = snapshotToken;
    const result = await callTool(request.tool, request.args, epoch, request.ingress, request.callId, deadlineMs);
    if (epoch !== queueEpoch) {
      logInfo('MCPBridge', `dropped call ${request.callId} (MCP requests were revoked while it was pending)`);
      return;
    }
    const resultUri = `${RESULTS_DIR}/${request.callId}.json`;
    const body = JSON.stringify(result);
    let response = body;
    if (request.tool === 'stage_install_result') {
      if (!token || snapshotToken !== token) return;
      const mac = await signSnapshot(token, body, snapshotSha256);
      if (epoch !== queueEpoch || snapshotToken !== token) return;
      response = JSON.stringify({ body, mac });
    }
    await FileSystem.writeAsStringAsync(resultUri, response);
    logInfo('MCPBridge', `answered call ${request.callId} (tool=${request.tool}, ok=${result.ok}, principal=${request.ingress.principal.slice(0, 8)})`);
  } catch (e) {
    logError('MCPBridge', `failed to process request file ${name}`, e);
  } finally {
    await FileSystem.deleteAsync(requestUri, { idempotent: true });
    inFlightRequestFiles.delete(name);
  }
}

// RN liveness for the native typed-op consumer (McpTypedOpConsumer.kt, PR 6):
// it hands a run_agent that no always-allow rule clears to this bridge (by
// moving the request into requests/) only while this file holds a time less
// than 2 s old; otherwise it refuses `not_attended` at once instead of letting
// the call stall. Written every drain cycle (no timer of its own); RN pauses
// its timers in the background, so the value goes stale there by itself.
// Only while Shelly is in the foreground (step 9 would refuse anyway): any
// other AppState writes 0, at once on the transition (listener) and on every
// drain cycle, so a backgrounded app is not live even before its timers pause.
export const BRIDGE_HEARTBEAT_FILE = `${QUEUE_DIR}/bridge-heartbeat`;

async function writeBridgeHeartbeat(): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(BRIDGE_HEARTBEAT_FILE, appIsForeground() ? String(Date.now()) : '0');
  } catch {
    // Best effort: a missing / stale heartbeat only makes native fail fast.
  }
}

let appStateSubscription: { remove: () => void } | null = null;

function watchAppStateForHeartbeat(): void {
  if (appStateSubscription) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppState } = require('react-native');
    const sub = AppState?.addEventListener?.('change', () => {
      if (!stopped) void writeBridgeHeartbeat();
    });
    appStateSubscription = sub && typeof sub.remove === 'function' ? sub : null;
  } catch {
    appStateSubscription = null;
  }
}

async function drainOnce(): Promise<void> {
  await writeBridgeHeartbeat();
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
  watchAppStateForHeartbeat();
  void pollLoop();
}

export function stopMCPPoller(): void {
  stopped = true;
  abortRunResultWaits();
  appStateSubscription?.remove();
  appStateSubscription = null;
  // Not live from now on (best effort; a stale value means the same after 2 s).
  void Promise.resolve()
    .then(() => FileSystem.writeAsStringAsync(BRIDGE_HEARTBEAT_FILE, '0'))
    .catch(() => {});
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
