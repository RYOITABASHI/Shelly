/**
 * 2026-08-04 on-device bug (DEFERRED.md — third and deepest bug in the same
 * incident as agent-manager-step-route-text.test.ts's routing fix): the SAME
 * 2-step chain "パープレキシティで最新のAIニュースを集めて、ローカルLLMで要約して、
 * 通知して" (actionType: notify) — after the ROUTING fix correctly kept step 1
 * (summarize) on-device — still produced a shallow, near-content-free bullet
 * list of company names + guessed URLs instead of a real summary. Two
 * independent, compounding causes, both in generateRunScript's per-step
 * system-prompt/contract construction (which — unlike resolveEscalationLadder —
 * had NO routeTextOverride-equivalent at all before this fix):
 *
 *  (A) The FINAL step of a chain is never suppressed (it's the one that
 *      performs the agent-level action), so its actionType fell through to
 *      `agent.action?.type` — 'notify' — whose system prompt says "Write the
 *      notification message itself... keep it to a few words or one
 *      sentence." That fought the step's own instruction ("ローカルLLMで要約して")
 *      instead of letting it drive generation.
 *
 *  (B) generateRunScript's own detectRouteSignals(agent.prompt) call (which
 *      decides whether to inject the "You are a research-collection agent...
 *      Return ONLY a Markdown bullet list of [title](url) — summary" contract)
 *      ran on agent.prompt — buildStepPrompt's COMPOSITE (base prompt + step
 *      0's real carried result + this step's instruction). Step 0's carried
 *      news text is full of freshness/collection signals, so needsWeb tripped
 *      true for the summarize step too, and the collection contract overrode
 *      "要約して" with a rigid bullet-list-of-links format.
 *
 * Fix under test: MaterializeRunOpts.isOrchestratedStep (A) makes a chain step
 * use generic 'draft'-style content-generation guidance instead of the
 * top-level action's delivery-format instruction; MaterializeRunOpts's
 * (re-threaded) routeTextOverride (B) makes generateRunScript's own
 * detectRouteSignals call judge by the step's OWN instruction, exactly
 * mirroring the routing fix's already-established pattern. Both are additive —
 * a genuinely single-shot (non-orchestrated) notify agent is unaffected by
 * either (isOrchestratedStep is never set, routeTextOverride is never passed).
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

const AGENT_ID = 'step-content-agent';
const BASE_PROMPT = 'パープレキシティで最新のAIニュースを集めて、ローカルLLMで要約して、通知して';
const COLLECT_STEP = '最新のAIニュースを集めて';
const SUMMARIZE_STEP = 'ローカルLLMで要約して';
const COLLECTED_NEWS_PREVIEW =
  'OpenAI、Google DeepMind、Anthropicなど主要企業が2026年8月に最新のAI研究成果を発表した。';

const notifyAgent: Agent = {
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
  action: { type: 'notify' },
  orchestration: { steps: [COLLECT_STEP, SUMMARIZE_STEP] },
};

interface CapturedStep {
  systemPromptJson: string;
  /** Just the run-agent-*.sh heredoc body — excludes the separately-written
   *  plan-agent-*.json PlanSpec, which for a per-step attempt is single-step
   *  shaped (orchestration cleared, steps.length < 2) and, per
   *  MaterializeRunOpts.skipSkillPlanRehydration's doc comment, is never
   *  actually consumed for an attended run (the native launcher only routes
   *  through the PlanSpec executor when steps.list >= 2) — it independently
   *  recomputes detectRouteSignals/action on the SAME composite prompt and
   *  would otherwise make this test see stale, irrelevant content. */
  shScriptBody: string;
  rawCommand: string;
}

function extractLine(cmd: string, prefix: string): string {
  // Lines inside the heredoc body are indented (tabs/spaces) — match on the
  // trimmed line, not a literal start-of-line prefix.
  const line = cmd.split('\n').find((l) => l.trim().startsWith(prefix));
  if (!line) return '';
  const trimmed = line.trim();
  // shellQuote()'d: prefix='...' — strip the prefix + surrounding quotes.
  return trimmed.slice(prefix.length + 1, -1).replace(/'\\''/g, "'");
}

/** Extract just the run-agent-*.sh heredoc body from a materialize command
 *  (bounded by <<'SHELLY_AGENT_<id>' ... SHELLY_AGENT_<id> markers), so
 *  assertions about the .sh script's own content are never polluted by the
 *  separately-written plan-agent-*.json sitting elsewhere in the same batched
 *  command string. */
function extractShScriptBody(cmd: string): string {
  const startMarker = cmd.match(/<<'(SHELLY_AGENT_[A-Za-z0-9_]+)'/);
  if (!startMarker) return cmd;
  const marker = startMarker[1];
  const startIdx = cmd.indexOf(`<<'${marker}'`) + `<<'${marker}'`.length;
  const endIdx = cmd.indexOf(`\n${marker}`, startIdx);
  return endIdx === -1 ? cmd.slice(startIdx) : cmd.slice(startIdx, endIdx);
}

function makeRunCommand(captured: CapturedStep[], agentId: string = AGENT_ID) {
  const logs: Array<Record<string, unknown>> = [];
  return jest.fn(async (cmd: string) => {
    if (cmd.includes(`# run-agent-${agentId}`)) {
      const shScriptBody = extractShScriptBody(cmd);
      const systemPromptJson = extractLine(shScriptBody, 'SYSTEM_PROMPT_JSON=');
      captured.push({ systemPromptJson, shScriptBody, rawCommand: cmd });
      logs.push({
        agentId,
        timestamp: Date.now() + logs.length,
        status: 'success',
        durationMs: 5,
        toolUsed: extractLine(shScriptBody, 'TOOL_LABEL=') || 'unknown',
        outputPreview: logs.length === 0 ? COLLECTED_NEWS_PREVIEW : 'summary text',
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
    return '';
  });
}

describe('orchestration step content generation — the final step is driven by ITS OWN instruction, not the agent action / composite prompt', () => {
  beforeEach(() => {
    mockTerminalEmulator.cancelAgent.mockClear();
    mockTerminalEmulator.execCommand.mockClear();
    mockTerminalEmulator.runAgent.mockClear();
    mockTerminalEmulator.execCommand.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    mockTerminalEmulator.runAgent.mockResolvedValue(undefined);
    useAgentStore.getState().setAgents([]);
    useAgentStore.getState().setRunHistory({});
  });

  it("(A) the final step's system prompt is NOT notify's brevity instruction", async () => {
    useAgentStore.getState().setAgents([notifyAgent]);
    const captured: CapturedStep[] = [];
    const runCommand = makeRunCommand(captured);

    await runAgentNow(AGENT_ID, runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    expect(captured.length).toBeGreaterThanOrEqual(2);
    // Pre-fix: this contained "keep it to a few words or one sentence" and
    // fought the step's real "要約して" instruction.
    expect(captured[1].systemPromptJson).not.toContain('few words');
    expect(captured[1].systemPromptJson).not.toContain('one sentence');
    // Post-fix: generic 'draft'-style content-generation guidance instead.
    expect(captured[1].systemPromptJson).toContain('Write the requested document or content directly');
  });

  it("(B) the final step's prompt is NOT force-shaped into a research-collection bullet-list-of-links contract", async () => {
    useAgentStore.getState().setAgents([notifyAgent]);
    const captured: CapturedStep[] = [];
    const runCommand = makeRunCommand(captured);

    await runAgentNow(AGENT_ID, runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    expect(captured.length).toBeGreaterThanOrEqual(2);
    // Pre-fix: needsWeb tripped true on the composite (step 0's carried news
    // text), injecting this contract and overriding "要約して" with a rigid
    // "- [title](url) — summary" shape — which is exactly the shallow output
    // observed on-device.
    expect(captured[1].shScriptBody).not.toContain('research-collection agent');
    expect(captured[1].shScriptBody).not.toContain('Return ONLY a Markdown bullet list');
  });

  it('regression: step 0 (genuinely web-mandatory by its OWN instruction) still gets the collection contract', async () => {
    useAgentStore.getState().setAgents([notifyAgent]);
    const captured: CapturedStep[] = [];
    const runCommand = makeRunCommand(captured);

    await runAgentNow(AGENT_ID, runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    expect(captured.length).toBeGreaterThanOrEqual(2);
    expect(captured[0].shScriptBody).toContain('research-collection agent');
  });

  it('regression: a genuinely single-shot (non-orchestrated) notify agent is unaffected — still gets the brevity system prompt', async () => {
    const singleShotAgent: Agent = {
      ...notifyAgent,
      id: 'single-shot-notify-agent',
      prompt: '今日の天気を教えて',
      orchestration: undefined,
    };
    useAgentStore.getState().setAgents([singleShotAgent]);
    const captured: CapturedStep[] = [];
    const runCommand = makeRunCommand(captured, 'single-shot-notify-agent');

    await runAgentNow('single-shot-notify-agent', runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    expect(captured.length).toBeGreaterThanOrEqual(1);
    expect(captured[0].systemPromptJson).toContain('few words');
  });
});
