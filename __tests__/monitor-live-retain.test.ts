/**
 * 2026-11-01 on-device (promo filming): two MONITOR LIVE issues.
 *  1) When a run ended and its ephemeral "run once now" agent was deleted,
 *     the pane fell back to the DEMO wall (with its scripted, real-looking
 *     approval ask). The last real run now stays a pick candidate
 *     (pickMonitorRun + agent-store monitorLastRun).
 *  2) A CLI-pinned step read "AUTO · Auto" until it ran; its planned CLI now
 *     labels it from the start (LiveAgentInfo.tools → plannedCliProvider).
 */
import type { MonitorRun } from '@/lib/agent-progress';
import { createLiveSource, pickMonitorRun, plannedCliProvider, type RetainedLiveRun } from '@/lib/monitor-live';
import { summarize } from '@/lib/monitor-source';
import { useAgentStore } from '@/store/agent-store';
import type { ToolChoice } from '@/store/types';

const T0 = Date.parse('2026-11-01T07:00:00.000Z');
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

function run(over: Partial<MonitorRun> = {}): MonitorRun {
  return {
    runId: 'r1',
    agentId: 'once-1',
    mode: 'SERIAL',
    startedAt: at(0),
    stepCount: 2,
    lastSeq: 4,
    branches: [
      {
        branchId: 'r1#0',
        stepIndex: 0,
        state: 'RUNNING',
        provider: { kind: 'CLI', name: 'cli:codex' },
        startedAt: at(1),
        updatedAt: at(2),
      },
    ],
    ...over,
  };
}

const CODEX = { type: 'cli', cli: 'codex' } as ToolChoice;
const CLAUDE = { type: 'cli', cli: 'claude' } as ToolChoice;

describe('plannedCliProvider', () => {
  it('maps a CLI tool to its run provider id', () => {
    expect(plannedCliProvider(CODEX)).toEqual({ kind: 'CLI', name: 'cli:codex' });
    expect(plannedCliProvider(CLAUDE)).toEqual({ kind: 'CLI', name: 'cli:claude' });
  });

  it('ignores every other tool, a CLI tool without a known id, and nothing', () => {
    expect(plannedCliProvider({ type: 'local' } as ToolChoice)).toBeNull();
    expect(plannedCliProvider({ type: 'auto' } as ToolChoice)).toBeNull();
    expect(plannedCliProvider({ type: 'perplexity' } as ToolChoice)).toBeNull();
    expect(plannedCliProvider({ type: 'cli' } as ToolChoice)).toBeNull();
    expect(plannedCliProvider({ type: 'cli', cli: 'agy' } as unknown as ToolChoice)).toBeNull();
    expect(plannedCliProvider(undefined)).toBeNull();
    expect(plannedCliProvider(null)).toBeNull();
  });
});

describe('createLiveSource: planned CLI label before the step starts', () => {
  it('CH-02 pinned to Claude Code reads "Claude Code" while CH-01 Codex runs', () => {
    const src = createLiveSource(run(), { steps: ['list files', 'review'], tools: [CODEX, CLAUDE] });
    const [ch1, ch2] = src.agents;
    expect(ch1).toMatchObject({ channel: 'CH-01', kind: 'CLI', provider: 'codex-cli', providerName: 'Codex CLI' });
    expect(ch2).toMatchObject({ channel: 'CH-02', kind: 'CLI', provider: 'claude-cli', providerName: 'Claude Code' });
    expect(src.snapshot(T0 + 3000, []).agents.s1.state).toBe('STANDBY');
  });

  it('the step its own report wins over the plan', () => {
    const r = run();
    r.branches.push({
      branchId: 'r1#1',
      stepIndex: 1,
      state: 'RUNNING',
      provider: { kind: 'CLI', name: 'cli:codex' },
      startedAt: at(2),
      updatedAt: at(2),
    });
    const src = createLiveSource(r, { tools: [CODEX, CLAUDE] });
    expect(src.agents[1]).toMatchObject({ providerName: 'Codex CLI', provider: 'codex-cli' });
  });

  it('a step without a CLI tool stays AUTO until it reports (no guessing)', () => {
    const src = createLiveSource(run(), { tools: [CODEX, { type: 'local' } as ToolChoice] });
    expect(src.agents[1]).toMatchObject({ kind: 'AUTO', provider: 'auto' });
    const none = createLiveSource(run(), {});
    expect(none.agents[1]).toMatchObject({ kind: 'AUTO', provider: 'auto' });
  });

  it('no tokens are invented for the planned CLI step', () => {
    const src = createLiveSource(run(), { tools: [CODEX, CLAUDE] });
    const sum = summarize(src.agents, src.snapshot(T0 + 3000, []));
    expect(sum.cliTokens).toBe(0);
  });
});

describe('pickMonitorRun: keep the last real run instead of the DEMO', () => {
  const ended = run({ endedAt: at(30), status: 'success', branches: [{ ...run().branches[0], state: 'DONE', endedAt: at(30) }] });
  const retained: RetainedLiveRun = { run: ended, info: { name: 'Once', steps: ['list files', 'review'] } };

  it('null only when no real run was ever seen', () => {
    expect(pickMonitorRun([], null, [], T0)).toBeNull();
    expect(pickMonitorRun([], undefined, [], T0)).toBeNull();
  });

  it('the retained run stands in once its agent (and its liveRuns) are gone', () => {
    expect(pickMonitorRun([], retained, [], T0 + 60_000)).toBe(ended);
  });

  it('a newer run of another agent replaces it; an active run always wins', () => {
    const newer = run({ runId: 'r2', agentId: 'other', startedAt: at(40), endedAt: at(50), status: 'success' });
    expect(pickMonitorRun([newer], retained, [], T0 + 60_000)).toBe(newer);
    const olderButActive = run({ runId: 'r0', agentId: 'other', startedAt: at(-10), branches: [{ ...run().branches[0], updatedAt: at(55) }] });
    expect(pickMonitorRun([olderButActive], retained, [], T0 + 60_000)).toBe(olderButActive);
  });

  it('an older finished run of a known agent does not displace the retained newer one', () => {
    const older = run({ runId: 'r0', agentId: 'other', startedAt: at(-100), endedAt: at(-90), status: 'success' });
    expect(pickMonitorRun([older], retained, [], T0 + 60_000)).toBe(ended);
  });

  it('the store copy of the same run wins over the retained copy', () => {
    const fresher = { ...ended, lastSeq: 9 };
    expect(pickMonitorRun([fresher], retained, [], T0 + 60_000)).toBe(fresher);
  });
});

describe('agent-store monitorLastRun', () => {
  beforeEach(() => useAgentStore.setState({ monitorLastRun: null }));

  it('stores the retained run and keeps the same state for an identical set', () => {
    const r = run();
    const info = { name: 'Once' };
    useAgentStore.getState().setMonitorLastRun({ run: r, info });
    const first = useAgentStore.getState().monitorLastRun;
    expect(first?.run).toBe(r);
    useAgentStore.getState().setMonitorLastRun({ run: r, info });
    expect(useAgentStore.getState().monitorLastRun).toBe(first);
    useAgentStore.getState().setMonitorLastRun({ run: r, info, savedPath: '/sdcard/x.md' });
    expect(useAgentStore.getState().monitorLastRun?.savedPath).toBe('/sdcard/x.md');
  });

  it('survives removing the agent and clearing liveRuns', () => {
    const r = run();
    useAgentStore.getState().setMonitorLastRun({ run: r, info: {} });
    useAgentStore.getState().removeAgent('once-1');
    useAgentStore.getState().clearLiveRuns();
    expect(useAgentStore.getState().monitorLastRun?.run).toBe(r);
  });
});
