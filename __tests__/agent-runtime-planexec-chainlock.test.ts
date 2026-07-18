import * as fs from 'fs';
import * as path from 'path';

// docs/superpowers/DEFERRED.md "エージェント二重実行レース" (2026-07-18
// follow-up): found via on-device testing of the chain-lock fix itself. The
// chain-scoped lock (lib/agent-manager.ts's acquireChainLock/releaseChainLock,
// ${locksDir}/${agentId}.chain.lock — lib/agent-executor.ts::getChainLockDir
// is the single source of truth) is checked by the LEGACY .sh script's own
// generated bash (AGENT_SCRIPT_VERSION 20's CHAIN_LOCK_DIR check). But an
// orchestrated agent whose tool IS supported by the PlanSpec executor — the
// common case since North Star P0(c) — never reaches that legacy .sh on its
// native/unattended fire, so it was unprotected against colliding with an
// attended chain (Sidebar RUN NOW / @agent chat) still in flight for the same
// agent. Confirmed on-device: agent-mrode1ec's attended RUN NOW and its own
// native */5 alarm fired within seconds of each other with zero mutual
// awareness. This is a pure Kotlin-content assertion test (no NDK/Gradle in
// this environment to compile/run the native code) — same convention as
// __tests__/local-llm-ensure-parity.test.ts.
describe('AgentRuntime.kt::runPlanAgent — chain-lock check', () => {
  const root = path.resolve(__dirname, '..');
  const agentRuntime = fs.readFileSync(
    path.join(
      root,
      'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/AgentRuntime.kt',
    ),
    'utf8',
  );

  it('checks the same chain-lock directory path lib/agent-executor.ts::getChainLockDir computes', () => {
    expect(agentRuntime).toContain('.shelly/agents/locks/$agentId.chain.lock');
  });

  it('skips (does not launch the executor) when the chain-lock directory exists', () => {
    expect(agentRuntime).toContain('if (chainLockDir.isDirectory) {');
    const chainLockIdx = agentRuntime.indexOf('if (chainLockDir.isDirectory) {');
    const nodeLaunchIdx = agentRuntime.indexOf('/system/bin/linker64 ');
    expect(chainLockIdx).toBeGreaterThan(-1);
    expect(nodeLaunchIdx).toBeGreaterThan(-1);
    // The chain-lock check must be textually BEFORE the node/executor launch,
    // so a live attended chain's lock is always consulted before this native
    // path could otherwise start a colliding run.
    expect(chainLockIdx).toBeLessThan(nodeLaunchIdx);
  });

  it('writes a "skipped" receiver log on chain-lock collision, matching the existing halt-switch precedent in this same function', () => {
    // Both the pre-existing global-halt-switch guard and this new chain-lock
    // guard, in the same function, share this exact call shape.
    const occurrences = agentRuntime.split('writeReceiverLog(homeDir, agentId, "skipped", message)').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(agentRuntime).toContain('return AgentRunResult(agentId, 130, "", message)');
  });

  it('the chain-lock check runs after all existing plan validation guards (kill-switch, version, agent-id, action-type, assets) and before the local-LLM autostart preflight', () => {
    const haltIdx = agentRuntime.indexOf('.shelly/agents/.halted');
    const trustedLaunchIdx = agentRuntime.indexOf('val trustedLaunch = trustedPlanLaunch(homeDir, agentId)');
    const chainLockIdx = agentRuntime.indexOf('val chainLockDir = File(homeDir,');
    const localLlmPreflightIdx = agentRuntime.indexOf('readPlanSpecToolType(plan) == "local"');
    expect(haltIdx).toBeGreaterThan(-1);
    expect(trustedLaunchIdx).toBeGreaterThan(-1);
    expect(chainLockIdx).toBeGreaterThan(-1);
    expect(localLlmPreflightIdx).toBeGreaterThan(-1);
    expect(chainLockIdx).toBeGreaterThan(haltIdx);
    expect(chainLockIdx).toBeGreaterThan(trustedLaunchIdx);
    expect(chainLockIdx).toBeLessThan(localLlmPreflightIdx);
  });
});
