/**
 * Fan-out subtasks (parallel groups, 2026-08-13 — Hermes sub-agent gap
 * increment 1): pure-core tests for the grouping rules. See
 * AgentOrchestrationStep.parallelGroup's doc comment in store/types.ts for
 * the user-facing contract; planParallelGroups (lib/agent-orchestration.ts)
 * is the SINGLE place the rules live, consumed by both executors and the UI.
 * The scripts/shelly-plan-executor.js port is parity-tested against these
 * same behaviors in __tests__/plan-executor-orchestration-chain.test.ts.
 */
import {
  MAX_PARALLEL_BRANCHES,
  normalizeStep,
  normalizeSteps,
  planParallelGroups,
  type NormalizedStep,
} from '@/lib/agent-orchestration';
import type { AgentApiCallConfig, AgentOrchestrationConfig } from '@/store/types';

describe('normalizeStep — parallelGroup carriage + sanitization', () => {
  it('carries a valid group id through', () => {
    expect(normalizeStep({ instruction: 'research A', parallelGroup: 'g1' })).toEqual({
      instruction: 'research A',
      parallelGroup: 'g1',
    });
  });
  it('trims surrounding whitespace on the id', () => {
    expect(normalizeStep({ instruction: 'x', parallelGroup: ' g1 ' }).parallelGroup).toBe('g1');
  });
  it('drops an invalid id (bad charset / too long) — fail-safe to serial, never an error', () => {
    expect(normalizeStep({ instruction: 'x', parallelGroup: 'has spaces' }).parallelGroup).toBeUndefined();
    expect(normalizeStep({ instruction: 'x', parallelGroup: 'ドラフト' }).parallelGroup).toBeUndefined();
    expect(normalizeStep({ instruction: 'x', parallelGroup: 'a'.repeat(33) }).parallelGroup).toBeUndefined();
    expect(normalizeStep({ instruction: 'x', parallelGroup: '' }).parallelGroup).toBeUndefined();
  });
  it('coexists with a tool pin and with an apiCall step', () => {
    const pinned = normalizeStep({ instruction: 'x', tool: { type: 'local' }, parallelGroup: 'g' });
    expect(pinned.tool).toEqual({ type: 'local' });
    expect(pinned.parallelGroup).toBe('g');
    const api = normalizeStep({
      instruction: 'call it',
      apiCall: { host: 'api.groq.com', method: 'POST', path: '/x', authRef: 'groq' } as AgentApiCallConfig,
      parallelGroup: 'g',
    });
    expect(api.apiCall).toBeDefined();
    expect(api.parallelGroup).toBe('g');
  });
  it('a plain string step never carries a group (legacy shape byte-identical)', () => {
    expect(normalizeStep('plain')).toEqual({ instruction: 'plain' });
  });
});

describe('planParallelGroups — the single place the grouping rules live', () => {
  const s = (instruction: string, parallelGroup?: string): NormalizedStep =>
    parallelGroup ? { instruction, parallelGroup } : { instruction };

  it('all-serial steps: contextBase[i] === i, no groups (existing behavior untouched)', () => {
    const plan = planParallelGroups([s('a'), s('b'), s('c')]);
    expect(plan.contextBase).toEqual([0, 1, 2]);
    expect(plan.group).toEqual([undefined, undefined, undefined]);
  });

  it('two consecutive marked steps before a final step form a group sharing the pre-group context', () => {
    const plan = planParallelGroups([s('collect'), s('research A', 'g'), s('research B', 'g'), s('aggregate')]);
    expect(plan.group).toEqual([undefined, 'g', 'g', undefined]);
    // Branches see only the results BEFORE the group (index 1 = the group
    // start); the post-group aggregate sees everything (its own index).
    expect(plan.contextBase).toEqual([0, 1, 1, 3]);
  });

  it('a singleton marker stays serial (>= 2 members required)', () => {
    const plan = planParallelGroups([s('a', 'g'), s('b'), s('c')]);
    expect(plan.group).toEqual([undefined, undefined, undefined]);
    expect(plan.contextBase).toEqual([0, 1, 2]);
  });

  it('the FINAL step never groups — severed, and the remaining run still groups when >= 2 survive', () => {
    const plan = planParallelGroups([s('a', 'g'), s('b', 'g'), s('final', 'g')]);
    expect(plan.group).toEqual(['g', 'g', undefined]);
    expect(plan.contextBase).toEqual([0, 0, 2]);
  });

  it('the FINAL step severing can collapse a would-be pair back to serial', () => {
    const plan = planParallelGroups([s('a'), s('b', 'g'), s('final', 'g')]);
    expect(plan.group).toEqual([undefined, undefined, undefined]);
    expect(plan.contextBase).toEqual([0, 1, 2]);
  });

  it('members beyond MAX_PARALLEL_BRANCHES are severed to serial (deterministic cap, never an error)', () => {
    const steps = [s('b1', 'g'), s('b2', 'g'), s('b3', 'g'), s('b4', 'g'), s('b5', 'g'), s('final')];
    const plan = planParallelGroups(steps);
    expect(MAX_PARALLEL_BRANCHES).toBe(3);
    expect(plan.group).toEqual(['g', 'g', 'g', undefined, undefined, undefined]);
    // Severed members run serially AFTER the group, seeing the branch results.
    expect(plan.contextBase).toEqual([0, 0, 0, 3, 4, 5]);
  });

  it('two adjacent DIFFERENT group ids form two independent groups', () => {
    const steps = [s('a1', 'g1'), s('a2', 'g1'), s('b1', 'g2'), s('b2', 'g2'), s('final')];
    const plan = planParallelGroups(steps);
    expect(plan.group).toEqual(['g1', 'g1', 'g2', 'g2', undefined]);
    // g2's branches see g1's aggregated results (their group starts at 2).
    expect(plan.contextBase).toEqual([0, 0, 2, 2, 4]);
  });

  it('NON-consecutive same-id markers do not merge across an unmarked step', () => {
    const steps = [s('a', 'g'), s('mid'), s('b', 'g'), s('final')];
    const plan = planParallelGroups(steps);
    // Each marked run is a singleton -> serial.
    expect(plan.group).toEqual([undefined, undefined, undefined, undefined]);
    expect(plan.contextBase).toEqual([0, 1, 2, 3]);
  });

  it('normalizeSteps -> planParallelGroups end-to-end from an AgentOrchestrationConfig', () => {
    const config: AgentOrchestrationConfig = {
      steps: [
        'collect the topic list',
        { instruction: 'research source A', parallelGroup: 'research' },
        { instruction: 'research source B', parallelGroup: 'research' },
        { instruction: 'summarize everything into one digest' },
      ],
    };
    const steps = normalizeSteps(config);
    const plan = planParallelGroups(steps);
    expect(plan.group).toEqual([undefined, 'research', 'research', undefined]);
    expect(plan.contextBase).toEqual([0, 1, 1, 3]);
  });

  it('empty input is a no-op', () => {
    expect(planParallelGroups([])).toEqual({ contextBase: [], group: [] });
  });
});
