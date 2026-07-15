/**
 * Regression test for the 2026-07-15 P1 audit finding: lib/agent-pipeline-
 * presets.ts's enforceCharLimit() (the G6 "re-summarize within N chars for an
 * X post" guarantee) had NO production caller anywhere in the foreground JS
 * orchestration path — only scripts/shelly-plan-executor.js's own
 * enforcePlanCharLimit/resolveCharLimit reimplementation enforced it. A
 * multi-step chain's orchestration.charLimit field was carried in the config
 * but never actually clamped the final step's dispatched content.
 *
 * The fix:
 *  - lib/agent-executor.ts's generateRunScript() reads agent.orchestration
 *    .charLimit, clamps it (clampCharLimit), and embeds it as RESULT_CHAR_
 *    LIMIT in the generated script; a new enforce_char_limit_text() shell
 *    function (mirroring enforceCharLimit's algorithm) clamps $RESULT_FILE
 *    before clean_result_preview/dispatch_agent_action ever run.
 *  - lib/agent-manager.ts's runAgentOrchestrated() carries charLimit onto
 *    the FINAL step's stepAgent only (non-final steps must keep full text
 *    for the next step's context).
 *
 * Follows this repo's 2026-07-15 convention: extract the REAL emitted
 * enforce_char_limit_text() text and execute it via a real bash+node child
 * process, cross-checked against the JS reference implementation
 * (enforceCharLimit) it's supposed to mirror exactly — not a hand-typed
 * assumption of what either one produces.
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

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateRunScript } from '@/lib/agent-executor';
import { enforceCharLimit, clampCharLimit } from '@/lib/agent-pipeline-presets';
import { runAgentNow } from '@/lib/agent-manager';
import { useAgentStore } from '@/store/agent-store';
import { Agent, ToolChoice } from '@/store/types';

function agent(tool: ToolChoice, orchestration?: Agent['orchestration']): Agent {
  return {
    id: 'cl',
    name: 'CL',
    description: '',
    prompt: 'summarize this',
    schedule: null,
    tool,
    orchestration,
    outputPath: '~/out',
    outputTemplate: null,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 0,
    version: 1,
  };
}

function extractFunction(script: string, fnName: string): string {
  const marker = `${fnName}() {`;
  const fnStart = script.indexOf(marker);
  if (fnStart === -1) throw new Error(`${fnName} not found in generated script`);
  const lines = script.slice(fnStart).split('\n');
  let heredocTerm: string | null = null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (heredocTerm !== null) {
      if (line === heredocTerm) heredocTerm = null;
      continue;
    }
    // No trailing $ anchor: a heredoc-start line may have trailing content
    // after the terminator word (e.g. `<<'NODEEOF' 2>/dev/null`).
    const heredocMatch = line.match(/<<-?\s*'?"?([A-Z_]+)'?"?/);
    if (heredocMatch) {
      heredocTerm = heredocMatch[1];
      continue;
    }
    if (line === '}') {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error(`closing brace for ${fnName} not found`);
  return lines.slice(0, end + 1).join('\n');
}

const nodeBin = process.execPath.replace(/\\/g, '/');

function runEnforceCharLimitText(fnText: string, content: string, limit: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-charlimit-'));
  const file = path.join(dir, 'result.md');
  const scriptPath = path.join(dir, 'run.sh');
  fs.writeFileSync(file, content, 'utf8');
  const wrapper = `node_usable() { return 0; }
shelly_node() { "${nodeBin}" "$@"; }
${fnText}
enforce_char_limit_text ${JSON.stringify(file)} ${limit}
`;
  fs.writeFileSync(scriptPath, wrapper, 'utf8');
  try {
    return execFileSync('bash', [scriptPath], { stdio: 'pipe' }).toString('utf8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('generateRunScript — RESULT_CHAR_LIMIT wiring (2026-07-15 P1 audit fix)', () => {
  it('no orchestration.charLimit configured -> RESULT_CHAR_LIMIT=0 (no-op)', () => {
    const s = generateRunScript(agent({ type: 'local' }));
    expect(s).toContain('RESULT_CHAR_LIMIT=0');
  });

  it('a configured charLimit within range is embedded as-is', () => {
    const s = generateRunScript(agent({ type: 'local' }, { steps: [], charLimit: 280 }));
    expect(s).toContain('RESULT_CHAR_LIMIT=280');
  });

  it('below the floor is clamped up to 40 (clampCharLimit parity)', () => {
    const s = generateRunScript(agent({ type: 'local' }, { steps: [], charLimit: 5 }));
    expect(s).toContain(`RESULT_CHAR_LIMIT=${clampCharLimit(5)}`);
    expect(s).toContain('RESULT_CHAR_LIMIT=40');
  });

  it('above the ceiling is clamped down to 4000 (clampCharLimit parity)', () => {
    const s = generateRunScript(agent({ type: 'local' }, { steps: [], charLimit: 99999 }));
    expect(s).toContain(`RESULT_CHAR_LIMIT=${clampCharLimit(99999)}`);
    expect(s).toContain('RESULT_CHAR_LIMIT=4000');
  });

  it('enforce_char_limit_text runs BEFORE result_preview / dispatch_agent_action in the success branch', () => {
    // 2026-07-15 P1 audit fix, adapted for the Codex-driver-answer routing
    // landed by 8dfc370b4 (Codex driver surfaces real answer text): the raw
    // RESULT_FILE is no longer what gets previewed/dispatched — RESULT_CONTENT_
    // FILE is (either $RESULT_FILE.answer for a codex-driver step, or
    // $RESULT_FILE itself for every other tool, per its initialization in the
    // generated script). The char-limit clamp therefore also operates on
    // RESULT_CONTENT_FILE, so a Codex-routed step's real answer text is what
    // gets truncated, not the untouched telemetry stream.
    const s = generateRunScript(agent({ type: 'local' }, { steps: [], charLimit: 280 }));
    const enforceIdx = s.indexOf('enforce_char_limit_text "$RESULT_CONTENT_FILE" "$RESULT_CHAR_LIMIT"');
    const previewIdx = s.indexOf('PREVIEW=$(result_preview "$RESULT_FILE")');
    const dispatchIdx = s.indexOf('dispatch_agent_action "$RESULT_CONTENT_FILE" "$PREVIEW"');
    expect(enforceIdx).toBeGreaterThan(-1);
    expect(previewIdx).toBeGreaterThan(-1);
    expect(dispatchIdx).toBeGreaterThan(-1);
    expect(enforceIdx).toBeLessThan(previewIdx);
    expect(previewIdx).toBeLessThan(dispatchIdx);
  });
});

describe('enforce_char_limit_text — real execution, cross-checked against enforceCharLimit (regression)', () => {
  const script = generateRunScript(agent({ type: 'local' }));
  const fnText = extractFunction(script, 'enforce_char_limit_text');

  it('limit=0 is a no-op (passes text through unchanged)', () => {
    const text = 'hello world';
    expect(runEnforceCharLimitText(fnText, text, 0)).toBe(text);
  });

  it('text already under the limit is unchanged', () => {
    const text = 'STEAM教育×AIの最新動向まとめ。';
    expect(runEnforceCharLimitText(fnText, text, 280)).toBe(text);
    expect(runEnforceCharLimitText(fnText, text, 280)).toBe(enforceCharLimit(text, 280));
  });

  it.each([
    ['JA sentence-boundary cut', '最新のAI技術に関する論文が複数発表された。研究チームは新しいモデルを提案し、既存手法を大きく上回る性能を達成したと報告している。今後さらなる応用が期待される分野である。', 60],
    ['EN sentence-boundary cut', 'A new paper on AI was published today. Researchers proposed a novel model that outperforms existing methods by a wide margin. Further applications are expected in this area soon.', 80],
    ['no terminator -> ellipsis fallback', 'x'.repeat(500), 100],
    ['floor limit (40)', 'あ'.repeat(500), 40],
    ['ceiling limit (4000) with long text', 'y'.repeat(5000), 4000],
    // limit stays >= 40 (clampCharLimit's own floor) in every case here so the
    // shell function (which trusts its caller to have already clamped, per
    // its own doc comment — generateRunScript always does) and the JS
    // reference (which self-clamps) are compared on equal footing; the
    // clamping behavior ITSELF is already covered by the generateRunScript
    // describe block above.
    ['mixed JA/EN with emoji-adjacent punctuation', 'STEAM教育×AIの最新動向まとめ！論文3件、ニュース2件を要約しました。詳細はリンク先を参照してください。', 50],
  ])('%s: shell output === JS reference output, and both stay within budget', (_label, text, limit) => {
    const shellOut = runEnforceCharLimitText(fnText, text, limit);
    const jsOut = enforceCharLimit(text, limit);
    expect(shellOut).toBe(jsOut);
    expect(Array.from(shellOut).length).toBeLessThanOrEqual(limit);
  });
});

describe('runAgentOrchestrated — charLimit only carried onto the FINAL step (agent-manager, end-to-end)', () => {
  const AGENT_ID = 'chain-charlimit';

  interface Captured {
    resultCharLimit: string;
  }

  function captureFromMaterializeCommand(cmd: string): Captured {
    const lines = cmd.split('\n');
    const line = lines.find((l) => l.startsWith('RESULT_CHAR_LIMIT='));
    return { resultCharLimit: line ? line.slice('RESULT_CHAR_LIMIT='.length) : '<missing>' };
  }

  function makeRunCommand(captured: Captured[]) {
    const logs: Array<Record<string, unknown>> = [];
    return jest.fn(async (cmd: string) => {
      if (cmd.includes(`# run-agent-${AGENT_ID}`)) {
        const step = captureFromMaterializeCommand(cmd);
        captured.push(step);
        logs.push({
          agentId: AGENT_ID,
          timestamp: Date.now() + logs.length,
          status: 'success',
          durationMs: 5,
          toolUsed: 'Local LLM',
          outputPreview: `ok step ${logs.length + 1}`,
        });
        return '';
      }
      if (cmd.includes('CEREBRAS_API_KEY')) return '';
      if (cmd.includes('---SHELLY_AGENT_LOG---')) {
        return logs.map((l) => `${JSON.stringify(l)}\n---SHELLY_AGENT_LOG---\n`).join('');
      }
      return '';
    });
  }

  beforeEach(() => {
    mockTerminalEmulator.cancelAgent.mockClear();
    mockTerminalEmulator.execCommand.mockClear();
    mockTerminalEmulator.runAgent.mockClear();
    mockTerminalEmulator.execCommand.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    mockTerminalEmulator.runAgent.mockResolvedValue(undefined);
    useAgentStore.getState().setAgents([]);
    useAgentStore.getState().setRunHistory({});
  });

  it('a 3-step chain with charLimit=100 only embeds RESULT_CHAR_LIMIT=100 on the LAST step', async () => {
    const chainAgent: Agent = {
      id: AGENT_ID,
      name: AGENT_ID,
      description: '',
      prompt: '',
      schedule: null,
      tool: { type: 'local' },
      orchestration: {
        steps: [
          'collect the latest news with sources',
          'summarize the collected news',
          'write a short two sentence conclusion',
        ],
        charLimit: 100,
      },
      outputPath: '~/out',
      outputTemplate: null,
      enabled: true,
      lastRun: null,
      lastResult: null,
      createdAt: 0,
      version: 1,
    };
    useAgentStore.getState().setAgents([chainAgent]);
    const captured: Captured[] = [];
    const runCommand = makeRunCommand(captured);

    await runAgentNow(AGENT_ID, runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    expect(captured.length).toBeGreaterThanOrEqual(3);
    expect(captured[0].resultCharLimit).toBe('0');
    expect(captured[1].resultCharLimit).toBe('0');
    expect(captured[2].resultCharLimit).toBe('100');
  });

  it('a single-run (non-chain) agent with orchestration.charLimit set directly still gets it (no orchestration stripping to worry about)', async () => {
    const singleAgent: Agent = {
      id: AGENT_ID,
      name: AGENT_ID,
      description: '',
      prompt: 'write something',
      schedule: null,
      tool: { type: 'local' },
      orchestration: { steps: [], charLimit: 200 },
      outputPath: '~/out',
      outputTemplate: null,
      enabled: true,
      lastRun: null,
      lastResult: null,
      createdAt: 0,
      version: 1,
    };
    const s = generateRunScript(singleAgent);
    expect(s).toContain('RESULT_CHAR_LIMIT=200');
  });
});
