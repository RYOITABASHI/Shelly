jest.mock('@/lib/home-path', () => ({ getHomePath: () => '/home/t' }));

import { answerReportsGateBlock, runSucceededInFull } from '@/lib/agent-run-success';
import {
  blockSignalsForRun,
  buildRunBlockReadCommand,
  parseRunBlockSignals,
  runHadBlockedAction,
} from '@/lib/agent-run-blocks';
import { resolveRunResultTarget } from '@/lib/agent-confirm-outcome';

const RUN_END = Date.parse('2026-11-01T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const line = (o: Record<string, unknown>) => JSON.stringify(o);

describe('answerReportsGateBlock (narrow text fallback)', () => {
  it('matches the on-device Claude Code answer', () => {
    expect(answerReportsGateBlock(
      "I tried to list the files, but the command was blocked by Shelly's agent gate, so I didn't base a summary on it.",
    )).toBe(true);
  });
  it('matches the driver deny message and a Japanese answer', () => {
    expect(answerReportsGateBlock('Shelly agent gate declined this action (see the agent audit log).')).toBe(true);
    expect(answerReportsGateBlock('コマンドはShellyのエージェントゲートで拒否されたため実行できませんでした。')).toBe(true);
  });
  it('does not match an answer that only mentions the gate, or a generic block', () => {
    expect(answerReportsGateBlock("Shelly's agent gate allowed every read, here is the summary.")).toBe(false);
    expect(answerReportsGateBlock('The website blocked the scraper, so I used the cached copy.')).toBe(false);
    expect(answerReportsGateBlock('')).toBe(false);
    expect(answerReportsGateBlock(undefined)).toBe(false);
  });
});

describe('runSucceededInFull with block signals', () => {
  const clean = {
    status: 'success',
    steps: [
      { status: 'success' as const, outputPreview: 'Collected 5 items.' },
      { status: 'success' as const, outputPreview: 'Summary: all good.' },
    ],
    plannedStepCount: 2,
    outputPreview: 'Summary: all good.',
  };

  it('a clean run still counts as a full success', () => {
    expect(runSucceededInFull(clean)).toBe(true);
    expect(runSucceededInFull({ ...clean, blocked: false })).toBe(true);
  });
  it('an audit-trail block fails it', () => {
    expect(runSucceededInFull({ ...clean, blocked: true })).toBe(false);
  });
  it('a step answer saying the gate blocked it fails it', () => {
    expect(runSucceededInFull({
      ...clean,
      steps: [
        clean.steps[0],
        { status: 'success', outputPreview: "The command was blocked by Shelly's agent gate, so I stopped." },
      ],
    })).toBe(false);
  });
  it('a single-step run whose answer reports a gate block fails it', () => {
    expect(runSucceededInFull({ status: 'success', outputPreview: 'Shelly agent gate declined this action.' })).toBe(false);
  });
  it('a multi-action run with a skipped action fails it', () => {
    expect(runSucceededInFull({
      status: 'success',
      actionResults: [{ status: 'success' }, { status: 'skipped' }],
    })).toBe(false);
    expect(runSucceededInFull({
      status: 'success',
      actionResults: [{ status: 'success' }, { status: 'success' }],
    })).toBe(true);
  });
});

describe('parseRunBlockSignals / blockSignalsForRun', () => {
  const inRun = RUN_END - 20_000;
  const text = [
    line({ ts: iso(inRun), kind: 'driver_start' }),
    line({ ts: iso(inRun), kind: 'gate_decision', answer: 'y', decision: 'accept', actionDecision: 'accept' }),
    line({ ts: iso(inRun), kind: 'gate_decision', answer: 'y', decision: 'allow' }),
    line({ ts: iso(inRun), kind: 'escalation_resolved', decision: 'accept' }),
    line({ ts: iso(inRun), kind: 'escalation_preapproved' }),
    'not json',
    '',
  ].join('\n');

  it('a clean audit trail has no blocks', () => {
    expect(parseRunBlockSignals(text)).toEqual([]);
  });

  it('finds declined escalations, gate denies and refused CLI branches', () => {
    const signals = parseRunBlockSignals([
      text,
      line({ ts: iso(inRun), kind: 'escalation_resolved', decision: 'decline' }),
      line({ ts: iso(inRun), kind: 'gate_decision', answer: 'escalate', decision: 'deny', actionDecision: 'decline' }),
      line({ ts: iso(inRun), kind: 'gate_decision', answer: 'n', decision: 'denied' }),
      line({ ts: iso(inRun), kind: 'escalation_timeout', decision: 'decline' }),
      line({ ts: iso(inRun), kind: 'escalation_denied_unattended' }),
      line({ ts: iso(inRun), kind: 'plan.executor', event: 'cli_branch_refused' }),
      line({ ts: iso(inRun), kind: 'plan.executor', event: 'cli_branch_end' }),
    ].join('\n'));
    expect(signals.map((s) => s.kind)).toEqual([
      'escalation_declined',
      'gate_decision',
      'gate_decision',
      'escalation_timeout',
      'escalation_denied_unattended',
      'cli_branch_refused',
    ]);
  });

  it('only counts lines inside the run window', () => {
    const signals = parseRunBlockSignals([
      line({ ts: iso(RUN_END - 3_600_000), kind: 'escalation_resolved', decision: 'decline' }),
      line({ ts: iso(RUN_END + 60_000), kind: 'escalation_resolved', decision: 'decline' }),
    ].join('\n'));
    expect(signals).toHaveLength(2);
    expect(blockSignalsForRun(signals, { timestamp: RUN_END, durationMs: 60_000 })).toEqual([]);
    expect(blockSignalsForRun(signals, { timestamp: RUN_END, durationMs: 3_700_000 })).toHaveLength(1);
  });
});

describe('runHadBlockedAction', () => {
  it('reads every audit file of the agent and reports a block in the window', async () => {
    const runCommand = jest.fn(async () =>
      line({ ts: iso(RUN_END - 10_000), kind: 'escalation_resolved', decision: 'decline' }));
    await expect(runHadBlockedAction(runCommand, { agentId: 'agent-1', timestamp: RUN_END, durationMs: 60_000 })).resolves.toBe(true);
    const cmd = (runCommand.mock.calls[0] as unknown as [string])[0];
    expect(cmd).toContain("'/home/t/.shelly/agents/logs/agent-1'/agent-driver-audit*.jsonl");
    expect(cmd).toContain('plan-executor-audit.jsonl');
    expect(cmd).toContain("'/home/t/.shelly/agents/audits/agent-1-agent-driver-audit.jsonl'");
  });
  it('a clean trail, a read failure or an unsafe id reads as no block', async () => {
    await expect(runHadBlockedAction(jest.fn(async () => ''), { agentId: 'a', timestamp: RUN_END, durationMs: 1 })).resolves.toBe(false);
    await expect(runHadBlockedAction(jest.fn(async () => { throw new Error('x'); }), { agentId: 'a', timestamp: RUN_END })).resolves.toBe(false);
    const runCommand = jest.fn(async () => '');
    await expect(runHadBlockedAction(runCommand, { agentId: 'a/../b', timestamp: RUN_END })).resolves.toBe(false);
    await expect(runHadBlockedAction(runCommand, { agentId: 'a', timestamp: undefined })).resolves.toBe(false);
    expect(runCommand).not.toHaveBeenCalled();
    expect(buildRunBlockReadCommand("a'b", '/h')).toBeNull();
  });
});

describe('resolveRunResultTarget', () => {
  it('appends below lines posted after the running bubble, else updates in place', () => {
    expect(resolveRunResultTarget([{ id: 'draft' }, { id: 'running' }], 'running')).toBe('in-place');
    expect(resolveRunResultTarget(
      [{ id: 'running' }, { id: 'handoff-step-1' }, { id: 'ask' }, { id: 'user-no' }],
      'running',
    )).toBe('new-message');
  });
});
