jest.mock('@/lib/home-path', () => ({ getHomePath: () => '/home/shelly-test' }));

// Phase 2 of the app-act rollout: schema + secret-scan coverage ONLY.
// No dispatch/execution logic exists for 'app-act' yet — see
// lib/agent-plan-spec.ts toPlanAction's default branch and
// scripts/shelly-plan-executor.js's `action.type === 'unsupported'` refusal,
// both asserted below as the inertness guarantee.

import { generateRunScript } from '@/lib/agent-executor';
import { resolveAgentRoute } from '@/lib/agent-tool-router';
import { buildAgentPlanSpec } from '@/lib/agent-plan-spec';
import type { Agent, AgentAction } from '@/store/types';

function agent(action: AgentAction, over: Partial<Agent> = {}): Agent {
  return {
    id: 'app-act-test',
    name: 'App Act Test',
    description: '',
    prompt: 'summarize the run result for posting',
    schedule: null,
    tool: { type: 'local' },
    outputPath: '~/out',
    outputTemplate: null,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 0,
    version: 1,
    action,
    ...over,
  };
}

describe('app-act action schema (Phase 2 — schema only, no dispatch)', () => {
  it('round-trips appActRecipeId and appActParams through JSON (persistence shape)', () => {
    const action: AgentAction = {
      type: 'app-act',
      appActRecipeId: 'x.post',
      appActParams: { text: '{{result}}' },
    };
    const a = agent(action);

    const serialized = JSON.stringify(a);
    const parsed = JSON.parse(serialized) as Agent;

    expect(parsed.action?.type).toBe('app-act');
    expect(parsed.action?.appActRecipeId).toBe('x.post');
    expect(parsed.action?.appActParams).toEqual({ text: '{{result}}' });
  });

  it('round-trips an explicit appActMethod, and leaves it undefined (== accessibility default) when absent', () => {
    const apiAction: AgentAction = {
      type: 'app-act',
      appActRecipeId: 'x.post',
      appActParams: { text: '{{result}}' },
      appActMethod: 'api',
    };
    const parsedApi = JSON.parse(JSON.stringify(agent(apiAction))) as Agent;
    expect(parsedApi.action?.appActMethod).toBe('api');

    const defaultAction: AgentAction = {
      type: 'app-act',
      appActRecipeId: 'x.post',
      appActParams: { text: '{{result}}' },
    };
    const parsedDefault = JSON.parse(JSON.stringify(agent(defaultAction))) as Agent;
    expect(parsedDefault.action?.appActMethod).toBeUndefined();
  });

  it('accepts app-act in the AgentActionType union and in generateRunScript without throwing', () => {
    const action: AgentAction = {
      type: 'app-act',
      appActRecipeId: 'x.post',
      appActParams: { text: 'Result: {{result}}' },
    };
    expect(() => generateRunScript(agent(action))).not.toThrow();
  });

  it('frames an app-act result as generic requested app-action content (no post-specific wiring)', () => {
    const action: AgentAction = {
      type: 'app-act',
      appActRecipeId: 'x.post',
      appActParams: { text: '{{result}}' },
    };
    const script = generateRunScript(agent(action, { tool: { type: 'local' } }));
    expect(script).toContain('Produce exactly the content needed for the requested app action.');
  });

  it('is inert: PlanSpec builder refuses app-act as unsupported (fail closed, not a silent draft fallback)', () => {
    const action: AgentAction = {
      type: 'app-act',
      appActRecipeId: 'x.post',
      appActParams: { text: '{{result}}' },
    };
    const spec = buildAgentPlanSpec(agent(action));
    expect(spec.action.type).toBe('unsupported');
    expect((spec.action as { unsupportedReason?: string }).unsupportedReason).toContain('app-act');
  });
});

describe('app-act secret scan coverage', () => {
  const SECRET = 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH';

  it('trips the secret guard when a secret is embedded in appActParams.text', () => {
    const action: AgentAction = {
      type: 'app-act',
      appActRecipeId: 'x.post',
      appActParams: { text: `Posting with leaked key ${SECRET}` },
    };
    const r = resolveAgentRoute(agent(action, { prompt: 'post an update' }));
    expect(r.decision.guard).toBe('secret');
    expect(r.decision.route).toBe('on-device');
    expect(r.decision.noCloudFallback).toBe(true);
  });

  it('does not trip the secret guard for an app-act agent with no secret-bearing text', () => {
    const action: AgentAction = {
      type: 'app-act',
      appActRecipeId: 'x.post',
      appActParams: { text: '{{result}}' },
    };
    const r = resolveAgentRoute(agent(action, { prompt: 'post an update' }));
    expect(r.decision.guard).not.toBe('secret');
  });
});
