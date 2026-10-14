/**
 * lib/agent-add-queue.ts — `shelly agent add "<natural language>"` shell → RN
 * bridge (2026-10-14).
 *
 * Purpose: let the ChatGPT app (driving Codex through `codex remote-control`
 * hosted in a Shelly PTY tab) ASK Shelly to register an autonomous agent. The
 * request is only a seed for the SAME in-app `@agent <NL>` flow the user gets
 * by typing in the AI pane (NL parser → slot-fill / LLM clarification →
 * plain-language chat confirmation → install). Nothing is ever registered
 * without the user's own confirmation in Shelly's chat, and the shell side
 * never writes `~/.shelly/agents/*.json` (it only READS them for
 * `shelly agent list`).
 *
 * Wire format (one request per file, Knox blocks `am start`, so this is the
 * same file-queue pattern as `shelly closepaw` — lib/closepaw-queue.ts):
 *
 *   $HOME/.shelly-agent-req-<reqId>   (written to `<name>.tmp`, then renamed)
 *   agentadd:<reqId>:<tsMs>:<encodeURIComponent(text)>\n
 *
 * Owners:
 *   - RN (app/_layout.tsx drainAgentAddRequests) is the ONLY consumer of the
 *     request text. While the app is active it claims a request file by an
 *     atomic rename, validates it with parseAgentAddLine below, focuses an AI
 *     pane and queues `@agent <text>` through ai-pane-store's
 *     pendingExternalPrompt with source 'terminal-request', then answers the
 *     shim with `.shelly-agent-result-<reqId>.json` (code 'sent').
 *   - Native AgentAddHandoff.kt never reads the text into any flow. When
 *     Shelly is NOT the foreground app (or RN has not claimed the request
 *     within a few seconds) it renames the request to
 *     `$HOME/.shelly-agent-pending-<reqId>`, posts "Shelly: confirm new agent"
 *     (tap opens Shelly) and answers the shim with code 'notified'. RN picks
 *     pending files up once it is foregrounded, without answering the shim
 *     again. The atomic rename decides the RN/native race: exactly one wins.
 *
 * Every request (req or pending) expires AGENT_ADD_MAX_AGE_MS after the shim
 * wrote it, so a request that nobody confirmed never surfaces later.
 *
 * The text is UNTRUSTED (it comes from an LLM / a remote app). It is:
 *   - capped (AGENT_ADD_MAX_CODE_POINTS code points) and control/bidi chars
 *     stripped (sanitizeAgentAddText),
 *   - restricted to a NEW-agent request: the reserved `@agent` sub-commands
 *     (run/stop/delete/edit/list/history/status) and leading `@` / `/` are
 *     refused, so a remote caller can never run, stop, delete or edit an
 *     existing agent through this path (validateAgentAddText),
 *   - shown in the chat with an explicit "Requested from the terminal (e.g.
 *     Codex / ChatGPT)" origin line (components/panes/AIPane.tsx),
 *   - forced through the interactive confirmation regardless of the
 *     agentRegistrationRequireConfirm setting (resolveRegistrationConfirm
 *     Requirement 'terminal-request', plus markTerminalAgentRequest below so
 *     slot-fill follow-up turns also stay confirm-gated).
 */

export const AGENT_ADD_PREFIX = 'agentadd:';
/** Requests older than this are dropped (never surfaced, never confirmed). */
export const AGENT_ADD_MAX_AGE_MS = 10 * 60 * 1000;
/** Allowed clock skew for a timestamp slightly in the future. */
export const AGENT_ADD_MAX_FUTURE_MS = 5_000;
/** RN hands at most one request to the chat per interval; extra requests
 *  wait in their files for a later tick (and expire after 10 min). */
export const AGENT_ADD_MIN_INTERVAL_MS = 5_000;
export const AGENT_ADD_MAX_CODE_POINTS = 2000;
/** A 2000-code-point text percent-encodes to at most 2000 * 12 chars. */
export const AGENT_ADD_MAX_ENCODED_CHARS = 24_000;
/** The shim refuses a new request while this many are already waiting. */
export const AGENT_ADD_MAX_PENDING = 5;
/** After a terminal request reaches the chat, every agent registration stays
 *  confirm-gated for this long (covers slot-fill follow-up turns). */
export const TERMINAL_AGENT_REQUEST_CONFIRM_WINDOW_MS = 30 * 60 * 1000;

export const AGENT_ADD_REQUEST_FILE_PREFIX = '.shelly-agent-req-';
export const AGENT_ADD_PENDING_FILE_PREFIX = '.shelly-agent-pending-';
export const AGENT_ADD_CLAIM_FILE_PREFIX = '.shelly-agent-claim-';

export const AGENT_ADD_MSG_SENT = "Sent to Shelly — confirm the new agent in Shelly's chat";
export const AGENT_ADD_MSG_NOTIFIED = 'Shelly is in the background — tap the notification to confirm';

const REQ_ID_RE = /^[0-9]{10,16}-[0-9a-f]{8}$/;
const TS_RE = /^[0-9]{10,16}$/;
const REQUEST_FILE_RE = /^\.shelly-agent-(req|pending)-([0-9]{10,16}-[0-9a-f]{8})$/;

/** C0/C1 controls, plus bidi overrides/isolates and zero-width/BOM chars that
 *  could make the text shown in the chat differ from what is parsed. */
const UNSAFE_CHARS_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g;

/** `@agent` sub-commands that act on EXISTING agents (lib/agent-manager.ts
 *  parseAgentCommand). A terminal request may only describe a new agent. */
const RESERVED_FIRST_WORDS = new Set(['list', 'run', 'stop', 'delete', 'history', 'edit', 'status']);

export type AgentAddResultCode =
  | 'sent'
  | 'notified'
  | 'queued'
  | 'rate-limited'
  | 'stale'
  | 'invalid'
  | 'failed';

export type AgentAddParse =
  | { ok: true; reqId: string; tsMs: number; text: string }
  | { ok: false; reqId: string | null; reason: 'malformed' | 'stale' | 'empty' | 'reserved' };

export function sanitizeAgentAddText(raw: string | null | undefined): string {
  const collapsed = String(raw ?? '')
    .replace(UNSAFE_CHARS_RE, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/^ +| +$/g, '');
  const codePoints = Array.from(collapsed);
  if (codePoints.length <= AGENT_ADD_MAX_CODE_POINTS) return collapsed;
  return codePoints.slice(0, AGENT_ADD_MAX_CODE_POINTS).join('').replace(/ +$/g, '');
}

/** null = acceptable new-agent request text; otherwise the refusal reason. */
export function validateAgentAddText(text: string): 'empty' | 'reserved' | null {
  const trimmed = text.trim();
  if (!trimmed) return 'empty';
  if (trimmed.startsWith('@') || trimmed.startsWith('/')) return 'reserved';
  const first = (trimmed.split(/\s+/)[0] ?? '').toLowerCase();
  if (RESERVED_FIRST_WORDS.has(first)) return 'reserved';
  return null;
}

export function encodeAgentAddLine(reqId: string, tsMs: number, text: string): string {
  return `${AGENT_ADD_PREFIX}${reqId}:${tsMs}:${encodeURIComponent(text)}`;
}

/** Pure validation of one request record. Never throws. */
export function parseAgentAddLine(line: string, nowMs: number): AgentAddParse {
  if (typeof line !== 'string') return { ok: false, reqId: null, reason: 'malformed' };
  const trimmed = line.replace(/\r?\n$/, '');
  if (!trimmed.startsWith(AGENT_ADD_PREFIX)) return { ok: false, reqId: null, reason: 'malformed' };
  const parts = trimmed.slice(AGENT_ADD_PREFIX.length).split(':');
  if (parts.length !== 3) return { ok: false, reqId: null, reason: 'malformed' };
  const [reqIdRaw, tsRaw, encoded] = parts;
  const reqId = REQ_ID_RE.test(reqIdRaw) ? reqIdRaw : null;
  if (!reqId || !TS_RE.test(tsRaw) || encoded.length > AGENT_ADD_MAX_ENCODED_CHARS) {
    return { ok: false, reqId, reason: 'malformed' };
  }
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || nowMs - ts > AGENT_ADD_MAX_AGE_MS || ts - nowMs > AGENT_ADD_MAX_FUTURE_MS) {
    return { ok: false, reqId, reason: 'stale' };
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return { ok: false, reqId, reason: 'malformed' };
  }
  const text = sanitizeAgentAddText(decoded);
  const invalid = validateAgentAddText(text);
  if (invalid) return { ok: false, reqId, reason: invalid };
  return { ok: true, reqId, tsMs: ts, text };
}

/** The exact AI-pane input a validated request becomes — the same text the
 *  user would type to start the in-app agent-creation flow. */
export function buildAgentAddPrompt(text: string): string {
  return `@agent ${text}`;
}

// ── Control requests: `shelly agent confirm <reqId> <hash8>` / `reject <reqId>` ──

export const AGENT_CTL_PREFIX = 'agentctl:';
export const AGENT_CTL_FILE_PREFIX = '.shelly-agent-ctl-';
/** A control request is answered within seconds or not at all. */
export const AGENT_CTL_MAX_AGE_MS = 60_000;
const CTL_FILE_RE = /^\.shelly-agent-ctl-[0-9]{10,16}-[0-9a-f]{8}$/;
const SUMMARY_FILE_RE = /^\.shelly-agent-summary-([0-9]{10,16}-[0-9a-f]{8})\.json$/;
const CTL_HASH_PREFIX_RE = /^[0-9a-f]{8}$/;

export type AgentCtlRequest =
  /** hashPrefix: first 8 hex of the definition hash printed in the summary
   *  (a binding, not a secret — lib/agent-add-approval.ts). */
  | { ctlId: string; op: 'confirm'; reqId: string; hashPrefix: string }
  | { ctlId: string; op: 'reject'; reqId: string }
  /** `shelly closepaw confirm <reqId> <hash8>` / `reject <reqId>` (Shelly-
   *  trusted ClosePaw variant — lib/closepaw-shell-approval.ts). */
  | { ctlId: string; op: 'closepaw-confirm'; reqId: string; hashPrefix: string }
  | { ctlId: string; op: 'closepaw-reject'; reqId: string };

/** `agentctl:<ctlId>:<tsMs>:<confirm|reject>:<reqId>[:<hash8>]`. Never throws. */
export function parseAgentCtlLine(line: string, nowMs: number): AgentCtlRequest | null {
  if (typeof line !== 'string' || !line.startsWith(AGENT_CTL_PREFIX)) return null;
  const parts = line.replace(/\r?\n$/, '').slice(AGENT_CTL_PREFIX.length).split(':');
  if (parts.length < 4 || parts.length > 5) return null;
  const [ctlId, tsRaw, op, reqId, hashPrefix] = parts;
  if (!REQ_ID_RE.test(ctlId) || !TS_RE.test(tsRaw) || !REQ_ID_RE.test(reqId)) return null;
  const ts = Number(tsRaw);
  if (nowMs - ts > AGENT_CTL_MAX_AGE_MS || ts - nowMs > AGENT_ADD_MAX_FUTURE_MS) return null;
  if (op === 'confirm' && parts.length === 5 && CTL_HASH_PREFIX_RE.test(hashPrefix)) return { ctlId, op, reqId, hashPrefix };
  if (op === 'reject' && parts.length === 4) return { ctlId, op, reqId };
  if (op === 'closepaw-confirm' && parts.length === 5 && CTL_HASH_PREFIX_RE.test(hashPrefix)) return { ctlId, op, reqId, hashPrefix };
  if (op === 'closepaw-reject' && parts.length === 4) return { ctlId, op, reqId };
  return null;
}

export function agentCtlResultFileName(ctlId: string): string {
  if (!REQ_ID_RE.test(ctlId)) throw new Error('invalid agent ctl id');
  return `.shelly-agent-ctlresult-${ctlId}.json`;
}

export function agentAddSummaryFileName(reqId: string): string {
  if (!REQ_ID_RE.test(reqId)) throw new Error('invalid agent-add reqId');
  return `.shelly-agent-summary-${reqId}.json`;
}

export type AgentAddFileRef = { name: string; kind: 'req' | 'pending'; reqId: string };

/** Pick request files out of a $HOME listing, oldest reqId first. */
export function listAgentAddRequestFiles(names: readonly string[]): AgentAddFileRef[] {
  const out: AgentAddFileRef[] = [];
  for (const name of names) {
    const m = REQUEST_FILE_RE.exec(name);
    if (m) out.push({ name, kind: m[1] as 'req' | 'pending', reqId: m[2] });
  }
  return out.sort((a, b) => (a.reqId < b.reqId ? -1 : a.reqId > b.reqId ? 1 : 0));
}

export function agentAddClaimFileName(reqId: string): string {
  if (!REQ_ID_RE.test(reqId)) throw new Error('invalid agent-add reqId');
  return `${AGENT_ADD_CLAIM_FILE_PREFIX}${reqId}`;
}

export function agentAddResultFileName(reqId: string): string {
  if (!REQ_ID_RE.test(reqId)) throw new Error('invalid agent-add reqId');
  return `.shelly-agent-result-${reqId}.json`;
}

/** Shim-facing message for a rejected request. */
export function agentAddRejectMessage(reason: 'malformed' | 'stale' | 'empty' | 'reserved'): string {
  switch (reason) {
    case 'stale':
      return 'shelly agent add: the request expired before Shelly could show it; nothing was registered';
    case 'empty':
      return 'shelly agent add: the request is empty';
    case 'reserved':
      return 'shelly agent add: only new-agent requests are accepted (run/stop/delete/edit existing agents in Shelly itself)';
    default:
      return 'shelly agent add: malformed request';
  }
}

// ── Confirm-gate marker (runtime only, never persisted) ────────────────────

// Review fix (2026-10-14): this marker ONLY tightens confirm-gating, per
// conversation. It never decides which request a draft belongs to — that is
// carried on the draft itself (ParsedAgentDraft.terminalRequestId, set only
// for a dispatch whose source is 'terminal-request'), so a user's own
// `@agent` draft can never be bound to (or summarized for) a terminal request.
const terminalRequestAtByConversation = new Map<string, number>();

/** Called when a terminal request is handed to an AI pane conversation. */
export function markTerminalAgentRequest(conversationKey: string, nowMs: number = Date.now()): void {
  terminalRequestAtByConversation.set(conversationKey, nowMs);
}

/** True while a terminal-originated request handed to THIS conversation may
 *  still be in its slot-fill / confirmation turns. Callers force the
 *  interactive confirmation then (fail-closed; never relaxes anything). */
export function isTerminalAgentRequestActive(conversationKey: string, nowMs: number = Date.now()): boolean {
  const at = terminalRequestAtByConversation.get(conversationKey);
  return at !== undefined && nowMs - at <= TERMINAL_AGENT_REQUEST_CONFIRM_WINDOW_MS;
}

/** Valid request id shape (for ids carried on drafts / dispatch options). */
export function isAgentAddRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQ_ID_RE.test(value);
}

/** Epoch ms encoded in a request id (its creation time on the shell side). */
export function agentAddRequestTimestamp(reqId: string): number {
  return REQ_ID_RE.test(reqId) ? Number(reqId.split('-')[0]) : 0;
}

/** Test hook. */
export function __resetTerminalAgentRequestMarkerForTests(): void {
  terminalRequestAtByConversation.clear();
}

// ── RN drain (app/_layout.tsx) ─────────────────────────────────────────────

export type AgentAddResult = { ok: boolean; code: AgentAddResultCode; message: string };

/** File operations and app hooks the drain needs; every name is relative to
 *  $HOME. Injected so the drain is unit-testable without expo-file-system. */
export type AgentAddDrainDeps = {
  /** True only while Shelly is the active (foreground) app and the pane
   *  layout has hydrated — RN never claims a request in the background. */
  isActive: () => boolean;
  /** False while a previous external prompt is still waiting to be claimed
   *  by an AI pane (one slot; a second hand-off would overwrite it). */
  canAcceptPrompt: () => boolean;
  listHome: () => Promise<string[]>;
  /** Atomic rename; false when the source is gone (someone else claimed it). */
  move: (from: string, to: string) => Promise<boolean>;
  /** File content, or null when unreadable / over the size cap. */
  read: (name: string) => Promise<string | null>;
  remove: (name: string) => Promise<void>;
  writeResult: (reqId: string, result: AgentAddResult) => Promise<void>;
  /** Focus an AI pane and queue the prompt (source 'terminal-request').
   *  Returns false when no AI pane could be opened. */
  handOff: (prompt: string, reqId: string) => boolean;
  /** `shelly agent confirm|reject` control request (lib/agent-add-flow.ts). */
  handleCtl: (ctl: AgentCtlRequest) => Promise<AgentAddResult>;
  writeCtlResult: (ctlId: string, result: AgentAddResult) => Promise<void>;
  now: () => number;
  log?: (message: string) => void;
};

export type AgentAddDrainState = { lastHandOffAt: number };

export function createAgentAddDrainState(): AgentAddDrainState {
  return { lastHandOffAt: Number.NEGATIVE_INFINITY };
}

function reqIdTimestamp(reqId: string): number {
  return Number(reqId.split('-')[0]);
}

/**
 * One drain pass. Hands at most ONE valid request to the chat, oldest first;
 * the rest stay in their files for a later pass. Only `req` files (the shim
 * is still waiting) get a result file; `pending` files were already answered
 * by the native notification path. Returns the number handed off (0/1).
 */
export async function drainAgentAddRequests(
  deps: AgentAddDrainDeps,
  state: AgentAddDrainState,
): Promise<number> {
  if (!deps.isActive()) return 0;
  const names = await deps.listHome();
  const now = deps.now();

  // A claim left behind by a crash between rename and delete: drop it once
  // its request would have expired anyway (never replayed).
  for (const name of names) {
    if (!name.startsWith(AGENT_ADD_CLAIM_FILE_PREFIX)) continue;
    const reqId = name.slice(AGENT_ADD_CLAIM_FILE_PREFIX.length).replace(/^ctl-/, '');
    if (REQ_ID_RE.test(reqId) && now - reqIdTimestamp(reqId) > AGENT_ADD_MAX_AGE_MS) {
      await deps.remove(name);
    }
  }

  // Summaries (`shelly agent show`) outlive their request by one TTL at most.
  for (const name of names) {
    const m = SUMMARY_FILE_RE.exec(name);
    if (m && now - reqIdTimestamp(m[1]) > 2 * AGENT_ADD_MAX_AGE_MS) await deps.remove(name);
  }

  // Control requests (`shelly agent confirm|reject`): all of them, oldest
  // first. A confirm carries the definition-hash prefix the summary printed
  // (a binding to the shown definition, checked in lib/agent-add-flow.ts).
  for (const name of names.filter((n) => CTL_FILE_RE.test(n)).sort()) {
    const ctlId = name.slice(AGENT_CTL_FILE_PREFIX.length);
    const claim = `${AGENT_ADD_CLAIM_FILE_PREFIX}ctl-${ctlId}`;
    if (!(await deps.move(name, claim))) continue;
    const content = await deps.read(claim);
    await deps.remove(claim);
    const end = content ? content.lastIndexOf('\n') : -1;
    const records = content && end >= 0 ? content.slice(0, end).split('\n').filter((l) => l.trim()) : [];
    const ctl = records.length === 1 ? parseAgentCtlLine(records[0], now) : null;
    if (!ctl || ctl.ctlId !== ctlId) {
      await deps.writeCtlResult(ctlId, { ok: false, code: 'invalid', message: 'shelly agent: malformed or expired control request' });
      continue;
    }
    let result: AgentAddResult;
    try {
      result = await deps.handleCtl(ctl);
    } catch {
      result = { ok: false, code: 'failed', message: 'shelly agent: Shelly failed to process the request' };
    }
    await deps.writeCtlResult(ctlId, result);
  }

  for (const file of listAgentAddRequestFiles(names)) {
    const expired = now - reqIdTimestamp(file.reqId) > AGENT_ADD_MAX_AGE_MS;
    if (!expired) {
      if (now - state.lastHandOffAt < AGENT_ADD_MIN_INTERVAL_MS) return 0;
      if (!deps.canAcceptPrompt()) return 0;
    }
    const claim = agentAddClaimFileName(file.reqId);
    if (!(await deps.move(file.name, claim))) continue;
    const content = await deps.read(claim);
    await deps.remove(claim);

    // Exactly one complete, newline-terminated record per file.
    const end = content ? content.lastIndexOf('\n') : -1;
    const records = content && end >= 0 ? content.slice(0, end).split('\n').filter((l) => l.trim()) : [];
    const parsed: AgentAddParse =
      records.length === 1
        ? parseAgentAddLine(records[0], now)
        : { ok: false, reqId: file.reqId, reason: 'malformed' };
    if (!parsed.ok || parsed.reqId !== file.reqId) {
      const reason = 'reason' in parsed ? parsed.reason : 'malformed';
      deps.log?.(`agent add: ${file.kind} ${file.reqId} rejected (${reason})`);
      if (file.kind === 'req') {
        await deps.writeResult(file.reqId, {
          ok: false,
          code: reason === 'stale' ? 'stale' : 'invalid',
          message: agentAddRejectMessage(reason),
        });
      }
      continue;
    }

    const opened = deps.handOff(buildAgentAddPrompt(parsed.text), parsed.reqId);
    state.lastHandOffAt = now;
    deps.log?.(`agent add: ${file.kind} ${file.reqId} handed to the AI pane (opened=${opened}, ${parsed.text.length} chars)`);
    if (file.kind === 'req') {
      await deps.writeResult(
        file.reqId,
        opened
          ? { ok: true, code: 'sent', message: AGENT_ADD_MSG_SENT }
          : {
              ok: false,
              code: 'failed',
              message:
                'shelly agent add: Shelly could not open an AI pane (layout full) — open an AI pane in Shelly and run the command again',
            },
      );
    }
    return 1;
  }
  return 0;
}
