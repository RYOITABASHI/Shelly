/**
 * lib/agent-runs-view.ts — pure display logic for the Agent Runs pane
 * (components/panes/AgentRunsPane.tsx).
 *
 * Deliberately dependency-free (type-only imports from store/types.ts, which
 * itself imports nothing at runtime) so the grouping / ordering / formatting
 * rules are unit-testable in the plain-node "unit" jest project — the same
 * extract-for-testability split lib/agent-data-sync.ts already uses.
 *
 * Nothing here formats a user-facing string directly: age descriptions and
 * route rows return i18n KEYS plus interpolation params, so every visible
 * string still resolves through lib/i18n's en.ts/ja.ts pair.
 */
import type { Agent, AgentRouteDecision, AgentRunLog } from '@/store/types';

/** One agent's retained run history, ready to render. */
export interface AgentRunGroup {
  agentId: string;
  /** The agent's name, or the raw id when the agent itself was deleted but
   *  ~/.shelly/agents/logs/<agentId>/ (and therefore the store's runHistory)
   *  still holds its runs. */
  agentName: string;
  /** Newest first. The store already caps this at 30 per agent. */
  runs: AgentRunLog[];
  /** Timestamp of `runs[0]`, hoisted so callers don't re-derive it. */
  latestTimestamp: number;
}

/**
 * Turns agent-store's `runHistory` map into a render-ready, newest-first list.
 *
 * agent-store appends with `.slice(-30)`, i.e. OLDEST-first, and
 * readAgentRunLogs reads one JSON file per run off disk — neither guarantees
 * ordering strongly enough to render straight through, so runs are re-sorted
 * defensively here (on a copy — the store's arrays are never mutated).
 */
export function buildAgentRunGroups(
  runHistory: Record<string, AgentRunLog[] | undefined>,
  agents: readonly Pick<Agent, 'id' | 'name'>[],
  opts: { agentId?: string | null } = {},
): AgentRunGroup[] {
  const nameById = new Map(agents.map((a) => [a.id, a.name]));
  const groups: AgentRunGroup[] = [];

  for (const [agentId, logs] of Object.entries(runHistory)) {
    if (opts.agentId && agentId !== opts.agentId) continue;
    if (!logs || logs.length === 0) continue;
    const runs = [...logs].sort((a, b) => b.timestamp - a.timestamp);
    groups.push({
      agentId,
      agentName: nameById.get(agentId) || agentId,
      runs,
      latestTimestamp: runs[0].timestamp,
    });
  }

  return groups.sort((a, b) => b.latestTimestamp - a.latestTimestamp);
}

/** Semantic tone name — the pane maps these onto useTheme().colors, never hex. */
export type RunStatusTone = 'success' | 'error' | 'warning' | 'muted';

export function runStatusTone(status: AgentRunLog['status']): RunStatusTone {
  switch (status) {
    case 'success':
      return 'success';
    case 'error':
      return 'error';
    // 'unavailable' = every web backend failed transiently. Not a hard error
    // (it never trips the circuit breaker), so it must not read like one.
    case 'unavailable':
      return 'warning';
    case 'skipped':
    default:
      return 'muted';
  }
}

/** MaterialIcons glyph name for a run status. */
export function runStatusIcon(status: AgentRunLog['status']): string {
  switch (status) {
    case 'success':
      return 'check-circle';
    case 'error':
      return 'error';
    case 'unavailable':
      return 'cloud-off';
    case 'skipped':
    default:
      return 'remove-circle-outline';
  }
}

/**
 * Compact duration label. Returns '' (not '0ms') for a missing/nonsensical
 * value so the row simply omits the chip instead of showing a fake zero.
 */
export function formatRunDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** An i18n key plus its interpolation params — resolved by the caller's `t()`. */
export interface RunAgeToken {
  key: string;
  params?: Record<string, string | number>;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local-time `YYYY-MM-DD HH:mm` — locale-neutral, so both en and ja read it. */
function formatAbsolute(timestamp: number): string {
  const d = new Date(timestamp);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    ` ${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/**
 * Relative age of a run. A future timestamp (clock skew between the alarm
 * that wrote the log and the app reading it) collapses to "just now" rather
 * than rendering a negative count.
 */
export function describeRunAge(timestamp: number, now: number): RunAgeToken {
  const diff = now - timestamp;
  if (!Number.isFinite(diff) || diff < 60_000) return { key: 'agent_runs.age_just_now' };
  if (diff < 3_600_000) {
    return { key: 'agent_runs.age_minutes', params: { count: Math.floor(diff / 60_000) } };
  }
  if (diff < 86_400_000) {
    return { key: 'agent_runs.age_hours', params: { count: Math.floor(diff / 3_600_000) } };
  }
  if (diff < 7 * 86_400_000) {
    return { key: 'agent_runs.age_days', params: { count: Math.floor(diff / 86_400_000) } };
  }
  return { key: 'agent_runs.age_absolute', params: { when: formatAbsolute(timestamp) } };
}

/**
 * One label/value line of the route-decision detail block. Exactly one of
 * `value` (already-formatted, non-translatable data) or `valueKey` (a
 * translated constant such as "Yes") is set.
 */
export interface RouteDecisionRow {
  labelKey: string;
  value?: string;
  valueKey?: string;
}

/**
 * Explodes an AgentRouteDecision into renderable rows, skipping every field
 * that is absent — the audit trail should never show blank "Keyword:" lines
 * for a run whose route was not keyword-guarded.
 */
export function buildRouteDecisionRows(decision: AgentRouteDecision | undefined): RouteDecisionRow[] {
  if (!decision) return [];
  const rows: RouteDecisionRow[] = [
    { labelKey: 'agent_runs.route_route', value: decision.route },
    { labelKey: 'agent_runs.route_tool', value: `${decision.toolLabel} (${decision.toolType})` },
    { labelKey: 'agent_runs.route_guard', value: decision.guard },
  ];
  if (decision.keyword) {
    rows.push({ labelKey: 'agent_runs.route_keyword', value: decision.keyword });
  }
  if (decision.secretKinds && decision.secretKinds.length > 0) {
    rows.push({ labelKey: 'agent_runs.route_secrets', value: decision.secretKinds.join(', ') });
  }
  if (decision.noCloudFallback) {
    rows.push({ labelKey: 'agent_runs.route_no_cloud', valueKey: 'agent_runs.value_yes' });
  }
  if (decision.score) {
    const candidates = decision.score.candidates
      .map((c) => `${c.toolType} ${c.score}`)
      .join(', ');
    rows.push({
      labelKey: 'agent_runs.route_score',
      value: `${Math.round(decision.score.confidence * 100)}% · ${candidates}`,
    });
  }
  rows.push({ labelKey: 'agent_runs.route_why', value: decision.why });
  return rows;
}
