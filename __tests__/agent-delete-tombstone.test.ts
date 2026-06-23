jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

const mockTerminalEmulator = {
  cancelAgent: jest.fn(async () => undefined),
  execCommand: jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
  runAgent: jest.fn(async () => undefined),
};

jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: mockTerminalEmulator,
}));
jest.mock('expo-notifications', () => ({}));
jest.mock('expo-file-system/legacy', () => ({}));

import {
  DELETED_AGENT_MARKER_DIR,
  deleteAgent,
  filterDeletedAgentMetadata,
  runAgentNow,
} from '@/lib/agent-manager';
import { useAgentStore } from '@/store/agent-store';
import { Agent } from '@/store/types';

const agent = (id: string): Agent => ({
  id,
  name: id,
  description: '',
  prompt: '',
  schedule: null,
  tool: { type: 'local' },
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
});

describe('agent deletion tombstones', () => {
  beforeEach(() => {
    mockTerminalEmulator.cancelAgent.mockClear();
    mockTerminalEmulator.execCommand.mockClear();
    mockTerminalEmulator.runAgent.mockClear();
    mockTerminalEmulator.execCommand.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    mockTerminalEmulator.runAgent.mockResolvedValue(undefined);
    useAgentStore.getState().setAgents([]);
    useAgentStore.getState().setRunHistory({});
  });

  it('uses the native/shared deleted-agent marker directory', () => {
    expect(DELETED_AGENT_MARKER_DIR).toBe('.deleted');
  });

  it('filters tombstoned agents so deleted seed agents cannot reappear in the sidebar', () => {
    expect(filterDeletedAgentMetadata(
      [agent('x-casual-draft'), agent('codex-article-draft'), agent('..'), agent('bad.id')],
      new Set(['x-casual-draft']),
    ).map((a) => a.id)).toEqual(['codex-article-draft']);
  });

  it('rejects path-like agent ids before issuing shell deletes', async () => {
    await expect(deleteAgent('..')).rejects.toThrow(/unsafe id/);
    await expect(deleteAgent('bad.id')).rejects.toThrow(/unsafe id/);
    expect(mockTerminalEmulator.execCommand).not.toHaveBeenCalled();
  });

  it('preserves a one-shot driver audit before deleting the log directory', async () => {
    useAgentStore.getState().setAgents([agent('agent-x')]);

    await deleteAgent('agent-x');

    const calls = mockTerminalEmulator.execCommand.mock.calls as unknown as Array<[string, number?]>;
    const command = calls[0]?.[0] ?? '';
    expect(command).toContain('if [ -s "$d/logs/agent-x/agent-driver-audit.jsonl" ]; then');
    expect(command).toContain('mkdir -p "$d/audits"');
    expect(command).toContain('cp "$d/logs/agent-x/agent-driver-audit.jsonl" "$d/audits/agent-x-agent-driver-audit.jsonl"');
    expect(command).not.toContain('cp "$d/logs/agent-x/agent-driver-audit.jsonl" "$d/audits/agent-x-agent-driver-audit.jsonl" 2>/dev/null || true');
    expect(command.indexOf('cp "$d/logs/agent-x/agent-driver-audit.jsonl"')).toBeLessThan(
      command.indexOf('rm -rf "$d/logs/agent-x"')
    );
    expect(command.indexOf('rm -rf "$d/logs/agent-x"')).toBeLessThan(
      command.indexOf('printf \'%s\\n\' "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date)" > "$d/.deleted/agent-x"')
    );
    expect(useAgentStore.getState().agents).toEqual([]);
  });

  it('waits for the native agent service to write a run log before returning', async () => {
    useAgentStore.getState().setAgents([agent('agent-x')]);
    const log = {
      agentId: 'agent-x',
      timestamp: 1_800_000,
      status: 'success',
      durationMs: 42,
      toolUsed: 'Codex',
      outputPreview: 'ok',
    };
    // ③b-2 escalation: the run loop queries the free-cloud keys (ladderEnv) and
    // reads logs before/after each attempt. Command-aware mock: no keys, and the
    // FIRST log read (before-snapshot) is empty so the wait detects the new log.
    let logReads = 0;
    const runCommand = jest.fn(async (cmd: string) => {
      if (cmd.includes('CEREBRAS_API_KEY')) return ''; // ladderEnv: no free-cloud keys
      if (cmd.includes('SHELLY_AGENT_LOG')) {
        logReads += 1;
        return logReads === 1 ? '' : `${JSON.stringify(log)}\n---SHELLY_AGENT_LOG---\n`;
      }
      return ''; // materialize / misc
    });

    await runAgentNow('agent-x', runCommand, {
      runStartedAtMs: 1_799_000,
      waitTimeoutMs: 2_000,
      pollMs: 1,
    });

    // The first attempt (local) succeeds, so the agent runs once and the run log
    // is captured (no escalation needed).
    expect(mockTerminalEmulator.runAgent).toHaveBeenCalledWith('agent-x');
    expect(mockTerminalEmulator.runAgent).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState().getRunHistory('agent-x')).toEqual([log]);
  });
});
