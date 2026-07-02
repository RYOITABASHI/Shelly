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
    expect(terminalSessionService).toContain('val intervalMs = intent.getLongExtra(EXTRA_INTERVAL_MS, 0L)');
    expect(terminalSessionService).toContain('val unattended = intervalMs > 0 || !cron.isNullOrBlank()');
    expect(terminalSessionService).toContain('runAgentInBackground(agentId, unattended)');
    expect(terminalSessionService).toContain('AgentRuntime.runAgent(applicationContext, agentId, unattended)');
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
    // broker/executor: it corrupts node's OpenSSL config read on device.
    expect(agentRuntime).not.toContain('LD_PRELOAD');
    expect(executorSrc).toContain('delete env.LD_PRELOAD');
  });

  it('honors the STOP-ALL kill-switch in both the native gate and the executor', () => {
    const executorSrc = fs.readFileSync(scriptCopy, 'utf8');
    expect(agentRuntime).toContain('.shelly/agents/.halted');
    expect(executorSrc).toContain('paths.haltSentinel');
    expect(executorSrc).toContain("haltSentinel: path.join(agentsDir, '.halted')");
  });
});
