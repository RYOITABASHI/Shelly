/**
 * Phase 5: an orchestration step may optionally pin a concrete tool, skipping
 * the keyword-based auto-routing for that step only (lib/agent-orchestration.ts
 * normalizeStep + lib/agent-manager.ts runAgentOrchestrated).
 *
 * Two layers are covered:
 *  - `resolveAgentRoute` (pure): proves the GUARD distinction at the layer
 *    where it's actually decided — an unpinned step's tool stays 'auto' and
 *    resolves via 'keyword'/'scorer', a pinned step's tool is concrete and
 *    resolves via 'configured-tool' (the SAME path a top-level non-auto
 *    Agent.tool already uses — no new mechanism).
 *  - `runAgentNow` → runAgentOrchestrated (end-to-end): proves the pin
 *    actually reaches the materialized run-script that TerminalEmulator
 *    executes on-device. NOTE: the escalation ladder (agent-manager.ts
 *    runLadderAttempts) always re-materializes each attempt with a FORCED
 *    concrete `tool` + `runOn: 'auto'` (see its "force the configured-tool
 *    branch" comment) — so the materialized script's OWN route decision is
 *    'configured-tool' for EVERY successful attempt, pinned or not. The
 *    meaningful, distinguishing signal at this layer is which TOOL got
 *    materialized, not the guard label — asserted below via TOOL_LABEL /
 *    ROUTE_DECISION_JSON embedded in the generated script.
 *
 * Only the shell boundary (runCommand) and the native TerminalEmulator bridge
 * are mocked, following the pattern in __tests__/agent-delete-tombstone.test.ts.
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
import { Agent, AgentRouteDecision } from '@/store/types';
import { resolveAgentRoute } from '@/lib/agent-tool-router';
import { buildStepPrompt, normalizeSteps } from '@/lib/agent-orchestration';

const AGENT_ID = 'chain-agent';

const baseAgent: Agent = {
  id: AGENT_ID,
  name: AGENT_ID,
  description: '',
  prompt: '', // empty — keeps step-instruction keyword signals unambiguous
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

// ── Layer 1: resolveAgentRoute — the guard is decided here, pure & offline ──
describe('resolveAgentRoute — orchestration step tool pin (guard layer)', () => {
  // Mirrors EXACTLY how runAgentOrchestrated builds a stepAgent
  // (lib/agent-manager.ts): tool defaults to agent.tool when the step has no
  // pin, prompt is buildStepPrompt(agent.prompt, step.instruction, prior).
  function stepAgentFor(agent: Agent, instruction: string, tool: Agent['tool'] | undefined) {
    return {
      ...agent,
      prompt: buildStepPrompt(agent.prompt, instruction, []),
      orchestration: undefined,
      tool: tool ?? agent.tool,
    };
  }

  it('(a) regression: an unpinned step (tool undefined) resolves via keyword/scorer, exactly like today', () => {
    const step = stepAgentFor(baseAgent, 'review this github pull request and merge it', undefined);
    const { decision, tool } = resolveAgentRoute(step);
    expect(decision.guard).not.toBe('configured-tool');
    expect(['keyword', 'scorer']).toContain(decision.guard);
    expect(tool.type).toBe('cli'); // code-keyword task → Codex CLI, same as a single-run agent
  });

  it('(b) a pinned step resolves via configured-tool and returns EXACTLY the pinned tool, ignoring its own keywords', () => {
    // Misleading on purpose: strong CODE keywords that would normally score to
    // Codex CLI — the pin must win regardless of instruction content.
    const pinned = { type: 'perplexity' as const, model: 'sonar-deep-research' };
    const step = stepAgentFor(baseAgent, 'review this github pull request and merge it', pinned);
    const { decision, tool } = resolveAgentRoute(step);
    expect(decision.guard).toBe('configured-tool');
    expect(tool).toEqual(pinned);
  });

  it('(c) mixed array: each step in the SAME chain resolves independently — pin does not leak to the unpinned sibling', () => {
    const steps = normalizeSteps({ steps: [
      'review this github pull request and merge it',
      { instruction: 'review this github pull request and merge it', tool: { type: 'local' as const } },
    ] });
    const results = steps.map((s) => resolveAgentRoute(stepAgentFor(baseAgent, s.instruction, s.tool)));
    expect(results[0].decision.guard).not.toBe('configured-tool');
    expect(results[0].tool.type).toBe('cli');
    expect(results[1].decision.guard).toBe('configured-tool');
    expect(results[1].tool.type).toBe('local');
  });
});

// ── Layer 2: runAgentNow → runAgentOrchestrated — the pin reaches the shell ──
interface CapturedStep {
  toolLabel: string;
  routeDecision: AgentRouteDecision;
}

/** Extract TOOL_LABEL= / ROUTE_DECISION_JSON= from a materialize command's
 * embedded generateRunScript() output (each is a single shellQuote()'d line). */
function captureFromMaterializeCommand(cmd: string): CapturedStep {
  const lines = cmd.split('\n');
  const toolLabelLine = lines.find((l) => l.startsWith('TOOL_LABEL='));
  const routeLine = lines.find((l) => l.startsWith('ROUTE_DECISION_JSON='));
  const unquote = (line: string, prefix: string) => line.slice(prefix.length + 1, -1);
  const toolLabel = toolLabelLine ? unquote(toolLabelLine, 'TOOL_LABEL=') : '';
  const routeJson = routeLine ? unquote(routeLine, 'ROUTE_DECISION_JSON=') : '{}';
  return { toolLabel, routeDecision: JSON.parse(routeJson) as AgentRouteDecision };
}

/**
 * Build a mocked runCommand that drives runAgentOrchestrated end to end:
 *  - answers the ladderEnv probe with "no free-cloud keys",
 *  - captures every materialize call's resolved tool (via TOOL_LABEL /
 *    ROUTE_DECISION_JSON) into `captured`, in step order,
 *  - and — the moment a materialize call is captured — immediately "commits"
 *    a successful run-log entry for it, so the very next log read (the
 *    escalation ladder's wait-for-completion + after-snapshot) sees a
 *    success and the ladder does NOT climb past the first candidate.
 */
function makeRunCommand(captured: CapturedStep[]) {
  const logs: Array<Record<string, unknown>> = [];
  return jest.fn(async (cmd: string) => {
    // NOTE: check the materialize marker BEFORE the ladderEnv ('CEREBRAS_API_KEY')
    // marker — the generated run script itself embeds a line that unsets
    // CEREBRAS_API_KEY (apiKeyEnvScrub) when the resolved tool doesn't need an
    // API key env var, so a materialize command can ALSO contain that substring.
    if (cmd.includes(`# run-agent-${AGENT_ID}`)) {
      const step = captureFromMaterializeCommand(cmd);
      captured.push(step);
      logs.push({
        agentId: AGENT_ID,
        timestamp: Date.now() + logs.length,
        status: 'success',
        durationMs: 5,
        toolUsed: step.toolLabel,
        outputPreview: `ok via ${step.toolLabel}`,
        routeDecision: step.routeDecision,
      });
      return '';
    }
    if (cmd.includes('CEREBRAS_API_KEY')) return ''; // ladderEnv: no free-cloud keys, no consent
    if (cmd.includes('---SHELLY_AGENT_LOG---')) {
      return logs.map((l) => `${JSON.stringify(l)}\n---SHELLY_AGENT_LOG---\n`).join('');
    }
    return ''; // listAgentLogFiles / aggregate write / memory / skills / misc
  });
}

describe('orchestration step tool pin — end-to-end (agent-manager)', () => {
  beforeEach(() => {
    mockTerminalEmulator.cancelAgent.mockClear();
    mockTerminalEmulator.execCommand.mockClear();
    mockTerminalEmulator.runAgent.mockClear();
    mockTerminalEmulator.execCommand.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    mockTerminalEmulator.runAgent.mockResolvedValue(undefined);
    useAgentStore.getState().setAgents([]);
    useAgentStore.getState().setRunHistory({});
  });

  it('(a) regression: plain-string-only steps still reach the shell with the auto-scored tool', async () => {
    const agent: Agent = {
      ...baseAgent,
      orchestration: {
        steps: [
          'review this github pull request and merge it',
          'write a short two sentence conclusion',
        ],
      },
    };
    useAgentStore.getState().setAgents([agent]);
    const captured: CapturedStep[] = [];
    const runCommand = makeRunCommand(captured);

    await runAgentNow(AGENT_ID, runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    expect(captured.length).toBeGreaterThanOrEqual(2);
    // The strong code-keyword step routes to Codex CLI, exactly as a single-run
    // agent with the same prompt would (no orchestration-specific behavior change).
    expect(captured[0].routeDecision.toolType).toBe('cli');
    expect(captured[0].toolLabel).toBe('Codex CLI');
  });

  it('(b) a step with an explicit tool pin reaches the shell with EXACTLY that tool, not an auto-routed one', async () => {
    const agent: Agent = {
      ...baseAgent,
      orchestration: {
        // >= 2 steps so this takes the orchestration codepath (isOrchestrated
        // requires >= 2); the second step is unrelated so the pinned first
        // step is isolated cleanly.
        steps: [
          // Misleading on purpose: strong CODE keywords that would normally
          // score to Codex CLI — the pin must win over them regardless.
          { instruction: 'review this github pull request and merge it', tool: { type: 'perplexity', model: 'sonar-deep-research' } },
          'write a short two sentence conclusion',
        ],
      },
    };
    useAgentStore.getState().setAgents([agent]);
    const captured: CapturedStep[] = [];
    const runCommand = makeRunCommand(captured);

    await runAgentNow(AGENT_ID, runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    expect(captured.length).toBeGreaterThanOrEqual(1);
    expect(captured[0].routeDecision.toolType).toBe('perplexity');
    expect(captured[0].toolLabel).toBe('Perplexity API (sonar-deep-research)');
  });

  it('(c) mixed array: an unpinned step auto-routes while a pinned step in the SAME chain ignores its own keywords', async () => {
    const agent: Agent = {
      ...baseAgent,
      orchestration: {
        steps: [
          'review this github pull request and merge it', // plain string → auto (Codex CLI expected)
          {
            instruction: 'review this github pull request and merge it', // same misleading text
            tool: { type: 'local', model: 'Qwen3.5-0.8B-Q4_K_M' },
          },
        ],
      },
    };
    useAgentStore.getState().setAgents([agent]);
    const captured: CapturedStep[] = [];
    const runCommand = makeRunCommand(captured);

    await runAgentNow(AGENT_ID, runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    expect(captured.length).toBeGreaterThanOrEqual(2);
    // Step 1: unpinned, code-keyword instruction → Codex CLI (auto-routed).
    expect(captured[0].routeDecision.toolType).toBe('cli');
    // Step 2: pinned to local — ignoring the IDENTICAL code-keyword instruction
    // that drove step 1 to Codex. Proves the pin is per-step, not chain-wide.
    expect(captured[1].routeDecision.toolType).toBe('local');
    expect(captured[1].toolLabel).toBe('Local LLM');
  });
});
