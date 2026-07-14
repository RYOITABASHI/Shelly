jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import * as fs from 'fs';
import * as path from 'path';
import { PLAN_SPEC_SCHEMA_VERSION } from '@/lib/agent-plan-spec';

describe('shelly-plan-executor.js parity', () => {
  const root = path.resolve(__dirname, '..');
  const scriptCopy = path.join(root, 'scripts', 'shelly-plan-executor.js');
  const assetCopy = path.join(root, 'modules/terminal-emulator/android/src/main/assets/shelly-plan-executor.js');
  const homeInitializer = fs.readFileSync(
    path.join(root, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt'),
    'utf8',
  );
  const agentRuntime = fs.readFileSync(
    path.join(root, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/AgentRuntime.kt'),
    'utf8',
  );
  const terminalSessionService = fs.readFileSync(
    path.join(root, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/TerminalSessionService.kt'),
    'utf8',
  );

  it('scripts/ copy and the APK asset are byte-identical', () => {
    expect(fs.readFileSync(assetCopy, 'utf8')).toBe(fs.readFileSync(scriptCopy, 'utf8'));
  });

  it('extracts the plan executor asset into Shelly HOME', () => {
    expect(homeInitializer).toContain('shelly-plan-executor.js');
    expect(homeInitializer).toContain('.shelly-plan-executor.js');
  });

  it('keeps schema version lockstep across TS, JS, and native gate', () => {
    const executorSrc = fs.readFileSync(scriptCopy, 'utf8');
    expect(executorSrc).toContain(`const PLAN_SPEC_SCHEMA_VERSION = ${PLAN_SPEC_SCHEMA_VERSION}`);
    expect(agentRuntime).toContain(`private const val CURRENT_PLAN_SPEC_VERSION = ${PLAN_SPEC_SCHEMA_VERSION}`);
  });

  it('gates the canary by both flag and target agent id', () => {
    expect(agentRuntime).toContain('SHELLY_PLAN_EXECUTOR');
    expect(agentRuntime).toContain('SHELLY_PLAN_EXECUTOR_AGENT_ID');
    expect(agentRuntime).toContain('return flags["SHELLY_PLAN_EXECUTOR_AGENT_ID"] == agentId');
  });

  it('passes native trust state separately from the untrusted plan file', () => {
    const executorSrc = fs.readFileSync(scriptCopy, 'utf8');
    expect(agentRuntime).toContain('readPlanSpecAgentId(plan)');
    expect(agentRuntime).toContain('PlanSpec agent id mismatch');
    expect(agentRuntime).toContain('--agent-id');
    expect(agentRuntime).toContain('--unattended 1');
    expect(agentRuntime).toContain('--trusted-autonomous-agent-id');
    expect(agentRuntime).toContain('--trusted-autonomous-action');
    expect(agentRuntime).toContain('--trusted-tool-type');
    expect(executorSrc).toContain('trustedNativeLowRiskAction(args, plan, actionType)');
    expect(executorSrc).toContain("trustedTool === 'local' && plan.tool.type === 'local'");
    expect(executorSrc).not.toContain('if (!plan.agent.autonomous) requestActionApproval');
    expect(executorSrc).not.toContain('plan.paths && plan.paths.home');
  });

  it('derives unattended mode from scheduled service extras before launching the agent', () => {
    // PR #122 (widget one-tap run) split this into a named `scheduled` check
    // and marks a widget-triggered manual run unattended too (`scheduled ||
    // manual`), so a widget tap keeps per-action approval fail-closed exactly
    // like an AlarmManager fire, even though it carries no interval/cron.
    expect(terminalSessionService).toContain('val intervalMs = intent.getLongExtra(EXTRA_INTERVAL_MS, 0L)');
    expect(terminalSessionService).toContain('val scheduled = intervalMs > 0 || !cron.isNullOrBlank()');
    expect(terminalSessionService).toContain('val unattended = scheduled || manual');
    expect(terminalSessionService).toContain('runAgentInBackground(agentId, tainted, unattended, manual, widgetAgent?.name)');
    expect(terminalSessionService).toContain('tainted = tainted');
    expect(terminalSessionService).toContain('unattended = unattended');
  });

  it('launches the executor via linker64 node with SHELLY_LIB_DIR and the plan version gate', () => {
    // Startup contract: bionic node under the dynamic linker, lib dir exported,
    // and the schema-version gate that refuses a stale on-disk PlanSpec.
    expect(agentRuntime).toContain('/system/bin/linker64');
    expect(agentRuntime).toContain('"$libPath/node"');
    expect(agentRuntime).toContain('export SHELLY_LIB_DIR=');
    expect(agentRuntime).toContain('planVersion != CURRENT_PLAN_SPEC_VERSION');
  });

  it('never falls back to the .sh runner once the PlanSpec path is chosen', () => {
    // shouldRunPlanExecutor => `return runPlanAgent(...)`, so the flag-gated canary
    // returns its own result and can never source run-agent-<id>.sh on failure.
    expect(agentRuntime).toContain('return runPlanAgent(');
  });

  it('does not pass LD_PRELOAD to the leaf node (bionic OpenSSL crash guard)', () => {
    const executorSrc = fs.readFileSync(scriptCopy, 'utf8');
    // The exec wrapper preload is only for shell/codex exec, not the pure-node
    // broker/executor: explicitly clear it before launching bionic node.
    expect(agentRuntime).toContain('unset LD_PRELOAD && /system/bin/linker64');
    expect(agentRuntime).not.toContain('export LD_PRELOAD');
    expect(executorSrc).toContain('delete env.LD_PRELOAD');
  });

  it('resets the per-run CAP budget envelope at run start (wall-time-budget guard)', () => {
    const executorSrc = fs.readFileSync(scriptCopy, 'utf8');
    // The broker budget file is keyed per-agent and persists; without a per-run
    // reset the wall-time budget runs from the first-ever run and every later run
    // fails rc=42 "wall-time budget exhausted" (found in device-verify). Match the
    // .sh path which rm's it at run start.
    expect(executorSrc).toMatch(/fs\.rmSync\(path\.join\(paths\.tmpDir, `cap-budget-\$\{plan\.agent\.id\}\.json`\)/);
  });

  it('honors the STOP-ALL kill-switch in both the native gate and the executor', () => {
    const executorSrc = fs.readFileSync(scriptCopy, 'utf8');
    expect(agentRuntime).toContain('.shelly/agents/.halted');
    expect(executorSrc).toContain('paths.haltSentinel');
    expect(executorSrc).toContain("haltSentinel: path.join(agentsDir, '.halted')");
  });

  it('threads notification taint into the PlanSpec executor path, not just the legacy .sh path', () => {
    // Companion to notify-listener/parity.test.ts's "threads notification taint
    // into the legacy generated-agent broker path": that test only covers the
    // .sh branch of AgentRuntime.runAgent. Before this fix, runAgent's
    // shouldRunPlanExecutor branch called runPlanAgent(...) WITHOUT the
    // `tainted` value it already has in scope, so a notification-triggered
    // (tainted=true) run silently lost its taint on the PlanSpec path and
    // classifyEgress's tainted-secret-spend gate (shelly-capability-broker.js)
    // never applied once SHELLY_PLAN_EXECUTOR flips on.
    const executorSrc = fs.readFileSync(scriptCopy, 'utf8');
    expect(agentRuntime).toContain('return runPlanAgent(appContext, homeDir, libDir, bashPath, agentId, tainted, unattended)');
    expect(agentRuntime).toMatch(/private fun runPlanAgent\(\s*context: Context,\s*homeDir: File,\s*libDir: File,\s*bashPath: String,\s*agentId: String,\s*tainted: Boolean,\s*unattended: Boolean/);
    // The env-var builder exports SHELLY_CAP_TAINTED=1 right after the other
    // CAP-001 flags (SHELLY_CAP_BROKER/FS/EXEC), guarded by the same `tainted`
    // param the legacy .sh path already gates its own export on.
    expect(agentRuntime).toMatch(/export SHELLY_CAP_BROKER=1 SHELLY_CAP_FS=1 SHELLY_CAP_EXEC=1"\)\s*\n\s*if \(tainted\) \{\s*\n\s*append\(" && export SHELLY_CAP_TAINTED=1"\)\s*\n\s*\}/);
    // JS-side contract: the executor must actually read the env var and forward
    // --tainted to the broker's http.request op (shelly-capability-broker.js
    // parses `args.tainted === '1'` and feeds it into classifyEgress), mirroring
    // the legacy .sh's http_post_json which always forwards
    // "${SHELLY_CAP_TAINTED:-0}" via --tainted. Without this, exporting the env
    // var alone would be inert dead code.
    expect(executorSrc).toContain("tainted: process.env.SHELLY_CAP_TAINTED === '1'");
    expect(executorSrc).toContain("if (opts.tainted) args.push('--tainted', '1');");
  });

  it('wires app-act into the PlanSpec executor path (Phase 4), not just the legacy .sh path', () => {
    const executorSrc = fs.readFileSync(scriptCopy, 'utf8');
    // Native gate: AgentRuntime.kt must allow 'app-act' through
    // PLAN_EXECUTOR_ACTIONS or every PlanSpec-routed app-act run is refused
    // before the executor ever launches.
    expect(agentRuntime).toContain('PLAN_EXECUTOR_ACTIONS = setOf("draft", "notify", "webhook", "cli", "intent", "dm-reply", "app-act", "__suppressed__")');
    // Executor: dispatchActionTrusted must accept 'app-act' and resolve+redact
    // its params (mirrors the legacy .sh's resolve_app_act_params) before they
    // reach the approval-request preview shown to the human.
    expect(executorSrc).toContain("actionType !== 'app-act'");
    expect(executorSrc).toContain('function resolveAppActParams(params, preview)');
    expect(executorSrc).toContain("v.split('{{result}}').join(preview)");
    expect(executorSrc).toContain('appActRecipeId: extra.appActRecipeId');
    expect(executorSrc).toContain('appActParamsResolved: extra.appActParamsResolved');
    // unattendedPreflightFailure only allowlists draft/notify for unattended
    // runs, so app-act (not added there) is refused-when-unattended by
    // construction — assert that allowlist stayed narrow rather than widening
    // to accidentally include app-act.
    expect(executorSrc).toMatch(/if \(actionType !== 'draft' && actionType !== 'notify'\) \{/);
  });
});
