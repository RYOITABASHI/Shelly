/**
 * lib/agent-role-store.ts — agent roles (Inc A, WP1): persistence of role
 * definitions, their tamper seal, and per-role approval levels.
 *
 * Roles live in the EXISTING ~/.shelly/agents/roles.json (no new folder). The
 * gate's PROTECTED_POLICY_FILE_RE already hard-denies agent CLI writes to
 * `.shelly/agents/<name>.json` ('policy-write'); the file has no top-level
 * `id`, so every agents-dir scanner skips it (same as policy.json).
 *
 * Single writer: the RN app (ShellRunner tmp + mv, like
 * lib/agent-user-policy-store.ts). NO runtime reads this file: roles are
 * snapshotted onto steps at creation (toStepRole → AgentOrchestrationStep.role).
 *
 * Seal. Everything with the agent's uid can rewrite the file, so every write
 * records sha256(file bytes) in the seal (Keystore-backed SecureStore key
 * `shelly_roles_v1`, lib/agent-role-device.ts). During a write the seal lists
 * [new, old] so a crash between the two steps cannot lock the user out; it
 * then drops to [new].
 *
 * Levels. The approval level of a role is NEVER written to roles.json. It
 * lives in the same SecureStore value (`levels`), bound to the role's
 * definition hash: a level whose roleHash differs from the role's current
 * roleDefinitionHash reads as 'off'. Levels are set only from the user's
 * typed chat (`via: 'chat'`). At run time only the existing per-agent entry
 * (lib/agent-run-without-approval.ts) is used — these levels only decide what
 * that entry is set to when a routed agent is confirmed (WP3).
 *
 * Fail-closed load — `unavailable` (routing disabled, the user is told, the
 * file is never overwritten except by the explicit reset) when: the file
 * cannot be read; the seal cannot be read; the file's hash is not in the
 * seal (a non-empty file with an empty seal included); the file is missing
 * while the seal lists a hash; the file is unparseable; or ANY role in it is
 * invalid (a role is never silently dropped).
 */
import { sha256Hex } from '@/lib/sha256';
import { logInfo, logWarn } from '@/lib/debug-logger';
import { validateWorkspaceRoot } from '@/lib/agent-boundary-policy';
import {
  MAX_ROLES,
  MAX_ROLE_DEFAULT_STEPS,
  ROLES_RELATIVE_PATH,
  ROLE_DEFAULT_STEP_MAX_CHARS,
  ROLE_ENGINE_TYPES,
  ROLE_INSTRUCTIONS_MAX_CHARS,
  ROLE_NAME_MAX_CHARS,
  ROLE_PROMPT_MAX_CHARS,
  ROLE_WORKSPACE_PATH_MAX_CHARS,
  isRoleKind,
  type AgentRole,
  type AgentRoleWorkspace,
  type AgentRolesFile,
  type AgentStepRole,
  type LoadedRoles,
  type RoleEngine,
  type RoleKind,
  type RoleLevel,
  type RoleLevelVia,
} from '@/lib/agent-role-types';

export type ShellRunner = (cmd: string) => Promise<string>;

/** One stored level. 'off' is never stored (it is the absence of an entry). */
export interface RoleLevelEntry {
  roleId: string;
  level: Exclude<RoleLevel, 'off'>;
  /** roleDefinitionHash of the role when the level was set. */
  roleHash: string;
  setAt: number;
  via: RoleLevelVia;
}

/** The SecureStore value `shelly_roles_v1`. */
export interface RoleSealState {
  fileHashes: string[];
  levels: RoleLevelEntry[];
}

/** Where the seal lives. read() resolves null when the seal is unreadable;
 *  a never-written seal reads as { fileHashes: [], levels: [] }. */
export interface RoleSealPort {
  read: () => Promise<RoleSealState | null>;
  write: (state: RoleSealState) => Promise<void>;
}

const HASH_RE = /^[0-9a-f]{64}$/;
const ROLE_ID_RE = /^[A-Za-z0-9_-]{1,48}$/;
const MODEL_RE = /^[A-Za-z0-9._:/@+-]{1,80}$/;
// Control characters other than tab / newline.
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const NAME_FORBIDDEN_RE = /[\u0000-\u001f\u007f-\u009f]/;
/** Home-level directories that hold Shelly's runtime, never a workspace. */
const RUNTIME_HOME_DIRS = new Set(['bin', 'models', 'lib', 'usr', 'tmp']);

let sealPort: RoleSealPort | null = null;

/** Wire the seal (lib/agent-role-device.ts on device; an in-memory fake in tests). */
export function configureRoleSealPort(port: RoleSealPort | null): void {
  sealPort = port;
}

// ─── Seal value ────────────────────────────────────────────────────────────

function isLevelEntry(v: unknown): v is RoleLevelEntry {
  const e = v as RoleLevelEntry | null;
  return (
    !!e &&
    typeof e === 'object' &&
    typeof e.roleId === 'string' &&
    ROLE_ID_RE.test(e.roleId) &&
    (e.level === 'standard' || e.level === 'all') &&
    typeof e.roleHash === 'string' &&
    HASH_RE.test(e.roleHash) &&
    typeof e.setAt === 'number' &&
    Number.isFinite(e.setAt) &&
    e.via === 'chat'
  );
}

/**
 * Parse the SecureStore value. Missing/empty = never written. Unparseable or
 * a bad fileHashes list = unreadable (null → fail closed). An invalid level
 * entry is dropped: losing a level only makes that role 'off' (stricter).
 */
export function parseRoleSealValue(raw: string | null | undefined): RoleSealState | null {
  const v = (raw ?? '').trim();
  if (!v) return { fileHashes: [], levels: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(v);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const p = parsed as { fileHashes?: unknown; levels?: unknown };
  if (!Array.isArray(p.fileHashes) || p.fileHashes.length > 2) return null;
  if (!p.fileHashes.every((h) => typeof h === 'string' && HASH_RE.test(h))) return null;
  const levels = Array.isArray(p.levels) ? p.levels.filter(isLevelEntry) : [];
  // One entry per role (the newest wins).
  const byRole = new Map<string, RoleLevelEntry>();
  for (const e of levels) {
    const prev = byRole.get(e.roleId);
    if (!prev || e.setAt >= prev.setAt) byRole.set(e.roleId, e);
  }
  return { fileHashes: [...(p.fileHashes as string[])], levels: [...byRole.values()] };
}

export function serializeRoleSealValue(state: RoleSealState): string {
  return JSON.stringify({ fileHashes: state.fileHashes, levels: state.levels });
}

// ─── Validation ────────────────────────────────────────────────────────────

function normalizeEngine(raw: unknown): RoleEngine | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const type = r.type;
  if (typeof type !== 'string' || !(ROLE_ENGINE_TYPES as readonly string[]).includes(type)) return null;
  if (type === 'cli') {
    return r.cli === 'codex' || r.cli === 'claude' ? { type: 'cli', cli: r.cli } : null;
  }
  if (r.model !== undefined) {
    if (typeof r.model !== 'string' || !MODEL_RE.test(r.model)) return null;
    return { type, model: r.model } as RoleEngine;
  }
  return { type } as RoleEngine;
}

/**
 * Structural check of a fixed workspace path (home-relative `~/x` or
 * absolute). The full check against the real home (symlinks, aliases) runs
 * where the role is saved / confirmed (WP2/WP3); this rejects what can never
 * be a workspace: `..`, dot directories, runtime dirs, home / root itself.
 */
export function fixedWorkspaceError(path: unknown): string | null {
  if (typeof path !== 'string') return 'workspace path is not a string';
  const p = path.trim();
  if (!p || p !== path) return 'workspace path is empty or padded';
  if (p.length > ROLE_WORKSPACE_PATH_MAX_CHARS) return 'workspace path is too long';
  if (CONTROL_RE.test(p) || /[\n\t]/.test(p)) return 'workspace path has control characters';
  if (!p.startsWith('~/') && !p.startsWith('/')) return 'workspace path must start with ~/ or /';
  const segments = p.replace(/^~\//, '').split('/').filter(Boolean);
  if (!segments.length) return 'workspace path cannot be the home directory or /';
  if (segments.some((s) => s === '..' || s === '.')) return 'workspace path cannot contain . or ..';
  if (segments.some((s) => s.startsWith('.'))) return 'workspace path cannot be inside a dot directory';
  if (p.startsWith('~/') && RUNTIME_HOME_DIRS.has(segments[0])) return 'workspace path cannot be a Shelly runtime directory';
  const verdict = validateWorkspaceRoot(p);
  return verdict.ok ? null : verdict.reason ?? 'invalid workspace path';
}

function normalizeWorkspace(raw: unknown): AgentRoleWorkspace | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.mode === 'request') return { mode: 'request' };
  if (r.mode === 'fixed' && fixedWorkspaceError(r.path) === null) return { mode: 'fixed', path: r.path as string };
  return null;
}

function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const name = v.trim();
  if (!name || name !== v || NAME_FORBIDDEN_RE.test(name)) return null;
  if (Array.from(name).length > ROLE_NAME_MAX_CHARS) return null;
  return name;
}

/**
 * Validate one role. Returns the role rebuilt from its known fields only
 * (unknown keys dropped) or null when anything is invalid.
 */
export function parseRole(raw: unknown): AgentRole | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !ROLE_ID_RE.test(r.id)) return null;
  const name = cleanName(r.name);
  if (!name) return null;
  if (typeof r.instructions !== 'string') return null;
  const instructions = r.instructions;
  if (!instructions.trim() || CONTROL_RE.test(instructions)) return null;
  if (Array.from(instructions).length > ROLE_INSTRUCTIONS_MAX_CHARS) return null;
  const engine = normalizeEngine(r.engine);
  if (!engine) return null;
  if (!Array.isArray(r.handles) || r.handles.length === 0) return null;
  if (!r.handles.every(isRoleKind)) return null;
  const handles = r.handles as RoleKind[];
  if (new Set(handles).size !== handles.length) return null;
  const workspace = normalizeWorkspace(r.workspace);
  if (!workspace) return null;
  let defaultSteps: string[] | undefined;
  if (r.defaultSteps !== undefined) {
    if (!Array.isArray(r.defaultSteps) || r.defaultSteps.length > MAX_ROLE_DEFAULT_STEPS) return null;
    const ok = r.defaultSteps.every(
      (s) =>
        typeof s === 'string' &&
        s.trim().length > 0 &&
        !CONTROL_RE.test(s) &&
        Array.from(s).length <= ROLE_DEFAULT_STEP_MAX_CHARS,
    );
    if (!ok) return null;
    defaultSteps = [...(r.defaultSteps as string[])];
  }
  if (r.autoAttach !== undefined && r.autoAttach !== 'after-implement') return null;
  if (typeof r.createdAt !== 'number' || !Number.isFinite(r.createdAt)) return null;
  if (typeof r.updatedAt !== 'number' || !Number.isFinite(r.updatedAt)) return null;
  return {
    id: r.id,
    name,
    instructions,
    engine,
    handles: [...handles],
    workspace,
    ...(defaultSteps ? { defaultSteps } : {}),
    ...(r.autoAttach === 'after-implement' ? { autoAttach: 'after-implement' as const } : {}),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** Validate a whole role list (ids and names unique, at most MAX_ROLES). */
export function parseRoleList(raw: unknown): AgentRole[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_ROLES) return null;
  const roles: AgentRole[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const item of raw) {
    const role = parseRole(item);
    if (!role) return null;
    const key = role.name.toLowerCase();
    if (ids.has(role.id) || names.has(key)) return null;
    ids.add(role.id);
    names.add(key);
    roles.push(role);
  }
  return roles;
}

/** Parse the raw file text (content check only; the seal is checked separately). */
export function parseRolesFile(text: string): { roles: AgentRole[]; ok: boolean } {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { roles: [], ok: true };
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return { roles: [], ok: false };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { roles: [], ok: false };
  const r = raw as Record<string, unknown>;
  if (r.kind !== 'shelly-roles' || r.version !== 1 || 'id' in r) return { roles: [], ok: false };
  const roles = parseRoleList(r.roles);
  return roles ? { roles, ok: true } : { roles: [], ok: false };
}

export function serializeRolesFile(roles: readonly AgentRole[]): string {
  const file: AgentRolesFile = { kind: 'shelly-roles', version: 1, roles: [...roles] };
  return `${JSON.stringify(file, null, 2)}\n`;
}

// ─── Hashes / snapshots ────────────────────────────────────────────────────

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return value === undefined ? 'null' : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * sha256 over the fields that define what a role does (timestamps excluded).
 * A level is valid only while its roleHash equals this.
 */
export function roleDefinitionHash(role: AgentRole): string {
  const canonical = {
    id: role.id,
    name: role.name,
    instructions: role.instructions,
    engine: role.engine,
    handles: role.handles,
    workspace: role.workspace,
    defaultSteps: role.defaultSteps && role.defaultSteps.length ? role.defaultSteps : null,
    autoAttach: role.autoAttach ?? null,
  };
  return sha256Hex(`shelly-role-v1\n${stableStringify(canonical)}`);
}

/** The snapshot an orchestration step carries (AgentOrchestrationStep.role). */
export function toStepRole(role: AgentRole): AgentStepRole {
  return { id: role.id, name: role.name, instructions: role.instructions, roleHash: roleDefinitionHash(role) };
}

/**
 * The `# Your role` prompt block, capped at ROLE_PROMPT_MAX_CHARS code points.
 * The single shape for both a step prompt (WP4 buildStepPrompt, mirrored in
 * the PlanSpec executor) and a single-unit routed agent's prompt prefix.
 */
export function composeRoleInstructions(role: Pick<AgentRole, 'name' | 'instructions'>): string {
  const name = String(role.name ?? '').replace(/\s+/g, ' ').trim();
  const instructions = String(role.instructions ?? '').trim();
  const block = `# Your role\n${name}: ${instructions}`;
  const cps = Array.from(block);
  return cps.length <= ROLE_PROMPT_MAX_CHARS ? block : `${cps.slice(0, ROLE_PROMPT_MAX_CHARS - 1).join('')}…`;
}

/** Short random role id. */
export function newRoleId(): string {
  return `role_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** The strictest of the given levels ('off' < 'standard' < 'all'). Empty → 'off'. */
export function minRoleLevel(levels: readonly RoleLevel[]): RoleLevel {
  if (!levels.length) return 'off';
  if (levels.includes('off')) return 'off';
  if (levels.includes('standard')) return 'standard';
  return 'all';
}

// ─── Shell I/O ─────────────────────────────────────────────────────────────

const shaCmd = (f: string) => `{ sha256sum ${f} 2>/dev/null || toybox sha256sum ${f} 2>/dev/null; } | cut -c1-64`;

// "M" when the file does not exist; else "P" + the shell-computed sha256 of
// the exact on-disk bytes + newline + content.
function readCommand(): string {
  const f = `"$HOME/${ROLES_RELATIVE_PATH}"`;
  return `if [ -e ${f} ]; then printf 'P'; ${shaCmd(f)}; cat ${f}; else printf 'M'; fi`;
}

/** Parse readCommand output (exported for tests). */
export function parseRolesReadOutput(out: string): { exists: boolean; hash: string; text: string } {
  if (!out.startsWith('P')) return { exists: false, hash: '', text: '' };
  const nl = out.indexOf('\n');
  if (nl === -1) return { exists: true, hash: '', text: '' };
  return { exists: true, hash: out.slice(1, nl).trim().toLowerCase(), text: out.slice(nl + 1) };
}

function writeCommand(content: string): string {
  const marker = `SHELLY_ROLES_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const target = `"$HOME/${ROLES_RELATIVE_PATH}"`;
  const tmp = `"$HOME/${ROLES_RELATIVE_PATH}.${marker}.tmp"`;
  // Prints the written file's sha256 so the seal records the real bytes.
  return `set -e\nmkdir -p "$(dirname ${target})" && cat > ${tmp} <<'${marker}' && mv -f ${tmp} ${target} && ${shaCmd(target)}\n${content}${marker}`;
}

/** Seal verdict for a file state. An empty seal accepts only "no file / empty file". */
export function isSealedRolesState(exists: boolean, text: string, fileHash: string, fileHashes: readonly string[]): boolean {
  if (fileHashes.length === 0) return !exists || !text.trim();
  if (!exists || !HASH_RE.test(fileHash)) return false;
  return fileHashes.includes(fileHash);
}

// ─── Load / write ──────────────────────────────────────────────────────────

let cache: LoadedRoles | null = null;
let lastFileHash: string | null = null;
let chain: Promise<unknown> = Promise.resolve();

/** Last loaded/written state, or null before the first load. */
export function getCachedRoles(): LoadedRoles | null {
  return cache;
}

/** Test hook. */
export function __resetRoleStoreForTests(): void {
  cache = null;
  lastFileHash = null;
  chain = Promise.resolve();
}

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn);
  chain = next.catch(() => undefined);
  return next;
}

async function readSeal(): Promise<RoleSealState | null> {
  if (!sealPort) return null;
  try {
    return await sealPort.read();
  } catch {
    return null;
  }
}

async function loadInner(run: ShellRunner): Promise<{ loaded: LoadedRoles; seal: RoleSealState | null }> {
  let out = '';
  try {
    out = await run(readCommand());
  } catch (e) {
    logWarn('AgentRoles', 'roles.json read failed — role routing disabled', e);
    cache = { roles: [], unavailable: true, reason: 'read-failed' };
    return { loaded: cache, seal: null };
  }
  const { exists, hash, text } = parseRolesReadOutput(out);
  lastFileHash = exists && HASH_RE.test(hash) ? hash : null;
  const seal = await readSeal();
  if (!seal) {
    logWarn('AgentRoles', 'role seal unreadable — role routing disabled');
    cache = { roles: [], unavailable: true, reason: 'seal-unreadable' };
    return { loaded: cache, seal: null };
  }
  if (!isSealedRolesState(exists, text, hash, seal.fileHashes)) {
    logWarn('AgentRoles', `roles.json does not match its seal (exists=${exists}, seal=${seal.fileHashes.length}) — role routing disabled`);
    cache = { roles: [], unavailable: true, reason: 'unsealed' };
    return { loaded: cache, seal };
  }
  const parsed = parseRolesFile(text);
  if (!parsed.ok) {
    logWarn('AgentRoles', 'roles.json is present but invalid — role routing disabled until reset');
    cache = { roles: [], unavailable: true, reason: 'invalid' };
    return { loaded: cache, seal };
  }
  cache = { roles: parsed.roles, unavailable: false };
  return { loaded: cache, seal };
}

/** Read and verify roles.json. Never throws. */
export function loadRoles(run: ShellRunner): Promise<LoadedRoles> {
  return serialized(async () => (await loadInner(run)).loaded);
}

/** Drop levels whose role is gone or whose definition changed. */
function liveLevels(levels: readonly RoleLevelEntry[], roles: readonly AgentRole[]): RoleLevelEntry[] {
  const hashes = new Map(roles.map((r) => [r.id, roleDefinitionHash(r)]));
  return levels.filter((e) => hashes.get(e.roleId) === e.roleHash);
}

async function writeFileSealed(
  run: ShellRunner,
  roles: AgentRole[],
  previousHash: string | null,
  levels: RoleLevelEntry[],
): Promise<void> {
  if (!sealPort) throw new Error('role seal is not configured; refusing to write');
  const content = serializeRolesFile(roles);
  const predicted = sha256Hex(content);
  // [new, old] first so a crash between the two writes stays verifiable.
  await sealPort.write({
    fileHashes: previousHash && previousHash !== predicted ? [predicted, previousHash] : [predicted],
    levels,
  });
  const written = (await run(writeCommand(content))).trim().toLowerCase();
  const actual = HASH_RE.test(written) ? written : predicted;
  await sealPort.write({ fileHashes: [actual], levels });
  lastFileHash = actual;
  cache = { roles, unavailable: false };
}

/**
 * Serialised read-modify-write. Re-reads and re-verifies first and refuses
 * to write over an unavailable file (re-sealing an edited file would launder
 * the edit — only resetRoles may replace it). Throws when the mutated list is
 * invalid. Levels of removed / redefined roles are dropped.
 */
export function mutateRoles(
  run: ShellRunner,
  mutate: (roles: AgentRole[]) => AgentRole[],
): Promise<AgentRole[]> {
  return serialized(async () => {
    if (!sealPort) throw new Error('role seal is not configured; refusing to write');
    const { loaded, seal } = await loadInner(run);
    if (loaded.unavailable || !seal) {
      throw new Error(`roles.json is unavailable (${loaded.reason ?? 'unknown'}); refusing to overwrite it`);
    }
    const previousHash = lastFileHash;
    const next = parseRoleList(mutate(loaded.roles.map((r) => ({ ...r }))));
    if (!next) throw new Error('invalid role list; nothing was written');
    await writeFileSealed(run, next, previousHash, liveLevels(seal.levels, next));
    logInfo('AgentRoles', `roles.json written roles=${next.length}`);
    return next;
  });
}

/** Replace the whole role list (validated, sealed). */
export function saveRoles(run: ShellRunner, roles: AgentRole[]): Promise<AgentRole[]> {
  return mutateRoles(run, () => roles);
}

/**
 * The explicit recovery path: replace whatever is on disk — even an
 * unavailable file — with an EMPTY role list, seal it, and clear every level.
 * Reachable only from the user's own chat after a typed confirm (NL
 * 「ロール設定を初期化」, WP2).
 */
export function resetRoles(run: ShellRunner): Promise<AgentRole[]> {
  return serialized(async () => {
    if (!sealPort) throw new Error('role seal is not configured; refusing to write');
    await writeFileSealed(run, [], null, []);
    logInfo('AgentRoles', 'roles.json reset to an empty, freshly sealed list (user-confirmed)');
    return [];
  });
}

// ─── Levels ────────────────────────────────────────────────────────────────

/** Level of a role: the stored level when its hash matches the role's current definition, else 'off'. */
export async function getRoleLevel(role: AgentRole): Promise<RoleLevel> {
  const seal = await readSeal();
  if (!seal) return 'off';
  const entry = seal.levels.find((e) => e.roleId === role.id);
  if (!entry) return 'off';
  return entry.roleHash === roleDefinitionHash(role) ? entry.level : 'off';
}

/**
 * Set a role's level. Only the user's typed chat may do this (`via: 'chat'`;
 * terminal requests, inbound messages and MONITOR team drafts must never call
 * it). The role must exist on disk, verified, with this exact definition.
 * 'off' removes the entry.
 */
export function setRoleLevel(
  run: ShellRunner,
  role: AgentRole,
  level: RoleLevel,
  opts: { via: RoleLevelVia; now?: number },
): Promise<void> {
  return serialized(async () => {
    if (!opts || opts.via !== 'chat') throw new Error('role levels can only be set from the user\'s chat');
    if (level !== 'off' && level !== 'standard' && level !== 'all') throw new Error('invalid role level');
    if (!sealPort) throw new Error('role seal is not configured; refusing to write');
    const { loaded, seal } = await loadInner(run);
    if (loaded.unavailable || !seal) throw new Error(`roles.json is unavailable (${loaded.reason ?? 'unknown'})`);
    const onDisk = loaded.roles.find((r) => r.id === role.id);
    const roleHash = roleDefinitionHash(role);
    if (!onDisk || roleDefinitionHash(onDisk) !== roleHash) throw new Error('role is not saved with this definition');
    const levels = seal.levels.filter((e) => e.roleId !== role.id);
    if (level !== 'off') levels.push({ roleId: role.id, level, roleHash, setAt: opts.now ?? Date.now(), via: 'chat' });
    await sealPort.write({ fileHashes: seal.fileHashes, levels });
    logInfo('AgentRoles', `role ${role.id} level=${level}`);
  });
}

/** Remove a role's level (e.g. after the role was deleted). No-op when none. */
export function forgetRole(roleId: string): Promise<void> {
  return serialized(async () => {
    if (!sealPort) throw new Error('role seal is not configured; refusing to write');
    const seal = await readSeal();
    if (!seal) throw new Error('role seal is unreadable');
    if (!seal.levels.some((e) => e.roleId === roleId)) return;
    await sealPort.write({ fileHashes: seal.fileHashes, levels: seal.levels.filter((e) => e.roleId !== roleId) });
  });
}
