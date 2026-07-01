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

  it('does not trust plan.agent.autonomous to skip action approval', () => {
    const executorSrc = fs.readFileSync(scriptCopy, 'utf8');
    expect(executorSrc).toContain('requestActionApproval(paths, plan, actionType, preview, paths.resultFile, config)');
    expect(executorSrc).not.toContain('if (!plan.agent.autonomous) requestActionApproval');
  });
});
