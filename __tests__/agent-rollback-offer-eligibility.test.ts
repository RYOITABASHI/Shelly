/**
 * Undo-affordance safety: the "元に戻す" (Undo) button that
 * components/panes/AIPane.tsx renders on an attended run's completion
 * bubble MUST be impossible to show for a run whose action type is not
 * rollback-eligible — even if lib/agent-manager.ts's module-level
 * pendingRollbackHandles map happens to still be holding a handle for that
 * agentId (e.g. left over from an EARLIER run of the same agent, before it
 * was edited to an irreversible action type).
 *
 * Two layers are under test here, matching the two fixes this file backs:
 *
 *  1. Root cause (in runAgentNowInner): a stray handle from a prior
 *     optimistic run must be cleared the instant a NEW run of the same
 *     agentId starts, even when that new run does not itself go optimistic.
 *     Before this fix, a handle captured by run N survived untouched through
 *     a non-optimistic run N+1 of the same agent, because the capture/clear
 *     logic only executes when THAT run went optimistic.
 *
 *  2. Defense in depth (rollbackOfferEligible): even with #1 in place, any
 *     UI surface that decides whether to show "Undo" must independently
 *     re-classify reversibility from the run's own agent snapshot — never
 *     infer eligibility from "a handle object happens to exist" alone.
 *     rollbackAgentRun()/consumeAgentRollbackHandle() themselves do NOT
 *     re-check eligibility (verified by reading lib/agent-manager.ts: they
 *     only check handle presence) — that is fine for those two functions
 *     because handle-lifecycle invariant #1 guarantees a live handle can only
 *     ever correspond to an eligible run, but the UI's OWN gating logic must
 *     not rely on that invariant alone, per this file's own design note.
 *     This suite proves rollbackOfferEligible() independently rejects an
 *     irreversible snapshot even while a REAL, valid handle for that same
 *     agentId sits in the map.
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

let mockSettings: any;
jest.mock('@/store/settings-store', () => ({
  useSettingsStore: {
    getState: () => ({ settings: mockSettings }),
  },
}));

import {
  consumeAgentRollbackHandle,
  peekAgentRollbackHandle,
  rollbackOfferEligible,
  runAgentNow,
} from '@/lib/agent-manager';
import type { RollbackRunCommand } from '@/lib/agent-rollback';
import { useAgentStore } from '@/store/agent-store';
import type { Agent } from '@/store/types';

const AGENT_ID = 'rollback-offer-agent';

function baseAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT_ID,
    name: AGENT_ID,
    description: '',
    prompt: 'save a short note',
    schedule: null,
    tool: { type: 'auto' },
    outputPath: '$HOME/agent-output/out.md',
    outputTemplate: null,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 0,
    version: 1,
    requireActionApproval: true,
    action: { type: 'draft' },
    ...overrides,
  } as Agent;
}

/** Scriptable fake git shell matching lib/auto-savepoint.ts's command shapes.
 *  Reused from the same pattern as __tests__/agent-rollback.test.ts. The
 *  first two `status --porcelain` calls are prepareRollbackWorkspace's own
 *  "is the tree already clean" checks (checkAndSave's internal one, then the
 *  explicit post-check) — both clean. Every call after that is
 *  captureRollbackPoint's post-run checkAndSave, which reports one new file
 *  so a real handle gets captured. */
function makeSavepointRunner(): { run: RollbackRunCommand; calls: string[] } {
  const calls: string[] = [];
  let statusCalls = 0;
  const run: RollbackRunCommand = async (cmd) => {
    calls.push(cmd);
    if (/rev-parse --git-dir/.test(cmd)) return { stdout: '.git', exitCode: 0 };
    if (/status --porcelain/.test(cmd)) {
      statusCalls++;
      return statusCalls <= 2
        ? { stdout: '', exitCode: 0 }
        : { stdout: '?? draft.md\n', exitCode: 0 };
    }
    if (/rev-parse --short HEAD/.test(cmd)) return { stdout: 'abc1234\n', exitCode: 0 };
    if (/diff --cached --name-only/.test(cmd)) return { stdout: '', exitCode: 0 };
    return { stdout: '', exitCode: 0 };
  };
  return { run, calls };
}

/** Drives runAgentNow through a successful attended run, matching the
 *  materialize/ladder-probe/log-read shape __tests__/agent-manager-
 *  inflight-dedupe.test.ts already established for this exact function. */
function makeAgentRunCommand() {
  const logs: Array<Record<string, unknown>> = [];
  const runCommand = jest.fn(async (cmd: string) => {
    if (cmd.includes(`# run-agent-${AGENT_ID}`)) {
      logs.push({
        agentId: AGENT_ID,
        timestamp: Date.now() + logs.length,
        status: 'success',
        durationMs: 5,
        toolUsed: 'attempt-1',
        outputPreview: 'ok',
      });
      return '';
    }
    if (cmd.includes('CEREBRAS_API_KEY')) return '';
    if (cmd.includes('---SHELLY_AGENT_LOG---')) {
      return logs.map((l) => `${JSON.stringify(l)}\n---SHELLY_AGENT_LOG---\n`).join('');
    }
    return '';
  });
  return runCommand;
}

describe('rollback-offer safety: stray-handle invalidation + independent re-classification', () => {
  beforeEach(() => {
    mockTerminalEmulator.cancelAgent.mockClear();
    mockTerminalEmulator.execCommand.mockClear();
    mockTerminalEmulator.runAgent.mockClear();
    mockTerminalEmulator.execCommand.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    mockTerminalEmulator.runAgent.mockResolvedValue(undefined);
    useAgentStore.getState().setAgents([baseAgent()]);
    useAgentStore.getState().setRunHistory({});
    mockSettings = {
      agentOptimisticWorkspaceWrites: true,
      agentOutputTarget: 'local',
      defaultRequireActionApproval: true,
    };
    // pendingRollbackHandles is a module-level singleton in lib/agent-manager.ts
    // (deliberately, see its doc comment) — reset it between tests so an
    // earlier test's captured handle can never leak into a later test's
    // "no handle exists" assertion.
    consumeAgentRollbackHandle(AGENT_ID);
  });

  it('a reversible draft run captures a real, live undo handle', async () => {
    const { run: savepointRunner } = makeSavepointRunner();
    await runAgentNow(AGENT_ID, makeAgentRunCommand(), {
      waitTimeoutMs: 2000,
      pollMs: 1,
      savepointRunner,
    });
    expect(peekAgentRollbackHandle(AGENT_ID)).not.toBeNull();
    expect(rollbackOfferEligible(AGENT_ID, baseAgent({ action: { type: 'draft' } }), mockSettings)).toBe(true);
  });

  it('ROOT-CAUSE FIX: an intervening non-optimistic run clears the previous run\'s stray handle', async () => {
    const { run: savepointRunner } = makeSavepointRunner();
    // Run 1: eligible draft agent — captures a real handle.
    await runAgentNow(AGENT_ID, makeAgentRunCommand(), {
      waitTimeoutMs: 2000,
      pollMs: 1,
      savepointRunner,
    });
    expect(peekAgentRollbackHandle(AGENT_ID)).not.toBeNull();

    // The agent gets edited to an IRREVERSIBLE action type (e.g. `cli`) —
    // classifyRunReversibility now rejects it, so run 2 never goes
    // optimistic, and (before the fix) never touched pendingRollbackHandles
    // either way — leaving run 1's handle stranded for the UI to
    // mis-associate with run 2's completion bubble.
    useAgentStore.getState().setAgents([baseAgent({ action: { type: 'cli' } })]);
    await runAgentNow(AGENT_ID, makeAgentRunCommand(), {
      waitTimeoutMs: 2000,
      pollMs: 1,
      savepointRunner,
    });

    expect(peekAgentRollbackHandle(AGENT_ID)).toBeNull();
  });

  it('DEFENSE IN DEPTH: rollbackOfferEligible rejects an irreversible snapshot even while a REAL handle for that agentId still exists', async () => {
    const { run: savepointRunner } = makeSavepointRunner();
    await runAgentNow(AGENT_ID, makeAgentRunCommand(), {
      waitTimeoutMs: 2000,
      pollMs: 1,
      savepointRunner,
    });
    // Sanity: the handle really is there (this is not a vacuous "always
    // false" check — the negative assertion below has an object to reject).
    expect(peekAgentRollbackHandle(AGENT_ID)).not.toBeNull();

    // Simulate the UI being handed a snapshot of what the agent looks like
    // NOW (e.g. edited to `cli` between the run and the message render) —
    // this is exactly what hooks/use-ai-pane-dispatch.ts's
    // buildRollbackOffer passes: the actual agent object the run used, not
    // just an agentId. Even though a genuine, still-live handle for this
    // agentId exists, the independent classification must say no.
    const irreversibleSnapshot = baseAgent({ action: { type: 'cli' } });
    expect(rollbackOfferEligible(AGENT_ID, irreversibleSnapshot, mockSettings)).toBe(false);

    // Same agentId, reversible snapshot + settings still say yes — proves
    // the false above was the classification, not some other bug making the
    // function always return false.
    expect(rollbackOfferEligible(AGENT_ID, baseAgent({ action: { type: 'draft' } }), mockSettings)).toBe(true);
  });

  it('rollbackOfferEligible is false when NO handle exists, even for a reversible snapshot', () => {
    expect(peekAgentRollbackHandle(AGENT_ID)).toBeNull();
    expect(rollbackOfferEligible(AGENT_ID, baseAgent({ action: { type: 'draft' } }), mockSettings)).toBe(false);
  });

  it('rollbackOfferEligible is false when the optimistic-writes setting is off, even with a live handle', async () => {
    const { run: savepointRunner } = makeSavepointRunner();
    await runAgentNow(AGENT_ID, makeAgentRunCommand(), {
      waitTimeoutMs: 2000,
      pollMs: 1,
      savepointRunner,
    });
    expect(peekAgentRollbackHandle(AGENT_ID)).not.toBeNull();

    const settingsOff = { ...mockSettings, agentOptimisticWorkspaceWrites: false };
    expect(rollbackOfferEligible(AGENT_ID, baseAgent({ action: { type: 'draft' } }), settingsOff)).toBe(false);
  });
});
