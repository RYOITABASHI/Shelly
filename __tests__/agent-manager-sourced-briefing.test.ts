/**
 * Sourced briefings (2026-10-09), ATTENDED chain (lib/agent-manager.ts
 * runAgentOrchestratedBody) — the counterpart of
 * __tests__/plan-executor-sourced-briefing.test.ts for the unattended
 * executor. Reproduces the on-device incident chain (Perplexity research →
 * local summarize → markdown briefing draft) and checks that sources survive
 * every step, the prompts carry the contract, and the saved draft is
 * rewritten with only sourced items + a programmatic Sources section.
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

import { runAgentNow } from '@/lib/agent-manager';
import { NO_SOURCES_MESSAGE, RESEARCH_REQUIREMENTS_MARKER, SOURCING_CONTRACT_MARKER } from '@/lib/agent-sources';
import { useAgentStore } from '@/store/agent-store';
import { useAIPaneStore } from '@/store/ai-pane-store';
import type { Agent, AgentRunLog } from '@/store/types';
import { DEMO_UTTERANCE } from './fixtures/sourced-briefing';

const AGENT_ID = 'sourced-briefing-agent';
const SAVED = '/home/shelly-test/agent-output/2026-10-09/2026-10-09_briefing.md';

const makeAgent = (): Agent => ({
  id: AGENT_ID,
  name: 'Briefing',
  description: '',
  prompt: DEMO_UTTERANCE,
  schedule: null,
  tool: { type: 'local' },
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
  action: { type: 'draft' },
  orchestration: {
    steps: [
      { instruction: 'search the web with Perplexity for the top 3 on-device AI news stories.', tool: { type: 'perplexity', model: 'sonar-deep-research' } },
      { instruction: 'summarize them with the local LLM.', tool: { type: 'local' } },
      'write a markdown briefing.',
    ],
  },
});

// What extract_ai_content leaves in RESULT_FILE for a Perplexity step: the
// content followed by the "## Sources" block built from search_results.
const RESEARCH_FULL = [
  '1. **Google releases Gemma 3n for on-device AI** (2026-09-30) — Google released Gemma 3n, a mobile-first open model that runs on phones with 2GB of RAM. [1]',
  '2. **Apple expands Foundation Models framework** (2026-09-15) — Apple opened its on-device Foundation Models framework to developers in iOS 26. [2]',
  '3. **Qualcomm unveils Snapdragon 8 Elite Gen 5 NPU** (2026-09-24) — Qualcomm announced a faster Hexagon NPU for on-device generative AI. [3]',
  '',
  '## Sources',
  '[1] Announcing Gemma 3n — https://blog.google/technology/developers/gemma-3n/',
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

function makeRunCommand(allCommands: string[], fullTexts: string[]) {
  const logs: Array<Record<string, unknown>> = [];
  let stepRuns = 0;
  return jest.fn(async (cmd: string) => {
    allCommands.push(cmd);
    if (cmd.includes(`# run-agent-${AGENT_ID}`)) {
      const isFinal = stepRuns === fullTexts.length - 1;
      logs.push({
        agentId: AGENT_ID,
        timestamp: Date.now() + logs.length,
        status: 'success',
        durationMs: 5,
        toolUsed: 'x',
        // The run log only ever carries a short preview — the sources block
        // at the END of the research text never fits.
        outputPreview: fullTexts[stepRuns].replace(/\s+/g, ' ').slice(0, 120),
        ...(isFinal ? { savedPath: SAVED } : {}),
      });
      stepRuns += 1;
      return '';
    }
    if (cmd.includes('agent-step-result-') && cmd.startsWith('cat ')) {
      return stepRuns > 0 ? fullTexts[stepRuns - 1] : '';
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

function stepScripts(allCommands: string[]): string[] {
  return allCommands.filter((c) => c.includes(`# run-agent-${AGENT_ID}`) && c.includes('agent-step-result-$AGENT_ID'));
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

  it('carries sources across 3 steps and rewrites the saved draft with only sourced items', async () => {
    const allCommands: string[] = [];
    const uncitedSummary = 'On-device AI had a big month with lots of exciting launches across the industry.';
    await runAgentNow(AGENT_ID, makeRunCommand(allCommands, [RESEARCH_FULL, uncitedSummary, FINAL_FABRICATED]), {
      waitTimeoutMs: 2000,
      pollMs: 1,
    });

    const scripts = stepScripts(allCommands);
    expect(scripts.length).toBeGreaterThanOrEqual(3);
    // Step 1: research directive + sonar-pro (not deep research) + recency filter.
    expect(scripts[0]).toContain(RESEARCH_REQUIREMENTS_MARKER);
    expect(scripts[0]).toContain("MODEL='sonar-pro'");
    expect(scripts[0]).toContain('\\"search_recency_filter\\":\\"month\\"');
    // Every orchestrated step keeps its full result for the TS side.
    expect(scripts[0]).toContain('clean_result_full "$RESULT_FILE" "$TMP_DIR/agent-step-result-$AGENT_ID.md"');
    // Step 2: numbered sources + contract + cooler local sampling.
    expect(scripts[1]).toContain('[1] Announcing Gemma 3n — https://blog.google/technology/developers/gemma-3n/');
    expect(scripts[1]).toContain(SOURCING_CONTRACT_MARKER);
    expect(scripts[1]).toContain('\\"max_tokens\\":1024,\\"temperature\\":0.2,');
    // Step 3: the uncited summary was replaced by the research-item template.
    expect(scripts[2]).not.toContain('big month');
    expect(scripts[2]).toContain('Google releases Gemma 3n for on-device AI');

    const rewrite = allCommands.find((c) => c.includes(`cat > '${SAVED}.`));
    expect(rewrite).toBeDefined();
    expect(rewrite).not.toMatch(/Neural LLM/);
    expect(rewrite).not.toMatch(/AI Engine 3\.0/);
    expect(rewrite).toContain('1. **Google releases Gemma 3n for on-device AI** — Runs on phones with 2GB of RAM. [1]');
    expect(rewrite).toContain('## Sources');
    expect(rewrite).toContain('- [1] [Announcing Gemma 3n](https://blog.google/technology/developers/gemma-3n/)');

    const aggregate = findAggregate(allCommands);
    expect(aggregate.status).toBe('success');
    expect(aggregate.savedPath).toBe(SAVED);
    expect(aggregate.steps![2].outputPreview).toContain('Gemma 3n');
  });

  it('stops with a clear "no sources" failure when the research step found nothing citable', async () => {
    const allCommands: string[] = [];
    await runAgentNow(
      AGENT_ID,
      makeRunCommand(allCommands, ['1. **Apple Neural LLM** — Apple did a thing.', 'unused', 'unused']),
      { waitTimeoutMs: 2000, pollMs: 1 },
    );
    expect(stepScripts(allCommands)).toHaveLength(1);
    const aggregate = findAggregate(allCommands);
    expect(aggregate.status).toBe('error');
    expect(aggregate.steps![1].outputPreview).toBe(NO_SOURCES_MESSAGE);
    expect(aggregate.savedPath).toBeUndefined();
  });
});
