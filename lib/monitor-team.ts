/**
 * lib/monitor-team.ts — pure model behind the MONITOR pane's wiring map.
 *
 * A team is an ordered list of COLUMNS. Columns run left → right; every node
 * stacked in the same column runs at the same time (a parallel group). Edges
 * are never authored — they are derived from column order (every node in
 * column k feeds every node in column k + 1). A sub-agent hangs under its
 * parent node and is spawned by it at run time, so it is not a chain step.
 *
 * Hard shape rules (enforced by validate(), and every mutation below refuses
 * to produce a team that breaks them):
 *   - at least one column, no empty column
 *   - at most MAX_PARALLEL_BRANCHES nodes per column
 *   - the final column holds exactly one node (the final step performs the
 *     agent action and is never a fan-out branch — same rule as
 *     planParallelGroups() in lib/agent-orchestration.ts)
 *   - at most HARD_MAX_STEPS chain nodes in total
 *   - every node has a non-empty one-sentence role
 *   - at most MAX_SUBS_PER_NODE sub-agents per node, MAX_SUBS_TOTAL in all
 *   - cycles are impossible by construction (columns are a strict order)
 *
 * All functions are pure and never mutate their input.
 */
import type { AgentOrchestrationStep, ToolChoice } from '@/store/types';
import { HARD_MAX_STEPS, MAX_PARALLEL_BRANCHES } from './agent-orchestration';
import { formatMoney, USD_TO_YEN } from './monitor-source';

// ─── Types ───────────────────────────────────────────────────────────────────

export type MonitorProvider =
  | 'auto'
  | 'perplexity'
  | 'gemini-api'
  | 'cerebras'
  | 'groq'
  | 'local'
  | 'codex-cli'
  | 'claude-cli';

export type MonitorProviderKind = 'API' | 'CLI' | 'LOCAL' | 'AUTO';

export const MONITOR_PROVIDERS: readonly MonitorProvider[] = [
  'auto',
  'perplexity',
  'gemini-api',
  'cerebras',
  'groq',
  'local',
  'codex-cli',
  'claude-cli',
];

/** Display label of each provider (proper nouns, not translated). */
export const MONITOR_PROVIDER_LABEL: Record<MonitorProvider, string> = {
  auto: 'Auto',
  perplexity: 'Perplexity',
  'gemini-api': 'Gemini API',
  cerebras: 'Cerebras',
  groq: 'Groq',
  local: 'Local LLM',
  'codex-cli': 'Codex CLI',
  'claude-cli': 'Claude Code',
};

export const MONITOR_PROVIDER_KIND: Record<MonitorProvider, MonitorProviderKind> = {
  auto: 'AUTO',
  perplexity: 'API',
  'gemini-api': 'API',
  cerebras: 'API',
  groq: 'API',
  local: 'LOCAL',
  'codex-cli': 'CLI',
  // Subscription CLI (claude.ai plan / setup-token), like Codex's ChatGPT plan.
  'claude-cli': 'CLI',
};

export interface MonitorTeamNode {
  id: string;
  /** One-sentence role; for a chain node this becomes the step instruction. */
  role: string;
  provider: MonitorProvider;
  /** Ask the user (in plain chat) before this node writes anything. */
  askBeforeWrite: boolean;
  /** Optional short display name (e.g. "ARXIV SCOUT"). */
  name?: string;
}

export interface MonitorSubAgent extends MonitorTeamNode {
  /** Chain node that spawns this sub-agent. */
  parentId: string;
}

/** Where the team's final step saves its result (e.g. Obsidian + folder). */
export interface MonitorDestination {
  /** Short display label, e.g. "OBSIDIAN". */
  label: string;
  /** Target path; may contain the "{date}" placeholder (YYYY-MM-DD). */
  path: string;
}

export interface MonitorTeam {
  title: string;
  /** Free-form schedule, e.g. "daily 7:00". */
  schedule?: string;
  /** Optional budget cap per run, in USD (shown in the viewer's currency). */
  capUsd?: number;
  /** Output destination of the final step. */
  destination?: MonitorDestination;
  columns: MonitorTeamNode[][];
  subAgents: MonitorSubAgent[];
}

export type MonitorTeamErrorCode =
  | 'empty_team'
  | 'empty_column'
  | 'column_full'
  | 'final_parallel'
  | 'too_many_steps'
  | 'empty_role'
  | 'duplicate_id'
  | 'orphan_sub'
  | 'unknown_node'
  | 'last_node'
  | 'too_many_subs';

export interface MonitorTeamError {
  code: MonitorTeamErrorCode;
  column?: number;
  nodeId?: string;
}

export type MonitorTeamResult =
  | { ok: true; team: MonitorTeam }
  | { ok: false; error: MonitorTeamError };

/** Where a node goes: join an existing column, or become a new column
 *  inserted before original column `index` (index === columns.length appends). */
export type MonitorDropTarget =
  | { kind: 'column'; index: number }
  | { kind: 'newColumn'; index: number };

export const MAX_ROLE_CHARS = 140;
/** Sub-agent caps (a pasted team file can carry any number of them). */
export const MAX_SUBS_PER_NODE = 2;
export const MAX_SUBS_TOTAL = 4;
/** A pasted team file longer than this is refused before parsing. */
export const MAX_TEAM_FILE_CHARS = 8000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Collapse whitespace/newlines and clamp — a role is one sentence. */
export function normalizeRole(role: string): string {
  return role.replace(/\s+/g, ' ').trim().slice(0, MAX_ROLE_CHARS);
}

export function chainNodes(team: MonitorTeam): MonitorTeamNode[] {
  return team.columns.flat();
}

export function findNode(
  team: MonitorTeam,
  id: string,
): { node: MonitorTeamNode; column: number; row: number } | null {
  for (let c = 0; c < team.columns.length; c++) {
    const row = team.columns[c].findIndex((n) => n.id === id);
    if (row >= 0) return { node: team.columns[c][row], column: c, row };
  }
  return null;
}

function cloneTeam(team: MonitorTeam): MonitorTeam {
  return {
    ...team,
    ...(team.destination ? { destination: { ...team.destination } } : {}),
    columns: team.columns.map((col) => col.map((n) => ({ ...n }))),
    subAgents: team.subAgents.map((s) => ({ ...s })),
  };
}

/** Next free id of the form n<k>. */
export function nextNodeId(team: MonitorTeam): string {
  const used = new Set([...chainNodes(team), ...team.subAgents].map((n) => n.id));
  let k = used.size + 1;
  while (used.has(`n${k}`)) k++;
  return `n${k}`;
}

// ─── Validation ──────────────────────────────────────────────────────────────

/** Returns every rule the team breaks (empty array = valid). */
export function validate(team: MonitorTeam): MonitorTeamError[] {
  const errors: MonitorTeamError[] = [];
  if (team.columns.length === 0) {
    errors.push({ code: 'empty_team' });
    return errors;
  }
  team.columns.forEach((col, i) => {
    if (col.length === 0) errors.push({ code: 'empty_column', column: i });
    if (col.length > MAX_PARALLEL_BRANCHES) errors.push({ code: 'column_full', column: i });
  });
  const last = team.columns.length - 1;
  if (team.columns[last].length > 1) errors.push({ code: 'final_parallel', column: last });
  const nodes = chainNodes(team);
  if (nodes.length > HARD_MAX_STEPS) errors.push({ code: 'too_many_steps' });
  const seen = new Set<string>();
  for (const n of [...nodes, ...team.subAgents]) {
    if (normalizeRole(n.role).length === 0) errors.push({ code: 'empty_role', nodeId: n.id });
    if (seen.has(n.id)) errors.push({ code: 'duplicate_id', nodeId: n.id });
    seen.add(n.id);
  }
  const chainIds = new Set(nodes.map((n) => n.id));
  const subsPer = new Map<string, number>();
  for (const s of team.subAgents) {
    if (!chainIds.has(s.parentId)) errors.push({ code: 'orphan_sub', nodeId: s.id });
    subsPer.set(s.parentId, (subsPer.get(s.parentId) ?? 0) + 1);
  }
  const overParent = [...subsPer.entries()].find(([, n]) => n > MAX_SUBS_PER_NODE);
  if (overParent || team.subAgents.length > MAX_SUBS_TOTAL) {
    errors.push({ code: 'too_many_subs', ...(overParent ? { nodeId: overParent[0] } : {}) });
  }
  return errors;
}

export function isValidTeam(team: MonitorTeam): boolean {
  return validate(team).length === 0;
}

function checked(team: MonitorTeam): MonitorTeamResult {
  const errors = validate(team);
  return errors.length === 0 ? { ok: true, team } : { ok: false, error: errors[0] };
}

// ─── Mutations ───────────────────────────────────────────────────────────────

/** Place `node` at `target` in `columns` (indices refer to `columns` as
 *  given; empty columns are dropped afterwards). */
function placeAt(
  columns: MonitorTeamNode[][],
  node: MonitorTeamNode,
  target: MonitorDropTarget,
): MonitorTeamNode[][] | null {
  const next = columns.map((c) => [...c]);
  if (target.kind === 'column') {
    if (target.index < 0 || target.index >= next.length) return null;
    next[target.index].push(node);
  } else {
    if (target.index < 0 || target.index > next.length) return null;
    next.splice(target.index, 0, [node]);
  }
  return next.filter((c) => c.length > 0);
}

/** Move a chain node to `target`. Refuses (ok: false) rather than produce an
 *  invalid team. Indices in `target` refer to the team's CURRENT columns. */
export function moveNode(
  team: MonitorTeam,
  nodeId: string,
  target: MonitorDropTarget,
): MonitorTeamResult {
  const found = findNode(team, nodeId);
  if (!found) return { ok: false, error: { code: 'unknown_node', nodeId } };
  if (target.kind === 'column' && target.index === found.column) return { ok: true, team };
  if (target.kind === 'column') {
    const dest = team.columns[target.index];
    if (dest && dest.length >= MAX_PARALLEL_BRANCHES) {
      return { ok: false, error: { code: 'column_full', column: target.index } };
    }
  }
  const base = cloneTeam(team);
  // Empty the source slot but keep the column so target indices stay valid.
  const columns = base.columns.map((col, c) =>
    c === found.column ? col.filter((n) => n.id !== nodeId) : col,
  );
  const placed = placeAt(columns, { ...found.node }, target);
  if (!placed) return { ok: false, error: { code: 'unknown_node', nodeId } };
  return checked({ ...base, columns: placed });
}

/** Move one step earlier (←) or later (→) as a serial step. A node sharing
 *  its column first splits out next to its group; a lone node swaps past
 *  the neighbouring column. */
export function shiftNode(team: MonitorTeam, nodeId: string, dir: -1 | 1): MonitorTeamResult {
  const found = findNode(team, nodeId);
  if (!found) return { ok: false, error: { code: 'unknown_node', nodeId } };
  const shared = team.columns[found.column].length > 1;
  let index: number;
  if (dir < 0) index = shared ? found.column : found.column - 1;
  else index = shared ? found.column + 1 : found.column + 2;
  if (index < 0 || index > team.columns.length) return { ok: true, team };
  return moveNode(team, nodeId, { kind: 'newColumn', index });
}

/** "Make parallel with": join the column of another node. */
export function makeParallel(team: MonitorTeam, nodeId: string, withId: string): MonitorTeamResult {
  const other = findNode(team, withId);
  if (!other) return { ok: false, error: { code: 'unknown_node', nodeId: withId } };
  return moveNode(team, nodeId, { kind: 'column', index: other.column });
}

export interface NewNodeInput {
  role: string;
  provider?: MonitorProvider;
  askBeforeWrite?: boolean;
  name?: string;
}

/** Add a chain node. Default position: a new serial step right before the
 *  final step (so the final step stays the final step). */
export function addNode(
  team: MonitorTeam,
  input: NewNodeInput,
  target?: MonitorDropTarget,
): MonitorTeamResult & { id?: string } {
  const role = normalizeRole(input.role);
  const id = nextNodeId(team);
  if (role.length === 0) return { ok: false, error: { code: 'empty_role', nodeId: id } };
  if (chainNodes(team).length >= HARD_MAX_STEPS) return { ok: false, error: { code: 'too_many_steps' } };
  const node: MonitorTeamNode = {
    id,
    role,
    provider: input.provider ?? 'auto',
    askBeforeWrite: input.askBeforeWrite ?? false,
    ...(input.name ? { name: input.name } : {}),
  };
  const where: MonitorDropTarget =
    target ?? { kind: 'newColumn', index: Math.max(0, team.columns.length - 1) };
  if (where.kind === 'column') {
    const dest = team.columns[where.index];
    if (dest && dest.length >= MAX_PARALLEL_BRANCHES) {
      return { ok: false, error: { code: 'column_full', column: where.index } };
    }
  }
  const base = cloneTeam(team);
  const placed = placeAt(base.columns, node, where);
  if (!placed) return { ok: false, error: { code: 'unknown_node', nodeId: id } };
  const res = checked({ ...base, columns: placed });
  return res.ok ? { ...res, id } : res;
}

export type NodePatch = Partial<Pick<MonitorTeamNode, 'role' | 'provider' | 'askBeforeWrite' | 'name'>>;

/** Edit a chain node or a sub-agent in place. */
export function updateNode(team: MonitorTeam, nodeId: string, patch: NodePatch): MonitorTeamResult {
  const apply = <T extends MonitorTeamNode>(n: T): T => {
    if (n.id !== nodeId) return n;
    const next = { ...n, ...patch };
    if (patch.role !== undefined) next.role = normalizeRole(patch.role);
    return next;
  };
  const isKnown =
    findNode(team, nodeId) !== null || team.subAgents.some((s) => s.id === nodeId);
  if (!isKnown) return { ok: false, error: { code: 'unknown_node', nodeId } };
  return checked({
    ...team,
    columns: team.columns.map((col) => col.map(apply)),
    subAgents: team.subAgents.map(apply),
  });
}

/** Remove a chain node (and its sub-agents) or a sub-agent. */
export function removeNode(team: MonitorTeam, nodeId: string): MonitorTeamResult {
  if (team.subAgents.some((s) => s.id === nodeId)) {
    return checked({ ...team, subAgents: team.subAgents.filter((s) => s.id !== nodeId) });
  }
  if (!findNode(team, nodeId)) return { ok: false, error: { code: 'unknown_node', nodeId } };
  if (chainNodes(team).length <= 1) return { ok: false, error: { code: 'last_node', nodeId } };
  return checked({
    ...team,
    columns: team.columns
      .map((col) => col.filter((n) => n.id !== nodeId))
      .filter((col) => col.length > 0),
    subAgents: team.subAgents.filter((s) => s.parentId !== nodeId),
  });
}

// ─── Derived edges ───────────────────────────────────────────────────────────

export interface MonitorTeamEdge {
  id: string;
  from: string;
  /** Node id, or 'goal' for the final result. */
  to: string;
  sub?: boolean;
}

/** Every node in column k → every node in column k+1; each sub-agent hangs
 *  off its parent; the final node → 'goal'. */
export function deriveEdges(team: MonitorTeam): MonitorTeamEdge[] {
  const edges: MonitorTeamEdge[] = [];
  for (let c = 0; c + 1 < team.columns.length; c++) {
    for (const a of team.columns[c]) {
      for (const b of team.columns[c + 1]) edges.push({ id: `${a.id}>${b.id}`, from: a.id, to: b.id });
    }
  }
  for (const s of team.subAgents) edges.push({ id: `${s.parentId}>${s.id}`, from: s.parentId, to: s.id, sub: true });
  const last = team.columns[team.columns.length - 1];
  if (last && last.length === 1) edges.push({ id: `${last[0].id}>goal`, from: last[0].id, to: 'goal' });
  return edges;
}

// ─── Drag drop resolution ────────────────────────────────────────────────────

/**
 * Resolve a horizontal drop position on the map into a target. Column c
 * occupies [left + c*(colW+gap), +colW). The centre 60% of a column joins it;
 * the outer 20% on each side, and the gaps, insert a new column there.
 */
export function resolveDropTarget(
  x: number,
  columnCount: number,
  colW: number,
  gap: number,
  left = 0,
): MonitorDropTarget {
  const pitch = colW + gap;
  const rel = x - left;
  if (rel < 0) return { kind: 'newColumn', index: 0 };
  const c = Math.floor(rel / pitch);
  if (c >= columnCount) return { kind: 'newColumn', index: columnCount };
  const within = rel - c * pitch;
  if (within >= colW) return { kind: 'newColumn', index: c + 1 };
  if (within < colW * 0.2) return { kind: 'newColumn', index: c };
  if (within > colW * 0.8) return { kind: 'newColumn', index: c + 1 };
  return { kind: 'column', index: c };
}

// ─── Orchestration mapping ───────────────────────────────────────────────────

export function providerToTool(provider: MonitorProvider): ToolChoice | undefined {
  switch (provider) {
    case 'auto':
      return undefined;
    case 'codex-cli':
      return { type: 'cli', cli: 'codex' };
    case 'claude-cli':
      return { type: 'cli', cli: 'claude' };
    case 'perplexity':
    case 'gemini-api':
    case 'cerebras':
    case 'groq':
    case 'local':
      return { type: provider };
  }
}

/**
 * Map the team's chain columns to AgentOrchestrationStep[] (in column order).
 * A multi-node column becomes consecutive steps sharing one parallelGroup id,
 * so planParallelGroups() runs them as one fan-out group. Sub-agents are not
 * chain steps and are not emitted. askBeforeWrite has no per-step field in
 * AgentOrchestrationStep — see requiresWriteApproval().
 */
export function toOrchestrationSteps(team: MonitorTeam): AgentOrchestrationStep[] {
  const steps: AgentOrchestrationStep[] = [];
  team.columns.forEach((col, c) => {
    const group = col.length > 1 ? `p${c + 1}` : undefined;
    for (const n of col) {
      const tool = providerToTool(n.provider);
      steps.push({
        instruction: normalizeRole(n.role),
        ...(tool ? { tool } : {}),
        ...(group ? { parallelGroup: group } : {}),
      });
    }
  });
  return steps;
}

/** True when any chain node asked to confirm before writing. */
export function requiresWriteApproval(team: MonitorTeam): boolean {
  return chainNodes(team).some((n) => n.askBeforeWrite);
}

// ─── Team file format ────────────────────────────────────────────────────────
//
//   # Morning AI paper digest   daily 7:00 / cap ¥20
//   -> OBSIDIAN: 20_Literature/AI_Papers/{date}/
//   - 同時に:                       (or "in parallel:")
//     - collect new papers from arXiv
//     - collect new papers from Hugging Face
//   - pick 3 and summarize
//     - sub: check every claim has a source
//   - save to Obsidian AI_Papers/ (ask before writing)
//
// A provider pin is a trailing "[Perplexity]" (label or id); "(ask before
// writing)" / "(書き込み前に確認)" sets askBeforeWrite. The header meta after
// the title (two+ spaces) is "schedule / cap <money>"; the cap accepts "¥20"
// (converted at USD_TO_YEN) or "$0.15" and is written back in the viewer's
// currency. A top-level "-> LABEL: path" line sets the output destination.

const PARALLEL_HEADER_RE = /^(同時に|並列で|in parallel|parallel)\s*[:：]\s*$/i;
const SUB_PREFIX_RE = /^(sub|サブ)\s*[:：]\s*/i;
const ASK_RE = /\s*[(（]\s*(ask before writing|書き込み前に確認)\s*[)）]\s*/i;
const PROVIDER_RE = /\s*\[([^\]]+)\]\s*$/;
const CAP_RE = /^cap\s*([¥￥$])\s*(\d[\d,]*(?:\.\d+)?)$/i;
const DEST_RE = /^(?:->|→)\s*(.+?)\s*[:：]\s*(\S.*)$/;

/** Split header meta "daily 7:00 / cap ¥20" into schedule + capUsd. */
export function parseTeamMeta(meta: string): { schedule?: string; capUsd?: number } {
  const rest: string[] = [];
  let capUsd: number | undefined;
  for (const seg of meta.split('/').map((x) => x.trim()).filter(Boolean)) {
    const m = CAP_RE.exec(seg);
    if (m && capUsd === undefined) {
      const n = Number(m[2].replace(/,/g, ''));
      if (Number.isFinite(n)) {
        capUsd = m[1] === '$' ? n : n / USD_TO_YEN;
        continue;
      }
    }
    rest.push(seg);
  }
  const schedule = rest.join(' / ');
  return { ...(schedule ? { schedule } : {}), ...(capUsd !== undefined ? { capUsd } : {}) };
}

/** Header meta in the viewer's currency, e.g. "daily 7:00 / cap ¥20". */
export function formatTeamMeta(team: Pick<MonitorTeam, 'schedule' | 'capUsd'>, locale = 'en'): string {
  const parts: string[] = [];
  if (team.schedule) parts.push(team.schedule);
  if (team.capUsd !== undefined) parts.push(`cap ${formatMoney(team.capUsd, locale)}`);
  return parts.join(' / ');
}

/** Destination path with the "{date}" placeholder filled in. */
export function destinationPath(dest: MonitorDestination, date: string): string {
  return dest.path.split('{date}').join(date);
}

function parseProvider(raw: string): MonitorProvider | null {
  const v = raw.trim().toLowerCase();
  for (const p of MONITOR_PROVIDERS) {
    if (p === v || MONITOR_PROVIDER_LABEL[p].toLowerCase() === v) return p;
  }
  return null;
}

function parseItem(text: string): Omit<MonitorTeamNode, 'id'> {
  let rest = text;
  let askBeforeWrite = false;
  if (ASK_RE.test(rest)) {
    askBeforeWrite = true;
    rest = rest.replace(ASK_RE, ' ');
  }
  let provider: MonitorProvider = 'auto';
  const pm = PROVIDER_RE.exec(rest);
  if (pm) {
    const p = parseProvider(pm[1]);
    if (p) {
      provider = p;
      rest = rest.slice(0, pm.index);
    }
  }
  return { role: normalizeRole(rest), provider, askBeforeWrite };
}

export type ParseTeamResult =
  | { ok: true; team: MonitorTeam }
  | { ok: false; error: MonitorTeamError | { code: 'syntax'; line: number } | { code: 'too_long' } };

/** C0 controls except tab / LF / CR, and DEL. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function parseTeamFile(rawSource: string): ParseTeamResult {
  if (rawSource.length > MAX_TEAM_FILE_CHARS) return { ok: false, error: { code: 'too_long' } };
  const source = rawSource.replace(CONTROL_CHARS_RE, '');
  let title = '';
  let meta: { schedule?: string; capUsd?: number } = {};
  let destination: MonitorDestination | undefined;
  const columns: MonitorTeamNode[][] = [];
  const subAgents: MonitorSubAgent[] = [];
  let openParallel: MonitorTeamNode[] | null = null;
  let lastSerial: MonitorTeamNode | null = null;
  let k = 0;
  const mint = () => `n${++k}`;
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\t/g, '  ');
    if (raw.trim() === '') continue;
    const header = /^#\s+(.*)$/.exec(raw.trim());
    if (header && raw.trimStart().startsWith('#')) {
      const parts = /^(.*?)(?:\s{2,}(.*))?$/.exec(header[1].trimEnd());
      title = (parts?.[1] ?? header[1]).trim();
      const m = parts?.[2]?.trim();
      meta = m ? parseTeamMeta(m) : {};
      continue;
    }
    const dest = DEST_RE.exec(raw.trim());
    if (dest && !/^\s/.test(raw)) {
      destination = { label: dest[1].trim(), path: dest[2].trim() };
      continue;
    }
    const item = /^(\s*)[-*]\s+(.*)$/.exec(raw);
    if (!item) return { ok: false, error: { code: 'syntax', line: i + 1 } };
    const indented = item[1].length >= 2;
    const body = item[2].trim();
    if (!indented) {
      openParallel = null;
      lastSerial = null;
      if (PARALLEL_HEADER_RE.test(body)) {
        openParallel = [];
        columns.push(openParallel);
        continue;
      }
      const node = { id: mint(), ...parseItem(body) };
      columns.push([node]);
      lastSerial = node;
      continue;
    }
    if (SUB_PREFIX_RE.test(body)) {
      const parent = lastSerial ?? openParallel?.[openParallel.length - 1] ?? null;
      if (!parent) return { ok: false, error: { code: 'syntax', line: i + 1 } };
      subAgents.push({ id: mint(), parentId: parent.id, ...parseItem(body.replace(SUB_PREFIX_RE, '')) });
      continue;
    }
    if (!openParallel) return { ok: false, error: { code: 'syntax', line: i + 1 } };
    openParallel.push({ id: mint(), ...parseItem(body) });
  }
  const team: MonitorTeam = {
    title,
    ...meta,
    ...(destination ? { destination } : {}),
    columns,
    subAgents,
  };
  const errors = validate(team);
  return errors.length === 0 ? { ok: true, team } : { ok: false, error: errors[0] };
}

function serializeItem(n: MonitorTeamNode): string {
  let s = normalizeRole(n.role);
  if (n.provider !== 'auto') s += ` [${MONITOR_PROVIDER_LABEL[n.provider]}]`;
  if (n.askBeforeWrite) s += ' (ask before writing)';
  return s;
}

export function serializeTeamFile(team: MonitorTeam, parallelLabel = 'in parallel:', locale = 'en'): string {
  const out: string[] = [];
  const meta = formatTeamMeta(team, locale);
  out.push(`# ${team.title}${meta ? `   ${meta}` : ''}`);
  if (team.destination) out.push(`-> ${team.destination.label}: ${team.destination.path}`);
  const subsOf = (id: string) => team.subAgents.filter((s) => s.parentId === id);
  for (const col of team.columns) {
    if (col.length > 1) {
      out.push(`- ${parallelLabel}`);
      for (const n of col) {
        out.push(`  - ${serializeItem(n)}`);
        for (const s of subsOf(n.id)) out.push(`  - sub: ${serializeItem(s)}`);
      }
    } else {
      const n = col[0];
      out.push(`- ${serializeItem(n)}`);
      for (const s of subsOf(n.id)) out.push(`  - sub: ${serializeItem(s)}`);
    }
  }
  return out.join('\n') + '\n';
}
