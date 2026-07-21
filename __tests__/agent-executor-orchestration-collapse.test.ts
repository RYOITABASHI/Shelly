jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateRunScript } from '@/lib/agent-executor';
import { Agent, AgentOrchestrationConfig, ToolChoice } from '@/store/types';

/** bash -n the script via a temp FILE (a full script exceeds the Windows argv limit for `-c`). */
function bashParses(script: string): void {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-collapse-parse-')), 'run.sh');
  fs.writeFileSync(file, script);
  execFileSync('bash', ['-n', file]);
}

const baseAgent = (tool: ToolChoice, orchestration?: AgentOrchestrationConfig, autonomous?: boolean): Agent => ({
  id: 't',
  name: 'T',
  description: '',
  prompt: 'collect news, summarize it, and post to X',
  schedule: null,
  tool,
  autonomous,
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
  orchestration,
});

// bug #155(b) (docs/superpowers/DEFERRED.md): generateRunScript originally had
// no concept of agent.orchestration.steps at all — a real multi-step
// orchestrated agent whose tool is unsupported by the PlanSpec chain executor
// (e.g. autonomous `auto` -> codex CLI) fell back to this legacy script on
// every scheduled/native fire and silently ran only agent.prompt, with steps
// 2..N never running and no signal anywhere that they were skipped. A
// 2026-07-16 pass added ORCHESTRATION_COLLAPSED_NOTE as a visibility-only fix
// (silent collapse -> a note in the run log). A same-day follow-up
// (__tests__/agent-executor-chain-execution.test.ts) then added a REAL
// bash-side chain executor for the exact case this note used to warn about
// (an orchestrated agent resolved to the codex driver, every step plain) — so
// for THAT case the note no longer fires at all (the chain actually runs).
// This file now covers the RESIDUAL cases codexOrchestrationChainCommand
// deliberately does not attempt: a step carrying its own tool pin, a step
// carrying a structured apiCall, and a non-cli/non-PlanSpec-supported tool
// pin (e.g. an orchestrated agent explicitly pinned to 'local') — those still
// collapse to a single step, with the note.
describe('generateRunScript — orchestration-collapse note (bug #155(b), residual cases)', () => {
  const orchestratedCodexPlain = baseAgent(
    { type: 'auto' },
    { steps: ['collect the latest news with sources', 'summarize the findings', 'post a digest to X'] },
    true,
  );

  const orchestratedCodexWithToolPin = baseAgent(
    { type: 'auto' },
    {
      steps: [
        'collect the latest news with sources',
        { instruction: 'summarize using the local model', tool: { type: 'local' } },
        'post a digest to X',
      ],
    },
    true,
  );

  const orchestratedCodexWithApiCall = baseAgent(
    { type: 'auto' },
    {
      steps: [
        {
          instruction: 'call the Perplexity API',
          apiCall: { host: 'api.perplexity.ai', method: 'POST', path: '/chat/completions', authRef: 'perplexity' },
        },
        'post a digest to X',
      ],
    },
    true,
  );

  it('a plain (no tool-pin/apiCall) codex-resolved chain now runs for REAL — no collapse note', () => {
    // This is the exact scenario the note used to fire for; the real chain
    // executor (agent-executor-chain-execution.test.ts) now handles it.
    const s = generateRunScript(orchestratedCodexPlain);
    expect(s).toContain("ORCHESTRATION_COLLAPSED_NOTE=''");
    expect(s).not.toContain('[Shelly] Note: this agent is configured as a');
  });

  it('bakes a non-empty ORCHESTRATION_COLLAPSED_NOTE when a step carries its own tool pin (residual, unsupported by the chain loop)', () => {
    const s = generateRunScript(orchestratedCodexWithToolPin);
    expect(s).toMatch(/ORCHESTRATION_COLLAPSED_NOTE='\[Shelly\] Note: this agent is configured as a 3-step chain/);
    expect(s).toContain('cannot run the full chain unattended');
    bashParses(s);
  });

  it('bakes a non-empty ORCHESTRATION_COLLAPSED_NOTE when a step carries a structured apiCall (residual, unsupported by the chain loop)', () => {
    const s = generateRunScript(orchestratedCodexWithApiCall);
    expect(s).toMatch(/ORCHESTRATION_COLLAPSED_NOTE='\[Shelly\] Note: this agent is configured as a 2-step chain/);
    bashParses(s);
  });

  it('leaves the note EMPTY for a non-orchestrated agent (no behavior change)', () => {
    const s = generateRunScript(baseAgent({ type: 'local' }, undefined, false));
    expect(s).toContain("ORCHESTRATION_COLLAPSED_NOTE=''");
    expect(s).not.toContain('[Shelly] Note: this agent is configured as a');
  });

  it('leaves the note EMPTY for a single-step "chain" (isOrchestrated requires >= 2)', () => {
    const s = generateRunScript(baseAgent({ type: 'local' }, { steps: ['just one step'] }, false));
    expect(s).toContain("ORCHESTRATION_COLLAPSED_NOTE=''");
  });

  it('leaves the note EMPTY for an orchestration-STRIPPED per-step materialization (mirrors runAgentOrchestrated\'s stepAgent, which clears steps to avoid recursing)', () => {
    // lib/agent-manager.ts's runAgentOrchestrated builds each step's stepAgent with
    // orchestration EITHER undefined OR { steps: [], charLimit } (isOrchestrated is
    // false either way) — this must NOT trip the collapse note, since THAT call path
    // already correctly runs the full chain via the JS-side per-step loop.
    const s = generateRunScript(baseAgent({ type: 'local' }, { steps: [], charLimit: 200 }, false), { suppressAction: true });
    expect(s).toContain("ORCHESTRATION_COLLAPSED_NOTE=''");
  });

  it('a non-cli resolved tool (e.g. an explicit local pin) still shows the note for an orchestrated agent — the chain loop only supports the resolved-to-codex case', () => {
    const s = generateRunScript(baseAgent({ type: 'local' }, { steps: ['step one', 'step two'] }, false));
    expect(s).toMatch(/ORCHESTRATION_COLLAPSED_NOTE='\[Shelly\] Note: this agent is configured as a 2-step chain/);
  });

  it('injects the note into PREVIEW/ERROR_MESSAGE strictly AFTER dispatch_agent_action and write_native_notification_request already ran', () => {
    const s = generateRunScript(orchestratedCodexWithToolPin);
    const dispatchIdx = s.indexOf('if ! dispatch_agent_action "$RESULT_CONTENT_FILE" "$PREVIEW"');
    const failureNotifyIdx = s.indexOf('write_native_notification_request "$STATUS" "$PREVIEW" || true');
    const noteInjectIdx = s.indexOf('if [ -n "$ORCHESTRATION_COLLAPSED_NOTE" ]; then');
    const logWriteIdx = s.indexOf('# Log run result');
    expect(dispatchIdx).toBeGreaterThan(-1);
    expect(failureNotifyIdx).toBeGreaterThan(-1);
    expect(noteInjectIdx).toBeGreaterThan(-1);
    expect(logWriteIdx).toBeGreaterThan(-1);
    // The note injection is the LAST thing that touches PREVIEW/ERROR_MESSAGE
    // before the run-log JSON write — strictly after both the success dispatch
    // call and the failure-branch notification.
    expect(noteInjectIdx).toBeGreaterThan(dispatchIdx);
    expect(noteInjectIdx).toBeGreaterThan(failureNotifyIdx);
    expect(noteInjectIdx).toBeLessThan(logWriteIdx);
  });

  it('never reaches resolve_app_act_params\'s {{result}} substitution (the live external-post risk)', () => {
    // app-act is "the first agent action type that reaches a real
    // external-posting surface" (see the code comment at its ACTION_APP_ACT_PARAMS_JSON
    // definition) — resolve_app_act_params substitutes {{result}} using the exact
    // $preview value dispatch_agent_action was called with. Because the note is
    // injected only after dispatch_agent_action returns (previous test), the
    // function-call SITE that passes "$preview" into resolve_app_act_params must
    // textually precede the note injection — i.e. it always sees the clean value.
    const s = generateRunScript({
      ...orchestratedCodexWithToolPin,
      action: { type: 'app-act', appActRecipeId: 'x-post', appActParams: { text: '{{result}}' } },
    } as Agent);
    const resolveCallIdx = s.indexOf('resolve_app_act_params "$ACTION_APP_ACT_PARAMS_JSON" "$preview"');
    const noteInjectIdx = s.indexOf('if [ -n "$ORCHESTRATION_COLLAPSED_NOTE" ]; then');
    expect(resolveCallIdx).toBeGreaterThan(-1);
    expect(noteInjectIdx).toBeGreaterThan(-1);
    expect(resolveCallIdx).toBeLessThan(noteInjectIdx);
    bashParses(s);
  });

  it('bumps the script version in lockstep with the native gate (v21)', () => {
    const s = generateRunScript(orchestratedCodexWithToolPin);
    expect(s).toContain('SHELLY_AGENT_SCRIPT_VERSION=21');
  });

  it('reflects the resolved tool label in the note (autonomous auto -> codex, tool-pinned step residual case)', () => {
    const s = generateRunScript(orchestratedCodexWithToolPin);
    expect(s).toMatch(/ORCHESTRATION_COLLAPSED_NOTE='\[Shelly\] Note:.*tool "[^"]*[Cc]odex[^"]*" cannot run the full chain/);
  });
});
