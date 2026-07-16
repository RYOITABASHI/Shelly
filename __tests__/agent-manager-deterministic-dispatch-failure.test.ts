/**
 * P3 UX fix (docs/superpowers/DEFERRED.md "エスカレーションラダーが「毎回人間
 * 承認」アクションで人間に多重リクエストする"): runLadderAttempts
 * (lib/agent-manager.ts) used to escalate to the next candidate tool on ANY
 * failed attempt, regardless of action type or failure cause. For cli /
 * intent / dm-reply — action types whose run RESULT *is* the human-facing
 * approval object, requiring an in-app approval tap on every attempt — a
 * deterministic dispatch-time/environment failure (e.g. the cli action's
 * fixed command isn't on Shelly's PATH → exit 127) reproduces identically no
 * matter which LLM backend generated the preceding content, so escalating
 * just asks the human to approve the same doomed action a second time.
 *
 * These tests exercise the fix end-to-end through runAgentNow →
 * runEscalatingAttempts → runLadderAttempts, following the exact mocking
 * pattern established in __tests__/agent-manager-step-tool-pin.test.ts: only
 * the shell boundary (runCommand) and the native TerminalEmulator bridge are
 * mocked. The number of captured materialize calls IS the number of
 * candidate-tool attempts the ladder actually ran — one captured call means
 * "ended as a single failure, no second approval request"; two means "climbed
 * to the next tool, second approval request fired" (today's pre-fix, and
 * still-correct-for-other-cases, behavior).
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
import { Agent, AgentActionType } from '@/store/types';

const AGENT_ID = 'dispatch-failure-agent';

const baseAgent: Agent = {
  id: AGENT_ID,
  name: AGENT_ID,
  description: '',
  // Neutral prompt: no code/web/secret keyword signals, so the ladder is the
  // plain attended default (primary/local → codex) and the test is only
  // exercising the failure-classification branch, not routing itself.
  prompt: 'summarize this note for me',
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

interface AttemptOutcome {
  status: 'success' | 'error';
  outputPreview: string;
}

/**
 * Build a mocked runCommand that drives runEscalatingAttempts end to end:
 *  - answers the ladderEnv probe with "no free-cloud keys" (so the attended
 *    ladder is exactly [primary/local, codex] — at most 2 candidates),
 *  - counts each materialize call (one per candidate-tool ATTEMPT) and
 *    "commits" the corresponding entry from `outcomes` as that attempt's run
 *    log, so the very next log read (the ladder's wait-for-completion +
 *    after-snapshot) sees it,
 *  - a materialize call beyond outcomes.length reuses the LAST outcome (only
 *    relevant if a test's assertion about call count already failed).
 */
function makeRunCommand(outcomes: AttemptOutcome[]) {
  const logs: Array<Record<string, unknown>> = [];
  let materializeCalls = 0;
  const runCommand = jest.fn(async (cmd: string) => {
    // Check the materialize marker BEFORE the ladderEnv ('CEREBRAS_API_KEY')
    // marker — the generated run script itself embeds a line that unsets
    // CEREBRAS_API_KEY when the resolved tool doesn't need it, so a
    // materialize command can ALSO contain that substring.
    //
    // NOTE: runEscalatingAttempts also re-materializes the agent's ORIGINAL
    // script once AFTER the whole ladder finishes (to restore the on-disk
    // script for the next scheduled fire) — that trailing call matches this
    // same marker but is NOT a new attempt (no TerminalEmulator.runAgent
    // follows it, and it happens after the loop has already decided the
    // outcome), so it must not be treated as an attempt outcome. Clamp to the
    // last outcome so it's harmless if reached.
    if (cmd.includes(`# run-agent-${AGENT_ID}`)) {
      const outcome = outcomes[Math.min(materializeCalls, outcomes.length - 1)];
      materializeCalls += 1;
      logs.push({
        agentId: AGENT_ID,
        timestamp: Date.now() + logs.length,
        status: outcome.status,
        durationMs: 5,
        toolUsed: materializeCalls === 1 ? 'attempt-1' : 'attempt-2',
        outputPreview: outcome.outputPreview,
        errorMessage: outcome.status === 'error' ? outcome.outputPreview : undefined,
      });
      return '';
    }
    if (cmd.includes('CEREBRAS_API_KEY')) return ''; // ladderEnv: no free-cloud keys, no consent
    if (cmd.includes('---SHELLY_AGENT_LOG---')) {
      return logs.map((l) => `${JSON.stringify(l)}\n---SHELLY_AGENT_LOG---\n`).join('');
    }
    return ''; // listAgentLogFiles / aggregate write / memory / skills / misc
  });
  return { runCommand };
}

/**
 * The number of actual candidate-tool ATTEMPTS the ladder ran — distinct from
 * the materialize-command count, which also includes the trailing
 * script-restore re-materialize (see makeRunCommand's note). Each real
 * attempt (and ONLY a real attempt) calls TerminalEmulator.runAgent() exactly
 * once, immediately after materializing that attempt's script and before
 * waiting for its completion — this is the one call the restore never makes.
 */
function attemptCount(): number {
  return mockTerminalEmulator.runAgent.mock.calls.length;
}

function agentWithAction(actionType: AgentActionType): Agent {
  return {
    ...baseAgent,
    action:
      actionType === 'cli'
        ? { type: 'cli', command: 'ls' }
        : actionType === 'intent'
          ? { type: 'intent', intentMode: 'share', intentShareText: 'hi' }
          : actionType === 'dm-reply'
            ? { type: 'dm-reply', dmPairingId: 'p1', dmReplyText: 'hi' }
            : { type: actionType },
  };
}

describe('runLadderAttempts — deterministic dispatch-time failure does not double-request approval', () => {
  beforeEach(() => {
    mockTerminalEmulator.cancelAgent.mockClear();
    mockTerminalEmulator.execCommand.mockClear();
    mockTerminalEmulator.runAgent.mockClear();
    mockTerminalEmulator.execCommand.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    mockTerminalEmulator.runAgent.mockResolvedValue(undefined);
    useAgentStore.getState().setAgents([]);
    useAgentStore.getState().setRunHistory({});
  });

  it('cli action + exit-127 (command not found) dispatch failure → single failure, no second approval request', async () => {
    const agent = agentWithAction('cli');
    useAgentStore.getState().setAgents([agent]);
    const { runCommand } = makeRunCommand([
      { status: 'error', outputPreview: 'CLI action failed with exit 127.' },
      { status: 'success', outputPreview: 'should never be reached' },
    ]);

    await runAgentNow(AGENT_ID, runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    // Exactly ONE candidate tool was attempted (one TerminalEmulator.runAgent
    // call) — the ladder ended as a single failure instead of climbing to the
    // second candidate tool, i.e. no second approval request fired.
    expect(attemptCount()).toBe(1);
  });

  it('cli action + low-quality/echoed completion → STILL escalates to the second tool (regression guard)', async () => {
    const agent = agentWithAction('cli');
    useAgentStore.getState().setAgents([agent]);
    const echoed = 'As an AI, I cannot generate a literal CLI command for this task.';
    const { runCommand } = makeRunCommand([
      { status: 'success', outputPreview: echoed }, // isLowQualityCompletion → attemptFailed → escalates
      { status: 'success', outputPreview: 'a real, usable completion' },
    ]);

    await runAgentNow(AGENT_ID, runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    // The model-quality escalation path must be untouched by this fix: two
    // candidate tools were attempted.
    expect(attemptCount()).toBe(2);
  });

  it('draft action + the SAME deterministic-shaped failure text → STILL escalates (fix is scoped to cli/intent/dm-reply only)', async () => {
    const agent = agentWithAction('draft');
    useAgentStore.getState().setAgents([agent]);
    const { runCommand } = makeRunCommand([
      { status: 'error', outputPreview: 'CLI action failed with exit 127.' },
      { status: 'success', outputPreview: 'a real, usable completion' },
    ]);

    await runAgentNow(AGENT_ID, runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    // draft is not one of the "result IS the approval object" action types —
    // the deterministic-dispatch-failure short-circuit must NOT apply, so the
    // ladder climbs exactly as it did before this fix.
    expect(attemptCount()).toBe(2);
  });

  it('notify action + the SAME deterministic-shaped failure text → STILL escalates (regression guard)', async () => {
    const agent = agentWithAction('notify');
    useAgentStore.getState().setAgents([agent]);
    const { runCommand } = makeRunCommand([
      { status: 'error', outputPreview: 'CLI action failed with exit 127.' },
      { status: 'success', outputPreview: 'a real, usable completion' },
    ]);

    await runAgentNow(AGENT_ID, runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    expect(attemptCount()).toBe(2);
  });
});
