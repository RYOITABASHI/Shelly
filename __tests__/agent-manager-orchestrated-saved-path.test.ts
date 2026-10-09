/**
 * Attended orchestrated (multi-step) run: the aggregate run log that replaces
 * the per-step logs must carry the FINAL step's saved draft path, so the
 * Sidebar agent detail "Open" button (agentRunOpenPath(lastLog)) and the
 * completion notices can open the file. Before the fix the per-step log that
 * held savedPath was deleted and the aggregate had no savedPath at all.
 *
 * Harness copied from __tests__/agent-manager-parallel-group.test.ts.
 */
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
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

import { runAgentNow } from '@/lib/agent-manager';
import { agentRunOpenPath, pickFinalStepOutput } from '@/lib/agent-run-output';
import { buildAgentCompanionNotice } from '@/lib/agent-companion-notice';
import { useAgentStore } from '@/store/agent-store';
import { agentThreadKey, useAIPaneStore } from '@/store/ai-pane-store';
import type { Agent, AgentRunLog } from '@/store/types';

const AGENT_ID = 'orchestrated-saved-path-agent';
const SAVED = '/data/user/0/dev.shelly.terminal/files/home/agent-output/2026-10-08/2026-10-08_digest.md';
const MIRROR = '/sdcard/Documents/ObsidianVault/Inbox/2026-10-08_digest.md';

const makeAgent = (): Agent => ({
  id: AGENT_ID,
  name: 'Digest',
  description: '',
  prompt: 'Compile the weekly digest',
  schedule: null,
  tool: { type: 'auto' },
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
  action: { type: 'draft' },
  orchestration: {
    steps: ['collect the meeting notes', 'write the digest'],
  },
});

function extractLine(cmd: string, prefix: string): string {
  const line = cmd.split('\n').find((l) => l.trim().startsWith(prefix));
  if (!line) return '';
  const trimmed = line.trim();
  return trimmed.slice(prefix.length + 1, -1).replace(/'\\''/g, "'");
}

function makeRunCommand(allCommands: string[], opts: { finalSaves: boolean }) {
  const logs: Array<Record<string, unknown>> = [];
  const previews = ['collected items', 'final digest text'];
  let stepRuns = 0;
  return jest.fn(async (cmd: string) => {
    allCommands.push(cmd);
    if (cmd.includes(`# run-agent-${AGENT_ID}`)) {
      const isFinal = stepRuns === previews.length - 1;
      logs.push({
        agentId: AGENT_ID,
        timestamp: Date.now() + logs.length,
        status: 'success',
        durationMs: 5,
        toolUsed: extractLine(cmd, 'TOOL_LABEL=') || 'unknown',
        outputPreview: previews[Math.min(stepRuns, previews.length - 1)],
        ...(isFinal && opts.finalSaves ? { savedPath: SAVED, savedPathMirror: MIRROR } : {}),
      });
      stepRuns += 1;
      return '';
    }
    if (cmd.includes('CEREBRAS_API_KEY')) {
      return [
        'CEREBRAS_API_KEY=0',
        'GROQ_API_KEY=0',
        'PERPLEXITY_API_KEY=1',
        'GEMINI_API_KEY=1',
        'SHELLY_AUTONOMOUS_CLOUD=0',
        'SHELLY_AUTONOMOUS_CLOUD_STOP=0',
      ].join('\n');
    }
    if (cmd.includes('---SHELLY_AGENT_LOG---')) {
      return logs.map((l) => `${JSON.stringify(l)}\n---SHELLY_AGENT_LOG---\n`).join('');
    }
    return '';
  });
}

/** The aggregate log JSON from the command that persists it. */
function findAggregate(allCommands: string[]): AgentRunLog {
  const cmd = allCommands.find((c) => c.includes('"steps":[') && c.includes(`/logs/${AGENT_ID}/`));
  expect(cmd).toBeDefined();
  const line = cmd!.split('\n').find((l) => l.startsWith('{') && l.includes('"steps":['));
  expect(line).toBeDefined();
  return JSON.parse(line!) as AgentRunLog;
}

describe('attended orchestration — aggregate run log carries the saved output path', () => {
  beforeEach(() => {
    mockTerminalEmulator.execCommand.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    mockTerminalEmulator.runAgent.mockResolvedValue(undefined);
    useAgentStore.getState().setAgents([makeAgent()]);
    useAgentStore.getState().setRunHistory({});
    useAIPaneStore.setState({ conversations: {}, isLoaded: true });
  });

  it("copies the final step's savedPath/savedPathMirror into the aggregate, so the Sidebar shows Open", async () => {
    const allCommands: string[] = [];
    await runAgentNow(AGENT_ID, makeRunCommand(allCommands, { finalSaves: true }), { waitTimeoutMs: 2000, pollMs: 1 });

    const aggregate = findAggregate(allCommands);
    expect(aggregate.steps).toHaveLength(2);
    expect(aggregate.savedPath).toBe(SAVED);
    expect(aggregate.savedPathMirror).toBe(MIRROR);
    // Sidebar.tsx's detail popup builds its Open button from exactly this.
    expect(agentRunOpenPath(aggregate)).toBe(SAVED);
    // ...and the companion completion notice carries the inline Open link.
    expect(buildAgentCompanionNotice(aggregate, 'Digest', 'Done.').openFileOffer).toEqual({ path: SAVED });
  });

  it("attaches the Open link to the chain's terminal hand-off line in the agent thread", async () => {
    await runAgentNow(AGENT_ID, makeRunCommand([], { finalSaves: true }), { waitTimeoutMs: 2000, pollMs: 1 });

    const messages = useAIPaneStore.getState().conversations[agentThreadKey(AGENT_ID)]?.messages ?? [];
    const handoff = messages.filter((m) => m.handoff);
    expect(handoff.length).toBeGreaterThanOrEqual(2);
    expect(handoff[handoff.length - 1].openFileOffer).toEqual({ path: SAVED });
    // Only the terminal line carries it.
    expect(handoff.slice(0, -1).every((m) => !m.openFileOffer)).toBe(true);
  });

  it('leaves the aggregate without savedPath when the final step saved nothing', async () => {
    const allCommands: string[] = [];
    await runAgentNow(AGENT_ID, makeRunCommand(allCommands, { finalSaves: false }), { waitTimeoutMs: 2000, pollMs: 1 });

    const aggregate = findAggregate(allCommands);
    expect('savedPath' in aggregate).toBe(false);
    expect(agentRunOpenPath(aggregate)).toBeUndefined();
  });
});

describe('pickFinalStepOutput / agentRunOpenPath', () => {
  it('copies only non-empty fields', () => {
    expect(pickFinalStepOutput(undefined)).toEqual({});
    expect(pickFinalStepOutput({ savedPath: '', actionResults: [] })).toEqual({});
    expect(pickFinalStepOutput({ savedPath: SAVED })).toEqual({ savedPath: SAVED });
  });

  it('treats a blank savedPath as no file', () => {
    expect(agentRunOpenPath({ savedPath: '  ' })).toBeUndefined();
    expect(agentRunOpenPath(undefined)).toBeUndefined();
  });
});
