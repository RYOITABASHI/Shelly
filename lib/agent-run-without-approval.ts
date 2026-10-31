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
 * Residual (DEFERRED.md): a same-uid process could restore an OLDER
 * SecureStore blob (rollback to a time the flag was ON); git subcommands
 * allowed as reads honour the repository's own config (core.fsmonitor …).
 */
import { checkCommandSafety } from '@/lib/command-safety';
import { REVIEW_REQUIRED_ACTION_TYPES } from '@/lib/agent-action-types';
import { dequoteShellWords, isWithinRoot, normalizePath, validateWorkspaceRoot } from '@/lib/agent-boundary-policy';
import { sha256Hex } from '@/lib/sha256';

const STORE_KEY = 'shelly_run_without_approval_v2';
const MAX_ENTRIES = 500;
const HEX_SHA256_RE = /^[0-9a-f]{64}$/;

export type RunWithoutApprovalVia = 'detail' | 'chat';

export type RunWithoutApprovalEntry = {
  agentId: string;
  enabledAt: number;
  via: RunWithoutApprovalVia;
  /** runWithoutApprovalDefinitionHash() of the definition it was enabled for. */
  definitionHash: string;
};

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
  if (!agent || !agent.id) return false;
  const entry = (await loadRunWithoutApproval()).find((e) => e.agentId === agent.id);
  if (!entry) return false;
  let current: string;
  try {
    current = runWithoutApprovalDefinitionHash(agent);
  } catch {
    return false;
  }
  if (current !== entry.definitionHash) {
    warn(`agent ${agent.id} definition changed since run-without-approval was enabled; treating it as OFF`);
    return false;
  }
  return true;
}

export function subscribeRunWithoutApproval(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** User-only writer: the agent detail toggle or the typed-OK chat
 *  registration. Never called from anything an agent run can drive. */
export async function setRunWithoutApproval(
  agent: RunWithoutApprovalAgentLike,
  enabled: boolean,
  via: RunWithoutApprovalVia,
  now: number = Date.now(),
): Promise<void> {
  if (!agent || !agent.id) return;
  const list = (await loadRunWithoutApproval()).filter((e) => e.agentId !== agent.id);
  const next = enabled
    ? [...list, { agentId: agent.id, enabledAt: now, via, definitionHash: runWithoutApprovalDefinitionHash(agent) }].slice(-MAX_ENTRIES)
    : list;
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

export type AutoApproveVerdict = { ok: true; kind?: 'read' | 'in-root-write' } | { ok: false; reason: string };

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
    // stderr plumbing that never names a file
    .replace(/\s\d?>&\d\b/g, ' ')
    .replace(/\s\d?>\s*\/dev\/null\b/g, ' ');
  if (!script.trim()) return { kind: 'refuse', reason: 'no-command' };
  if (TRUST_STATE_RE.test(raw) || TRUST_STATE_RE.test(script)) return { kind: 'refuse', reason: 'trust-state-path' };
  if (/[$`]/.test(script)) return { kind: 'refuse', reason: 'expansion' };
  if (/<\(|>\(|<</.test(script)) return { kind: 'refuse', reason: 'indirect' };
  const segments = splitSegments(script).map((s) => s.split(/\s+/).filter(Boolean));
  if (segments.length === 0) return { kind: 'refuse', reason: 'no-command' };
  for (const tokens of segments) {
    if (tokens.some((t) => hasDotComponent(t.replace(/^[<>]+/, '')))) return { kind: 'refuse', reason: 'protected-path' };
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

export function escalationAutoApprovable(
  request: {
    command?: string | null;
    signals?: readonly string[] | null;
    state?: string | null;
    reason?: string | null;
    cwd?: string | null;
    workspaceRoot?: string | null;
  },
  opts: {
    enabled: boolean;
    policyBlocksAutoAccept?: boolean;
    /** The workspace root of the hash-verified agent definition (or
     *  DEFAULT_AGENT_PROJECT_DIR). Absent ⇒ no in-root write is auto-approved. */
    trustedWorkspaceRoot?: string | null;
    /** Home directory spellings, to expand `~` in trustedWorkspaceRoot. */
    homePaths?: readonly string[];
  },
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

export function detectRunWithoutApprovalIntent(text: string | null | undefined): boolean {
  const s = stripQuotedText(String(text ?? ''));
  if (!s.trim()) return false;
  if (NEGATED_EN_RE.test(s) || NEGATED_JP_RE.test(s)) return false;
  return RUN_WITHOUT_APPROVAL_JA_RE.test(s) || RUN_WITHOUT_APPROVAL_EN_RE.test(s);
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
