/**
 * __tests__/agent-audit-log.test.ts — the boundary-gate "flight recorder"
 * reader (lib/agent-audit-log.ts) behind AgentRunsPane's Gate decisions
 * section: parsing scripts/shelly-agent-driver.js's gate_decision JSONL
 * lines, correlating them to one run by time window, and the shell
 * round-trip that reads them off disk.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import {
  entriesForRun,
  parseFlightRecorderLog,
  readAgentFlightRecorder,
} from '@/lib/agent-audit-log';

function gateLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts: '2026-08-25T10:00:00.000Z',
    kind: 'gate_decision',
    command: 'cat /workspace/notes.md',
    verdictDecision: 'allow',
    signals: [],
    reason: 'within policy',
    level: 'L2',
    ...overrides,
  });
}

describe('parseFlightRecorderLog', () => {
  it('parses a gate_decision line into a flight-recorder entry', () => {
    const entries = parseFlightRecorderLog(gateLine());
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      decision: 'allow',
      command: 'cat /workspace/notes.md',
      reason: 'within policy',
      signals: [],
      level: 'L2',
    });
    expect(entries[0].timestamp).toBe(Date.parse('2026-08-25T10:00:00.000Z'));
  });

  it('ignores non gate_decision lines (driver/broker lifecycle events)', () => {
    const text = [
      JSON.stringify({ ts: '2026-08-25T10:00:00.000Z', kind: 'thread_started' }),
      JSON.stringify({ ts: '2026-08-25T10:00:01.000Z', kind: 'http.request' }),
      gateLine({ ts: '2026-08-25T10:00:02.000Z' }),
    ].join('\n');
    expect(parseFlightRecorderLog(text)).toHaveLength(1);
  });

  it('skips malformed JSON lines without throwing', () => {
    const text = ['not json', gateLine(), '{"broken":'].join('\n');
    expect(parseFlightRecorderLog(text)).toHaveLength(1);
  });

  it('skips blank lines and tolerates a trailing newline', () => {
    const text = `${gateLine()}\n\n`;
    expect(parseFlightRecorderLog(text)).toHaveLength(1);
  });

  it('normalizes an entry with no verdictDecision to gray, unless answer was a hard "n"', () => {
    const graySignal = parseFlightRecorderLog(
      gateLine({ verdictDecision: undefined, answer: 'escalate' }),
    );
    expect(graySignal[0].decision).toBe('gray');

    const denySignal = parseFlightRecorderLog(gateLine({ verdictDecision: undefined, answer: 'n' }));
    expect(denySignal[0].decision).toBe('deny');
  });

  it('defaults missing command/reason/signals rather than throwing', () => {
    const entries = parseFlightRecorderLog(
      JSON.stringify({ ts: '2026-08-25T10:00:00.000Z', kind: 'gate_decision', verdictDecision: 'deny' }),
    );
    expect(entries[0]).toMatchObject({ command: '', reason: '', signals: [] });
  });

  it('sorts entries oldest first regardless of input order', () => {
    const text = [
      gateLine({ ts: '2026-08-25T10:00:05.000Z' }),
      gateLine({ ts: '2026-08-25T10:00:01.000Z' }),
    ].join('\n');
    const entries = parseFlightRecorderLog(text);
    expect(entries[0].timestamp).toBeLessThan(entries[1].timestamp);
  });
});

describe('entriesForRun', () => {
  const entries = [
    { timestamp: 1_000, decision: 'allow' as const, command: 'a', reason: '', signals: [] },
    { timestamp: 50_000, decision: 'allow' as const, command: 'b', reason: '', signals: [] },
    { timestamp: 100_000, decision: 'deny' as const, command: 'c', reason: '', signals: [] },
  ];

  it('keeps only entries inside [timestamp - durationMs, timestamp], with slack', () => {
    // Run window: [100000 - 60000, 100000] = [40000, 100000], +/- 5s slack.
    const result = entriesForRun(entries, { timestamp: 100_000, durationMs: 60_000 });
    expect(result.map((e) => e.command)).toEqual(['b', 'c']);
  });

  it('falls back to a zero-width window (just slack) for a non-positive durationMs', () => {
    const result = entriesForRun(entries, { timestamp: 1_000, durationMs: 0 });
    expect(result.map((e) => e.command)).toEqual(['a']);
  });
});

describe('readAgentFlightRecorder', () => {
  it('reads the live per-agent audit path, falling back to the audits/ mirror', async () => {
    const runCommand = jest.fn(async (cmd: string) => {
      expect(cmd).toContain('/home/shelly-test/.shelly/agents/logs/agent-1/agent-driver-audit.jsonl');
      expect(cmd).toContain('/home/shelly-test/.shelly/agents/audits/agent-1-agent-driver-audit.jsonl');
      return gateLine();
    });
    const entries = await readAgentFlightRecorder(runCommand, 'agent-1');
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(entries).toHaveLength(1);
    expect(entries[0].command).toBe('cat /workspace/notes.md');
  });

  it('returns an empty array (never throws) when the shell round-trip fails', async () => {
    const runCommand = jest.fn(async () => {
      throw new Error('exit 127');
    });
    await expect(readAgentFlightRecorder(runCommand, 'agent-1')).resolves.toEqual([]);
  });

  it('refuses an unsafe agentId without ever shelling out', async () => {
    const runCommand = jest.fn(async () => '');
    const entries = await readAgentFlightRecorder(runCommand, '../../etc');
    expect(entries).toEqual([]);
    expect(runCommand).not.toHaveBeenCalled();
  });
});
