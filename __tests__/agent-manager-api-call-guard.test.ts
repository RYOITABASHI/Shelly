/**
 * api-call (v1) attended-run guard (Track C): runAgentNow must refuse a clean,
 * user-facing error for an agent whose orchestration contains an apiCall step,
 * or whose terminal action is 'api-call' — api-call is PlanSpec-executor-only
 * in v1 (scripts/shelly-plan-executor.js), and runAgentOrchestrated's per-step
 * `.sh` generator (lib/agent-executor.ts) has no concept of an apiCall step at
 * all: without this guard it would silently send the step's synthetic display
 * label to a model as a literal prompt and carry the resulting garbage forward
 * as a fake-successful prior result (see lib/agent-manager.ts's runAgentNow
 * for the full reasoning). Mirrors the mocking pattern in
 * __tests__/agent-manager-step-tool-pin.test.ts.
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

import { runAgentNow } from '@/lib/agent-manager';
import { useAgentStore } from '@/store/agent-store';
import { Agent } from '@/store/types';
import { t } from '@/lib/i18n';

// Locale-agnostic: this environment's default locale can be 'en' or 'ja'
// depending on the host machine, so assert against the SAME t() lookup the
// guard itself uses rather than hardcoding one language's string.
const EXPECTED_MESSAGE = t('agents.api_call_attended_unsupported');

const AGENT_ID = 'api-call-guard-agent';

const baseAgent: Agent = {
  id: AGENT_ID,
  name: AGENT_ID,
  description: '',
  prompt: 'do a thing',
  schedule: null,
  tool: { type: 'auto' },
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
};

describe('runAgentNow — api-call (v1) attended-run guard', () => {
  beforeEach(() => {
    mockTerminalEmulator.cancelAgent.mockClear();
    mockTerminalEmulator.execCommand.mockClear();
    mockTerminalEmulator.runAgent.mockClear();
    useAgentStore.getState().setAgents([]);
    useAgentStore.getState().setRunHistory({});
    useAgentStore.setState({ halted: false });
  });

  it('refuses cleanly when an orchestration step carries an apiCall config', async () => {
    const agent: Agent = {
      ...baseAgent,
      orchestration: {
        steps: [
          {
            instruction: 'search for sources',
            apiCall: { host: 'api.perplexity.ai', method: 'GET', path: '/v1/search' },
          },
          'summarize and post the digest',
        ],
      },
    };
    useAgentStore.getState().setAgents([agent]);
    const runCommand = jest.fn(async () => '');

    await expect(runAgentNow(AGENT_ID, runCommand)).rejects.toThrow(EXPECTED_MESSAGE);
    // No shell command was ever run (materialize/dispatch never started) —
    // the guard fires before any privileged action.
    expect(runCommand).not.toHaveBeenCalled();
    expect(mockTerminalEmulator.runAgent).not.toHaveBeenCalled();
  });

  it('refuses cleanly when the terminal action itself is api-call, even on a >= 2 step orchestrated agent', async () => {
    const agent: Agent = {
      ...baseAgent,
      orchestration: { steps: ['gather sources', 'post the digest'] },
      action: {
        type: 'api-call',
        apiCall: { host: 'api.perplexity.ai', method: 'POST', path: '/v1/index', bodyTemplate: '{{result}}' },
      },
    };
    useAgentStore.getState().setAgents([agent]);
    const runCommand = jest.fn(async () => '');

    await expect(runAgentNow(AGENT_ID, runCommand)).rejects.toThrow(EXPECTED_MESSAGE);
    expect(runCommand).not.toHaveBeenCalled();
    expect(mockTerminalEmulator.runAgent).not.toHaveBeenCalled();
  });

  it('does NOT refuse a plain orchestrated agent with no apiCall anywhere (no false positive)', async () => {
    const agent: Agent = {
      ...baseAgent,
      orchestration: { steps: ['gather sources', 'post the digest'] },
    };
    useAgentStore.getState().setAgents([agent]);
    const logs: Array<Record<string, unknown>> = [];
    const runCommand = jest.fn(async (cmd: string) => {
      if (cmd.includes(`# run-agent-${AGENT_ID}`)) {
        logs.push({ agentId: AGENT_ID, timestamp: Date.now() + logs.length, status: 'success', durationMs: 1, toolUsed: 'x', outputPreview: 'ok' });
        return '';
      }
      if (cmd.includes('---SHELLY_AGENT_LOG---')) {
        return logs.map((l) => `${JSON.stringify(l)}\n---SHELLY_AGENT_LOG---\n`).join('');
      }
      return '';
    });

    await expect(runAgentNow(AGENT_ID, runCommand, { waitTimeoutMs: 2000, pollMs: 1 })).resolves.toBeUndefined();
    expect(runCommand).toHaveBeenCalled();
  });
});
