// 2026-11-01 on-device bug (build 2743): "@agent Right now, using Codex, …,
// then using Claude Code, … Run it without approval" registered the agent as
// AUTONOMOUS — detectAutonomousIntent's phrase list includes "without
// approval" / 承認なしで, so the run-without-approval opt-in also flipped the
// draft to unattended semantics ("Runs autonomously" on the confirm card). The
// autonomous ladder is local-first, so the attended Run now ran the
// Codex-pinned step 1 on the local LLM (Claude Code is honored first even
// unattended, which is why step 2 was not swapped).
import { parseAgentNL, detectAutonomousIntent } from '@/lib/agent-nl-parser';
import { resolveEscalationLadder, LadderEnv } from '@/lib/agent-escalation-ladder';
import { summarizeAgentDraftAsText } from '@/lib/agent-plan-summary';
import { Agent, AgentOrchestrationStep, ToolChoice } from '@/store/types';

const KEYED: LadderEnv = { hasCerebrasKey: true, hasGroqKey: true };
const UTTERANCE =
  'Right now, using Codex, check the git log and file list in ~/demo, then using Claude Code, summarize this project in 3 lines. Run it without approval';

const mkStepAgent = (tool: ToolChoice, autonomous: boolean | undefined, prompt: string): Agent => ({
  id: 'a',
  name: 'A',
  description: '',
  prompt,
  schedule: null,
  tool,
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
  ...(autonomous ? { autonomous: true } : {}),
});

const types = (l: { tools: ToolChoice[] }) => l.tools.map((t) => (t.type === 'cli' ? `cli:${t.cli}` : t.type));

describe('run without approval never makes the agent autonomous', () => {
  it('the reported utterance: run-without-approval ON, autonomous OFF, step pins kept', () => {
    const d = parseAgentNL(UTTERANCE);
    expect(d.runWithoutApproval).toBe(true);
    expect(d.autonomous).toBe(false);
    const steps = (d.orchestrationSteps ?? []) as AgentOrchestrationStep[];
    expect(steps.length).toBe(2);
    expect(steps[0].tool).toEqual({ type: 'cli', cli: 'codex' });
    expect(steps[1].tool).toEqual({ type: 'cli', cli: 'claude' });
  });

  it('the confirm summary does not claim "Runs autonomously"', () => {
    const text = summarizeAgentDraftAsText(parseAgentNL(UTTERANCE));
    expect(text).not.toMatch(/Runs autonomously/);
  });

  it('step 1 (Codex pin) of the parsed draft runs on Codex only — no local fallback', () => {
    const d = parseAgentNL(UTTERANCE);
    const step = ((d.orchestrationSteps ?? []) as AgentOrchestrationStep[])[0];
    const l = resolveEscalationLadder(mkStepAgent(step.tool as ToolChoice, d.autonomous, step.instruction), KEYED, step.instruction);
    expect(types(l)).toEqual(['cli:codex']);
  });

  it.each([
    'run it without approval',
    'Run this without any approvals',
    '承認なしで実行して',
    '確認なしで動かして',
  ])('"%s" alone is not autonomous intent', (phrase) => {
    expect(detectAutonomousIntent(`毎日8時にニュースを要約して。${phrase}`)).toBe(false);
  });

  it.each([
    'every day at 8am, post to X without approval',
    '承認なしでお願いします',
    '自律的に実行して、承認なしで実行して',
    'run it autonomously, run it without approval',
  ])('other autonomy phrases still count: "%s"', (text) => {
    expect(detectAutonomousIntent(text)).toBe(true);
  });
});
