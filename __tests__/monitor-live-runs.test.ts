/**
 * agent-store `liveRuns` slice + lib/monitor-live-poll.ts (the progress.jsonl
 * poller behind the MONITOR pane's LIVE source).
 */
import { MAX_LIVE_RUNS_PER_AGENT, useAgentStore } from '@/store/agent-store';
import type { MonitorRun } from '@/lib/agent-progress';
import {
  SAVED_PATH_MAX_TRIES,
  anyRunActive,
  buildPollCommand,
  createPollMemo,
  parsePollOutput,
  pollLiveRunsOnce,
  savedPathForRun,
  selectPollTargets,
  type PollExec,
  type PollState,
  type PollStore,
} from '@/lib/monitor-live-poll';

const T0 = Date.parse('2026-10-30T07:00:00.000Z');
const iso = (sec: number) => new Date(T0 + sec * 1000).toISOString();

function run(runId: string, agentId: string, startSec: number, extra: Partial<MonitorRun> = {}): MonitorRun {
  return { runId, agentId, mode: 'SINGLE', startedAt: iso(startSec), lastSeq: 1, branches: [], ...extra };
}

function jsonl(runId: string, agentId: string, startSec: number, ended: boolean): string {
  const lines = [
    { v: 1, runId, agentId, seq: 1, ts: iso(startSec), kind: 'run_start', mode: 'SINGLE', stepCount: 1 },
    { v: 1, runId, agentId, seq: 2, ts: iso(startSec + 1), kind: 'branch_state', stepIndex: 0, state: 'RUNNING' },
  ];
  if (ended) {
    lines.push({ v: 1, runId, agentId, seq: 3, ts: iso(startSec + 2), kind: 'branch_state', stepIndex: 0, state: 'DONE' });
    lines.push({ v: 1, runId, agentId, seq: 4, ts: iso(startSec + 2), kind: 'run_end', status: 'success' } as never);
  }
  return lines.map((l) => JSON.stringify(l)).join('\n');
}

beforeEach(() => {
  useAgentStore.setState({ liveRuns: {}, agents: [], runningAgentIds: [] });
});

describe('agent-store liveRuns', () => {
  it('inserts, replaces by runId, and keeps the same state when nothing changed', () => {
    const s = useAgentStore.getState();
    s.upsertLiveRuns('a', [run('r1', 'a', 0)]);
    const first = useAgentStore.getState().liveRuns;
    useAgentStore.getState().upsertLiveRuns('a', [run('r1', 'a', 0)]);
    expect(useAgentStore.getState().liveRuns).toBe(first);
    useAgentStore.getState().upsertLiveRuns('a', [run('r1', 'a', 0, { lastSeq: 5, endedAt: iso(9), status: 'success' })]);
    const list = useAgentStore.getState().liveRuns.a;
    expect(list).toHaveLength(1);
    expect(list[0].run).toMatchObject({ lastSeq: 5, status: 'success' });
  });

  it('ignores runs of another agent and keeps the newest N, oldest first', () => {
    const s = useAgentStore.getState();
    s.upsertLiveRuns('a', [run('x', 'other', 0)]);
    expect(useAgentStore.getState().liveRuns.a).toBeUndefined();
    for (let i = 0; i < MAX_LIVE_RUNS_PER_AGENT + 2; i++) {
      useAgentStore.getState().upsertLiveRuns('a', [run(`r${i}`, 'a', 100 - i * 10)]);
    }
    const ids = useAgentStore.getState().liveRuns.a.map((e) => e.run.runId);
    expect(ids).toHaveLength(MAX_LIVE_RUNS_PER_AGENT);
    // sorted by start time; the two oldest starts (r5, r6) were dropped
    expect(ids).toEqual(['r4', 'r3', 'r2', 'r1', 'r0']);
  });

  it('records saved paths and failed lookups', () => {
    const s = useAgentStore.getState();
    s.upsertLiveRuns('a', [run('r1', 'a', 0)]);
    useAgentStore.getState().setLiveRunSavedPath('a', 'r1', null);
    expect(useAgentStore.getState().liveRuns.a[0].savedPathTries).toBe(1);
    useAgentStore.getState().setLiveRunSavedPath('a', 'r1', '/sdcard/out.md');
    expect(useAgentStore.getState().liveRuns.a[0].savedPath).toBe('/sdcard/out.md');
    // a run update keeps the saved path
    useAgentStore.getState().upsertLiveRuns('a', [run('r1', 'a', 0, { lastSeq: 9 })]);
    expect(useAgentStore.getState().liveRuns.a[0].savedPath).toBe('/sdcard/out.md');
  });
});

describe('monitor-live-poll: shell command + output', () => {
  it('uses the live shell $HOME, skips unsafe ids and unknown signatures', () => {
    const cmd = buildPollCommand([
      { agentId: 'good-1', knownSig: '1730271600.512', readPrev: true, readRunLog: true },
      { agentId: 'bad;rm -rf', knownSig: null, readPrev: false, readRunLog: false },
      { agentId: '../x', knownSig: null, readPrev: false, readRunLog: false },
      { agentId: 'b', knownSig: "1'; evil", readPrev: false, readRunLog: false },
    ]);
    expect(cmd).toContain('"$HOME/.shelly/agents/logs/good-1"');
    expect(cmd).toContain('= "1730271600.512"');
    expect(cmd).toContain('progress.prev.jsonl');
    expect(cmd).toContain('[0-9]*.json');
    expect(cmd).not.toContain('rm -rf');
    expect(cmd).not.toContain('../x');
    expect(cmd).not.toContain('evil');
    expect(cmd).toContain('/logs/b"');
    expect(cmd.endsWith('true')).toBe(true);
    expect(buildPollCommand([])).toBe('');
  });

  it('parses changed / unchanged / missing streams, prev and run-log sections', () => {
    const out = [
      '@@SHELLY_MON@@ P a 100.20 data',
      '{"x":1}',
      '{"x":2}',
      '',
      '@@SHELLY_MON@@ V a',
      'prevline',
      '',
      '@@SHELLY_MON@@ L a',
      '{"timestamp":1}',
      '',
      '@@SHELLY_MON@@ P b 5.5 same',
      '@@SHELLY_MON@@ P c none data',
      '',
    ].join('\n');
    const r = parsePollOutput(out);
    expect(r.a.sig).toBe('100.20');
    expect(r.a.progress).toContain('{"x":1}\n{"x":2}');
    expect(r.a.prev).toContain('prevline');
    expect(r.a.runLog).toContain('"timestamp":1');
    expect(r.b).toEqual({ agentId: 'b', sig: '5.5' });
    expect(r.c.sig).toBe('none');
    expect(r.c.progress?.trim()).toBe('');
  });

  it('matches a run log to the run by timestamp', () => {
    const r = run('r1', 'a', 100);
    expect(savedPathForRun(JSON.stringify({ timestamp: T0 + 110_000, savedPath: ' /x.md ' }), r)).toBe('/x.md');
    expect(savedPathForRun(JSON.stringify({ timestamp: T0 + 10_000, savedPath: '/old.md' }), r)).toBeUndefined();
    expect(savedPathForRun(JSON.stringify({ timestamp: T0 + 110_000 }), r)).toBeUndefined();
    expect(savedPathForRun('not json', r)).toBeUndefined();
  });
});

describe('monitor-live-poll: targets + one poll', () => {
  const store: PollStore = {
    upsertLiveRuns: (id, runs) => useAgentStore.getState().upsertLiveRuns(id, runs),
    setLiveRunSavedPath: (id, runId, p) => useAgentStore.getState().setLiveRunSavedPath(id, runId, p),
    getLiveRuns: () => useAgentStore.getState().liveRuns,
  };
  const getState = (): PollState => {
    const s = useAgentStore.getState();
    return { agents: s.agents, runningAgentIds: s.runningAgentIds, liveRuns: s.liveRuns };
  };

  it('targets running agents first, then recent agents, reading prev once', () => {
    useAgentStore.setState({
      agents: [{ id: 'old', lastRun: 1 } as never, { id: 'new', lastRun: 9 } as never],
      runningAgentIds: ['old'],
    });
    const memo = createPollMemo();
    const targets = selectPollTargets(getState(), memo);
    expect(targets.map((t) => t.agentId)).toEqual(['old', 'new']);
    expect(targets.every((t) => t.readPrev && !t.readRunLog && t.knownSig === null)).toBe(true);
  });

  it('feeds liveRuns, remembers signatures, then looks up the saved path once the run ended', async () => {
    useAgentStore.setState({ agents: [{ id: 'a', lastRun: 5 } as never], runningAgentIds: ['a'] });
    const memo = createPollMemo();
    const calls: string[] = [];
    let body = jsonl('r2', 'a', 100, false);
    const exec: PollExec = async (command) => {
      calls.push(command);
      const runLog = command.includes('[0-9]*.json')
        ? `@@SHELLY_MON@@ L a\n${JSON.stringify({ timestamp: T0 + 102_500, savedPath: '/sdcard/Obsidian/out.md' })}\n`
        : '';
      const prev = command.includes('progress.prev.jsonl') ? `@@SHELLY_MON@@ V a\n${jsonl('r1', 'a', 10, true)}\n` : '';
      return { exitCode: 0, stdout: `@@SHELLY_MON@@ P a 1.${body.length} data\n${body}\n${prev}${runLog}` };
    };

    expect(await pollLiveRunsOnce(exec, memo, getState, store, () => T0 + 101_000)).toBe(true);
    let list = useAgentStore.getState().liveRuns.a;
    expect(list.map((e) => e.run.runId)).toEqual(['r1', 'r2']);
    expect(memo.sigs.get('a')).toBe(`1.${body.length}`);
    expect(calls[0]).toContain('progress.prev.jsonl');

    body = jsonl('r2', 'a', 100, true);
    useAgentStore.setState({ runningAgentIds: [] });
    expect(await pollLiveRunsOnce(exec, memo, getState, store, () => T0 + 103_000)).toBe(false);
    expect(calls[1]).not.toContain('progress.prev.jsonl');
    expect(useAgentStore.getState().liveRuns.a[1].run.status).toBe('success');

    // third poll: the finished run's run log is read for its saved path
    await pollLiveRunsOnce(exec, memo, getState, store, () => T0 + 104_000);
    expect(calls[2]).toContain('[0-9]*.json');
    list = useAgentStore.getState().liveRuns.a;
    expect(list[1].savedPath).toBe('/sdcard/Obsidian/out.md');

    // found: no further run-log lookups
    await pollLiveRunsOnce(exec, memo, getState, store, () => T0 + 105_000);
    expect(calls[3]).not.toContain('[0-9]*.json');
  });

  it('gives up the saved-path lookup after a few misses', () => {
    useAgentStore.getState().upsertLiveRuns('a', [run('r1', 'a', 0, { endedAt: iso(5), status: 'success' })]);
    for (let i = 0; i < SAVED_PATH_MAX_TRIES; i++) useAgentStore.getState().setLiveRunSavedPath('a', 'r1', null);
    expect(selectPollTargets(getState(), createPollMemo())[0].readRunLog).toBe(false);
  });

  it('never throws when exec fails', async () => {
    useAgentStore.setState({ agents: [{ id: 'a', lastRun: 5 } as never] });
    const exec: PollExec = async () => {
      throw new Error('no exec');
    };
    await expect(pollLiveRunsOnce(exec, createPollMemo(), getState, store, () => T0)).resolves.toBe(false);
  });

  it('anyRunActive follows the lock list and unfinished recent runs', () => {
    expect(anyRunActive({ runningAgentIds: ['a'], liveRuns: {} }, T0)).toBe(true);
    const live = { a: [{ run: run('r1', 'a', 0) }] };
    expect(anyRunActive({ runningAgentIds: [], liveRuns: live }, T0 + 10_000)).toBe(true);
    expect(anyRunActive({ runningAgentIds: [], liveRuns: live }, T0 + 3_600_000)).toBe(false);
  });
});
