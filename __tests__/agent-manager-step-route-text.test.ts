/**
 * 2026-08-03 on-device bug (DEFERRED.md「オーケストレーションのステップ実行が合成
 * プロンプト全文でルーティング判定され偽の成功通知に至る」): a 2-step chain
 * "パープレキシティで最新のAIニュースを集めて、ローカルLLMで要約して、通知して"
 * ran step 1 (summarize) through the escalation ladder using stepAgent.prompt —
 * buildStepPrompt's COMPOSITE (base prompt + step 0's collected news text +
 * the instruction). The prior step's time-sensitive result made
 * detectRouteSignals report needsWeb for a pure transform step, so the ladder
 * excluded local and escalated to Perplexity/Gemini; Perplexity misread the
 * composite as "research local-LLM summarization" and returned an off-task
 * essay that was logged as SUCCESS and fired a real completion notification.
 *
 * Fix under test: runAgentOrchestratedBody passes step.instruction as
 * routeTextOverride to runLadderAttempts → resolveEscalationLadder →
 * resolveAgentRoute, so each step is ROUTED by what it is, while the composite
 * prompt (which the chosen tool genuinely needs — you can't summarize results
 * you weren't given) still reaches the materialized script unchanged.
 *
 * Harness mirrors __tests__/agent-manager-step-tool-pin.test.ts: only the shell
 * boundary (runCommand) and the native TerminalEmulator bridge are mocked.
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

const AGENT_ID = 'route-text-agent';

// The real utterance shape from the on-device repro. The base prompt is
// prepended to EVERY step's composite by buildStepPrompt, so its collection
// verb (集めて) + freshness modifier (最新) alone already polluted step 1's
// routing even before the prior result was added on top.
const BASE_PROMPT = 'パープレキシティで最新のAIニュースを集めて、ローカルLLMで要約して、通知して';
const COLLECT_STEP = '最新のAIニュースを集めて';
const SUMMARIZE_STEP = 'ニュースを要約して';
// What step 0 "actually collected" in the mocked run — time-sensitive,
// research-flavored text like the real Perplexity/Gemini news output that
// drove the misroute (研究 → academic webDomain → Perplexity).
const COLLECTED_NEWS_PREVIEW =
  'Perplexityは2026年8月に最新の研究成果を発表し、AIニュース各社が新型推論モデルの動向を報道した。';

const baseAgent: Agent = {
  id: AGENT_ID,
  name: AGENT_ID,
  description: '',
  prompt: BASE_PROMPT,
  schedule: null,
  tool: { type: 'auto' },
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
  orchestration: { steps: [COLLECT_STEP, SUMMARIZE_STEP] },
};

interface CapturedStep {
  toolLabel: string;
  routeDecision: AgentRouteDecision;
  /** Full materialize command — used to assert the COMPOSITE prompt (with the
   *  prior step's result) still reaches the generated script unchanged. */
  rawCommand: string;
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
  return { toolLabel, routeDecision: JSON.parse(routeJson) as AgentRouteDecision, rawCommand: cmd };
}

/**
 * Mocked runCommand driving runAgentOrchestrated end to end:
 *  - the ladderEnv probe reports Perplexity/Gemini keys PRESENT (the on-device
 *    condition — a keyed web backend is what made the misroute actually run),
 *    free-cloud (Cerebras/Groq) keys absent to keep the ladder short,
 *  - every materialize call's resolved tool is captured in step order, and a
 *    success log is committed immediately so the ladder never climbs — step 0's
 *    log carries the news-shaped preview that pollutes step 1's composite.
 */
function makeRunCommand(captured: CapturedStep[]) {
  const logs: Array<Record<string, unknown>> = [];
  return jest.fn(async (cmd: string) => {
    // Materialize marker first — the generated script itself can embed the
    // CEREBRAS_API_KEY substring (apiKeyEnvScrub), see step-tool-pin's note.
    if (cmd.includes(`# run-agent-${AGENT_ID}`)) {
      const step = captureFromMaterializeCommand(cmd);
      captured.push(step);
      logs.push({
        agentId: AGENT_ID,
        timestamp: Date.now() + logs.length,
        status: 'success',
        durationMs: 5,
        toolUsed: step.toolLabel,
        // Step 0 "collects" real time-sensitive news; later steps return plain
        // text. This preview is what runAgentOrchestratedBody carries into
        // priorResults → buildStepPrompt → step 1's composite prompt.
        outputPreview: logs.length === 0 ? COLLECTED_NEWS_PREVIEW : `ok via ${step.toolLabel}`,
        routeDecision: step.routeDecision,
      });
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
    return ''; // listAgentLogFiles / aggregate write / memory / skills / misc
  });
}

describe('orchestration step routing — each step is routed by its OWN instruction, not the composite prompt', () => {
  beforeEach(() => {
    mockTerminalEmulator.cancelAgent.mockClear();
    mockTerminalEmulator.execCommand.mockClear();
    mockTerminalEmulator.runAgent.mockClear();
    mockTerminalEmulator.execCommand.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    mockTerminalEmulator.runAgent.mockResolvedValue(undefined);
    useAgentStore.getState().setAgents([]);
    useAgentStore.getState().setRunHistory({});
  });

  it('on-device repro: the summarize step stays LOCAL even though step 0 fed it time-sensitive news text (pre-fix: escalated to Perplexity/Gemini)', async () => {
    useAgentStore.getState().setAgents([baseAgent]);
    const captured: CapturedStep[] = [];
    const runCommand = makeRunCommand(captured);

    await runAgentNow(AGENT_ID, runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    expect(captured.length).toBeGreaterThanOrEqual(2);

    // Step 0 (collect) is genuinely web-mandatory by ITS OWN instruction and
    // must keep the grounded web route — the fix must not regress web steps.
    expect(captured[0].routeDecision.toolType).toBe('gemini-api');

    // Step 1 (summarize): a pure transform by its own instruction. Before the
    // fix, the composite prompt (base collection verbs + step 0's news result)
    // flipped needsWeb → the ladder excluded local and materialized a keyed web
    // backend, whose off-task "success" reached the user as a fake completion
    // notification. It must now route on-device.
    expect(captured[1].routeDecision.toolType).toBe('local');
    expect(captured[1].routeDecision.toolType).not.toBe('perplexity');
    expect(captured[1].routeDecision.toolType).not.toBe('gemini-api');
  });

  it("the fix changes ROUTING only — step 1's materialized script still receives the composite prompt including step 0's carried result", async () => {
    useAgentStore.getState().setAgents([baseAgent]);
    const captured: CapturedStep[] = [];
    const runCommand = makeRunCommand(captured);

    await runAgentNow(AGENT_ID, runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    expect(captured.length).toBeGreaterThanOrEqual(2);
    // A summarize step without the prior result would have nothing to
    // summarize: the carried news text (and the step-scaffold header) must
    // still be baked into the step-1 script verbatim.
    expect(captured[1].rawCommand).toContain('新型推論モデル');
    expect(captured[1].rawCommand).toContain('Results from previous steps');
    // ...and step 0's script must NOT contain it (no prior results yet).
    expect(captured[0].rawCommand).not.toContain('新型推論モデル');
  });
});
