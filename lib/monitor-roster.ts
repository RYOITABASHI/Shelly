/**
 * lib/monitor-roster.ts — the MONITOR "staff" roster: the user's agent roles
 * shown as always-present STANDBY channels when nothing is running (in-app
 * MONITOR pane and the home-screen widget). Product owner 2026-11-02:
 * 「常時スタッフがいてくれたほうが良い」.
 *
 * Source of truth stays ~/.shelly/agents/roles.json (lib/agent-role-store.ts,
 * sealed, RN the single writer). From it RN derives a small DISPLAY-ONLY
 * snapshot — name, engine label, kind, handled task kinds; never the
 * instructions, never levels, never workspace paths — and publishes it to
 * ~/.shelly/agents/monitor-roster.json (the existing agents dir the widget
 * already reads; no new directory). Native (monitor/MonitorRoster.kt) reads
 * it read-only and treats every string as untrusted display text (re-capped,
 * control / format characters dropped). Native never writes it.
 *
 * The file has no top-level `id`, so every agents-dir scanner skips it (same
 * as policy.json / roles.json), and the gate's PROTECTED_POLICY_FILE_RE
 * already denies agent CLI writes to `.shelly/agents/*.json`.
 *
 * Pure parts are exported for tests; the publisher's I/O is injected
 * (lib/monitor-roster-device.ts wires execCommand + the native widget hook).
 */
import { logInfo, logWarn } from '@/lib/debug-logger';
import { subscribeRoles, loadRoles, getCachedRoles, type ShellRunner } from '@/lib/agent-role-store';
import { isRoleKind, type AgentRole, type LoadedRoles, type RoleEngine, type RoleKind } from '@/lib/agent-role-types';
import { liveChannelLabel } from '@/lib/monitor-live';
import type { MonitorAgentDef, MonitorAgentSnapshot, MonitorSnapshot, MonitorSource } from '@/lib/monitor-source';
import { MONITOR_PROVIDER_KIND, MONITOR_PROVIDER_LABEL, type MonitorProvider, type MonitorTeam } from '@/lib/monitor-team';

export const MONITOR_ROSTER_RELATIVE_PATH = '.shelly/agents/monitor-roster.json';
/** Entries written at most (the widget shows 4 and "+N"). */
export const ROSTER_MAX_ENTRIES = 8;
/** Max characters of any roster string. */
export const ROSTER_TEXT_MAX_CHARS = 24;

export type MonitorRosterKind = 'CLI' | 'API' | 'LOCAL';

export interface MonitorRosterEntry {
  name: string;
  /** Display label of the role's engine (Codex / Claude Code / Local LLM / API name). */
  engine: string;
  kind: MonitorRosterKind;
  handles: RoleKind[];
}

/** On-disk shape of monitor-roster.json. */
export interface MonitorRoster {
  kind: 'shelly-monitor-roster';
  version: 1;
  /** roles.json could not be verified (fail-closed): no names are published. */
  unavailable: boolean;
  /** Number of roles the user has (may exceed roles.length). */
  total: number;
  roles: MonitorRosterEntry[];
}

// Control (Cc) and format (Cf: bidi overrides, zero-width…) characters.
const UNPRINTABLE_RE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/** Display-safe text: unprintables dropped, whitespace collapsed, ≤ ROSTER_TEXT_MAX_CHARS code points. */
export function sanitizeRosterText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const flat = value.replace(UNPRINTABLE_RE, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(flat).slice(0, ROSTER_TEXT_MAX_CHARS).join('').trim();
}

/** Monitor provider of a role engine (for the in-app camera chip). */
export function roleEngineProvider(engine: RoleEngine): MonitorProvider | null {
  switch (engine.type) {
    case 'cli':
      return engine.cli === 'codex' ? 'codex-cli' : engine.cli === 'claude' ? 'claude-cli' : null;
    case 'gemini-api':
    case 'cerebras':
    case 'groq':
    case 'local':
    case 'perplexity':
      return engine.type;
    default:
      return null;
  }
}

/** Short engine label: Codex / Claude Code / Local LLM / the API's name. */
export function roleEngineLabel(engine: RoleEngine): string {
  if (engine.type === 'cli') return engine.cli === 'codex' ? 'Codex' : engine.cli === 'claude' ? 'Claude Code' : 'CLI';
  if (engine.type === 'openrouter') return 'OpenRouter';
  const p = roleEngineProvider(engine);
  return p ? MONITOR_PROVIDER_LABEL[p] : 'API';
}

export function roleEngineKind(engine: RoleEngine): MonitorRosterKind {
  if (engine.type === 'cli') return 'CLI';
  if (engine.type === 'local') return 'LOCAL';
  return 'API';
}

/** The display-only snapshot of a loaded role list. */
export function buildMonitorRoster(loaded: LoadedRoles): MonitorRoster {
  if (loaded.unavailable) {
    return { kind: 'shelly-monitor-roster', version: 1, unavailable: true, total: 0, roles: [] };
  }
  const roles: MonitorRosterEntry[] = [];
  for (const r of loaded.roles) {
    if (roles.length >= ROSTER_MAX_ENTRIES) break;
    const entry = rosterEntry(r);
    if (entry) roles.push(entry);
  }
  return { kind: 'shelly-monitor-roster', version: 1, unavailable: false, total: Math.max(roles.length, loaded.roles.length), roles };
}

function rosterEntry(role: AgentRole): MonitorRosterEntry | null {
  const name = sanitizeRosterText(role.name);
  if (!name) return null;
  return {
    name,
    engine: sanitizeRosterText(roleEngineLabel(role.engine)),
    kind: roleEngineKind(role.engine),
    handles: (role.handles ?? []).filter(isRoleKind).slice(0, 7),
  };
}

export function serializeMonitorRoster(roster: MonitorRoster): string {
  return `${JSON.stringify(roster)}\n`;
}

/** Shell command writing the roster atomically (tmp + mv) into the existing agents dir. */
export function rosterWriteCommand(content: string): string {
  const marker = `SHELLY_ROSTER_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const target = `"$HOME/${MONITOR_ROSTER_RELATIVE_PATH}"`;
  const tmp = `"$HOME/${MONITOR_ROSTER_RELATIVE_PATH}.${marker}.tmp"`;
  return `set -e\n[ -d "$HOME/.shelly/agents" ] && cat > ${tmp} <<'${marker}' && mv -f ${tmp} ${target}\n${content}${marker}`;
}

// ─── In-memory roster + publisher ──────────────────────────────────────────

export interface MonitorRosterPublisher {
  run: ShellRunner;
  /** Tells the home-screen widget to refresh once (no-op where absent). */
  notify: () => void;
}

let current: MonitorRoster | null = null;
let publisher: MonitorRosterPublisher | null = null;
let lastWritten: string | null = null;
let writeChain: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();

/** Latest roster (null before roles were ever loaded). */
export function getMonitorRoster(): MonitorRoster | null {
  return current;
}

export function subscribeMonitorRoster(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function configureMonitorRosterPublisher(p: MonitorRosterPublisher | null): void {
  publisher = p;
  if (p && current) void publishMonitorRoster(current);
}

/** Test hook. */
export function __resetMonitorRosterForTests(): void {
  current = null;
  publisher = null;
  lastWritten = null;
  writeChain = Promise.resolve();
  listeners.clear();
}

/** Record a role list (from the role store's listener) and publish it. */
export function noteRoles(loaded: LoadedRoles): Promise<void> {
  const next = buildMonitorRoster(loaded);
  if (!current || JSON.stringify(current) !== JSON.stringify(next)) {
    current = next;
    for (const l of listeners) {
      try {
        l();
      } catch {
        // display only
      }
    }
  }
  return publishMonitorRoster(next);
}

/** Write the roster file when its content changed, then ping the widget. Never throws. */
export function publishMonitorRoster(roster: MonitorRoster): Promise<void> {
  const p = publisher;
  if (!p) return Promise.resolve();
  const content = serializeMonitorRoster(roster);
  const next = writeChain.then(async () => {
    if (content === lastWritten) return;
    try {
      await p.run(rosterWriteCommand(content));
      lastWritten = content;
      logInfo('MonitorRoster', `roster published roles=${roster.roles.length} total=${roster.total} unavailable=${roster.unavailable}`);
      try {
        p.notify();
      } catch {
        // best effort
      }
    } catch (e) {
      logWarn('MonitorRoster', 'roster publish failed', e);
    }
  });
  writeChain = next.catch(() => undefined);
  return next;
}

/** Load roles once (when nothing loaded them yet); the listener publishes. */
export function ensureMonitorRoster(run: ShellRunner): Promise<void> {
  const cached = getCachedRoles();
  if (cached) return noteRoles(cached);
  return loadRoles(run).then(() => undefined, () => undefined);
}

subscribeRoles((loaded) => {
  void noteRoles(loaded);
});

// ─── In-app MONITOR source ─────────────────────────────────────────────────

function standby(): MonitorAgentSnapshot {
  return { state: 'STANDBY', lines: [], note: null, logs: 0, totalLogs: 1, tokens: 0, usd: null };
}

function providerFromEntry(entry: MonitorRosterEntry): MonitorProvider {
  const byLabel = (Object.keys(MONITOR_PROVIDER_LABEL) as MonitorProvider[]).find(
    (p) => p !== 'auto' && MONITOR_PROVIDER_LABEL[p] === entry.engine,
  );
  if (byLabel) return byLabel;
  if (entry.engine === 'Codex') return 'codex-cli';
  if (entry.kind === 'LOCAL') return 'local';
  return 'auto';
}

/** Channel id of a roster camera. */
export function rosterDefId(i: number): string {
  return `staff${i}`;
}

/** Roster entries as MONITOR camera defs (role name as the channel, like a live role step). */
export function rosterDefs(roster: MonitorRoster): MonitorAgentDef[] {
  return roster.roles.map((r, i) => {
    const provider = providerFromEntry(r);
    const kind = provider === 'auto' ? r.kind : MONITOR_PROVIDER_KIND[provider];
    return {
      id: rosterDefId(i),
      channel: liveChannelLabel(i, r.name),
      name: r.name,
      kind,
      provider,
      providerName: r.engine,
      model: '',
      operator: (((i % 5) + 1) as MonitorAgentDef['operator']),
    };
  });
}

/** A still source: every role on STANDBY (no playback, no costs). */
export function createRosterSource(roster: MonitorRoster, title: string): MonitorSource {
  const agents = rosterDefs(roster);
  const team: MonitorTeam = {
    title,
    columns: roster.roles.map((r, i) => [{ id: rosterDefId(i), role: r.name, name: r.name, provider: providerFromEntry(r), askBeforeWrite: false }]),
    subAgents: [],
  };
  const snap: MonitorSnapshot = {
    t: 0,
    agents: Object.fromEntries(agents.map((d) => [d.id, standby()])),
    approvalPending: false,
    approvalAgentId: null,
    complete: false,
    chat: [],
    missionPct: 0,
  };
  return { isDemo: false, agents, team, snapshot: () => snap };
}
