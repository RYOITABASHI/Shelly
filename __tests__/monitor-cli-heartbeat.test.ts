/**
 * Executor v24 CLI heartbeat (DEFERRED.md 2026-11-02 rehearsal item (l)):
 * a running CLI branch sends `heartbeat` progress events while its driver is
 * alive, with quietMs = time since the driver's last output. The reader
 * (lib/agent-progress.ts) treats them as liveness only, and the MONITOR
 * (lib/monitor-live.ts) no longer shows "no update for 30s — stuck?" on a
 * healthy CLI step — but still does when the heartbeats stop, or when the
 * driver is alive but silent for CLI_QUIET_STALE_AFTER_SEC.
 */
import { parseProgressJsonl, cliBranchOverlap, type MonitorRun } from '@/lib/agent-progress';
import { CLI_QUIET_STALE_AFTER_SEC, STALE_AFTER_SEC, createLiveSource, isRunActive } from '@/lib/monitor-live';

const T0 = Date.parse('2026-11-02T07:00:00.000Z');
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

type Ev = Record<string, unknown> & { sec: number };

function text(events: Ev[], runId = 'r1', agentId = 'agent-1'): string {
  return events
    .map(({ sec, ...e }, i) => JSON.stringify({ v: 1, runId, agentId, seq: i + 1, ts: at(sec), ...e }))
    .join('\n');
}

function runFrom(events: Ev[]): MonitorRun {
  const run = parseProgressJsonl(text(events));
  if (!run) throw new Error('no run');
  return run;
}

const start: Ev = { kind: 'run_start', mode: 'PARALLEL', stepCount: 2, sec: 0 };
const running = (stepIndex: number, sec: number): Ev => ({ kind: 'branch_state', stepIndex, state: 'RUNNING', sec });
const cliTool = (stepIndex: number, sec: number): Ev => ({
  kind: 'tool',
  stepIndex,
  tool: 'Claude Code',
  provider: { kind: 'CLI', name: 'cli:claude' },
  sec,
});
const beat = (stepIndex: number, sec: number, quietSec: number, activity?: string): Ev => ({
  kind: 'heartbeat',
  stepIndex,
  elapsedMs: sec * 1000,
  quietMs: quietSec * 1000,
  ...(activity ? { activity } : {}),
  sec,
});

describe('agent-progress: heartbeat events', () => {
  it('move updatedAt, record activity time = ts - quietMs, and never add a visible line', () => {
    const run = runFrom([start, running(0, 1), cliTool(0, 1), beat(0, 11, 2, 'Bash'), beat(0, 21, 4, 'Edit')]);
    const b = run.branches[0];
    expect(b.state).toBe('RUNNING');
    expect(b.updatedAt).toBe(at(21));
    expect(b.lastActivityAt).toBe(at(17));
    expect(b.heartbeat).toBe(true);
    expect(b.activity).toBe('Edit');
    expect(b.tail).toBeUndefined();
  });

  it('a quietMs reaching back past the previous event never moves activity before it', () => {
    const run = runFrom([start, running(0, 5), beat(0, 15, 60)]);
    expect(run.branches[0].lastActivityAt).toBe(at(5));
  });

  it('a later non-heartbeat event is activity at its own ts', () => {
    const run = runFrom([start, running(0, 1), beat(0, 11, 9), { kind: 'tail', stepIndex: 0, tail: 'x', sec: 14 }]);
    expect(run.branches[0].lastActivityAt).toBe(at(14));
  });

  it('a malformed quietMs counts as activity at the heartbeat; activity is capped', () => {
    const run = runFrom([start, running(0, 1), { kind: 'heartbeat', stepIndex: 0, quietMs: 'x', activity: 'A'.repeat(100), sec: 11 }]);
    expect(run.branches[0].lastActivityAt).toBe(at(11));
    expect(run.branches[0].activity).toHaveLength(40);
  });

  it('a heartbeat without stepIndex is dropped', () => {
    const run = runFrom([start, running(0, 1), { kind: 'heartbeat', quietMs: 0, sec: 11 }]);
    expect(run.branches[0].updatedAt).toBe(at(1));
    expect(run.branches[0].heartbeat).toBeUndefined();
  });

  it('does not change the CLI overlap measurement of the branch states', () => {
    const events = [start, running(0, 1), cliTool(0, 1), running(1, 2), cliTool(1, 2), beat(0, 11, 0), beat(1, 12, 0),
      { kind: 'branch_state', stepIndex: 0, state: 'DONE', sec: 20 }, { kind: 'branch_state', stepIndex: 1, state: 'DONE', sec: 30 },
      { kind: 'run_end', status: 'success', sec: 30 }];
    expect(cliBranchOverlap(text(events), 'r1')).toEqual({ cliBranches: 2, overlapMs: 18_000 });
  });
});

describe('monitor-live: stale indicator with CLI heartbeats', () => {
  it('a CLI step that keeps heartbeating with recent driver output is never stale', () => {
    const events: Ev[] = [start, running(0, 1), cliTool(0, 1)];
    for (let s = 11; s <= 301; s += 10) events.push(beat(0, s, 3, 'Bash'));
    const snap = createLiveSource(runFrom(events)).snapshot(T0 + 305_000, []);
    expect(snap.agents.s0.stale).toBe(false);
    // "updated Ns ago" is the driver's last output, not the heartbeat.
    expect(snap.agents.s0.updatedAgoSec).toBe(7);
  });

  it('heartbeats that stop (driver / executor gone) read stale after STALE_AFTER_SEC', () => {
    const src = createLiveSource(runFrom([start, running(0, 1), beat(0, 11, 0), beat(0, 21, 0)]));
    expect(src.snapshot(T0 + (21 + STALE_AFTER_SEC - 1) * 1000, []).agents.s0.stale).toBe(false);
    const late = src.snapshot(T0 + (21 + STALE_AFTER_SEC) * 1000, []);
    expect(late.agents.s0.stale).toBe(true);
    expect(late.agents.s0.updatedAgoSec).toBe(STALE_AFTER_SEC);
  });

  it('a driver alive but silent reads stale after CLI_QUIET_STALE_AFTER_SEC, with the silent time shown', () => {
    expect(CLI_QUIET_STALE_AFTER_SEC).toBeGreaterThan(STALE_AFTER_SEC);
    // Last driver output at 10 s; the executor keeps heartbeating.
    const quietUntil = (endSec: number) => {
      const events: Ev[] = [start, running(0, 1), cliTool(0, 1)];
      for (let s = 20; s <= endSec; s += 10) events.push(beat(0, s, s - 10));
      return createLiveSource(runFrom(events));
    };
    const early = quietUntil(120).snapshot(T0 + 125_000, []);
    expect(early.agents.s0.stale).toBe(false);
    expect(early.agents.s0.updatedAgoSec).toBe(115);
    const late = quietUntil(130).snapshot(T0 + 131_000, []);
    expect(late.agents.s0.stale).toBe(true);
    expect(late.agents.s0.updatedAgoSec).toBe(121);
  });

  it('a non-CLI step without heartbeats keeps the 30 s rule', () => {
    const src = createLiveSource(runFrom([start, running(0, 1), { kind: 'tail', stepIndex: 0, tail: 'w', sec: 2 }]));
    expect(src.snapshot(T0 + (2 + STALE_AFTER_SEC) * 1000, []).agents.s0.stale).toBe(true);
  });

  it('heartbeats keep the run active (isRunActive) past the dead window', () => {
    const events: Ev[] = [start, running(0, 1)];
    for (let s = 11; s <= 291; s += 10) events.push(beat(0, s, 1));
    const run = runFrom(events);
    expect(isRunActive(run, [], T0 + 295_000)).toBe(true);
    expect(isRunActive(run, [], T0 + 291_000 + 120_000)).toBe(false);
  });
});
