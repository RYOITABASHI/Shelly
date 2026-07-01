jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { buildAgentPlanSpec, PLAN_SPEC_KIND, PLAN_SPEC_SCHEMA_VERSION, validateAgentPlanSpec } from '@/lib/agent-plan-spec';
import type { Agent } from '@/store/types';

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-plan-test',
    name: 'Plan Test',
    description: 'plan',
    prompt: 'say hello',
    schedule: null,
    tool: { type: 'local' },
    autonomous: true,
    autonomyLevel: 'L1',
    workspaceRoot: '/tmp/work',
    outputPath: '~/agent-output',
    outputTemplate: null,
    action: { type: 'draft' },
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 1,
    version: 1,
    ...overrides,
  };
}

describe('Agent PlanSpec v1', () => {
  it('builds a versioned sidecar without raw API secret fields', () => {
    const spec = buildAgentPlanSpec(agent({ autonomous: false, tool: { type: 'perplexity', model: 'sonar' } }));

    expect(spec.kind).toBe(PLAN_SPEC_KIND);
    expect(spec.schemaVersion).toBe(PLAN_SPEC_SCHEMA_VERSION);
    expect(spec.tool).toMatchObject({ type: 'perplexity', authRef: 'perplexity' });
    expect(spec.policy.level).toBe('L1');
    expect(spec.output.suggestedRoots).toEqual(expect.arrayContaining([expect.stringContaining('/agent-output')]));

    const serialized = JSON.stringify(spec);
    expect(serialized).not.toContain('PERPLEXITY_API_KEY');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('Bearer ');
  });

  it('marks unsupported tools and actions fail-closed in the plan', () => {
    const spec = buildAgentPlanSpec(agent({
      tool: { type: 'cli', cli: 'codex' },
      action: { type: 'cli', command: 'rm -rf /' },
    }));

    expect(spec.tool.type).toBe('unsupported');
    expect(spec.tool.unsupportedReason).toContain('does not support cli tools yet');
    expect(spec.action.type).toBe('unsupported');
    expect(spec.action.unsupportedReason).toContain('does not support cli actions yet');
  });

  it('validates schema version and agent id', () => {
    const spec = buildAgentPlanSpec(agent());
    expect(validateAgentPlanSpec(spec).ok).toBe(true);
    expect(validateAgentPlanSpec({ ...spec, schemaVersion: 99 }).ok).toBe(false);
    expect(validateAgentPlanSpec({ ...spec, agent: { ...spec.agent, id: '../../bad' } }).ok).toBe(false);
  });
});
