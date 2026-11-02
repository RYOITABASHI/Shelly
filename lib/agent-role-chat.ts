/**
 * lib/agent-role-chat.ts — agent roles (Inc A, WP2): the chat surface for
 * creating / editing / listing / deleting / resetting roles. Plain
 * natural-language turns in the AI pane only (project rule: NEVER a card /
 * modal / button for agent confirmation), modeled on lib/agent-policy-chat.ts.
 *
 * The dispatcher (hooks/use-ai-pane-dispatch.ts) only (1) routes a reply to
 * a pending role question to handlePendingRoleReply and (2) offers a fresh
 * utterance's detectRoleIntent result to handleRoleIntent. Everything posted
 * here is a flowTurn.
 *
 * Nothing is written on a detection alone: every change is echoed and waits
 * for an exact confirm phrase (isConfirmPhrase), re-asks once on an unclear
 * reply, and is re-validated at commit (the pending payload round-tripped
 * through AsyncStorage).
 *
 * Who may change roles: only text the user TYPED in the chat composer
 * (`typedByUser`, no `source`). A `shelly agent add` terminal request, a
 * MONITOR team draft, a widget ASK, inbound text or a voice transcript may
 * list roles but never create / edit / delete them or set a level
 * (design §1: level writes only via the user's typed chat).
 */
import type { ChatMessage } from '@/store/types';
import {
  MAX_ROLES,
  ROLE_INSTRUCTIONS_MAX_CHARS,
  type AgentRole,
  type AgentRoleWorkspace,
  type PendingRoleChange,
  type RoleEngine,
  type RoleKind,
  type RoleLevel,
} from '@/lib/agent-role-types';
import {
  fixedWorkspaceError,
  forgetRole,
  getRoleLevel,
  loadRoles,
  mutateRoles,
  newRoleId,
  parseRole,
  resetRoles,
  setRoleLevel,
  type ShellRunner,
} from '@/lib/agent-role-store';
import { deriveRoleHandles, roleNameKey, type RoleChanges, type RoleIntent } from '@/lib/agent-role-intent';
import { runWithoutApprovalAllAllowedFor } from '@/lib/agent-run-without-approval';
import {
  buildWorkspacePrepareCommand,
  parseWorkspacePrepareOutput,
  resolveWorkspaceRootForHome,
} from '@/lib/agent-workspace-from-request';
import { isConfirmPhrase } from '@/lib/agent-confirm-phrase';
import { isCancelPhrase } from '@/lib/agent-slot-fill';
import { classifyYesNo } from '@/lib/agent-policy-rule-intent';
import { logInfo, logWarn } from '@/lib/debug-logger';
import en from '@/lib/i18n/locales/en';
import ja from '@/lib/i18n/locales/ja';

export type RoleLocale = 'en' | 'ja';

export interface RoleChatIO {
  /** Append an assistant flowTurn bubble (extra fields merged in). */
  post: (content: string, extra?: Partial<ChatMessage>) => void;
  run: ShellRunner;
  /** The app home (getHomePath()) — fixed workspaces are resolved against it. */
  home: string;
  now?: () => number;
}

/** Where the message came from (see the module doc). */
export interface RoleChatSource {
  typedByUser: boolean;
  /** AIPaneDispatchOptions.source — any value means "not the user's typing". */
  source?: string;
}

/** Only the user's own typing in the composer may change roles. */
export function canChangeRolesFrom(src: RoleChatSource): boolean {
  return src.typedByUser === true && !src.source;
}

function strings(locale: RoleLocale): Record<string, string> {
  return locale === 'ja' ? ja : en;
}

function fill(template: string, params: Record<string, string | number> = {}): string {
  return Object.entries(params).reduce((acc, [k, v]) => acc.split(`{{${k}}}`).join(String(v)), template);
}

function now(io: RoleChatIO): number {
  return io.now ? io.now() : Date.now();
}

// ─── Descriptions ──────────────────────────────────────────────────────────

export function roleEngineLabel(engine: RoleEngine, locale: RoleLocale): string {
  const s = strings(locale);
  switch (engine.type) {
    case 'cli':
      return engine.cli === 'claude' ? 'Claude Code' : 'Codex';
    case 'local':
      return s['roles.engine_local'];
    case 'gemini-api':
      return 'Gemini';
    case 'perplexity':
      return 'Perplexity';
    case 'cerebras':
      return 'Cerebras';
    case 'groq':
      return 'Groq';
    case 'openrouter':
      return 'OpenRouter';
    default:
      return String((engine as { type: string }).type);
  }
}

function workspaceLabel(ws: AgentRoleWorkspace, locale: RoleLocale): string {
  return ws.mode === 'fixed' ? ws.path : strings(locale)['roles.workspace_request'];
}

function levelLabel(level: RoleLevel, locale: RoleLocale): string {
  return strings(locale)[`roles.level_${level}`];
}

function kindsLabel(kinds: readonly RoleKind[], locale: RoleLocale): string {
  const s = strings(locale);
  return kinds.map((k) => s[`roles.kind_${k}`] ?? k).join(locale === 'ja' ? '・' : ', ');
}

function describeRole(role: AgentRole, locale: RoleLocale): string[] {
  const s = strings(locale);
  const lines = [
    fill(s['roles.field_name'], { v: role.name }),
    fill(s['roles.field_engine'], { v: roleEngineLabel(role.engine, locale) }),
    fill(s['roles.field_handles'], { v: kindsLabel(role.handles, locale) }),
    fill(s['roles.field_instructions'], { v: role.instructions }),
    fill(s['roles.field_workspace'], { v: workspaceLabel(role.workspace, locale) }),
  ];
  if (role.handles.includes('review')) {
    lines.push(fill(s['roles.field_autoattach'], { v: s[role.autoAttach ? 'roles.on' : 'roles.off'] }));
  }
  return lines;
}

// ─── Validation ────────────────────────────────────────────────────────────

const RESEARCH_HANDLES: readonly RoleKind[] = ['research'];

/** "all" needs a role that reads no untrusted input (design §5.2): no web
 *  engine, no URL / web cue / research wording in its instructions. */
export function roleAllowsAllLevel(role: Pick<AgentRole, 'instructions' | 'engine' | 'handles'>): boolean {
  if (role.handles.some((k) => RESEARCH_HANDLES.includes(k))) return false;
  return runWithoutApprovalAllAllowedFor({
    prompt: role.instructions,
    tool: role.engine,
    orchestrationSteps: [{ instruction: role.instructions, tool: role.engine }],
  });
}

/** The level actually applied, and whether "all" was lowered to standard. */
function effectiveLevel(role: AgentRole, level: RoleLevel | undefined): { level?: RoleLevel; degraded: boolean } {
  if (level === 'all' && !roleAllowsAllLevel(role)) return { level: 'standard', degraded: true };
  return { level, degraded: false };
}

type WorkspaceCheck = { ok: boolean; reason: string };

/**
 * A fixed workspace is checked structurally (fixedWorkspaceError), against
 * the real home (resolveWorkspaceRootForHome) and on disk: an existing
 * symlinked component anywhere from the home down refuses it (the same
 * pre-check the agent workspace uses; a missing directory is fine — it is
 * created when an agent uses the role).
 */
export async function checkFixedWorkspace(path: string, io: RoleChatIO): Promise<WorkspaceCheck> {
  const structural = fixedWorkspaceError(path);
  if (structural) return { ok: false, reason: structural };
  const abs = resolveWorkspaceRootForHome(path, io.home);
  if (!abs) return { ok: false, reason: 'not a folder inside the Shelly home' };
  let out: string;
  try {
    out = await io.run(buildWorkspacePrepareCommand(abs, io.home, false));
  } catch {
    out = 'REFUSE exec-failed';
  }
  const verdict = parseWorkspacePrepareOutput(out);
  return verdict.ok === false ? { ok: false, reason: verdict.reason } : { ok: true, reason: '' };
}

function nameTaken(roles: readonly AgentRole[], name: string, exceptId?: string): boolean {
  const key = roleNameKey(name);
  return roles.some((r) => r.id !== exceptId && roleNameKey(r.name) === key);
}

/** Roles a user-typed target names: exact key match first, then a unique word match. */
export function findRolesByName(roles: readonly AgentRole[], target: string): AgentRole[] {
  const key = roleNameKey(target);
  if (!key) return [];
  const stem = key.replace(/役$/, '');
  const exact = roles.filter((r) => {
    const k = roleNameKey(r.name);
    return k === key || k.replace(/役$/, '') === stem;
  });
  if (exact.length) return exact;
  return roles.filter((r) => roleNameKey(r.name).split(/\s+/).includes(key));
}

function unavailableText(reason: string | undefined, locale: RoleLocale): string {
  return fill(strings(locale)['roles.unavailable'], { reason: reason ?? 'unknown' });
}

// ─── Fresh intents ─────────────────────────────────────────────────────────

/**
 * Handle a detected role intent. Returns true when handled (the caller stops
 * routing); false to fall through (a weak edit/delete naming no saved role,
 * or a weak intent from a source that may not change roles).
 */
export async function handleRoleIntent(
  intent: RoleIntent,
  locale: RoleLocale,
  io: RoleChatIO,
  src: RoleChatSource,
): Promise<boolean> {
  const s = strings(locale);
  if (intent.kind === 'antigravity-refused') {
    logInfo('AgentRoles', 'role request named Antigravity — refused, nothing saved');
    io.post(s['roles.antigravity_refused']);
    return true;
  }
  if (intent.kind === 'list') {
    await postRoleList(locale, io);
    return true;
  }
  if (!canChangeRolesFrom(src)) {
    if ((intent.kind === 'edit' || intent.kind === 'delete') && intent.weak) return false;
    logInfo('AgentRoles', `role ${intent.kind} refused: source=${src.source ?? (src.typedByUser ? 'typed' : 'untyped')}`);
    io.post(s['roles.typed_only']);
    return true;
  }
  if (intent.kind === 'reset') {
    io.post(s['roles.reset_confirm'], { pendingRoleChange: { op: 'reset', attempts: 0, createdAt: now(io) } });
    return true;
  }

  const loaded = await loadRoles(io.run);
  if (loaded.unavailable) {
    if ((intent.kind === 'edit' || intent.kind === 'delete') && intent.weak) return false;
    io.post(unavailableText(loaded.reason, locale));
    return true;
  }

  if (intent.kind === 'create') return createFromIntent(intent, loaded.roles, locale, io);

  const matches = findRolesByName(loaded.roles, intent.target);
  if (matches.length !== 1) {
    if (matches.length === 0 && intent.weak) return false;
    io.post(
      matches.length === 0
        ? fill(s['roles.not_found'], { name: intent.target, names: loaded.roles.map((r) => r.name).join(', ') || '—' })
        : fill(s['roles.ambiguous_target'], { name: intent.target, names: matches.map((r) => r.name).join(', ') }),
    );
    return true;
  }
  const role = matches[0];
  if (intent.kind === 'delete') {
    io.post(fill(s['roles.delete_confirm'], { name: role.name }), {
      pendingRoleChange: { op: 'delete', roleId: role.id, roleName: role.name, attempts: 0, createdAt: now(io) },
    });
    return true;
  }
  return editFromIntent(role, intent.changes, locale, io);
}

async function createFromIntent(
  intent: Extract<RoleIntent, { kind: 'create' }>,
  roles: readonly AgentRole[],
  locale: RoleLocale,
  io: RoleChatIO,
): Promise<boolean> {
  const s = strings(locale);
  if (roles.length >= MAX_ROLES) {
    io.post(fill(s['roles.too_many'], { max: MAX_ROLES }));
    return true;
  }
  if (nameTaken(roles, intent.name)) {
    io.post(fill(s['roles.duplicate_name'], { name: intent.name }));
    return true;
  }
  if (!intent.instructions.trim()) {
    io.post(fill(s['roles.need_instructions'], { name: intent.name }));
    return true;
  }
  if (Array.from(intent.instructions).length > ROLE_INSTRUCTIONS_MAX_CHARS) {
    io.post(fill(s['roles.instructions_too_long'], { max: ROLE_INSTRUCTIONS_MAX_CHARS }));
    return true;
  }
  if (intent.workspaceInvalid) {
    io.post(fill(s['roles.bad_workspace'], { path: intent.workspaceInvalid, reason: 'not usable as a workspace' }));
    return true;
  }
  const workspace: AgentRoleWorkspace = intent.workspace ?? { mode: 'request' };
  if (workspace.mode === 'fixed') {
    const check = await checkFixedWorkspace(workspace.path, io);
    if (!check.ok) {
      io.post(fill(s['roles.bad_workspace'], { path: workspace.path, reason: check.reason }));
      return true;
    }
  }
  const engineDefaulted = !intent.engine;
  const engine: RoleEngine = intent.engine ?? { type: 'local' };
  const handlesDefaulted = intent.handles.length === 0;
  const handles: RoleKind[] = handlesDefaulted
    ? [engine.type === 'cli' ? 'implement' : 'write']
    : [...intent.handles];
  const isReviewer = handles.includes('review');
  const autoAttach = isReviewer && intent.autoAttach !== false;
  const t = now(io);
  const draft: AgentRole = {
    id: newRoleId(),
    name: intent.name,
    instructions: intent.instructions,
    engine,
    handles,
    workspace,
    ...(autoAttach ? { autoAttach: 'after-implement' as const } : {}),
    createdAt: t,
    updatedAt: t,
  };
  const role = parseRole(draft);
  if (!role) {
    io.post(fill(s['roles.invalid'], { name: intent.name }));
    return true;
  }
  const { level, degraded } = effectiveLevel(role, intent.level);
  io.post(buildCreateConfirm(role, level, { degraded, engineDefaulted, handlesDefaulted }, locale), {
    pendingRoleChange: { op: 'create', role, ...(level && level !== 'off' ? { level } : {}), attempts: 0, createdAt: t },
  });
  return true;
}

interface ConfirmNotes {
  degraded?: boolean;
  engineDefaulted?: boolean;
  handlesDefaulted?: boolean;
  levelReset?: RoleLevel;
}

function levelLines(role: AgentRole, level: RoleLevel | undefined, notes: ConfirmNotes, locale: RoleLocale): string[] {
  const s = strings(locale);
  const out: string[] = [];
  if (level !== undefined) out.push(fill(s['roles.field_level'], { v: levelLabel(level, locale) }));
  if (notes.degraded) out.push(s['roles.level_degraded']);
  return out;
}

function buildCreateConfirm(role: AgentRole, level: RoleLevel | undefined, notes: ConfirmNotes, locale: RoleLocale): string {
  const s = strings(locale);
  const lines = [s['roles.create_header'], ...describeRole(role, locale), ...levelLines(role, level ?? 'off', notes, locale)];
  if (notes.engineDefaulted) lines.push(s['roles.engine_defaulted']);
  if (notes.handlesDefaulted) lines.push(s['roles.handles_defaulted']);
  if (role.handles.includes('review')) {
    lines.push(fill(s[role.autoAttach ? 'roles.autoattach_on_note' : 'roles.autoattach_off_note'], { name: role.name }));
  }
  lines.push(s['roles.confirm_footer']);
  return lines.join('\n');
}

async function editFromIntent(role: AgentRole, changes: RoleChanges, locale: RoleLocale, io: RoleChatIO): Promise<boolean> {
  const s = strings(locale);
  if (changes.workspaceInvalid) {
    io.post(fill(s['roles.bad_workspace'], { path: changes.workspaceInvalid, reason: 'not usable as a workspace' }));
    return true;
  }
  if (changes.instructions !== undefined) {
    if (!changes.instructions.trim()) {
      io.post(fill(s['roles.need_instructions'], { name: role.name }));
      return true;
    }
    if (Array.from(changes.instructions).length > ROLE_INSTRUCTIONS_MAX_CHARS) {
      io.post(fill(s['roles.instructions_too_long'], { max: ROLE_INSTRUCTIONS_MAX_CHARS }));
      return true;
    }
  }
  if (changes.workspace?.mode === 'fixed') {
    const check = await checkFixedWorkspace(changes.workspace.path, io);
    if (!check.ok) {
      io.post(fill(s['roles.bad_workspace'], { path: changes.workspace.path, reason: check.reason }));
      return true;
    }
  }
  const instructions = changes.instructions ?? role.instructions;
  const handles = changes.instructions !== undefined
    ? (() => {
        const h = deriveRoleHandles(role.name, instructions);
        return h.length ? h : role.handles;
      })()
    : role.handles;
  if (changes.autoAttach === true && !handles.includes('review')) {
    io.post(fill(s['roles.autoattach_review_only'], { name: role.name }));
    return true;
  }
  const autoAttach = changes.autoAttach !== undefined ? changes.autoAttach : !!role.autoAttach && handles.includes('review');
  const { autoAttach: _drop, ...base } = role;
  void _drop;
  const edited: AgentRole = {
    ...base,
    instructions,
    handles: [...handles],
    engine: changes.engine ?? role.engine,
    workspace: changes.workspace ?? role.workspace,
    ...(autoAttach ? { autoAttach: 'after-implement' as const } : {}),
    updatedAt: now(io),
  };
  const parsed = parseRole(edited);
  if (!parsed) {
    io.post(fill(s['roles.invalid'], { name: role.name }));
    return true;
  }
  const definitionChanged = JSON.stringify(definingFields(parsed)) !== JSON.stringify(definingFields(role));
  const t = now(io);
  if (!definitionChanged) {
    if (changes.level === undefined) {
      io.post(fill(s['roles.no_change'], { name: role.name }));
      return true;
    }
    const { level, degraded } = effectiveLevel(role, changes.level);
    const lines = [fill(s['roles.level_confirm'], { name: role.name, level: levelLabel(level ?? 'off', locale) })];
    if (degraded) lines.push(s['roles.level_degraded']);
    lines.push(s['roles.existing_unaffected'], s['roles.confirm_footer']);
    io.post(lines.join('\n'), {
      pendingRoleChange: { op: 'level', roleId: role.id, roleName: role.name, level: level ?? 'off', attempts: 0, createdAt: t },
    });
    return true;
  }
  const previousLevel = await getRoleLevel(role);
  const { level, degraded } = effectiveLevel(parsed, changes.level);
  io.post(buildEditConfirm(parsed, level, { degraded, levelReset: changes.level === undefined && previousLevel !== 'off' ? previousLevel : undefined }, locale), {
    pendingRoleChange: { op: 'edit', roleId: role.id, role: parsed, ...(level !== undefined ? { level } : {}), attempts: 0, createdAt: t },
  });
  return true;
}

function definingFields(r: AgentRole): unknown {
  return [r.name, r.instructions, r.engine, r.handles, r.workspace, r.defaultSteps ?? null, r.autoAttach ?? null];
}

function buildEditConfirm(role: AgentRole, level: RoleLevel | undefined, notes: ConfirmNotes, locale: RoleLocale): string {
  const s = strings(locale);
  const lines = [fill(s['roles.edit_header'], { name: role.name }), ...describeRole(role, locale), ...levelLines(role, level, notes, locale)];
  if (notes.levelReset) lines.push(fill(s['roles.level_reset_note'], { level: levelLabel(notes.levelReset, locale) }));
  lines.push(s['roles.existing_unaffected'], s['roles.confirm_footer']);
  return lines.join('\n');
}

async function postRoleList(locale: RoleLocale, io: RoleChatIO): Promise<void> {
  const s = strings(locale);
  const loaded = await loadRoles(io.run);
  if (loaded.unavailable) {
    io.post(unavailableText(loaded.reason, locale));
    return;
  }
  if (!loaded.roles.length) {
    io.post(s['roles.list_empty']);
    return;
  }
  const lines = [s['roles.list_header']];
  let n = 1;
  for (const role of loaded.roles) {
    const level = await getRoleLevel(role);
    lines.push(
      fill(s['roles.list_item'], {
        n: n++,
        name: role.name,
        engine: roleEngineLabel(role.engine, locale),
        handles: kindsLabel(role.handles, locale),
        workspace: workspaceLabel(role.workspace, locale),
        level: levelLabel(level, locale),
      }) + (role.autoAttach ? s['roles.list_autoattach'] : ''),
    );
  }
  lines.push(s['roles.list_footer']);
  io.post(lines.join('\n'));
}

// ─── Replies to a pending question ─────────────────────────────────────────

function describePending(p: PendingRoleChange, locale: RoleLocale): string {
  const s = strings(locale);
  switch (p.op) {
    case 'create':
      return buildCreateConfirm(p.role, p.level, {}, locale);
    case 'edit':
      return buildEditConfirm(p.role, p.level, {}, locale);
    case 'delete':
      return fill(s['roles.delete_confirm'], { name: p.roleName });
    case 'level':
      return [fill(s['roles.level_confirm'], { name: p.roleName, level: levelLabel(p.level, locale) }), s['roles.confirm_footer']].join('\n');
    case 'reset':
      return s['roles.reset_confirm'];
  }
}

/**
 * Reply to a pending role question. Returns true when consumed. Only an
 * exact confirm phrase commits; cancel / no discards; anything else re-asks
 * once and then drops. The caller only calls this for typed composer text
 * (canChangeRolesFrom) — a pending question is never answered otherwise.
 */
export async function handlePendingRoleReply(
  pending: PendingRoleChange,
  userText: string,
  locale: RoleLocale,
  io: RoleChatIO,
  src: RoleChatSource,
): Promise<boolean> {
  const s = strings(locale);
  if (!canChangeRolesFrom(src)) return false;
  if (isCancelPhrase(userText) || classifyYesNo(userText) === 'no') {
    io.post(s['roles.cancelled']);
    return true;
  }
  if (isConfirmPhrase(userText)) {
    await commitPending(pending, locale, io);
    return true;
  }
  if ((pending.attempts ?? 0) >= 1) {
    io.post(s['roles.discarded_unclear']);
    return true;
  }
  io.post(`${s['roles.confirm_unclear']}\n${describePending(pending, locale)}`, {
    pendingRoleChange: { ...pending, attempts: (pending.attempts ?? 0) + 1 } as PendingRoleChange,
  });
  return true;
}

function failText(e: unknown, locale: RoleLocale): string {
  return `${strings(locale)['roles.save_failed']}: ${e instanceof Error ? e.message : String(e)}`;
}

async function commitPending(pending: PendingRoleChange, locale: RoleLocale, io: RoleChatIO): Promise<void> {
  const s = strings(locale);
  try {
    switch (pending.op) {
      case 'reset': {
        await resetRoles(io.run);
        logInfo('AgentRoles', 'roles reset (user-confirmed)');
        io.post(s['roles.reset_done']);
        return;
      }
      case 'create':
      case 'edit': {
        const role = parseRole(pending.role);
        if (!role || (pending.op === 'edit' && role.id !== pending.roleId)) {
          io.post(fill(s['roles.invalid'], { name: String(pending.role?.name ?? '') }));
          return;
        }
        if (role.workspace.mode === 'fixed') {
          // Re-checked at save: the directory may have changed since the ask.
          const check = await checkFixedWorkspace(role.workspace.path, io);
          if (!check.ok) {
            io.post(fill(s['roles.bad_workspace'], { path: role.workspace.path, reason: check.reason }));
            return;
          }
        }
        let refusal: string | null = null;
        const saved = await mutateRoles(io.run, (roles) => {
          if (pending.op === 'create') {
            if (roles.length >= MAX_ROLES) {
              refusal = fill(s['roles.too_many'], { max: MAX_ROLES });
              return roles;
            }
            if (nameTaken(roles, role.name) || roles.some((r) => r.id === role.id)) {
              refusal = fill(s['roles.duplicate_name'], { name: role.name });
              return roles;
            }
            return [...roles, role];
          }
          const idx = roles.findIndex((r) => r.id === role.id);
          if (idx === -1) {
            refusal = fill(s['roles.not_found'], { name: role.name, names: roles.map((r) => r.name).join(', ') || '—' });
            return roles;
          }
          if (nameTaken(roles, role.name, role.id)) {
            refusal = fill(s['roles.duplicate_name'], { name: role.name });
            return roles;
          }
          const next = [...roles];
          next[idx] = { ...role, createdAt: roles[idx].createdAt };
          return next;
        });
        if (refusal) {
          io.post(refusal);
          return;
        }
        const stored = saved.find((r) => r.id === role.id);
        const lines = [fill(s[pending.op === 'create' ? 'roles.created' : 'roles.edited'], { name: role.name })];
        if (stored && pending.level !== undefined) {
          const { level, degraded } = effectiveLevel(stored, pending.level);
          await setRoleLevel(io.run, stored, level ?? 'off', { via: 'chat' });
          lines.push(fill(s['roles.level_set'], { name: stored.name, level: levelLabel(level ?? 'off', locale) }));
          if (degraded) lines.push(s['roles.level_degraded']);
        }
        logInfo('AgentRoles', `role ${pending.op} id=${role.id} level=${pending.level ?? '-'}`);
        io.post(lines.join('\n'));
        return;
      }
      case 'level': {
        const loaded = await loadRoles(io.run);
        if (loaded.unavailable) {
          io.post(unavailableText(loaded.reason, locale));
          return;
        }
        const role = loaded.roles.find((r) => r.id === pending.roleId);
        if (!role) {
          io.post(fill(s['roles.not_found'], { name: pending.roleName, names: loaded.roles.map((r) => r.name).join(', ') || '—' }));
          return;
        }
        const { level, degraded } = effectiveLevel(role, pending.level);
        await setRoleLevel(io.run, role, level ?? 'off', { via: 'chat' });
        logInfo('AgentRoles', `role ${role.id} level=${level ?? 'off'} (user-confirmed)`);
        const lines = [fill(s['roles.level_set'], { name: role.name, level: levelLabel(level ?? 'off', locale) })];
        if (degraded) lines.push(s['roles.level_degraded']);
        io.post(lines.join('\n'));
        return;
      }
      case 'delete': {
        let removed: AgentRole | null = null;
        await mutateRoles(io.run, (roles) => {
          removed = roles.find((r) => r.id === pending.roleId) ?? null;
          return roles.filter((r) => r.id !== pending.roleId);
        });
        // mutateRoles already drops the level of a removed role; forgetRole
        // makes the "level removed too" promise explicit and idempotent.
        await forgetRole(pending.roleId);
        const gone = removed as AgentRole | null;
        logInfo('AgentRoles', `role deleted id=${pending.roleId} found=${!!gone}`);
        io.post(gone ? fill(s['roles.deleted'], { name: gone.name }) : fill(s['roles.not_found'], { name: pending.roleName, names: '—' }));
        return;
      }
    }
  } catch (e) {
    logWarn('AgentRoles', `role ${pending.op} failed`, e);
    io.post(failText(e, locale));
  }
}
