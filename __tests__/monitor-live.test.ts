/**
 * lib/monitor-live.ts — MonitorRun (progress.jsonl) → MonitorSnapshot mapping
 * for the MONITOR pane's LIVE source.
 */
import { parseProgressJsonl, type MonitorRun } from '@/lib/agent-progress';
import {
  STALE_AFTER_SEC,
  createLiveSource,
  isRunActive,
  liveOperator,
  pickDefaultLiveRun,
} from '@/lib/monitor-live';
import { summarize } from '@/lib/monitor-source';

const T0 = Date.parse('2026-10-30T07:00:00.000Z');
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

type Ev = Record<string, unknown>;

function runFrom(events: Ev[], runId = 'r1', agentId = 'agent-1'): MonitorRun {
  const text = events
    .map((e, i) => JSON.stringify({ v: 1, runId, agentId, seq: i + 1, ts: at((e.sec as number) ?? i), ...e }))
    .join('\n');
  const run = parseProgressJsonl(text);
  if (!run) throw new Error('no run');
  return run;
}

const start = (mode: string, stepCount: number, sec = 0): Ev => ({ kind: 'run_start', mode, stepCount, sec });
const state = (stepIndex: number, s: string, sec: number, groupId?: string): Ev => ({
  kind: 'branch_state',
  stepIndex,
  state: s,
  sec,
  ...(groupId ? { groupId } : {}),
});
const tool = (stepIndex: number, kind: string, name: string, sec: number, model?: string): Ev => ({
  kind: 'tool',
  stepIndex,
  tool: name,
  provider: { kind, name, ...(model ? { model } : {}) },
  sec,
});
const tail = (stepIndex: number, text: string, sec: number): Ev => ({ kind: 'tail', stepIndex, tail: text, sec });
const usage = (stepIndex: number, u: Ev, sec: number): Ev => ({ kind: 'usage', stepIndex, usage: u, sec });
const end = (status: string, sec: number): Ev => ({ kind: 'run_end', status, sec });

describe('monitor-live: serial run', () => {
  const run = runFrom([
    start('SERIAL', 3),
    state(0, 'STANDBY', 0),
    state(1, 'STANDBY', 0),
    state(2, 'STANDBY', 0),
    state(0, 'RUNNING', 1),
    tool(0, 'API', 'perplexity', 1, 'sonar'),
    usage(0, { inputTokens: 100, outputTokens: 50, usd: 0.002 }, 3),
    tail(0, '41 results', 4),
    state(0, 'DONE', 5),
    state(1, 'RUNNING', 6),
    tail(1, 'drafting summaries', 8),
  ]);
  const src = createLiveSource(run, { name: 'Paper digest', steps: ['collect papers from arXiv', 'summarize the top 3', 'save to Obsidian'] });

  it('builds one camera per step with stable channels and names', () => {
    expect(src.isDemo).toBe(false);
    expect(src.agents.map((d) => d.channel)).toEqual(['CH-01', 'CH-02', 'CH-03']);
    expect(src.agents.map((d) => d.name)).toEqual(['collect papers from arXiv', 'summarize the top 3', 'save to Obsidian']);
  });

  it('shows the reported provider, and AUTO until a tool event arrives', () => {
    expect(src.agents[0]).toMatchObject({ kind: 'API', provider: 'perplexity', providerName: 'Perplexity', model: 'sonar' });
    expect(src.agents[1]).toMatchObject({ kind: 'AUTO', provider: 'auto', providerName: 'Auto' });
  });

  it('maps states, tail, usage and per-step timing', () => {
    const snap = src.snapshot(T0 + 10_000, []);
    expect(snap.agents.s0).toMatchObject({ state: 'DONE', lines: ['41 results'], tokens: 150, usd: 0.002, elapsedSec: 4 });
    expect(snap.agents.s1).toMatchObject({ state: 'RUNNING', lines: ['drafting summaries'], elapsedSec: 4, updatedAgoSec: 2, stale: false });
    expect(snap.agents.s2.state).toBe('STANDBY');
    expect(snap.agents.s2.elapsedSec).toBeUndefined();
    expect(snap.run).toMatchObject({ outcome: 'running', elapsedSec: 10 });
  });

  it('mission progress is step-based: settled steps count 1, running half', () => {
    const snap = src.snapshot(T0 + 10_000, []);
    // (1 DONE + 0.5 RUNNING) / 3 steps
    expect(snap.missionPct).toBe(50);
    expect(summarize(src.agents, snap).missionPct).toBe(50);
    expect(snap.complete).toBe(false);
  });

  it('keeps the operator portrait stable per agent + step', () => {
    expect(src.agents.map((d) => d.operator)).toEqual([0, 1, 2].map((i) => liveOperator('agent-1', i)));
    expect(new Set(src.agents.map((d) => d.operator)).size).toBe(3);
    expect(createLiveSource(run).agents[1].operator).toBe(src.agents[1].operator);
  });

  it('completes with 100% and a frozen elapsed time on success', () => {
    const done = runFrom([
      start('SERIAL', 2),
      state(0, 'RUNNING', 1),
      state(0, 'DONE', 3),
      state(1, 'RUNNING', 3),
      state(1, 'DONE', 6),
      end('success', 7),
    ]);
    const snap = createLiveSource(done).snapshot(T0 + 600_000, []);
    expect(snap.complete).toBe(true);
    expect(snap.missionPct).toBe(100);
    expect(snap.run).toMatchObject({ outcome: 'success', elapsedSec: 7 });
    expect(snap.agents.s1.elapsedSec).toBe(3);
  });

  it('a single-step run is named after the agent', () => {
    const single = runFrom([start('SINGLE', 1), state(0, 'RUNNING', 1)]);
    expect(createLiveSource(single, { name: 'Morning brief' }).agents[0].name).toBe('Morning brief');
    expect(createLiveSource(single).agents[0].name).toBe('STEP 1');
  });
});

describe('monitor-live: 3-branch parallel', () => {
  const run = runFrom([
    start('PARALLEL', 4),
    state(0, 'STANDBY', 0, 'g1'),
    state(1, 'STANDBY', 0, 'g1'),
    state(2, 'STANDBY', 0, 'g1'),
    state(3, 'STANDBY', 0),
    state(0, 'RUNNING', 1, 'g1'),
    state(1, 'RUNNING', 1, 'g1'),
    state(2, 'RUNNING', 1, 'g1'),
    tool(0, 'API', 'gemini-api', 1, 'gemini-2.5-flash'),
    tool(1, 'LOCAL', 'local', 1),
    tool(2, 'CLI', 'cli', 1),
    state(1, 'DONE', 4, 'g1'),
  ]);
  const src = createLiveSource(run);

  it('stacks the parallel group in one map column, final step after it', () => {
    expect(src.team.columns.map((c) => c.map((n) => n.id))).toEqual([['s0', 's1', 's2'], ['s3']]);
    expect(src.team.subAgents).toEqual([]);
  });

  it('labels each branch with its own provider kind', () => {
    expect(src.agents.slice(0, 3).map((d) => [d.kind, d.providerName])).toEqual([
      ['API', 'Gemini API'],
      ['LOCAL', 'Local LLM'],
      ['CLI', 'Codex CLI'],
    ]);
  });

  it('counts running branches for RUN n/3', () => {
    const snap = src.snapshot(T0 + 5000, []);
    const sum = summarize(src.agents, snap);
    expect(sum.running).toBe(2);
    expect(sum.done).toBe(1);
    // (1 DONE + 2 × 0.5) / 4
    expect(snap.missionPct).toBe(50);
  });
});

describe('monitor-live: approval', () => {
  it('a WAITING_APPROVAL branch pins the approval on that camera', () => {
    const run = runFrom([
      start('SERIAL', 2),
      state(0, 'RUNNING', 1),
      state(0, 'DONE', 2),
      state(1, 'RUNNING', 2),
      tail(1, 'write 3 files to Obsidian?', 3),
      state(1, 'WAITING_APPROVAL', 3),
    ]);
    const snap = createLiveSource(run).snapshot(T0 + 4000, []);
    expect(snap.approvalPending).toBe(true);
    expect(snap.approvalAgentId).toBe('s1');
    expect(snap.agents.s1.state).toBe('APPROVAL');
    expect(snap.agents.s1.stale).toBe(false);
    expect(snap.chat).toEqual([]);
  });
});

describe('monitor-live: failed vs stopped by the user', () => {
  it('an error run is FAILED with the failed step and its reason', () => {
    const run = runFrom([
      start('SERIAL', 3),
      state(0, 'RUNNING', 1),
      state(0, 'DONE', 2),
      state(1, 'RUNNING', 2),
      tail(1, '429 rate limited after 2 retries', 5),
      state(1, 'FAILED', 5),
      state(2, 'SKIPPED', 5),
      end('error', 5),
    ]);
    const snap = createLiveSource(run).snapshot(T0 + 9000, []);
    expect(snap.agents.s1.state).toBe('FAILED');
    expect(snap.agents.s2.state).toBe('SKIPPED');
    expect(snap.run).toMatchObject({
      outcome: 'failed',
      failedChannel: 'CH-02',
      failureReason: '429 rate limited after 2 retries',
    });
    expect(snap.complete).toBe(false);
    // every step settled
    expect(snap.missionPct).toBe(100);
  });

  it('STOP-ALL (halted) shows the started step as STOPPED, the rest SKIPPED', () => {
    const run = runFrom([
      start('SERIAL', 3),
      state(0, 'RUNNING', 1),
      state(0, 'DONE', 2),
      state(1, 'RUNNING', 2),
      state(1, 'SKIPPED', 4),
      state(2, 'SKIPPED', 4),
      end('halted', 4),
    ]);
    const snap = createLiveSource(run).snapshot(T0 + 9000, []);
    expect(snap.agents.s0.state).toBe('DONE');
    expect(snap.agents.s1.state).toBe('STOPPED');
    expect(snap.agents.s2.state).toBe('SKIPPED');
    expect(snap.run?.outcome).toBe('stopped');
    expect(snap.run?.failureReason).toBeUndefined();
  });
});

describe('monitor-live: approval answered "no" / timed out', () => {
  const asked = (finalTail: string, status: string) =>
    runFrom([
      start('SERIAL', 2),
      state(0, 'RUNNING', 1),
      state(0, 'DONE', 2),
      state(1, 'RUNNING', 2),
      tail(1, 'write 3 files?', 3),
      state(1, 'WAITING_APPROVAL', 3),
      tail(1, finalTail, 9),
      state(1, 'SKIPPED', 9),
      end(status, 9),
    ]);

  it('a declined approval (executor: ActionSkipped → SKIPPED) is STOPPED, declined by you', () => {
    const snap = createLiveSource(asked('draft action declined', 'skipped')).snapshot(T0 + 10_000, []);
    expect(snap.agents.s1.state).toBe('STOPPED');
    expect(snap.agents.s1.note).toEqual({ key: 'monitor.live.declined' });
    expect(snap.run?.outcome).toBe('stopped');
    expect(snap.approvalPending).toBe(false);
  });

  it('an approval timeout stays SKIPPED with its own note', () => {
    const snap = createLiveSource(asked('draft action approval timed out', 'skipped')).snapshot(T0 + 10_000, []);
    expect(snap.agents.s1.state).toBe('SKIPPED');
    expect(snap.agents.s1.note).toEqual({ key: 'monitor.live.approval_timeout' });
    expect(snap.run?.outcome).toBe('skipped');
  });

  it('a step skipped without ever asking is plain SKIPPED even if its text says declined', () => {
    const run = runFrom([
      start('SERIAL', 1),
      state(0, 'RUNNING', 1),
      tail(0, 'policy declined: kept as a draft', 2),
      state(0, 'SKIPPED', 2),
      end('skipped', 2),
    ]);
    const snap = createLiveSource(run).snapshot(T0 + 5000, []);
    expect(snap.agents.s0.state).toBe('SKIPPED');
    expect(snap.agents.s0.note).toBeNull();
    expect(snap.run?.outcome).toBe('skipped');
  });
});

describe('monitor-live: stepCount larger than the branches seen', () => {
  it('uses stepCount as the mission denominator (truncated head / not yet announced steps)', () => {
    const run = runFrom([start('SERIAL', 4), state(0, 'RUNNING', 1), state(0, 'DONE', 2)]);
    const src = createLiveSource(run);
    // Steps not announced yet get STANDBY cameras (same set as the widget).
    expect(src.agents.map((d) => d.channel)).toEqual(['CH-01', 'CH-02', 'CH-03', 'CH-04']);
    const snap = src.snapshot(T0 + 3000, []);
    // 1 settled of 4 steps
    expect(snap.missionPct).toBe(25);
    expect(summarize(src.agents, snap).missionPct).toBe(25);
  });
});

describe('monitor-live: usage without cost', () => {
  it('API tokens without usd stay tokens-only (usd null), never invented money', () => {
    const run = runFrom([
      start('SERIAL', 2),
      state(0, 'RUNNING', 1),
      tool(0, 'API', 'groq', 1),
      usage(0, { inputTokens: 1200, outputTokens: 300 }, 2),
      state(0, 'DONE', 3),
      state(1, 'RUNNING', 3),
      tool(1, 'API', 'perplexity', 3),
      usage(1, { inputTokens: 10, outputTokens: 5, usd: 0.01 }, 4),
    ]);
    const src = createLiveSource(run);
    const snap = src.snapshot(T0 + 5000, []);
    expect(snap.agents.s0.usd).toBeNull();
    expect(snap.agents.s0.tokens).toBe(1500);
    const sum = summarize(src.agents, snap);
    expect(sum.apiUsdKnown).toBe(false);
    expect(sum.apiTokens).toBe(1515);
    expect(sum.apiUsd).toBeCloseTo(0.01);
  });

  it('a step with no usage at all reports zero tokens and no money', () => {
    const run = runFrom([start('SINGLE', 1), state(0, 'RUNNING', 1), tool(0, 'API', 'cerebras', 1)]);
    const src = createLiveSource(run);
    const snap = src.snapshot(T0 + 2000, []);
    expect(snap.agents.s0).toMatchObject({ tokens: 0, usd: null });
    expect(summarize(src.agents, snap)).toMatchObject({ apiUsdKnown: true, apiUsd: 0, apiTokens: 0 });
  });
});

describe('monitor-live: stale indicator (injected clock)', () => {
  const run = runFrom([start('SINGLE', 1), state(0, 'RUNNING', 1), tail(0, 'working', 2)]);
  const src = createLiveSource(run);

  it('is off while events are recent and on after STALE_AFTER_SEC of silence', () => {
    expect(src.snapshot(T0 + 2000 + (STALE_AFTER_SEC - 1) * 1000, []).agents.s0.stale).toBe(false);
    const late = src.snapshot(T0 + 2000 + STALE_AFTER_SEC * 1000, []);
    expect(late.agents.s0.stale).toBe(true);
    expect(late.agents.s0.updatedAgoSec).toBe(STALE_AFTER_SEC);
  });

  it('is never set once the run ended', () => {
    const ended = runFrom([start('SINGLE', 1), state(0, 'RUNNING', 1), end('error', 2)]);
    expect(createLiveSource(ended).snapshot(T0 + 3_600_000, []).agents.s0.stale).toBe(false);
  });
});

describe('monitor-live: default pick', () => {
  const finishedNew = runFrom([start('SINGLE', 1, 100), state(0, 'DONE', 110), end('success', 110)], 'rA', 'a');
  const runningOld = runFrom([start('SINGLE', 1, 50), state(0, 'RUNNING', 51)], 'rB', 'b');

  it('prefers the most recent running run over a newer finished one', () => {
    expect(pickDefaultLiveRun([finishedNew, runningOld], ['b'], T0 + 120_000)?.runId).toBe('rB');
  });

  it('falls back to the most recent run when nothing is running', () => {
    expect(pickDefaultLiveRun([runningOld, finishedNew], [], T0 + 3_600_000)?.runId).toBe('rA');
    expect(pickDefaultLiveRun([], [], T0)).toBeNull();
  });

  it('a silent run without a lock no longer counts as running', () => {
    expect(isRunActive(runningOld, [], T0 + 60_000)).toBe(true);
    expect(isRunActive(runningOld, [], T0 + 600_000)).toBe(false);
    expect(isRunActive(runningOld, ['b'], T0 + 600_000)).toBe(true);
  });
});
