/**
 * lib/agent-run-without-approval.ts — per-agent "承認なしで実行" (run without
 * approval), product owner request 2026-10-31.
 *
 * What the option is FOR (owner intent): let an attended run proceed without
 * the ROUTINE asks seen on device — reading outside the project root
 * (`cd ~/demo && git log --oneline -20; ls -la; head -50 README*`) and edits
 * inside the agent's own workspace. It is NOT a grant of arbitrary writes
 * outside the workspace.
 *
 * When ON for an agent, the RN approval choke points in app/_layout.tsx
 * (drainAgentEscalationRequests / drainAgentActionApprovalRequests) answer
 * exactly these asks of that agent's runs themselves, with the SAME
 * Keystore-signed reply the notification tap produces:
 *
 *   - CLI worker gate escalations (scripts/shelly-agent-driver.js
 *     gateCommandActions → "境界操作を許可しますか？") that are
 *       (a) a PURE READ — every segment is an allow-listed read-only tool
 *           (cat / head / tail / grep / rg / ls / git log|show|diff|status …,
 *           `find` without -delete/-exec, plus `cd`/`pushd`), no redirection,
 *           no expansion, nothing under a dot-directory (~/.bashrc, ~/.shelly*,
 *           ~/.ssh …) or shared_prefs / no_backup; or
 *       (b) a write that stays INSIDE the agent's workspace root — the gate
 *           raised no `leaves-root`, the request's root equals the root of
 *           the (hash-verified) agent definition, the cwd is inside it, every
 *           segment is an allow-listed file-edit tool (tee / cp / mv / mkdir /
 *           touch / rm / sed / git add|commit …), and no token has a glob,
 *           `~`, `$`, `..`, a dot-directory or a path outside the root, and
 *           there is no `cd` / `pushd` at all.
 *     This module re-derives (a) / (b) from the command itself: the request's
 *     own signal list is only used to REFUSE (any signal other than
 *     leaves-root / write-or-exec refuses; leaves-root refuses every write).
 *     The gate's "pure read" (READ_ONLY_RE) is not trusted for this: it
 *     counts `find / -delete`, `rg --pre`, `git log --output=…` as reads, and
 *     `cd` as a write. Signed via the native
 *     resolveAgentEscalationAutoApproval, which never mints a preapproval
 *     grant.
 *   - per-run action approvals of the local-only types in
 *     AUTO_APPROVABLE_ACTION_TYPES (draft save / local notification).
 *
 * Never auto-answered, flag or not:
 *   - anything the gate already denied (command-safety CRITICAL, POLICY-001
 *     deny, policy-write …) — the driver declines those before filing a
 *     request; as defence in depth this module re-runs checkCommandSafety and
 *     refuses CRITICAL / HIGH;
 *   - escalations carrying any other signal (network-send, secret-read,
 *     destructive, opaque-script-exec, indirect-exec, policy-write …);
 *   - any write combined with leaves-root (`cp x ~/.bashrc`, `cp x ~/bin/git`,
 *     `rm /sdcard/DCIM/a.jpg`, `find /sdcard -delete`, `mv /sdcard/Documents …`);
 *   - REVIEW_REQUIRED_ACTION_TYPES (cli / intent / dm-reply / browser-pane /
 *     social-post) and every outward-sending action (webhook / api-call);
 *   - POLICY-001 deny / draft_only / ask, a proactive-origin (notification-
 *     triggered / tainted) run (the caller passes policyBlocksAutoAccept).
 *
 * Trust model: the flag is NOT a field of the agent definition. Agent
 * definitions live in ~/.shelly/agents/<id>.json, a file any same-uid agent
 * process can rewrite. The flag lives ONLY in the Android-Keystore-backed
 * expo-secure-store (same pattern as lib/agent-closepaw-preapproval.ts): a
 * run cannot produce a valid ciphertext. Each entry also carries a hash of
 * the agent definition the user turned it ON for
 * (runWithoutApprovalDefinitionHash: prompt, steps, actions, schedule,
 * trigger, tool, workspace root, autonomy level, output path …). On every
 * use the hash is recomputed from the CURRENT definition; a mismatch — the
 * JSON was rewritten by a run, or the user edited the agent — reads as OFF
 * (the user re-toggles it). The only writers are the agent detail toggle
 * (Sidebar) and the typed-OK chat registration
 * (hooks/use-ai-pane-dispatch.ts confirmAgentDraftInner).
 * 2026-11-01: a second, opt-in level 'all' (すべて承認なしで実行) — see
 * RunWithoutApprovalLevel and the soft / hard table above
 * escalationAutoApprovable. Everything above describes the 'standard' level.
 * Residual (DEFERRED.md): a same-uid process could restore an OLDER
 * SecureStore blob (rollback to a time the flag was ON); git subcommands
 * allowed as reads honour the repository's own config (core.fsmonitor …).
 */
import { checkCommandSafety } from '@/lib/command-safety';
import { REVIEW_REQUIRED_ACTION_TYPES } from '@/lib/agent-action-types';
import { dequoteShellWords, isWithinRoot, normalizePath, validateWorkspaceRoot } from '@/lib/agent-boundary-policy';
import { sha256Hex } from '@/lib/sha256';
import { hasExplicitWebCue, isResearchStep } from '@/lib/agent-sources';
import { isShellyRuntimeHomeEntry } from '@/lib/agent-workspace-from-request';

const STORE_KEY = 'shelly_run_without_approval_v2';
const MAX_ENTRIES = 500;
const HEX_SHA256_RE = /^[0-9a-f]{64}$/;

export type RunWithoutApprovalVia = 'detail' | 'chat';

/**
 * 2026-11-01: two levels. 'standard' = the original option (module doc
 * above). 'all' = "すべて承認なしで実行" — on ATTENDED runs only, every
 * escalation the gate hands to a human is answered too, except the hard
 * refusals listed in the table above escalationAutoApprovable. Default OFF,
 * opt-in only, stored next to the entry in the same Keystore-backed blob.
 */
export type RunWithoutApprovalLevel = 'standard' | 'all';
export type RunWithoutApprovalSetting = 'off' | RunWithoutApprovalLevel;

export type RunWithoutApprovalEntry = {
  agentId: string;
  enabledAt: number;
  via: RunWithoutApprovalVia;
  /** runWithoutApprovalDefinitionHash() of the definition it was enabled for. */
  definitionHash: string;
  /** Absent on entries written before 2026-11-01 — they read as 'standard'
   *  (an entry existing = ON, exactly as before). Any value other than
   *  'all' also reads as 'standard': a malformed level never RAISES it. */
  level?: RunWithoutApprovalLevel;
};

/** The level an entry grants: only an explicit 'all' is 'all'. */
export function entryLevel(entry: Pick<RunWithoutApprovalEntry, 'level'> | null | undefined): RunWithoutApprovalLevel {
  return entry && entry.level === 'all' ? 'all' : 'standard';
}

/** What decides whether an agent's runs read untrusted input. Agent
 *  (orchestration.steps) and draft (orchestrationSteps) shapes both fit. */
export type UntrustedInputAgentLike = {
  prompt?: string | null;
  tool?: unknown;
  orchestration?: unknown;
  orchestrationSteps?: unknown;
  notificationTrigger?: unknown;
  action?: unknown;
  actions?: unknown;
};

const UNTRUSTED_TOOL_TYPES = new Set(['perplexity', 'browser-pane', 'closepaw']);
/** Actions that read screen / web content back into the run. */
const UNTRUSTED_ACTION_TYPES = new Set(['browser-pane', 'closepaw', 'dm-reply']);
const URL_RE = /\bhttps?:\/\/|\bwww\.[a-z0-9-]+\./i;

function toolType(tool: unknown): string {
  return tool && typeof tool === 'object' && typeof (tool as { type?: unknown }).type === 'string'
    ? String((tool as { type: string }).type)
    : '';
}

/**
 * Security review H2 (2026-11-01): the "all" level only for agents whose runs
 * read no untrusted text — no web research step (Perplexity, an explicit web
 * cue), no URL in the task, no browser / ClosePaw step, no notification
 * trigger. Web text can carry instructions to a CLI worker (prompt
 * injection); with every ask answered, nothing would stop it. Such an agent
 * falls back to the standard level (the confirm text and the agent detail
 * say so).
 */
export function runWithoutApprovalAllAllowedFor(agent: UntrustedInputAgentLike | null | undefined): boolean {
  if (!agent) return false;
  if (agent.notificationTrigger) return false;
  if (UNTRUSTED_TOOL_TYPES.has(toolType(agent.tool))) return false;
  const prompt = String(agent.prompt ?? '');
  if (URL_RE.test(prompt) || hasExplicitWebCue(prompt)) return false;
  const rawSteps = Array.isArray(agent.orchestrationSteps)
    ? agent.orchestrationSteps
    : agent.orchestration && typeof agent.orchestration === 'object' && Array.isArray((agent.orchestration as { steps?: unknown }).steps)
      ? (agent.orchestration as { steps: unknown[] }).steps
      : [];
  for (const step of rawSteps) {
    const instruction = typeof step === 'string'
      ? step
      : step && typeof step === 'object' ? String((step as { instruction?: unknown }).instruction ?? '') : '';
    const stepTool = step && typeof step === 'object' ? toolType((step as { tool?: unknown }).tool) : '';
    if (UNTRUSTED_TOOL_TYPES.has(stepTool)) return false;
    if (URL_RE.test(instruction) || isResearchStep(instruction, stepTool || undefined)) return false;
  }
  const actions = [agent.action, ...(Array.isArray(agent.actions) ? agent.actions : [])];
  if (actions.some((a) => UNTRUSTED_ACTION_TYPES.has(toolType(a)))) return false;
  return true;
}

export type RunWithoutApprovalStorage = {
  get: () => Promise<string | null>;
  set: (value: string) => Promise<void>;
};

/** Structural view of an Agent — every field that decides what a run does. */
export type RunWithoutApprovalAgentLike = {
  id: string;
  prompt?: string;
  action?: unknown;
  actions?: unknown;
  orchestration?: unknown;
  schedule?: string | null;
  autonomous?: boolean;
  notificationTrigger?: unknown;
  tool?: unknown;
  workspaceRoot?: string | null;
  autonomyLevel?: string | null;
  requireActionApproval?: boolean;
  runOn?: string | null;
  outputPath?: string | null;
  outputTemplate?: string | null;
  memory?: unknown;
};

let storage: RunWithoutApprovalStorage | null = null;
let cache: RunWithoutApprovalEntry[] | null = null;
const listeners = new Set<() => void>();

function getStorage(): RunWithoutApprovalStorage {
  if (storage) return storage;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const SecureStore = require('expo-secure-store');
  storage = {
    get: () => SecureStore.getItemAsync(STORE_KEY),
    set: (v: string) => SecureStore.setItemAsync(STORE_KEY, v),
  };
  return storage;
}

/** Test hook. */
export function __setRunWithoutApprovalStorageForTests(s: RunWithoutApprovalStorage | null): void {
  storage = s;
  cache = null;
}

function warn(message: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { logWarn } = require('@/lib/debug-logger');
    logWarn('RunWithoutApproval', message);
  } catch {
    // logging is best-effort
  }
}

function isEntry(v: unknown): v is RunWithoutApprovalEntry {
  const e = v as RunWithoutApprovalEntry | null;
  return !!e && typeof e.agentId === 'string' && e.agentId.length > 0 && typeof e.enabledAt === 'number'
    && (e.via === 'detail' || e.via === 'chat')
    && typeof e.definitionHash === 'string' && HEX_SHA256_RE.test(e.definitionHash);
}

/** JSON round-trip: what survives ~/.shelly/agents/<id>.json. */
function asPersisted(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return value === undefined ? 'null' : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function nonEmptyArray(v: unknown): unknown {
  return Array.isArray(v) && v.length > 0 ? v : null;
}

/**
 * Hash of the agent definition the option is bound to. Same normalization
 * at enable time (the in-memory agent) and at use time (the agent the store
 * rebuilt from its on-disk JSON), so a reload never flips it while any edit
 * of what the agent does (by the user or by a run rewriting the JSON) does.
 */
export function runWithoutApprovalDefinitionHash(agent: RunWithoutApprovalAgentLike): string {
  const steps = agent.orchestration && typeof agent.orchestration === 'object'
    ? asPersisted((agent.orchestration as { steps?: unknown }).steps)
    : null;
  const canonical = {
    id: agent.id,
    prompt: agent.prompt ?? '',
    action: asPersisted(agent.action),
    actions: nonEmptyArray(asPersisted(agent.actions)),
    orchestrationSteps: nonEmptyArray(steps),
    schedule: agent.schedule ?? null,
    autonomous: agent.autonomous === true,
    notificationTrigger: asPersisted(agent.notificationTrigger),
    tool: asPersisted(agent.tool),
    workspaceRoot: agent.workspaceRoot ?? null,
    autonomyLevel: agent.autonomyLevel ?? null,
    requireActionApproval: agent.requireActionApproval === true,
    runOn: agent.runOn ?? null,
    outputPath: agent.outputPath ?? null,
    outputTemplate: agent.outputTemplate ?? null,
    memory: asPersisted(agent.memory),
  };
  return sha256Hex(`shelly-run-without-approval-v1\n${stableStringify(canonical)}`);
}

export async function loadRunWithoutApproval(): Promise<RunWithoutApprovalEntry[]> {
  if (cache) return cache;
  try {
    const raw = await getStorage().get();
    const parsed = raw ? JSON.parse(raw) : [];
    cache = Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    // Unreadable / undecryptable → fail closed: every agent OFF.
    cache = [];
  }
  return cache;
}

/**
 * Default OFF. true only when a Keystore-backed entry exists for this agent
 * AND its definition hash equals the hash of the CURRENT definition (a
 * rewritten / edited agent reads as OFF until the user turns it on again).
 */
export async function isRunWithoutApprovalEnabled(agent: RunWithoutApprovalAgentLike | null | undefined): Promise<boolean> {
  return (await getRunWithoutApprovalSetting(agent)) !== 'off';
}

/**
 * 'off' | 'standard' | 'all' — same verification as isRunWithoutApprovalEnabled
 * (Keystore entry + definition hash of the CURRENT definition); the level
 * comes only from that entry, never from the agent definition.
 */
export async function getRunWithoutApprovalSetting(
  agent: RunWithoutApprovalAgentLike | null | undefined,
): Promise<RunWithoutApprovalSetting> {
  if (!agent || !agent.id) return 'off';
  const entry = (await loadRunWithoutApproval()).find((e) => e.agentId === agent.id);
  if (!entry) return 'off';
  let current: string;
  try {
    current = runWithoutApprovalDefinitionHash(agent);
  } catch {
    return 'off';
  }
  if (current !== entry.definitionHash) {
    warn(`agent ${agent.id} definition changed since run-without-approval was enabled; treating it as OFF`);
    return 'off';
  }
  const level = entryLevel(entry);
  // H2: an agent that reads untrusted input never gets the "all" level.
  if (level === 'all' && !runWithoutApprovalAllAllowedFor(agent as UntrustedInputAgentLike)) return 'standard';
  return level;
}

export function subscribeRunWithoutApproval(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** User-only writer: the agent detail toggle or the typed-OK chat
 *  registration. Never called from anything an agent run can drive.
 *  `setting`: true / 'standard' = the standard level, 'all' = the "all"
 *  level, false / 'off' = OFF. */
export async function setRunWithoutApproval(
  agent: RunWithoutApprovalAgentLike,
  setting: boolean | RunWithoutApprovalSetting,
  via: RunWithoutApprovalVia,
  now: number = Date.now(),
): Promise<void> {
  if (!agent || !agent.id) return;
  let level: RunWithoutApprovalSetting = setting === true ? 'standard' : setting === false ? 'off' : setting;
  // H2: never store "all" for an agent that reads untrusted input.
  if (level === 'all' && !runWithoutApprovalAllAllowedFor(agent as UntrustedInputAgentLike)) level = 'standard';
  const list = (await loadRunWithoutApproval()).filter((e) => e.agentId !== agent.id);
  const entry: RunWithoutApprovalEntry | null = level === 'off'
    ? null
    : {
        agentId: agent.id,
        enabledAt: now,
        via,
        definitionHash: runWithoutApprovalDefinitionHash(agent),
        // 'standard' is written without the field, byte-compatible with the
        // pre-level format (an older build reading it sees the same entry).
        ...(level === 'all' ? { level: 'all' as const } : {}),
      };
  const next = entry ? [...list, entry].slice(-MAX_ENTRIES) : list;
  await getStorage().set(JSON.stringify(next));
  cache = next;
  for (const fn of listeners) {
    try { fn(); } catch { /* listener errors never block the write */ }
  }
}

/** Deleting an agent drops its entry (an agent re-created later under the
 *  same id must not inherit it). */
export async function forgetRunWithoutApproval(agentId: string): Promise<void> {
  const list = await loadRunWithoutApproval();
  if (list.some((e) => e.agentId === agentId)) await setRunWithoutApproval({ id: agentId }, false, 'detail');
}

// ── Decisions (pure) ─────────────────────────────────────────────────────

/** Action types the option answers. Local-only (no data leaves the device):
 *  'draft' = file write inside the scoped output roots, 'notify' = a local
 *  Android notification. webhook / api-call are non-review today but send
 *  data off the device, so they deliberately keep the human tap. */
export const AUTO_APPROVABLE_ACTION_TYPES = ['draft', 'notify'] as const;

/** Gate signals an auto-answered escalation may carry — nothing else. Note
 *  `leaves-root` is only ever acceptable for a pure read (see module doc). */
export const ESCALATION_AUTO_SIGNALS: ReadonlySet<string> = new Set(['leaves-root', 'write-or-exec']);

/** The default driver cwd when an agent has no workspaceRoot
 *  (lib/agent-executor.ts PROJECT_DIR). */
export const DEFAULT_AGENT_PROJECT_DIR = '~/projects/shelly-content-studio';

/** App trust / approval state, never auto-approved (read or write). */
const TRUST_STATE_RE = /shared_prefs|no_backup|(?:^|[\s/'"=:<>])\.shelly|shelly-agent-(?:escalation|preapproval|action)/i;

export type AutoApproveVerdict = { ok: true; kind?: 'read' | 'in-root-write' | 'all' } | { ok: false; reason: string };

export function actionAutoApprovable(
  request: { actionType?: string | null },
  opts: { enabled: boolean; policyBlocksAutoAccept?: boolean },
): AutoApproveVerdict {
  if (!opts.enabled) return { ok: false, reason: 'flag-off' };
  if (opts.policyBlocksAutoAccept) return { ok: false, reason: 'policy-ask' };
  const type = String(request.actionType ?? '');
  if ((REVIEW_REQUIRED_ACTION_TYPES as readonly string[]).includes(type)) return { ok: false, reason: 'review-required' };
  if (!(AUTO_APPROVABLE_ACTION_TYPES as readonly string[]).includes(type)) return { ok: false, reason: 'not-local-only' };
  return { ok: true };
}

/** The fields of a per-run action approval request this decision reads. */
export type ActionAutoApproveRequestLike = {
  runId: string;
  agentId: string;
  actionType?: string | null;
  requestSha256?: string | null;
  actionNonce?: string | null;
  expiresAt?: number | null;
  /** Executor-written, informational — only ever combined with RN's own run
   *  registry by `originOf` (lib/agent-policy-approval.ts trustedRequestOrigin). */
  origin?: string | null;
};

export type ActionAutoApproveDecision<T> = { ok: true; minted: T } | { ok: false; reason: string };

/**
 * The whole "承認なしで実行" decision for one per-run action approval
 * (app/_layout.tsx autoApproveActionForFlaggedAgent): the drained request,
 * then the natively MINTED copy (the exact bytes the signed reply is bound
 * to). Every refusal names its reason so the caller can log it:
 * flag-off | proactive | policy-ask | review-required | not-local-only |
 * minted-unreadable | minted-expired | minted-mismatch | minted-proactive.
 *
 * Origin of the minted copy (2026-10-31 on-device finding, build 2739): the
 * native read (AgentActionApprovalBridge.toMap) did not carry the request's
 * `origin` field, so every minted copy read as proactive and a flagged
 * agent's draft save was always handed to the human. The minted copy's
 * origin is used when native supplies it; with an older native build that
 * omits it, the drained copy's `origin` is used instead — the same
 * executor-written field of the same file, so no weaker than before — and
 * RN's run registry is still consulted for `minted.agentId` either way.
 */
export async function decideActionAutoApproval<T extends ActionAutoApproveRequestLike>(
  parsed: T,
  opts: {
    enabled: boolean;
    /** POLICY-001 deny / draft_only / ask, or a proactive origin. */
    policyBlocksAutoAccept: boolean;
    /** lib/agent-policy-approval.ts trustedRequestOrigin (registry AND file). */
    originOf: (req: { agentId?: string | null; origin?: string | null }) => 'user' | 'event';
    /** Native readAgentActionApprovalRequest, parsed. */
    readMinted: () => Promise<T | null>;
    now?: number;
  },
): Promise<ActionAutoApproveDecision<T>> {
  if (!opts.enabled) return { ok: false, reason: 'flag-off' };
  if (opts.originOf(parsed) !== 'user') return { ok: false, reason: 'proactive' };
  const first = actionAutoApprovable(parsed, { enabled: true, policyBlocksAutoAccept: opts.policyBlocksAutoAccept });
  if (first.ok === false) return first;
  const minted = await opts.readMinted();
  if (!minted || !minted.requestSha256 || !minted.actionNonce) return { ok: false, reason: 'minted-unreadable' };
  const now = opts.now ?? Date.now();
  if (minted.expiresAt && minted.expiresAt < now) return { ok: false, reason: 'minted-expired' };
  if (minted.agentId !== parsed.agentId || minted.actionType !== parsed.actionType) return { ok: false, reason: 'minted-mismatch' };
  const mintedOrigin = opts.originOf({ agentId: minted.agentId, origin: minted.origin ?? parsed.origin ?? null });
  if (mintedOrigin !== 'user') return { ok: false, reason: 'minted-proactive' };
  const second = actionAutoApprovable(minted, { enabled: true, policyBlocksAutoAccept: opts.policyBlocksAutoAccept });
  if (second.ok === false) return second;
  return { ok: true, minted };
}

// ── Command shape analysis (lexical, conservative) ───────────────────────

/** Read-only tools. A command name with a path (`/tmp/cat`, `./ls`) is not one. */
const READ_TOOLS = new Set([
  'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'ls', 'stat', 'file', 'wc', 'diff',
  'pwd', 'tree', 'du', 'realpath', 'readlink', 'basename', 'dirname', 'echo', 'true', 'git', 'find',
]);
const READ_GIT_SUBCOMMANDS = new Set(['log', 'show', 'diff', 'status', 'rev-parse', 'ls-files', 'blame', 'shortlog', 'describe']);
/** Options that make an otherwise read-only tool write a file or run a program. */
const READ_BANNED_OPTIONS: Record<string, RegExp> = {
  rg: /^--pre(?:-glob)?(?:=|$)|^--search-zip$|^-z$/,
  git: /^(?:-c|--ext-diff|--textconv|--paginate)$|^-c.|^--(?:output|config-env|exec-path|upload-pack|git-dir|work-tree)(?:=|$)/,
  find: /^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/,
  tree: /^-o$|^--output/,
};
/** File-edit tools an in-workspace write may use. */
const WRITE_TOOLS = new Set(['tee', 'cp', 'mv', 'mkdir', 'touch', 'rm', 'rmdir', 'sed', 'echo', 'printf', 'cat', 'ln', 'git', 'patch']);
const WRITE_GIT_SUBCOMMANDS = new Set(['add', 'commit', 'mv', 'rm', 'restore', 'checkout', 'switch', 'stash', 'apply']);
const DIR_CHANGE_TOOLS = new Set(['cd', 'pushd', 'popd']);
/** `find` options whose operand is a match pattern, not a path it opens. */
const FIND_PATTERN_OPTIONS = new Set(['-path', '-ipath', '-wholename', '-iwholename', '-name', '-iname', '-lname', '-ilname']);

/** `bash -lc '<script>'` → `<script>` (the driver flattens argv into this). */
function shellPayload(command: string): string {
  const m = /^\s*(?:\S*\/)?(?:ba|da|z|k)?sh\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*c[A-Za-z]*\s+([\s\S]+)$/.exec(command);
  return m ? m[1] : command;
}

function splitSegments(script: string): string[] {
  return script
    .split(/\|\||&&|[;|&\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A path component that starts with a dot (not `.` / `..`): ~/.bashrc,
 *  ~/.shelly-runtime, .git/hooks, .ssh … */
function hasDotComponent(token: string): boolean {
  return token.split('/').some((c) => c.length > 1 && c.startsWith('.') && c !== '..');
}

export type CommandShape =
  | { kind: 'read' }
  | { kind: 'write'; segments: string[][] }
  | { kind: 'refuse'; reason: string };

/**
 * Lexical shape of an escalated command: pure read, candidate in-root write,
 * or refused outright. Over-refuses on purpose: it dequotes before splitting,
 * so a quoted `;` / `>` / `$` in an argument refuses the command (a human
 * answers it) rather than being reasoned about.
 */
export function analyzeEscalationCommand(command: string): CommandShape {
  const raw = String(command ?? '');
  const script = dequoteShellWords(shellPayload(raw))
    // stderr plumbing that never names a file: fd dups (`2>&1`, `>&2`) and
    // redirects to /dev/null (`2>/dev/null`, `> /dev/null`, `&>/dev/null`).
    // The target must END at /dev/null — `>/dev/null.x` / `>/dev/null/../x`
    // are left in place and handled as the redirect they are.
    .replace(/(^|\s)\d?>&\d(?=$|[\s;&|)}])/g, '$1')
    .replace(/(^|\s)(?:\d|&)?>>?\s*\/dev\/null(?=$|[\s;&|)}])/g, '$1');
  if (!script.trim()) return { kind: 'refuse', reason: 'no-command' };
  if (TRUST_STATE_RE.test(raw) || TRUST_STATE_RE.test(script)) return { kind: 'refuse', reason: 'trust-state-path' };
  if (/[$`]/.test(script)) return { kind: 'refuse', reason: 'expansion' };
  if (/<\(|>\(|<</.test(script)) return { kind: 'refuse', reason: 'indirect' };
  // `{ …; }` brace grouping runs its list in the current shell: the bare
  // `{` / `}` words are syntax, not commands, and are dropped. Subshells
  // `( … )` are not unwrapped (they refuse as an unknown tool).
  const segments = splitSegments(script)
    .map((s) => s.split(/\s+/).filter(Boolean))
    .map((tokens) => {
      let t = tokens;
      while (t[0] === '{') t = t.slice(1);
      while (t.length > 0 && t[t.length - 1] === '}') t = t.slice(0, -1);
      return t;
    })
    .filter((tokens) => tokens.length > 0);
  if (segments.length === 0) return { kind: 'refuse', reason: 'no-command' };
  // A dot component (~/.bashrc, ~/.ssh, .git/hooks …) refuses — except a
  // `find` match PATTERN (`-path ./.git -prune`, `-name .env`), which names
  // nothing to open; that exemption holds for a pure read only.
  let findPatternDotPath = false;
  for (const tokens of segments) {
    for (let i = 0; i < tokens.length; i++) {
      if (!hasDotComponent(tokens[i].replace(/^\d?[<>]+/, ''))) continue;
      if (tokens[0] === 'find' && i > 1 && FIND_PATTERN_OPTIONS.has(tokens[i - 1])) {
        findPatternDotPath = true;
        continue;
      }
      return { kind: 'refuse', reason: 'protected-path' };
    }
  }

  // (a) pure read?
  const redirects = /[<>]/.test(script);
  let isRead = !redirects;
  if (isRead) {
    for (const tokens of segments) {
      const [cmd, ...args] = tokens;
      if (DIR_CHANGE_TOOLS.has(cmd)) continue;
      if (!READ_TOOLS.has(cmd)) { isRead = false; break; }
      const banned = READ_BANNED_OPTIONS[cmd];
      if (banned && args.some((a) => banned.test(a))) { isRead = false; break; }
      if (cmd === 'git') {
        const sub = args.find((a, i) => !a.startsWith('-') && !(i > 0 && args[i - 1] === '-C'));
        if (!sub || !READ_GIT_SUBCOMMANDS.has(sub)) { isRead = false; break; }
      }
    }
  }
  if (isRead) return { kind: 'read' };
  if (findPatternDotPath) return { kind: 'refuse', reason: 'protected-path' };

  // (b) candidate in-root write: shape only — the root check is the caller's.
  for (const tokens of segments) {
    const [cmd, ...args] = tokens;
    if (DIR_CHANGE_TOOLS.has(cmd)) return { kind: 'refuse', reason: 'dir-change-write' };
    if (!WRITE_TOOLS.has(cmd) && !READ_TOOLS.has(cmd)) return { kind: 'refuse', reason: `tool:${cmd}` };
    const banned = READ_BANNED_OPTIONS[cmd];
    if (banned && args.some((a) => banned.test(a))) return { kind: 'refuse', reason: `option:${cmd}` };
    if (cmd === 'git') {
      const sub = args.find((a) => !a.startsWith('-'));
      if (!sub || (!WRITE_GIT_SUBCOMMANDS.has(sub) && !READ_GIT_SUBCOMMANDS.has(sub))) return { kind: 'refuse', reason: 'git-subcommand' };
      if (args.some((a) => a === '-C')) return { kind: 'refuse', reason: 'dir-change-write' };
    }
    for (const t of tokens) {
      const bare = t.replace(/^\d?[<>]+/, '');
      if (/[*?[\]{}]/.test(bare)) return { kind: 'refuse', reason: 'glob' };
      if (bare.startsWith('~')) return { kind: 'refuse', reason: 'home-path' };
      if (bare.split('/').includes('..')) return { kind: 'refuse', reason: 'parent-path' };
      if (bare.startsWith('-') && /[/=~]/.test(bare)) return { kind: 'refuse', reason: 'option-path' };
    }
  }
  return { kind: 'write', segments };
}

/** Every spelling of `root`: `~` / `$HOME` expanded with each home path, and
 *  Android's /data/data ↔ /data/user/0 alias. */
function rootAliases(root: string, homePaths: readonly string[]): string[] {
  const out = new Set<string>();
  const r = String(root ?? '').trim();
  if (!r) return [];
  const bases: string[] = [];
  const homeRel = /^(?:~|\$HOME|\$\{HOME\})(\/.*)?$/.exec(r);
  if (homeRel) {
    for (const h of homePaths) {
      if (h) bases.push(`${h}${homeRel[1] ?? ''}`);
    }
  } else {
    bases.push(r);
  }
  for (const b of bases) {
    if (!b.startsWith('/')) continue;
    const n = normalizePath(b).replace(/\/$/, '');
    out.add(n);
    out.add(n.replace(/^\/data\/data\//, '/data/user/0/'));
    out.add(n.replace(/^\/data\/user\/0\//, '/data/data/'));
  }
  return [...out];
}

function tokenWithinAnyRoot(roots: readonly string[], token: string, cwd: string): boolean {
  if (token.startsWith('/')) return roots.some((r) => isWithinRoot(r, token));
  return isWithinRoot(cwd, token) && roots.some((r) => isWithinRoot(r, normalizePath(`${cwd}/${token}`)));
}

export type EscalationRequestLike = {
  command?: string | null;
  signals?: readonly string[] | null;
  state?: string | null;
  reason?: string | null;
  cwd?: string | null;
  workspaceRoot?: string | null;
};

export type EscalationAutoApproveOpts = {
  enabled: boolean;
  policyBlocksAutoAccept?: boolean;
  /** The workspace root of the hash-verified agent definition (or
   *  DEFAULT_AGENT_PROJECT_DIR). Absent ⇒ no in-root write is auto-approved. */
  trustedWorkspaceRoot?: string | null;
  /** Home directory spellings, to expand `~` in trustedWorkspaceRoot. */
  homePaths?: readonly string[];
  /** The level read from the Keystore entry (getRunWithoutApprovalSetting).
   *  Absent ⇒ 'standard'. */
  level?: RunWithoutApprovalLevel;
  /** true only for a run RN's own registry says the user started from the
   *  app. The "all" level applies only when this is true; otherwise the
   *  standard rules decide. */
  attended?: boolean;
};

/**
 * ── "all" level (すべて承認なしで実行) — soft / hard refusal table ─────────
 *
 * escalationAutoApprovable first runs the standard rules. When they refuse
 * and the level is 'all' on an ATTENDED run, the refusal reason decides:
 * a HARD reason is final (a human answers); a SOFT reason is lifted and the
 * command is re-judged by allLevelEscalationVerdict, which has its own hard
 * checks (bottom of the table). What "all" is for: file work anywhere in the
 * Shelly home (create / edit / move / delete) and read-only syntax checks.
 * It never runs code the agent can choose (security review H1, 2026-11-01):
 * a script the worker wrote, `node -e` / `python -c`, `$(…)`, `npm run`,
 * `make` … still ask, because the script's text names nothing this lexical
 * check could refuse.
 *
 *   reason (standard path)          | under 'all'
 *   --------------------------------+----------------------------------------
 *   flag-off                        | HARD
 *   policy-ask (POLICY-001 deny /   | HARD
 *     draft_only / ask, proactive)  |
 *   not-live (queued request)       | HARD
 *   not-boundary-gray (POLICY-001   | HARD
 *     ask rule / proactive floor)   |
 *   no-command / no-signals         | HARD
 *   signal:leaves-root              | soft
 *   signal:write-or-exec            | soft
 *   signal:destructive (HIGH only;  | soft
 *     CRITICAL is a gate deny)      |
 *   signal:opaque-script-exec       | HARD, except the read-only syntax
 *                                   |   checks `node --check|-c F`,
 *                                   |   `python3 -m py_compile F…`,
 *                                   |   `bash|sh -n F` with every F inside
 *                                   |   the trusted workspace (exact shape,
 *                                   |   no other options / pipes), and the
 *                                   |   bare version probes
 *                                   |   `node|python3|python|git|bash
 *                                   |   --version` (no other word)
 *   signal:indirect-exec            | HARD ($(…), backticks, eval, xargs, env)
 *   signal:secret-read              | HARD
 *   signal:network-send             | HARD (data leaves the device — same
 *                                   |   line as external-send actions)
 *   signal:policy-write / unknown   | HARD
 *   safety:CRITICAL                 | HARD
 *   safety:HIGH                     | soft
 *   trust-state-path (.shelly,      | HARD
 *     shared_prefs, approval files) |
 *   protected-path (dot component)  | soft, re-checked: ~/<dot-dir>, .ssh /
 *                                   |   .gnupg / .codex / .config / .shelly*
 *                                   |   …, .git/hooks|config and .env* stay
 *                                   |   HARD
 *   expansion ($ / backticks)       | HARD, re-checked: only $HOME / ${HOME}
 *                                   |   resolve, and a QUOTED heredoc body
 *                                   |   (<<'EOF') written by cat / tee into
 *                                   |   the workspace is literal text
 *   indirect (<( >( <<)             | process substitution HARD; a heredoc
 *                                   |   body is skipped only when plain
 *                                   |   cat / tee writes it into a file
 *                                   |   inside the trusted workspace
 *   dir-change-write                | soft (cd followed lexically; cd to an
 *                                   |   unknown place, cd -, pushd / popd
 *                                   |   HARD)
 *   tool:<x>                        | soft only for the file tools in
 *                                   |   ALL_LEVEL_TOOLS; any other tool HARD
 *   option:<x>                      | soft, re-checked (find -exec, rg --pre,
 *                                   |   git -c, sed e / w / -f … HARD)
 *   git-subcommand                  | soft for the read / write subcommands
 *                                   |   (add, commit, log …); network git and
 *                                   |   the rest HARD
 *   glob / home-path / parent-path  | soft (paths resolved, then checked)
 *   option-path                     | soft
 *   write-outside-root              | soft inside the app home, HARD outside
 *   no-trusted-root / unsafe-root / | soft (the trusted root only widens
 *     root-mismatch                 |   what may be named outside home)
 *   cwd-outside-root                | soft when the cwd is inside the app
 *                                   |   home or the trusted root, else HARD
 *
 *   hard checks of allLevelEscalationVerdict (new reasons):
 *     safety:CRITICAL (raw AND dequoted payload) · signal:<hard> ·
 *     trust-state-path · secret-file (.env*, id_rsa, *.pem/*.key/*.p12/
 *     *.jks/*.keystore, auth.json, credentials) · protected-path ·
 *     shelly-control-path (~/<dot-dir>, ~/bin, ~/lib, ~/usr, ~/etc,
 *     ~/models, ~/storage, ~/shelly-*) · unresolved-path (a path that cannot
 *     be resolved: `~user/…`, a glob in the top home entry) · home-root (the
 *     home itself, or a glob directly in it) · outside-home (a path outside
 *     the app home that is not inside the trusted workspace root) ·
 *     cwd-outside-home · dir-change-unknown · script-exec (running a file by
 *     path) · tool:<x> (not a file tool) · system-tool:<x> (am / pm / cmd /
 *     settings / svc / content / setprop / su / sudo / reboot / input / kill
 *     / pkill / killall / crontab / shelly) · network-tool (git push / fetch
 *     / pull / clone / remote / send-email / ls-remote / submodule, npm|pnpm|
 *     yarn publish) · expansion · indirect.
 *
 * Residual (accepted with the opt-in, DEFERRED.md): the checks are lexical;
 * a file tool cannot run code, but e.g. a `cp` into a place a later,
 * separately approved run executes is judged by its path only. The gate's
 * own denies stay in force. Untrusted input (web research, URLs,
 * notification text) makes the level fall back to standard altogether
 * (runWithoutApprovalAllAllowedFor, security review H2).
 *
 * Never reached by this function at all: gate denies (CRITICAL, POLICY-001
 * deny, policy-write) — the driver declines them before filing a request —
 * and unattended runs (the driver declines every gray verdict itself).
 */
export const ALL_LEVEL_SOFT_REASONS: ReadonlySet<string> = new Set([
  'signal:leaves-root',
  'signal:write-or-exec',
  'signal:destructive',
  'safety:HIGH',
  'protected-path',
  'indirect',
  'dir-change-write',
  'git-subcommand',
  'glob',
  'home-path',
  'parent-path',
  'option-path',
  'write-outside-root',
  'no-trusted-root',
  'unsafe-root',
  'root-mismatch',
  'cwd-outside-root',
]);

/** Standard-path reasons that are HARD under "all" except for a narrow
 *  allowlist re-checked by allLevelEscalationVerdict (the read-only syntax
 *  checks, the file tools in ALL_LEVEL_TOOLS, re-checked options). */
export const ALL_LEVEL_CONDITIONAL_REASONS: ReadonlySet<string> = new Set(['signal:opaque-script-exec', 'expansion']);

/** Gate signals the "all" level may carry (opaque-script-exec only for the
 *  syntax-check allowlist). */
export const ALL_LEVEL_SIGNALS: ReadonlySet<string> = new Set([
  'leaves-root', 'write-or-exec', 'destructive', 'opaque-script-exec',
]);

function isSoftReasonForAll(reason: string): boolean {
  return ALL_LEVEL_SOFT_REASONS.has(reason) || ALL_LEVEL_CONDITIONAL_REASONS.has(reason) || /^(?:tool|option):/.test(reason);
}

export function escalationAutoApprovable(
  request: EscalationRequestLike,
  opts: EscalationAutoApproveOpts,
): AutoApproveVerdict {
  const standard = standardEscalationVerdict(request, opts);
  if (standard.ok === true || opts.level !== 'all' || opts.attended !== true) return standard;
  if (!isSoftReasonForAll(standard.reason)) return standard;
  return allLevelEscalationVerdict(request, opts);
}

/** The only commands the "all" level answers: file tools that read, write,
 *  move or delete — none of them runs a program it is handed. */
export const ALL_LEVEL_TOOLS: ReadonlySet<string> = new Set([
  'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'ls', 'stat', 'file', 'wc', 'diff', 'cmp',
  'pwd', 'tree', 'du', 'realpath', 'readlink', 'basename', 'dirname', 'echo', 'printf', 'true', 'false',
  'test', '[', 'git', 'find', 'tee', 'cp', 'mv', 'mkdir', 'touch', 'rm', 'rmdir', 'sed', 'ln', 'patch',
  'chmod', 'sort', 'uniq', 'cut', 'tr', 'date', 'sleep', 'which', 'cd',
]);
/** Interpreters / shells: only the read-only syntax checks are answered. */
const INTERPRETER_RE = /^(?:python\d?(?:\.\d+)*|pypy\d*|node(?:js)?|ruby|perl|php|deno|bun|lua(?:jit)?|Rscript|julia|tclsh|sh|bash|zsh|ksh|dash)$/;
/** Tools whose bare `--version` (no other word) the "all" level answers. */
const VERSION_PROBE_TOOLS: ReadonlySet<string> = new Set(['node', 'python3', 'python', 'git', 'bash']);
/** Android / Shelly commands that change system or app state, never
 *  auto-answered at any level. */
const ALL_LEVEL_SYSTEM_TOOLS = new Set([
  'am', 'pm', 'cmd', 'settings', 'svc', 'content', 'setprop', 'su', 'sudo', 'reboot', 'input',
  'kill', 'pkill', 'killall', 'crontab', 'shelly',
]);
const NETWORK_GIT_SUBCOMMANDS = new Set(['push', 'fetch', 'pull', 'clone', 'remote', 'send-email', 'ls-remote', 'submodule', 'request-pull']);
const PUBLISH_RE = /(?:^|[\s;&|(])(?:npm|pnpm|yarn|bun)\s+(?:\S+\s+)*publish\b/;
/** Credential / key / env files, by the last component of a word. Checked per
 *  argument word (not on free text: `event.key` in a heredoc'd script is code). */
const SECRET_BASENAME_RE = /^(?:\.env(?:\..+)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|auth\.json|credentials(?:\.json)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|.+\.(?:pem|key|p12|pfx|jks|keystore))$/i;
/** The unmistakable secret paths, on the whole text (heredoc bodies included). */
const SECRET_PATH_TEXT_RE = /(?:^|[\s/'"=:(])(?:id_(?:rsa|dsa|ecdsa|ed25519)|auth\.json|\.netrc|\.git-credentials)(?=$|[\s'"),;:&|<>])|\/\.env(?=$|[\s.'"),;:&|<>])/i;
/** Read-only listing tools that may name the home directory itself. */
const HOME_ROOT_OK_TOOLS = new Set(['ls', 'pwd', 'stat', 'du', 'tree', 'realpath', 'readlink', 'basename', 'dirname', 'echo', 'test', '[']);
/** Dot components that stay protected even inside the trusted workspace. */
const PROTECTED_DOT_COMPONENT_RE = /^\.(?:ssh|gnupg|codex|claude|config|aws|kube|docker|shelly.*|android|gradle|m2)$/i;
/** Redirect / argument targets that never name a real file. */
const DEVICE_PSEUDO_FILE_RE = /^\/dev\/(?:null|stdin|stdout|stderr|fd\/\d+)$/;
/** sed scripts / options that run a command or write a file. */
const SED_EXEC_OR_WRITE_RE = /(?:^|[;{}\s])[ew](?:\s|$)|\/[gpiImM0-9]*[ew][gpiImM0-9]*(?:\s|$|;)/;

function homeRelative(path: string, homes: readonly string[]): string | null {
  for (const h of homes) {
    if (path === h) return '';
    if (path.startsWith(`${h}/`)) return path.slice(h.length + 1);
  }
  return null;
}

/** `$HOME` / `${HOME}` are the only expansions the "all" level resolves. */
function withoutHomeVars(text: string): string {
  return text.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, '');
}

/**
 * The "all" level's own verdict for an attended escalation the standard
 * rules refused for a SOFT reason (see the table above). Lexical and
 * conservative: anything it cannot place asks a human.
 */
export function allLevelEscalationVerdict(request: EscalationRequestLike, opts: EscalationAutoApproveOpts): AutoApproveVerdict {
  if (!opts.enabled) return { ok: false, reason: 'flag-off' };
  if (opts.level !== 'all' || opts.attended !== true) return { ok: false, reason: 'not-all-level' };
  if (opts.policyBlocksAutoAccept) return { ok: false, reason: 'policy-ask' };
  if (request.state) return { ok: false, reason: 'not-live' };
  if (!/^boundary: /.test(String(request.reason ?? ''))) return { ok: false, reason: 'not-boundary-gray' };
  const raw = String(request.command ?? '').trim();
  if (!raw) return { ok: false, reason: 'no-command' };
  const signals = Array.isArray(request.signals) ? request.signals.map((s) => String(s).trim()).filter(Boolean) : [];
  if (signals.length === 0) return { ok: false, reason: 'no-signals' };
  const hardSignal = signals.find((s) => !ALL_LEVEL_SIGNALS.has(s));
  if (hardSignal) return { ok: false, reason: `signal:${hardSignal}` };

  const payload = shellPayload(raw);
  const once = dequoteShellWords(payload);
  const twice = dequoteShellWords(once);
  for (const text of [raw, payload, once, twice]) {
    if (checkCommandSafety(text).level === 'CRITICAL') return { ok: false, reason: 'safety:CRITICAL' };
  }
  for (const text of [raw, once, twice]) {
    if (TRUST_STATE_RE.test(text)) return { ok: false, reason: 'trust-state-path' };
    if (SECRET_PATH_TEXT_RE.test(text)) return { ok: false, reason: 'secret-file' };
    if (PUBLISH_RE.test(text)) return { ok: false, reason: 'network-tool' };
  }

  const homePaths = (opts.homePaths ?? []).filter(Boolean);
  const homes = rootAliases('~', homePaths);
  if (homes.length === 0) return { ok: false, reason: 'no-home' };
  const trustedRaw = String(opts.trustedWorkspaceRoot ?? '').trim();
  const trusted = trustedRaw && validateWorkspaceRoot(trustedRaw, [...homePaths]).ok
    ? rootAliases(trustedRaw, homePaths).filter((r) => validateWorkspaceRoot(r, [...homePaths]).ok)
    : [];
  const inHome = (p: string) => homeRelative(p, homes) !== null;
  const inTrusted = (p: string) => trusted.some((r) => p === r || p.startsWith(`${r}/`));

  const cwdRaw = String(request.cwd ?? '').trim();
  const initialCwd: string | null = cwdRaw.startsWith('/') ? normalizePath(cwdRaw) : (trusted[0] ?? null);
  if (!initialCwd || (!inHome(initialCwd) && !inTrusted(initialCwd))) return { ok: false, reason: 'cwd-outside-home' };
  let cwd: string = initialCwd;

  /** Resolve a path-ish word against the tracked cwd: absolute, `~`, `$HOME`
   *  / `${HOME}`; null when it cannot be resolved (`~user/…`). */
  const resolve = (word: string, base: string): string | null => {
    const homeRel = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)(.*)$/.exec(word);
    if (homeRel) return normalizePath(`${homes[0]}${homeRel[1]}`);
    if (word.startsWith('~') || word.startsWith('$')) return null;
    if (word.startsWith('/')) return normalizePath(word);
    return normalizePath(`${base}/${word}`);
  };

  /** Hard checks on one resolved path. */
  const checkPath = (p: string, word: string): string | null => {
    if (DEVICE_PSEUDO_FILE_RE.test(p)) return null;
    const rel = homeRelative(p, homes);
    if (rel === null) {
      if (!inTrusted(p)) return 'outside-home';
      if (p.split('/').some((c) => PROTECTED_DOT_COMPONENT_RE.test(c))) return 'protected-path';
      return null;
    }
    if (rel === '') return 'home-root';
    const top = rel.split('/')[0];
    // A glob in the top home entry (`~/b*/git`) can reach ~/bin.
    if (/[$`*?[\]{}]/.test(top)) return 'unresolved-path';
    if (top.startsWith('.') || isShellyRuntimeHomeEntry(top, 'all')) return 'shelly-control-path';
    const comps = rel.split('/');
    if (comps.some((c) => PROTECTED_DOT_COMPONENT_RE.test(c))) return 'protected-path';
    const gitIdx = comps.indexOf('.git');
    if (gitIdx >= 0 && (comps[gitIdx + 1] === 'hooks' || comps[gitIdx + 1] === 'config')) return 'protected-path';
    return null;
  };

  // Heredocs: a body written by plain `cat` / `tee` into a file inside the
  // trusted workspace is data — skipped by the word checks (an unquoted
  // body must still hold no expansion). Any other heredoc stays in the text
  // and every line of its body is judged as a command.
  const hasDirChange = /(?:^|[\n;&|(]\s*)(?:cd|pushd|popd)(?=$|\s)/.test(once);
  // The delimiter word must end where the shell word ends: `<<'EO'F` is the
  // delimiter EOF to bash, so reading it as EO would run the body to the
  // end of the script and skip the commands after the real terminator.
  const heredocRe = /(^|[\n;&|(][ \t]*)([^\n;&|<]*)<<(-?)[ \t]*['"\\]*([A-Za-z_][A-Za-z0-9_]*)['"]*(?=[ \t;&|<>()\n]|$)([^\n]*)\n([\s\S]*?)(?:\n[ \t]*\4[ \t]*(?=\n|$)|$)/g;
  let heredocRefusal: string | null = null;
  const stripped = once.replace(heredocRe, (whole, lead: string, before: string, _dash: string, delim: string, after: string, body: string) => {
    const writer = `${before} ${after}`.trim().split(/\s+/).filter(Boolean);
    const cmd = writer[0] ?? '';
    const plain = (cmd === 'cat' || cmd === 'tee') && !/[;&|]/.test(after);
    let target: string | null = null;
    if (plain && cmd === 'cat') {
      const i = writer.findIndex((w) => /^\d?>>?$/.test(w) || /^\d?>>?\S/.test(w));
      if (i >= 0) target = /^\d?>>?$/.test(writer[i]) ? (writer[i + 1] ?? null) : writer[i].replace(/^\d?>>?/, '');
    } else if (plain && cmd === 'tee') {
      target = writer.slice(1).find((w) => !w.startsWith('-') && !/^\d?>/.test(w)) ?? null;
    }
    const resolved = target ? resolve(target, initialCwd) : null;
    const skip = plain && !hasDirChange && trusted.length > 0 && !!resolved && inTrusted(resolved) && checkPath(resolved, target ?? '') === null;
    if (!skip) return whole;
    const quoted = new RegExp(`<<-?[ \\t]*(?:['"\\\\]|'\\\\'')+${delim}\\b`).test(raw);
    if (!quoted && /[$`]/.test(withoutHomeVars(body))) heredocRefusal = 'expansion';
    return `${lead}${before}<< ${after}`;
  });
  if (heredocRefusal) return { ok: false, reason: heredocRefusal };

  const script = dequoteShellWords(stripped)
    .replace(/(^|\s)\d?>&\d(?=$|[\s;&|)}])/g, '$1')
    .replace(/(^|\s)(?:\d|&)?>>?\s*\/dev\/null(?=$|[\s;&|)}])/g, '$1');
  if (/<\(|>\(/.test(script)) return { ok: false, reason: 'indirect' };
  if (/[$`]/.test(withoutHomeVars(script))) return { ok: false, reason: 'expansion' };

  const segments = splitSegments(script)
    .map((s) => s.split(/\s+/).filter(Boolean))
    .map((tokens) => {
      let t = tokens;
      while (t[0] === '{' || t[0] === '(' || t[0] === '!') t = t.slice(1);
      while (t.length > 0 && (t[t.length - 1] === '}' || t[t.length - 1] === ')')) t = t.slice(0, -1);
      return t;
    })
    .filter((tokens) => tokens.length > 0);
  if (segments.length === 0) return { ok: false, reason: 'no-command' };

  /** `node --check F` / `node -c F` / `python3 -m py_compile F…` /
   *  `bash|sh -n F`: every F a plain file inside the trusted workspace. */
  const isSyntaxCheck = (tokens: string[]): boolean => {
    const name = tokens[0];
    let files: string[] = [];
    if (/^node(?:js)?$/.test(name) && tokens.length === 3 && (tokens[1] === '--check' || tokens[1] === '-c')) files = [tokens[2]];
    else if (/^python3?(?:\.\d+)*$/.test(name) && tokens.length >= 4 && tokens[1] === '-m' && tokens[2] === 'py_compile') files = tokens.slice(3);
    else if (/^(?:ba)?sh$/.test(name) && tokens.length === 3 && tokens[1] === '-n') files = [tokens[2]];
    else return false;
    if (trusted.length === 0) return false;
    return files.every((f) => {
      if (!f || f.startsWith('-') || /[<>*?[\]{}]/.test(f)) return false;
      const p = resolve(f, cwd);
      return !!p && inTrusted(p) && checkPath(p, f) === null;
    });
  };

  /** `node|python3|python|git|bash --version`, exactly two words: prints a
   *  version string and runs nothing it is handed. */
  const isVersionProbe = (tokens: string[]): boolean => (
    tokens.length === 2 && tokens[1] === '--version' && VERSION_PROBE_TOOLS.has(tokens[0])
  );

  // A pipe feeds or reads an interpreter: syntax checks only stand alone.
  const hasPipe = /(?:^|[^|])\|(?!\|)/.test(script);
  for (const tokens of segments) {
    if (!hasPipe && isVersionProbe(tokens)) continue;
    if ((hasPipe || tokens.some((t) => /^\d?[<>]/.test(t))) && INTERPRETER_RE.test(tokens[0].replace(/^.*\//, ''))) {
      return { ok: false, reason: 'signal:opaque-script-exec' };
    }
    if (tokens[0].includes('/')) return { ok: false, reason: 'script-exec' };
    // `VAR=value cmd …` runs cmd with a changed environment (PATH, NODE_OPTIONS …).
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) return { ok: false, reason: 'env-assignment' };
    const cmdWord = tokens[0];
    if (INTERPRETER_RE.test(cmdWord)) {
      if (!isSyntaxCheck(tokens)) return { ok: false, reason: 'signal:opaque-script-exec' };
      continue;
    }
    if (ALL_LEVEL_SYSTEM_TOOLS.has(cmdWord)) return { ok: false, reason: `system-tool:${cmdWord}` };
    if (cmdWord === 'pushd' || cmdWord === 'popd') return { ok: false, reason: 'dir-change-unknown' };
    if (!ALL_LEVEL_TOOLS.has(cmdWord)) return { ok: false, reason: `tool:${cmdWord}` };
    const args = tokens.slice(1);
    const banned = READ_BANNED_OPTIONS[cmdWord];
    if (banned && args.some((a) => banned.test(a))) return { ok: false, reason: `option:${cmdWord}` };
    if (cmdWord === 'sed' && args.some((a) => a === '-f' || a.startsWith('--file') || a.startsWith('-f') || (!a.startsWith('-') && SED_EXEC_OR_WRITE_RE.test(a)))) {
      return { ok: false, reason: 'option:sed' };
    }
    if (cmdWord === 'git') {
      const sub = args.find((a, i) => !a.startsWith('-') && !(i > 0 && args[i - 1] === '-C'));
      if (sub && NETWORK_GIT_SUBCOMMANDS.has(sub)) return { ok: false, reason: 'network-tool' };
      if (!sub || (!WRITE_GIT_SUBCOMMANDS.has(sub) && !READ_GIT_SUBCOMMANDS.has(sub))) return { ok: false, reason: 'git-subcommand' };
    }
    const isCd = cmdWord === 'cd';
    if (isCd) {
      const target = args.filter((a) => a !== '-L' && a !== '-P');
      if (target.length === 0) { cwd = homes[0]; continue; } // bare `cd` → $HOME
      if (target.length > 1 || target[0] === '-' || target[0].startsWith('-')) return { ok: false, reason: 'dir-change-unknown' };
      const next = resolve(target[0], cwd);
      if (!next) return { ok: false, reason: 'dir-change-unknown' };
      const v = checkPath(next, target[0]);
      if (v && !(v === 'home-root' && homeRelative(next, homes) === '')) return { ok: false, reason: v };
      cwd = next;
      continue;
    }
    for (let i = 1; i < tokens.length; i++) {
      // Leading redirect operators (`>file`, `2>>file`, `<file`), then
      // `--opt=value` → value. A word that still holds `<` / `>` is markup
      // or data (`</div>`), not a path.
      let word = tokens[i].replace(/^(?:\d|&)?(?:>>?|<)&?/, '');
      const optVal = /^--?[A-Za-z][\w-]*=(.*)$/.exec(word);
      if (optVal) word = optVal[1];
      word = word.replace(/^['"`(]+|['"`),;]+$/g, '');
      if (!word || /[<>]/.test(word) || word.startsWith('-')) continue;
      if (SECRET_BASENAME_RE.test(word.replace(/\/+$/, '').replace(/^.*\//, ''))) return { ok: false, reason: 'secret-file' };
      const pathish = word.includes('/') || word.startsWith('~') || /^\$\{?HOME\}?$/.test(word) || word.startsWith('.');
      // Bare words: only checked when the cwd is the home itself (`cd ~ &&
      // rm -rf bin`) — elsewhere a bare word names something in the cwd.
      if (!pathish) {
        if (homeRelative(cwd, homes) === '') {
          const v = checkPath(normalizePath(`${cwd}/${word}`), word);
          if (v && v !== 'home-root') return { ok: false, reason: v };
        }
        continue;
      }
      if (word.startsWith('//') || /^[a-z][a-z0-9+.-]*:\/\//i.test(word)) continue; // URL remnant
      const resolved = resolve(word, cwd);
      // M1: a target that cannot be resolved asks a human.
      if (resolved === null) return { ok: false, reason: 'unresolved-path' };
      const verdict = checkPath(resolved, word);
      // `ls ~` names the home without writing it. A glob in the home
      // (`ls ~/*`) still refuses.
      const namesHomeOnly = verdict === 'home-root' && homeRelative(resolved, homes) === '';
      if (verdict && !(namesHomeOnly && HOME_ROOT_OK_TOOLS.has(cmdWord))) return { ok: false, reason: verdict };
      if (!verdict && homeRelative(resolved, homes) !== null && /[*?[]/.test(word) && homeRelative(resolved, homes)!.split('/').length === 1) {
        return { ok: false, reason: 'home-root' };
      }
    }
  }
  return { ok: true, kind: 'all' };
}

function standardEscalationVerdict(
  request: EscalationRequestLike,
  opts: EscalationAutoApproveOpts,
): AutoApproveVerdict {
  if (!opts.enabled) return { ok: false, reason: 'flag-off' };
  // POLICY-001 deny / draft_only / ask, proactive origin (caller in RN).
  if (opts.policyBlocksAutoAccept) return { ok: false, reason: 'policy-ask' };
  // A queued request belongs to a run that already declined and moved on.
  if (request.state) return { ok: false, reason: 'not-live' };
  // Only a gray verdict produced by the boundary classifier itself
  // (lib/agent-boundary-policy.ts: "boundary: <signals>"). A POLICY-001 ask
  // rule or the proactive read-only floor turns allow→gray with its own
  // reason prefix — the user asked to be asked there, so a human answers.
  if (!/^boundary: /.test(String(request.reason ?? ''))) return { ok: false, reason: 'not-boundary-gray' };
  const command = String(request.command ?? '').trim();
  if (!command) return { ok: false, reason: 'no-command' };
  const signals = Array.isArray(request.signals) ? request.signals.map((s) => String(s).trim()).filter(Boolean) : [];
  if (signals.length === 0) return { ok: false, reason: 'no-signals' };
  const foreign = signals.find((s) => !ESCALATION_AUTO_SIGNALS.has(s));
  if (foreign) return { ok: false, reason: `signal:${foreign}` };
  const safety = checkCommandSafety(command);
  if (safety.level === 'CRITICAL' || safety.level === 'HIGH') return { ok: false, reason: `safety:${safety.level}` };

  const shape = analyzeEscalationCommand(command);
  if (shape.kind === 'refuse') return { ok: false, reason: shape.reason };
  // (a) a pure read, wherever it reads (the protected / dot paths were
  // refused by the shape analysis).
  if (shape.kind === 'read') return { ok: true, kind: 'read' };

  // (b) a write: only when it provably stays inside the workspace.
  if (signals.includes('leaves-root')) return { ok: false, reason: 'write-outside-root' };
  const homePaths = opts.homePaths ?? [];
  const trusted = rootAliases(String(opts.trustedWorkspaceRoot ?? ''), homePaths);
  if (trusted.length === 0) return { ok: false, reason: 'no-trusted-root' };
  if (!trusted.every((r) => validateWorkspaceRoot(r, [...homePaths]).ok)) return { ok: false, reason: 'unsafe-root' };
  const requestRoot = rootAliases(String(request.workspaceRoot ?? ''), homePaths);
  if (!requestRoot.some((r) => trusted.includes(r))) return { ok: false, reason: 'root-mismatch' };
  const roots = trusted;
  const cwdRaw = String(request.cwd ?? '').trim();
  const cwd = cwdRaw ? normalizePath(cwdRaw) : roots[0];
  if (!cwd.startsWith('/') || !roots.some((r) => isWithinRoot(r, cwd))) return { ok: false, reason: 'cwd-outside-root' };
  for (const tokens of shape.segments) {
    // Arguments that are paths (contain `/`, or a redirect target). A bare
    // word is resolved against `cwd`, which is inside the root (no cd).
    for (const t of tokens.slice(1)) {
      const bare = t.replace(/^\d?[<>]+/, '');
      if (!bare || bare.startsWith('-')) continue;
      if (!tokenWithinAnyRoot(roots, bare, cwd)) return { ok: false, reason: 'write-outside-root' };
    }
  }
  return { ok: true, kind: 'in-root-write' };
}

// ── NL draft intent ──────────────────────────────────────────────────────

/**
 * NL draft: the user's own words ask for this option. Only an EXPLICIT
 * phrase — 承認なしで実行 / 承認なしで動かして / 確認なしで実行 / "run (it)
 * without approval" — and only in the user's own text: quoted (「…」 "…"
 * `…`), fenced (```…```) and blockquoted (> …) passages are dropped first,
 * so pasted content that mentions the phrase does not raise it. "notify me
 * if there is no approval yet" / "without asking follow-up questions" do
 * not match.
 */
const RUN_WITHOUT_APPROVAL_JA_RE = /(?:承認|確認)(?:は)?(?:なし|無し)で(?:実行|動かし|動かす|走らせ)/;
const RUN_WITHOUT_APPROVAL_EN_RE = /\brun(?:\s+(?:it|this|the\s+agent|them))?\s+without\s+(?:any\s+)?approvals?\b/i;
const NEGATED_EN_RE = /\b(?:don'?t|do not|never|shouldn'?t|please don'?t)\b[^.!?]{0,40}\bwithout\b/i;
const NEGATED_JP_RE = /(?:承認|確認|許可)(?:は)?(?:なし|無し|不要)(?:で|に)?(?:は)?[^。！？]{0,15}(?:しないで|しては(?:い)?けない|ダメ|だめ|禁止)/;

/** The user's own words: quoted / fenced / blockquoted passages removed. */
export function stripQuotedText(text: string): string {
  return String(text ?? '')
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/「[^」]*」|『[^』]*』|“[^”]*”|‘[^’]*’|"[^"\n]*"/g, ' ')
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');
}

/**
 * The "all" level phrases (2026-11-01): JA すべて / 全て / 全部 / 完全に / 一切
 * before the same 承認なしで実行 shape; EN "run (it) fully / completely /
 * entirely without approval" or "run (it) without any approvals at all".
 * They are checked on the same quote-stripped, negation-guarded text.
 */
const RUN_WITHOUT_APPROVAL_ALL_JA_RE =
  /(?:すべて|全て|全部|完全に|一切)(?:の)?(?:承認|確認)(?:は)?(?:なし|無し)で(?:実行|動かし|動かす|走らせ)/;
const RUN_WITHOUT_APPROVAL_ALL_EN_RE =
  /\brun(?:\s+(?:it|this|the\s+agent|them))?\s+(?:(?:fully|completely|entirely)\s+without\s+(?:any\s+)?approvals?\b|without\s+any\s+approvals?\s+at\s+all\b)/i;

export function detectRunWithoutApprovalIntent(text: string | null | undefined): boolean {
  return detectRunWithoutApprovalLevel(text) !== 'off';
}

/** 'off' | 'standard' | 'all' from the user's own words (see the two
 *  phrase sets above). A negated sentence is 'off' at either level. */
export function detectRunWithoutApprovalLevel(text: string | null | undefined): RunWithoutApprovalSetting {
  const s = stripQuotedText(String(text ?? ''));
  if (!s.trim()) return 'off';
  if (NEGATED_EN_RE.test(s) || NEGATED_JP_RE.test(s)) return 'off';
  if (RUN_WITHOUT_APPROVAL_ALL_JA_RE.test(s) || RUN_WITHOUT_APPROVAL_ALL_EN_RE.test(s)) return 'all';
  return RUN_WITHOUT_APPROVAL_JA_RE.test(s) || RUN_WITHOUT_APPROVAL_EN_RE.test(s) ? 'standard' : 'off';
}

/** The option phrase as it is removed from the task text (name / prompt /
 *  steps): the detection phrase plus its own conjugation tail (して / してください
 *  / please) and the clause punctuation around it. The "all" prefix
 *  (すべて… / fully … / … at all) goes with it. */
const RUN_WITHOUT_APPROVAL_STRIP_JA_RE =
  /[、,]?\s*(?:(?:すべて|全て|全部|完全に|一切)(?:の)?)?(?:承認|確認)(?:は)?(?:なし|無し)で(?:実行|動かし|動かす|走らせ)(?:して|させて|する|します|て|る)?(?:ください|下さい|ほしい|欲しい|ね)?\s*[。．.！!]?/g;
const RUN_WITHOUT_APPROVAL_STRIP_EN_RE =
  /[,;]?\s*(?:\band\s+)?(?:\bplease\s+)?\brun(?:\s+(?:it|this|the\s+agent|them))?\s+(?:(?:fully|completely|entirely)\s+)?without\s+(?:any\s+)?approvals?\b(?:\s+at\s+all\b)?(?:\s*,?\s*please\b)?\s*[.!]?/gi;
/** Quoted / fenced spans the strip leaves untouched (same set stripQuotedText drops). */
const QUOTED_SPAN_RE = /```[\s\S]*?(?:```|$)|`[^`\n]*`|「[^」]*」|『[^』]*』|“[^”]*”|‘[^’]*’|"[^"\n]*"/g;

function stripPhraseOutsideQuotes(line: string, re: RegExp): string {
  let out = '';
  let cursor = 0;
  QUOTED_SPAN_RE.lastIndex = 0;
  for (let m = QUOTED_SPAN_RE.exec(line); m; m = QUOTED_SPAN_RE.exec(line)) {
    out += line.slice(cursor, m.index).replace(re, ' ') + m[0];
    cursor = m.index + m[0].length;
    if (m[0].length === 0) QUOTED_SPAN_RE.lastIndex++;
  }
  return out + line.slice(cursor).replace(re, ' ');
}

/**
 * The task text without the "承認なしで実行" / "run it without approval"
 * directive: the option is a setting of the agent, not part of its task, so
 * it must not leak into the derived name, the prompt or a step. Only the
 * user's own words are touched (quoted / fenced / blockquoted passages stay
 * as written). Returns the input unchanged when no phrase is present.
 * lib/agent-nl-parser.ts's detectAutonomousIntent also judges autonomy on
 * this text: its own phrase list includes "without approval" / 承認なしで, so
 * the phrase used to turn the draft autonomous too (local-first step ladder:
 * a Codex-pinned step ran on the local LLM, 2026-11-01 build 2743).
 */
export function stripRunWithoutApprovalPhrases(text: string): string {
  const src = String(text ?? '');
  if (
    !RUN_WITHOUT_APPROVAL_JA_RE.test(src) && !RUN_WITHOUT_APPROVAL_EN_RE.test(src)
    && !RUN_WITHOUT_APPROVAL_ALL_EN_RE.test(src)
  ) return src;
  const stripped = src
    .split('\n')
    .map((line) => (/^\s*>/.test(line)
      ? line
      : stripPhraseOutsideQuotes(stripPhraseOutsideQuotes(line, RUN_WITHOUT_APPROVAL_STRIP_JA_RE), RUN_WITHOUT_APPROVAL_STRIP_EN_RE)))
    .join('\n');
  return stripped
    .replace(/[ \t]{2,}/g, ' ')
    // A removed span between two Japanese characters leaves no gap.
    .replace(/([぀-ヿ㐀-鿿]) (?=[぀-ヿ㐀-鿿])/g, '$1')
    .replace(/[ \t]+([、。,.!?！？])/g, '$1')
    .replace(/[、,;]+(?=\s*$)/g, '')
    .replace(/^[\s、,。.]+|\s+$/g, '')
    .trim();
}

/** Display form of an auto-approved command for the audit line. */
export function auditCommandText(command: string, maxChars = 200): string {
  const redacted = String(command)
    .replace(/\b([A-Za-z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*=)([^\s'"`]+)/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(redacted);
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : redacted;
}

/** i18n key of the audit line: the agent's level is always visible in it. */
export function runWithoutApprovalAuditKey(level: RunWithoutApprovalSetting): string {
  return level === 'all' ? 'agent_run_without_approval.auto_approved_all' : 'agent_run_without_approval.auto_approved';
}

/** Visible audit trail: one line in the agent's own chat thread. */
export function postRunWithoutApprovalAuditLine(agentId: string, content: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { useAIPaneStore, agentThreadKey } = require('@/store/ai-pane-store');
    useAIPaneStore.getState().addMessage(agentThreadKey(agentId), {
      id: `rwa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'assistant',
      content,
      timestamp: Date.now(),
    });
  } catch {
    // best-effort; the driver audit log still records escalation_resolved
  }
}
