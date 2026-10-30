/**
 * Provider overrides: the fold into the agent definition runs on the
 * run-completion path (lib/agent-manager.ts foldProviderOverridesFromDisk,
 * from the periodic run-log sync) — independent of MONITOR — only folds what
 * the app itself wrote, and updateAgent always removes a pending file so a
 * stale override can never silently override a later edit.
 */
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: { scheduleAgent: jest.fn(), cancelAgent: jest.fn() },
}));
jest.mock('@/lib/home-path', () => ({ getHomePath: () => '/home/shelly-test' }));
jest.mock('expo-notifications', () => ({}));
jest.mock('expo-file-system/legacy', () => ({}));

import { foldProviderOverridesFromDisk, updateAgent } from '@/lib/agent-manager';
import { useAgentStore } from '@/store/agent-store';
import {
  __resetAppWrittenOverridesForTests,
  noteAppWrittenOverrides,
  type ProviderOverrides,
} from '@/lib/agent-provider-overrides';
import type { Agent } from '@/store/types';

const AGENT: Agent = {
  id: 'agent-fold',
  name: 'Fold',
  description: '',
  prompt: 'collect and summarize',
  schedule: null,
  tool: { type: 'local' },
  outputPath: '$HOME/.shelly/agents/agent-fold/output.md',
  enabled: true,
  createdAt: 1,
  orchestration: { steps: ['collect', 'summarize'] },
} as Agent;

function listing(agentId: string, o: ProviderOverrides): string {
  return `@@SHELLY_OVERRIDES@@ ${agentId}\n${JSON.stringify(o)}\n`;
}

function runCommandWith(list: string) {
  const cmds: string[] = [];
  const run = jest.fn(async (cmd: string) => {
    cmds.push(cmd);
    if (cmd.includes('@@SHELLY_OVERRIDES@@')) return list;
    return '';
  });
  return { run, cmds };
}

const clears = (cmds: string[]) => cmds.filter((c) => c.startsWith('rm -f') && c.includes('agent-fold/overrides.json'));

describe('foldProviderOverridesFromDisk', () => {
  beforeEach(() => {
    __resetAppWrittenOverridesForTests();
    useAgentStore.setState({ agents: [AGENT], runningAgentIds: [], runHistory: {} });
  });

  const o: ProviderOverrides = { v: 1, runId: 'r1', steps: { '1': { tool: { type: 'groq' } } }, updatedAt: 1_000 };

  it('folds an app-written override once a run log newer than it exists, then removes the file', async () => {
    noteAppWrittenOverrides(AGENT.id, o);
    useAgentStore.setState({ runHistory: { [AGENT.id]: [{ agentId: AGENT.id, timestamp: 2_000, status: 'success' } as never] } });
    const { run, cmds } = runCommandWith(listing(AGENT.id, o));
    await foldProviderOverridesFromDisk(run, 5_000);
    const steps = useAgentStore.getState().agents[0].orchestration!.steps;
    expect(steps[1]).toEqual({ instruction: 'summarize', tool: { type: 'groq' } });
    expect(clears(cmds).length).toBeGreaterThan(0);
  });

  it('waits while the agent is running or no run has finished since the override', async () => {
    noteAppWrittenOverrides(AGENT.id, o);
    useAgentStore.setState({ runningAgentIds: [AGENT.id], runHistory: { [AGENT.id]: [{ agentId: AGENT.id, timestamp: 2_000, status: 'success' } as never] } });
    let r = runCommandWith(listing(AGENT.id, o));
    await foldProviderOverridesFromDisk(r.run, 5_000);
    expect(useAgentStore.getState().agents[0].orchestration!.steps[1]).toBe('summarize');
    expect(clears(r.cmds)).toHaveLength(0);

    useAgentStore.setState({ runningAgentIds: [], runHistory: { [AGENT.id]: [{ agentId: AGENT.id, timestamp: 500, status: 'success' } as never] } });
    r = runCommandWith(listing(AGENT.id, o));
    await foldProviderOverridesFromDisk(r.run, 5_000);
    expect(useAgentStore.getState().agents[0].orchestration!.steps[1]).toBe('summarize');
  });

  it('a file the app did not write (e.g. after a restart, or written by something else) is removed, never folded', async () => {
    useAgentStore.setState({ runHistory: { [AGENT.id]: [{ agentId: AGENT.id, timestamp: 2_000, status: 'success' } as never] } });
    const { run, cmds } = runCommandWith(listing(AGENT.id, o));
    await foldProviderOverridesFromDisk(run, 5_000);
    expect(useAgentStore.getState().agents[0].orchestration!.steps[1]).toBe('summarize');
    expect(clears(cmds)).toHaveLength(1);
  });

  it('startup sweep: a leftover file of a deleted agent is removed', async () => {
    useAgentStore.setState({ agents: [] });
    const { run, cmds } = runCommandWith(listing(AGENT.id, o));
    await foldProviderOverridesFromDisk(run, 5_000);
    expect(clears(cmds)).toHaveLength(1);
  });
});

describe('updateAgent clears a pending overrides.json', () => {
  it('an edit (chat confirm / picker save) removes the file so it cannot override the edit later', async () => {
    useAgentStore.setState({ agents: [AGENT], runningAgentIds: [], runHistory: {} });
    const cmds: string[] = [];
    const run = jest.fn(async (cmd: string) => {
      cmds.push(cmd);
      return '';
    });
    try {
      await updateAgent(AGENT.id, { name: 'Renamed' }, run);
    } catch {
      // materialize may fail against the mock; the clear runs after it only on success
    }
    expect(clears(cmds).length).toBeGreaterThan(0);
  });
});
