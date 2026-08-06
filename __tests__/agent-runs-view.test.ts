/**
 * __tests__/agent-runs-view.test.ts — pure display logic behind the Agent Runs
 * pane (components/panes/AgentRunsPane.tsx).
 *
 * The pane itself is a React component, so the grouping / ordering / formatting
 * rules it depends on live in lib/agent-runs-view.ts (dependency-free, no
 * expo-file-system, no JSX) exactly so they can be pinned here in the plain
 * "unit" jest project — the same split lib/agent-data-sync.ts uses.
 */
import {
  buildAgentRunGroups,
  buildRouteDecisionRows,
  describeRunAge,
  formatRunDuration,
  runStatusIcon,
  runStatusTone,
} from '@/lib/agent-runs-view';
import type { AgentRouteDecision, AgentRunLog } from '@/store/types';

function log(partial: Partial<AgentRunLog> & { agentId: string; timestamp: number }): AgentRunLog {
  return {
    status: 'success',
    outputPreview: '',
    durationMs: 1_000,
    toolUsed: 'codex',
    ...partial,
  };
}

const AGENTS = [
  { id: 'a1', name: 'Morning Digest' },
  { id: 'a2', name: 'Repo Watcher' },
];

describe('buildAgentRunGroups', () => {
  it('groups run logs per agent and resolves the agent name', () => {
    const groups = buildAgentRunGroups(
      { a1: [log({ agentId: 'a1', timestamp: 100 })] },
      AGENTS,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].agentId).toBe('a1');
    expect(groups[0].agentName).toBe('Morning Digest');
    expect(groups[0].runs).toHaveLength(1);
  });

  it('omits agents with no retained runs (empty or missing arrays)', () => {
    const groups = buildAgentRunGroups(
      { a1: [], a2: undefined, a3: [log({ agentId: 'a3', timestamp: 5 })] },
      AGENTS,
    );
    expect(groups.map((g) => g.agentId)).toEqual(['a3']);
  });

  it('falls back to the agent id when the agent definition is gone (deleted agent, logs retained)', () => {
    const groups = buildAgentRunGroups(
      { ghost: [log({ agentId: 'ghost', timestamp: 1 })] },
      AGENTS,
    );
    expect(groups[0].agentName).toBe('ghost');
  });

  it('orders runs newest-first even when the stored array is oldest-first', () => {
    const groups = buildAgentRunGroups(
      {
        a1: [
          log({ agentId: 'a1', timestamp: 100 }),
          log({ agentId: 'a1', timestamp: 300 }),
          log({ agentId: 'a1', timestamp: 200 }),
        ],
      },
      AGENTS,
    );
    expect(groups[0].runs.map((r) => r.timestamp)).toEqual([300, 200, 100]);
    expect(groups[0].latestTimestamp).toBe(300);
  });

  it('does not mutate the caller-supplied run history array', () => {
    const stored = [
      log({ agentId: 'a1', timestamp: 100 }),
      log({ agentId: 'a1', timestamp: 300 }),
    ];
    buildAgentRunGroups({ a1: stored }, AGENTS);
    expect(stored.map((r) => r.timestamp)).toEqual([100, 300]);
  });

  it('orders groups by their most recent run, newest agent first', () => {
    const groups = buildAgentRunGroups(
      {
        a1: [log({ agentId: 'a1', timestamp: 100 })],
        a2: [log({ agentId: 'a2', timestamp: 900 })],
      },
      AGENTS,
    );
    expect(groups.map((g) => g.agentId)).toEqual(['a2', 'a1']);
  });

  it('narrows to a single agent when opts.agentId is given', () => {
    const groups = buildAgentRunGroups(
      {
        a1: [log({ agentId: 'a1', timestamp: 100 })],
        a2: [log({ agentId: 'a2', timestamp: 900 })],
      },
      AGENTS,
      { agentId: 'a1' },
    );
    expect(groups.map((g) => g.agentId)).toEqual(['a1']);
  });

  it('returns an empty list when the requested agent has no runs', () => {
    const groups = buildAgentRunGroups(
      { a2: [log({ agentId: 'a2', timestamp: 900 })] },
      AGENTS,
      { agentId: 'a1' },
    );
    expect(groups).toEqual([]);
  });

  it('treats a null/undefined agentId filter as "all agents"', () => {
    const history = { a1: [log({ agentId: 'a1', timestamp: 1 })] };
    expect(buildAgentRunGroups(history, AGENTS, { agentId: null })).toHaveLength(1);
    expect(buildAgentRunGroups(history, AGENTS, {})).toHaveLength(1);
  });
});

describe('runStatusTone / runStatusIcon', () => {
  it('maps each status onto a distinct semantic tone', () => {
    expect(runStatusTone('success')).toBe('success');
    expect(runStatusTone('error')).toBe('error');
    expect(runStatusTone('unavailable')).toBe('warning');
    expect(runStatusTone('skipped')).toBe('muted');
  });

  it('gives every status a non-empty MaterialIcons name', () => {
    for (const status of ['success', 'error', 'skipped', 'unavailable'] as const) {
      expect(runStatusIcon(status).length).toBeGreaterThan(0);
    }
  });
});

describe('formatRunDuration', () => {
  it('uses milliseconds below one second', () => {
    expect(formatRunDuration(350)).toBe('350ms');
  });

  it('uses one decimal of seconds below a minute', () => {
    expect(formatRunDuration(1_250)).toBe('1.3s');
    expect(formatRunDuration(59_000)).toBe('59.0s');
  });

  it('uses zero-padded m/s above a minute', () => {
    expect(formatRunDuration(125_000)).toBe('2m 05s');
  });

  it('returns an empty string for missing or nonsensical durations', () => {
    expect(formatRunDuration(0)).toBe('');
    expect(formatRunDuration(-1)).toBe('');
    expect(formatRunDuration(Number.NaN)).toBe('');
  });
});

describe('describeRunAge', () => {
  const now = 1_700_000_000_000;

  it('reports sub-minute ages as "just now"', () => {
    expect(describeRunAge(now - 5_000, now).key).toBe('agent_runs.age_just_now');
  });

  it('reports minutes, hours and days with a count param', () => {
    expect(describeRunAge(now - 5 * 60_000, now)).toEqual({
      key: 'agent_runs.age_minutes',
      params: { count: 5 },
    });
    expect(describeRunAge(now - 3 * 3_600_000, now)).toEqual({
      key: 'agent_runs.age_hours',
      params: { count: 3 },
    });
    expect(describeRunAge(now - 2 * 86_400_000, now)).toEqual({
      key: 'agent_runs.age_days',
      params: { count: 2 },
    });
  });

  it('falls back to an absolute stamp beyond a week', () => {
    const token = describeRunAge(now - 30 * 86_400_000, now);
    expect(token.key).toBe('agent_runs.age_absolute');
    expect(String(token.params?.when)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('never reports a negative age for a clock-skewed future timestamp', () => {
    expect(describeRunAge(now + 60_000, now).key).toBe('agent_runs.age_just_now');
  });
});

describe('buildRouteDecisionRows', () => {
  const base: AgentRouteDecision = {
    route: 'on-device',
    toolType: 'local',
    toolLabel: 'Qwen3.5-2B',
    guard: 'secret',
    why: 'prompt referenced a credential',
  };

  it('returns nothing when the run has no route decision', () => {
    expect(buildRouteDecisionRows(undefined)).toEqual([]);
  });

  it('renders only the fields that are present', () => {
    const keys = buildRouteDecisionRows(base).map((r) => r.labelKey);
    expect(keys).toEqual([
      'agent_runs.route_route',
      'agent_runs.route_tool',
      'agent_runs.route_guard',
      'agent_runs.route_why',
    ]);
  });

  it('adds keyword / secretKinds / noCloudFallback / score rows only when set', () => {
    const rows = buildRouteDecisionRows({
      ...base,
      keyword: 'password',
      secretKinds: ['api_key', 'token'],
      noCloudFallback: true,
      score: {
        confidence: 0.87,
        candidates: [
          { toolType: 'local', score: 12 },
          { toolType: 'gemini-api', score: 4 },
        ],
      },
    });
    const byKey = Object.fromEntries(rows.map((r) => [r.labelKey, r]));
    expect(byKey['agent_runs.route_keyword'].value).toBe('password');
    expect(byKey['agent_runs.route_secrets'].value).toBe('api_key, token');
    expect(byKey['agent_runs.route_no_cloud'].valueKey).toBe('agent_runs.value_yes');
    expect(byKey['agent_runs.route_score'].value).toContain('87%');
    expect(byKey['agent_runs.route_score'].value).toContain('local 12');
  });

  it('omits an empty secretKinds array rather than rendering a blank row', () => {
    const keys = buildRouteDecisionRows({ ...base, secretKinds: [] }).map((r) => r.labelKey);
    expect(keys).not.toContain('agent_runs.route_secrets');
  });
});
