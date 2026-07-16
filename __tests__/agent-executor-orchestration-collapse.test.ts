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

// bug #155(b) (docs/superpowers/DEFERRED.md): generateRunScript had no concept
// of agent.orchestration.steps at all — a real multi-step orchestrated agent
// whose tool is unsupported by the PlanSpec chain executor (e.g. autonomous
// `auto` -> codex CLI) falls back to this legacy script on every scheduled/
// native fire and silently ran only agent.prompt, with steps 2..N never
// running and no signal anywhere that they were skipped. Fix: keep today's
// single-step execution UNCHANGED (no capability regression — a full bash-side
// chain executor was considered and deferred, see the DEFERRED.md writeup),
// but stop the SILENT part by surfacing a clear note wherever a human sees
// this run's outcome, without ever touching content that can reach a live
// external post.
describe('generateRunScript — orchestration-collapse note (bug #155(b))', () => {
  const orchestratedCodex = baseAgent(
    { type: 'auto' },
    { steps: ['collect the latest news with sources', 'summarize the findings', 'post a digest to X'] },
    true,
  );

  it('bakes a non-empty ORCHESTRATION_COLLAPSED_NOTE for a real (>=2 step) orchestrated agent', () => {
    const s = generateRunScript(orchestratedCodex);
    expect(s).toMatch(/ORCHESTRATION_COLLAPSED_NOTE='\[Shelly\] Note: this agent is configured as a 3-step chain/);
    expect(s).toContain('cannot run the full chain unattended');
    expect(s).toContain('Run this agent manually from the app for the complete chain');
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

  it('does not change the actual executed prompt (agent.prompt only, unchanged) — no capability regression vs. before the fix', () => {
    const s = generateRunScript(orchestratedCodex);
    // The escaped/executed prompt is still the base agent.prompt (possibly with
    // the pre-existing needsWeb collection-contract prefix — unrelated to this
    // fix) — this fix only changes VISIBILITY, not what runs. The chain's
    // individual step instructions ("summarize the findings", "post a digest to
    // X") must NOT appear baked into the executed prompt (that would mean a real
    // chain executor was built, which this fix deliberately does not attempt —
    // see DEFERRED.md bug #155).
    expect(s).toContain("collect news, summarize it, and post to X");
    expect(s).not.toContain("summarize the findings");
    expect(s).not.toContain("post a digest to X");
  });

  it('injects the note into PREVIEW/ERROR_MESSAGE strictly AFTER dispatch_agent_action and write_native_notification_request already ran', () => {
    const s = generateRunScript(orchestratedCodex);
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
    const s = generateRunScript({ ...orchestratedCodex, action: { type: 'app-act', appActRecipeId: 'x-post', appActParams: { text: '{{result}}' } } } as Agent);
    const resolveCallIdx = s.indexOf('resolve_app_act_params "$ACTION_APP_ACT_PARAMS_JSON" "$preview"');
    const noteInjectIdx = s.indexOf('if [ -n "$ORCHESTRATION_COLLAPSED_NOTE" ]; then');
    expect(resolveCallIdx).toBeGreaterThan(-1);
    expect(noteInjectIdx).toBeGreaterThan(-1);
    expect(resolveCallIdx).toBeLessThan(noteInjectIdx);
    bashParses(s);
  });

  it('bumps the script version in lockstep with the native gate (v13)', () => {
    const s = generateRunScript(orchestratedCodex);
    expect(s).toContain('SHELLY_AGENT_SCRIPT_VERSION=14');
  });

  it('reflects the resolved tool label in the note (autonomous auto -> codex)', () => {
    const s = generateRunScript(orchestratedCodex);
    expect(s).toMatch(/ORCHESTRATION_COLLAPSED_NOTE='\[Shelly\] Note:.*tool "[^"]*[Cc]odex[^"]*" cannot run the full chain/);
  });
});
