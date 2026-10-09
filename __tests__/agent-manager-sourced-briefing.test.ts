/**
 * Sourced briefings (2026-10-09), ATTENDED chain (lib/agent-manager.ts
 * runAgentOrchestratedBody) — the counterpart of
 * __tests__/plan-executor-sourced-briefing.test.ts for the unattended
 * executor. Reproduces the on-device incident chain (Perplexity research →
 * local summarize → markdown briefing draft) and checks:
 *  - sources survive every step, prompts carry the directive / contract;
 *  - the final step generates with its action SUPPRESSED, the text is
 *    post-processed, and a model-free DISPATCH run performs the agent's real
 *    action with the verified text (so the saved file, the completion
 *    notification and the run log all carry the processed briefing);
 *  - no sourced step saves unverified text to the draft destination;
 *  - summarize/write steps never run on the exec-capable Codex driver;
 *  - zero sources / processing failure fail closed.
 *
 * Harness copied from __tests__/agent-manager-orchestrated-saved-path.test.ts.
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

import { applySourcing, runAgentNow } from '@/lib/agent-manager';
import {
  NO_SOURCES_MESSAGE,
  RESEARCH_REQUIREMENTS_MARKER,
  SOURCED_OUTPUT_UNVERIFIABLE_MESSAGE,
  SOURCING_CONTRACT_MARKER,
  absorbResearchStep,
  createChainEvidence,
  extractSourcesFromText,
} from '@/lib/agent-sources';
import { useAgentStore } from '@/store/agent-store';
import { useAIPaneStore } from '@/store/ai-pane-store';
import type { Agent, AgentRunLog, ToolChoice } from '@/store/types';
import { DEMO_UTTERANCE } from './fixtures/sourced-briefing';

const AGENT_ID = 'sourced-briefing-agent';
const SAVED = '/home/shelly-test/agent-output/2026-10-09/2026-10-09_briefing.md';

const makeAgent = (tool: ToolChoice = { type: 'local' }, action: Agent['action'] = { type: 'draft' }): Agent => ({
  id: AGENT_ID,
  name: 'Briefing',
  description: '',
  prompt: DEMO_UTTERANCE,
  schedule: null,
  tool,
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
  action,
  orchestration: {
    steps: [
      { instruction: 'search the web with Perplexity for the top 3 on-device AI news stories.', tool: { type: 'perplexity', model: 'sonar-deep-research' } },
      'summarize them.',
      'write a markdown briefing.',
    ],
  },
});

// What extract_ai_content leaves in RESULT_FILE for a Perplexity step: the
// content followed by the "## Sources" block (citations order).
const RESEARCH_FULL = [
  '1. **Google releases Gemma 3n for on-device AI** (2026-09-30) — Google released Gemma 3n, a mobile-first open model that runs on phones with 2GB of RAM. [1]',
  '2. **Apple expands Foundation Models framework** (2026-09-15) — Apple opened its on-device Foundation Models framework to developers in iOS 26. [2]',
  '3. **Qualcomm unveils Snapdragon 8 Elite Gen 5 NPU** (2026-09-24) — Qualcomm announced a faster Hexagon NPU for on-device generative AI. [3]',
  '',
  '## Sources',
  '[1] Announcing Gemma 3n — https://blog.google/technology/developers/gemma-3n/ (2026-09-30)',
  '[2] Apple Foundation Models framework — https://www.apple.com/newsroom/2026/09/foundation-models/',
  '[3] Snapdragon 8 Elite Gen 5 — https://www.qualcomm.com/news/releases/2026/09/snapdragon-8-elite-gen-5',
].join('\n');

const FINAL_FABRICATED = [
  '# On-device AI Briefing',
  '',
  "1. **Apple Unveils 'Apple Neural LLM' on iPhone 17** — Apple launched a neural LLM. [1]",
  '2. **Google releases Gemma 3n for on-device AI** — Runs on phones with 2GB of RAM. [1]',
  '3. **Qualcomm Launches Snapdragon AI Engine 3.0** — Faster AI engine.',
].join('\n');

/** Each `# run-agent-` materialize is one script run: research, summarize,
 *  final (suppressed), then the dispatch run. `fullTexts[i]` is what the i-th
 *  run left in its step-result copy. */
function makeRunCommand(allCommands: string[], fullTexts: string[], opts: { failDispatch?: boolean } = {}) {
  const logs: Array<Record<string, unknown>> = [];
  let stepRuns = 0;
  return jest.fn(async (cmd: string) => {
    allCommands.push(cmd);
    if (cmd.includes(`# run-agent-${AGENT_ID}`) && cmd.includes('RESULT_FILE=')) {
      const isDispatch = cmd.includes('SHELLY_PRESET_RESULT_EOF');
      if (isDispatch && opts.failDispatch) throw new Error('dispatch exploded');
      logs.push({
        agentId: AGENT_ID,
        timestamp: Date.now() + logs.length,
        status: 'success',
        durationMs: 5,
        toolUsed: 'x',
        outputPreview: isDispatch ? '保存: agent-output/briefing.md processed' : (fullTexts[stepRuns] ?? '').replace(/\s+/g, ' ').slice(0, 120),
        ...(isDispatch ? { savedPath: SAVED } : {}),
      });
      stepRuns += 1;
      return '';
    }
    if (cmd.includes('agent-step-result-') && cmd.startsWith('cat ')) {
      return stepRuns > 0 ? fullTexts[stepRuns - 1] ?? '' : '';
    }
    if (cmd.includes('CEREBRAS_API_KEY')) {
      return ['CEREBRAS_API_KEY=0', 'GROQ_API_KEY=0', 'PERPLEXITY_API_KEY=1', 'GEMINI_API_KEY=1', 'SHELLY_AUTONOMOUS_CLOUD=0', 'SHELLY_AUTONOMOUS_CLOUD_STOP=0'].join('\n');
    }
    if (cmd.includes('---SHELLY_AGENT_LOG---')) {
      return logs.map((l) => `${JSON.stringify(l)}\n---SHELLY_AGENT_LOG---\n`).join('');
    }
    return '';
  });
}

function runScripts(allCommands: string[]): string[] {
  return allCommands.filter((c) => c.includes(`# run-agent-${AGENT_ID}`) && c.includes('RESULT_FILE=') && !c.includes('ORCHESTRATION_COLLAPSED_NOTE=\'\'\nCODEX_ORCH'));
}

function findAggregate(allCommands: string[]): AgentRunLog {
  const cmd = allCommands.find((c) => c.includes('"steps":[') && c.includes(`/logs/${AGENT_ID}/`));
  expect(cmd).toBeDefined();
  const line = cmd!.split('\n').find((l) => l.startsWith('{') && l.includes('"steps":['));
  return JSON.parse(line!) as AgentRunLog;
}

describe('attended chain — sourced briefing', () => {
  beforeEach(() => {
    mockTerminalEmulator.execCommand.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    mockTerminalEmulator.runAgent.mockResolvedValue(undefined);
    useAgentStore.getState().setAgents([makeAgent()]);
    useAgentStore.getState().setRunHistory({});
    useAIPaneStore.setState({ conversations: {}, isLoaded: true });
  });

  it('carries sources across steps, post-processes BEFORE dispatch, dispatches the verified text', async () => {
    const allCommands: string[] = [];
    const uncitedSummary = 'On-device AI had a big month with lots of exciting launches across the industry.';
    await runAgentNow(AGENT_ID, makeRunCommand(allCommands, [RESEARCH_FULL, uncitedSummary, FINAL_FABRICATED, '']), {
      waitTimeoutMs: 2000,
      pollMs: 1,
    });

    const scripts = runScripts(allCommands).filter((c) => c.includes('agent-step-result-$AGENT_ID') || c.includes('SHELLY_PRESET_RESULT_EOF'));
    expect(scripts.length).toBe(4);
    const [research, summarize, finalModel, dispatch] = scripts;
    // Step 1: research directive + sonar-pro (not deep research) behind the
    // user's PERPLEXITY_MODEL override + recency filter; per-run step-result
    // copy (nonce); no intermediate draft save.
    expect(research).toContain(RESEARCH_REQUIREMENTS_MARKER);
    expect(research).toContain('MODEL="${PERPLEXITY_MODEL:-sonar-pro}"');
    expect(research).toContain('\\"search_recency_filter\\":\\"month\\"');
    expect(research).toMatch(/clean_result_full "\$RESULT_FILE" "\$TMP_DIR\/agent-step-result-\$AGENT_ID-[a-z0-9]+\.md"/);
    expect(research).toContain('SKIP_SUPPRESSED_DRAFT_SAVE=1');
    // Step 2: fenced numbered sources + contract + text-only local sampling.
    expect(summarize).toContain('[1] Announcing Gemma 3n — https://blog.google/technology/developers/gemma-3n/');
    expect(summarize).toContain('BEGIN UNTRUSTED SOURCE DATA');
    expect(summarize).toContain(SOURCING_CONTRACT_MARKER);
    expect(summarize).toContain('\\"max_tokens\\":1024,\\"temperature\\":0.2,');
    expect(summarize).toContain('SHELLY_SOURCED_FALLBACK_EOF');
    // Step 3 (final) generates with its action suppressed; the uncited step-2
    // essay was replaced by the research template before being carried.
    expect(finalModel).toContain("ACTION_TYPE='__suppressed__'");
    expect(finalModel).toContain('SKIP_SUPPRESSED_DRAFT_SAVE=1');
    expect(finalModel).not.toContain('big month');
    expect(finalModel).toContain('Google releases Gemma 3n for on-device AI');
    // Dispatch run: no model call, the agent's real action, verified text.
    expect(dispatch).toContain("ACTION_TYPE='draft'");
    const preset = dispatch.split("<<'SHELLY_PRESET_RESULT_EOF'")[1].split('\nSHELLY_PRESET_RESULT_EOF')[0];
    expect(preset).not.toMatch(/Neural LLM/);
    expect(preset).not.toMatch(/AI Engine 3\.0/);
    expect(preset).toContain('1. **Google releases Gemma 3n for on-device AI** — Runs on phones with 2GB of RAM. [1]');
    expect(preset).toContain('## Sources');
    expect(preset).toContain('- [1] [Announcing Gemma 3n](https://blog.google/technology/developers/gemma-3n/) — 2026-09-30');
    // No post-hoc rewrite of the saved file is needed any more.
    expect(allCommands.some((c) => c.includes(`cat > '${SAVED}.`))).toBe(false);

    const aggregate = findAggregate(allCommands);
    expect(aggregate.status).toBe('success');
    expect(aggregate.savedPath).toBe(SAVED);
    expect(aggregate.steps).toHaveLength(3);
    expect(aggregate.steps![2].outputPreview).toBe('保存: agent-output/briefing.md processed');
  });

  it('dispatches the agent\'s REAL action (notify) — every channel gets the processed text', async () => {
    useAgentStore.getState().setAgents([makeAgent({ type: 'local' }, { type: 'notify' })]);
    const allCommands: string[] = [];
    await runAgentNow(AGENT_ID, makeRunCommand(allCommands, [RESEARCH_FULL, 'x [1] Google releases Gemma 3n', FINAL_FABRICATED, '']), {
      waitTimeoutMs: 2000,
      pollMs: 1,
    });
    const dispatch = allCommands.find((c) => c.includes('SHELLY_PRESET_RESULT_EOF') && c.includes(`# run-agent-${AGENT_ID}`));
    expect(dispatch).toBeDefined();
    expect(dispatch).toContain("ACTION_TYPE='notify'");
    expect(dispatch).not.toMatch(/Neural LLM/);
  });

  it('summarize/write steps never run on the Codex driver, even for a codex-tool agent', async () => {
    useAgentStore.getState().setAgents([makeAgent({ type: 'cli', cli: 'codex' })]);
    const allCommands: string[] = [];
    await runAgentNow(AGENT_ID, makeRunCommand(allCommands, [RESEARCH_FULL, 'x', FINAL_FABRICATED, '']), { waitTimeoutMs: 2000, pollMs: 1 });
    const scripts = runScripts(allCommands).filter((c) => c.includes('agent-step-result-$AGENT_ID') || c.includes('SHELLY_PRESET_RESULT_EOF'));
    expect(scripts.length).toBe(4);
    for (const s of scripts.slice(1)) {
      expect(s).not.toContain('--approval-policy untrusted');
    }
  });

  it('stops with a clear "no sources" failure when the research step found nothing citable', async () => {
    const allCommands: string[] = [];
    await runAgentNow(
      AGENT_ID,
      makeRunCommand(allCommands, ['1. **Apple Neural LLM** — Apple did a thing.', 'unused', 'unused', 'unused']),
      { waitTimeoutMs: 2000, pollMs: 1 },
    );
    const aggregate = findAggregate(allCommands);
    expect(aggregate.status).toBe('error');
    expect(aggregate.steps![1].outputPreview).toBe(NO_SOURCES_MESSAGE);
    expect(aggregate.savedPath).toBeUndefined();
    expect(allCommands.some((c) => c.includes('SHELLY_PRESET_RESULT_EOF'))).toBe(false);
  });

  it('fails closed when post-processing / dispatch throws — error step, no savedPath', async () => {
    const allCommands: string[] = [];
    await runAgentNow(AGENT_ID, makeRunCommand(allCommands, [RESEARCH_FULL, 'x', FINAL_FABRICATED, ''], { failDispatch: true }), {
      waitTimeoutMs: 2000,
      pollMs: 1,
    });
    const aggregate = findAggregate(allCommands);
    expect(aggregate.status).toBe('error');
    expect(aggregate.steps![2].outputPreview).toContain(SOURCED_OUTPUT_UNVERIFIABLE_MESSAGE);
    expect(aggregate.savedPath).toBeUndefined();
  });

  it('local (non-web) chains with recency words are untouched (review H2)', async () => {
    const agent = makeAgent();
    agent.prompt = 'Collect the latest git commits, then summarize them, then write a changelog.';
    agent.orchestration = { steps: ['Collect the latest git commits in my repo.', 'summarize them.', 'write a changelog.'] };
    useAgentStore.getState().setAgents([agent]);
    const allCommands: string[] = [];
    await runAgentNow(AGENT_ID, makeRunCommand(allCommands, ['abc123 fix bug', 'summary', 'changelog', '']), { waitTimeoutMs: 2000, pollMs: 1 });
    const scripts = runScripts(allCommands);
    expect(scripts.some((s) => s.includes(RESEARCH_REQUIREMENTS_MARKER))).toBe(false);
    expect(scripts.some((s) => s.includes('SHELLY_PRESET_RESULT_EOF'))).toBe(false);
    expect(findAggregate(allCommands).status).toBe('success');
  });
});

describe('applySourcing (unit)', () => {
  it('throws (caller fails closed) when the dispatch run rejects', async () => {
    const evidence = createChainEvidence();
    absorbResearchStep(evidence, RESEARCH_FULL, extractSourcesFromText(RESEARCH_FULL));
    await expect(
      applySourcing({
        runCommand: async () => FINAL_FABRICATED,
        agentId: AGENT_ID,
        evidence,
        research: false,
        synthesis: true,
        deferFinalAction: true,
        preview: '',
        today: '2026-10-09',
        dispatch: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
  });
});
