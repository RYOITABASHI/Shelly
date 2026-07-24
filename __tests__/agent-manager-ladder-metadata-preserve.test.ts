/**
 * DEFERRED.md エージェント二重実行レース — "副産物として見つかった実在する
 * データ消失リスク" follow-up (2026-07-21 finding, fixed here).
 *
 * runLadderAttempts (lib/agent-manager.ts) materializes each escalation-ladder
 * candidate once per attempt via materializeAgent(attemptAgent, ...). For an
 * ORCHESTRATION STEP, `attemptAgent` is derived from a `stepAgent` whose
 * caller (runAgentOrchestratedBody) has ALREADY cleared `.orchestration` to
 * undefined and pinned `.tool` to one candidate before runLadderAttempts ever
 * sees it. Before this fix, materializeAgentBody unconditionally wrote
 * `JSON.stringify(metadataAgent, ...)` — derived from that SAME attempt-
 * shaped agent — to the agent's PERSISTENT `<id>.json` metadata file, the
 * exact file loadAgentsFromDisk re-reads on every app launch. That means the
 * real, saved multi-step orchestration recipe was overwritten on disk with a
 * transient single-step snapshot for the duration of every single ladder
 * attempt — if the app process were killed at exactly that moment, the real
 * orchestration config would be permanently lost.
 *
 * The fix: MaterializeRunOpts gained an opt-in `skipMetadataWrite` flag, set
 * ONLY by runLadderAttempts's per-attempt materialize call, which makes
 * materializeAgentBody skip the `<id>.json` write entirely for that call
 * (the run script + PlanSpec files — which DO need the attempt's pinned
 * shape — are still written as before). The persistent metadata is left
 * exactly as the last OUTER (non-attempt-scoped) materialize call wrote it —
 * install time, or the post-chain "restore" materialize that already runs
 * once the whole orchestration chain completes.
 *
 * This test proves the fix end-to-end via runAgentNow → runAgentOrchestrated:
 * for a 2-step orchestrated agent, NOT ONE of the per-step ladder-attempt
 * materialize calls may touch `<id>.json`, and the single metadata write that
 * DOES happen (the post-chain restore) must carry the ORIGINAL orchestration
 * steps, not an attempt's cleared/pinned shape.
 *
 * Mocking follows the exact pattern already established in
 * __tests__/agent-manager-step-tool-pin.test.ts (same home-path / native
 * bridge mocks, same "capture the materialize command, synthesize a success
 * run log for it" trick to keep the ladder from escalating past one attempt
 * per step).
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

const AGENT_ID = 'chain-agent-metadata';
const METADATA_PATH = `/home/shelly-test/.shelly/agents/${AGENT_ID}.json`;
const SCRIPT_PATH = `/home/shelly-test/.shelly/agents/run-agent-${AGENT_ID}.sh`;

const baseAgent: Agent = {
  id: AGENT_ID,
  name: AGENT_ID,
  description: '',
  prompt: '',
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

/** Each writeFileCommand() call in lib/agent-manager.ts emits a heredoc block
 * shaped like:
 *   mkdir -p "$(dirname '<path>')" && cat > '<path>.<marker>.tmp' <<'<marker>'
 *   <content>
 *   <marker>
 * A single materialize call batches several of these (metadata + script +
 * plan spec) into ONE runCommand() invocation via commands.join('\n'), so
 * this extracts every block in a command, keyed by its target path — letting
 * the test tell a metadata write apart from a script/plan-spec write even
 * when they arrive in the same call. */
function extractWriteFileBlocks(cmd: string): Array<{ path: string; content: string }> {
  const blocks: Array<{ path: string; content: string }> = [];
  // The heredoc opener line continues past `<<'<marker>'` with the
  // `&& { [ ! -x ... ] || chmod +x ...; } && mv -f ... ...` chain before its
  // own newline — match anything (non-newline) up to that newline rather
  // than assuming the marker's closing quote is immediately followed by \n.
  const re = /mkdir -p "\$\(dirname '([^']+)'\)" && cat > '[^']+' <<'([^']+)'[^\n]*\n([\s\S]*?)\n\2/g;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(cmd))) {
    blocks.push({ path: m[1], content: m[3] });
  }
  return blocks;
}

interface MetadataWrite {
  cmd: string;
  agent: Agent;
}

/** Mocked runCommand driving runAgentOrchestrated end to end (same shape as
 * agent-manager-step-tool-pin.test.ts's makeRunCommand): answers the ladderEnv
 * probe with "no free-cloud keys", records every metadata (`<id>.json`) write
 * it sees, and — the instant a STEP's run script is (re)materialized —
 * immediately "commits" a successful run-log entry for it so the escalation
 * ladder does not climb past the first candidate for that step. */
function makeRunCommand(metadataWrites: MetadataWrite[], scriptMaterializeCount: { count: number }) {
  const logs: Array<Record<string, unknown>> = [];
  return jest.fn(async (cmd: string) => {
    const blocks = extractWriteFileBlocks(cmd);
    const metadataBlock = blocks.find((b) => b.path === METADATA_PATH);
    const scriptBlock = blocks.find((b) => b.path === SCRIPT_PATH);

    if (metadataBlock) {
      metadataWrites.push({ cmd, agent: JSON.parse(metadataBlock.content) as Agent });
    }
    if (scriptBlock) {
      scriptMaterializeCount.count += 1;
      logs.push({
        agentId: AGENT_ID,
        timestamp: Date.now() + logs.length,
        status: 'success',
        durationMs: 5,
        toolUsed: 'Local LLM',
        outputPreview: 'ok',
      });
      return '';
    }
    if (cmd.includes('CEREBRAS_API_KEY')) return ''; // ladderEnv: no free-cloud keys, no consent
    if (cmd.includes('---SHELLY_AGENT_LOG---')) {
      return logs.map((l) => `${JSON.stringify(l)}\n---SHELLY_AGENT_LOG---\n`).join('');
    }
    return ''; // chain-lock acquire/release/disarm, listAgentLogFiles, aggregate write, misc
  });
}

describe('runLadderAttempts per-attempt materialize — persistent metadata preservation', () => {
  beforeEach(() => {
    mockTerminalEmulator.cancelAgent.mockClear();
    mockTerminalEmulator.execCommand.mockClear();
    mockTerminalEmulator.runAgent.mockClear();
    mockTerminalEmulator.execCommand.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    mockTerminalEmulator.runAgent.mockResolvedValue(undefined);
    useAgentStore.getState().setAgents([]);
    useAgentStore.getState().setRunHistory({});
  });

  it('never overwrites <id>.json with a step-attempt shape, and the one write that DOES happen carries the original orchestration', async () => {
    const agent: Agent = {
      ...baseAgent,
      orchestration: {
        steps: [
          'first step instruction',
          'second step instruction',
        ],
      },
    };
    useAgentStore.getState().setAgents([agent]);

    const metadataWrites: MetadataWrite[] = [];
    const scriptMaterializeCount = { count: 0 };
    const runCommand = makeRunCommand(metadataWrites, scriptMaterializeCount);

    await runAgentNow(AGENT_ID, runCommand, { waitTimeoutMs: 2000, pollMs: 1 });

    // Sanity: the chain actually ran both steps (each step materializes its
    // run script at least once) — otherwise the "zero metadata writes during
    // the loop" assertion below would be vacuously true.
    expect(scriptMaterializeCount.count).toBeGreaterThanOrEqual(2);

    // The core regression proof: across the ENTIRE orchestrated run (both
    // steps' ladder attempts), <id>.json is written back to disk exactly
    // ONCE — the post-chain restore materialize that runs after the loop,
    // using the untouched original `agent` object. Every per-step ladder
    // attempt (scriptMaterializeCount of them) must NOT have touched it.
    expect(metadataWrites).toHaveLength(1);

    // And that single write must reflect the REAL, saved config — not an
    // attempt's orchestration-cleared, tool-pinned shape. Before the fix,
    // this exact assertion would have failed on every attempt PRIOR to the
    // final restore (metadataWrites would have contained N entries, each
    // with orchestration undefined/tool pinned to one ladder candidate).
    const persisted = metadataWrites[0].agent;
    expect(persisted.orchestration).toBeTruthy();
    expect(persisted.orchestration?.steps).toHaveLength(2);
    expect(persisted.tool).toEqual({ type: 'auto' });
  });
});
