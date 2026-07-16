jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { buildAgentPlanSpec, PLAN_SPEC_KIND, PLAN_SPEC_SCHEMA_VERSION, validateAgentPlanSpec } from '@/lib/agent-plan-spec';
import { isOrchestrated, normalizeSteps, resolveBudget } from '@/lib/agent-orchestration';
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

  it('marks unsupported tools fail-closed while preserving broker-supported actions', () => {
    const spec = buildAgentPlanSpec(agent({
      tool: { type: 'cli', cli: 'codex' },
      action: { type: 'cli', command: 'rm -rf /' },
    }));

    expect(spec.tool.type).toBe('unsupported');
    expect(spec.tool.unsupportedReason).toContain('does not support cli tools yet');
    expect(spec.action.type).toBe('cli');
    expect(spec.action.command).toBe('rm -rf /');
    expect(spec.action.safety?.level).toBe('CRITICAL');
  });

  it('serializes webhook and cli actions without raw authorization material', () => {
    const webhook = buildAgentPlanSpec(agent({
      action: { type: 'webhook', webhookUrl: 'https://hooks.example.test/incoming' },
    }));
    expect(webhook.action).toMatchObject({
      type: 'webhook',
      webhookUrl: 'https://hooks.example.test/incoming',
    });

    const cli = buildAgentPlanSpec(agent({
      action: { type: 'cli', command: 'printf ok' },
    }));
    expect(cli.action).toMatchObject({
      type: 'cli',
      command: 'printf ok',
    });
    expect(cli.action.safety?.level).toBe('SAFE');

    const serialized = JSON.stringify({ webhook, cli });
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('Bearer ');
  });

  it('serializes dm-reply on schema v1 with only the opaque pairing id and reply template', () => {
    const spec = buildAgentPlanSpec(agent({
      action: { type: 'dm-reply', dmPairingId: 'pair-1', dmReplyText: 'Reply: {{result}}' },
    }));
    expect(spec.schemaVersion).toBe(1);
    expect(spec.action).toEqual({
      type: 'dm-reply',
      dmPairingId: 'pair-1',
      dmReplyText: 'Reply: {{result}}',
    });
    expect(JSON.stringify(spec.action)).not.toContain('packageName');
    expect(JSON.stringify(spec.action)).not.toContain('notificationId');
  });

  it('serializes an api-call action (v1) with its full structured config', () => {
    const spec = buildAgentPlanSpec(agent({
      orchestration: { steps: ['gather sources', 'post the digest'] },
      action: {
        type: 'api-call',
        apiCall: {
          host: 'api.perplexity.ai',
          method: 'POST',
          path: '/chat/completions',
          authRef: 'perplexity',
          bodyTemplate: '{"query":"{{result}}"}',
        },
      },
    }));
    expect(spec.action).toEqual({
      type: 'api-call',
      apiCall: {
        host: 'api.perplexity.ai',
        method: 'POST',
        path: '/chat/completions',
        authRef: 'perplexity',
        bodyTemplate: '{"query":"{{result}}"}',
      },
    });
    expect(validateAgentPlanSpec(spec).ok).toBe(true);
    expect(JSON.stringify(spec.action)).not.toContain('PERPLEXITY_API_KEY');
    expect(JSON.stringify(spec.action)).not.toContain('Bearer ');
  });

  it('serializes the orchestration char limit as an optional executor limit', () => {
    const spec = buildAgentPlanSpec(agent({
      orchestration: {
        steps: ['collect sources', 'summarize for X'],
        charLimit: 5,
      },
    }));

    expect(spec.limits.charLimit).toBe(40);
    expect(validateAgentPlanSpec(spec).ok).toBe(true);

    const withoutLimit = buildAgentPlanSpec(agent());
    expect(withoutLimit.limits.charLimit).toBeUndefined();
  });

  it('validates schema version and agent id', () => {
    const spec = buildAgentPlanSpec(agent());
    expect(validateAgentPlanSpec(spec).ok).toBe(true);
    expect(validateAgentPlanSpec({ ...spec, schemaVersion: 99 }).ok).toBe(false);
    expect(validateAgentPlanSpec({ ...spec, agent: { ...spec.agent, id: '../../bad' } }).ok).toBe(false);
  });

  describe('orchestration `steps` field (increment 1 — schema plumbing only)', () => {
    // (a) Critical no-regression check: a non-orchestrated agent's PlanSpec is
    // unchanged — no `steps` key at all (not even `undefined` sitting in the
    // object; JSON.stringify must drop it exactly like it always has for every
    // other optional field in this schema).
    it('a non-orchestrated agent has no `steps` field at all', () => {
      const spec = buildAgentPlanSpec(agent());
      expect(spec.steps).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(spec, 'steps')).toBe(false);
      expect(JSON.parse(JSON.stringify(spec))).not.toHaveProperty('steps');
    });

    it('a single-step orchestration config (isOrchestrated === false) also has no `steps` field', () => {
      const spec = buildAgentPlanSpec(agent({ orchestration: { steps: ['only one step'] } }));
      expect(isOrchestrated({ steps: ['only one step'] })).toBe(false);
      expect(spec.steps).toBeUndefined();
    });

    it('does not change schemaVersion, kind, or any other field for a non-orchestrated agent (byte-for-byte parity with pre-increment shape)', () => {
      const baseAgent = agent();
      const spec = buildAgentPlanSpec(baseAgent);
      expect(spec.schemaVersion).toBe(PLAN_SPEC_SCHEMA_VERSION);
      expect(spec.schemaVersion).toBe(1);
      expect(spec.kind).toBe(PLAN_SPEC_KIND);
      // Full-shape parity: every key present is exactly the set that existed
      // before this increment, plus nothing new.
      expect(Object.keys(spec).sort()).toEqual(
        ['action', 'agent', 'generatedAt', 'kind', 'limits', 'output', 'paths', 'policy', 'prompt', 'routeDecision', 'schemaVersion', 'tool'].sort(),
      );
    });

    // (b) Parity check: an orchestrated agent's PlanSpec carries a `steps`
    // field whose content matches what normalizeSteps()/resolveBudget()
    // independently compute for the same orchestration config — the PlanSpec
    // builder must not re-derive or diverge from those pure helpers.
    it('an orchestrated agent carries `steps.list`/`steps.budget` matching normalizeSteps()/resolveBudget() directly', () => {
      const orchestration = {
        steps: [
          'collect sources on the topic',
          { instruction: 'summarize into a digest', tool: { type: 'local' as const, model: 'Qwen3.5-0.8B-Q4_K_M' } },
          'post the digest to X',
        ],
        maxSteps: 5,
      };
      const testAgent = agent({ orchestration });
      const spec = buildAgentPlanSpec(testAgent);

      expect(isOrchestrated(orchestration)).toBe(true);
      expect(spec.steps).toBeDefined();
      expect(spec.steps!.list).toEqual(normalizeSteps(orchestration));
      expect(spec.steps!.budget).toEqual(resolveBudget(orchestration));
      // Sanity on content, not just structural parity with the helpers:
      expect(spec.steps!.list).toHaveLength(3);
      expect(spec.steps!.list[1]).toEqual({
        instruction: 'summarize into a digest',
        tool: { type: 'local', model: 'Qwen3.5-0.8B-Q4_K_M' },
      });
      expect(spec.steps!.budget.maxSteps).toBe(5);
    });

    it('schemaVersion stays 1 for an orchestrated PlanSpec too — no version bump this increment', () => {
      const spec = buildAgentPlanSpec(agent({ orchestration: { steps: ['a', 'b'] } }));
      expect(spec.schemaVersion).toBe(1);
      expect(spec.schemaVersion).toBe(PLAN_SPEC_SCHEMA_VERSION);
    });

    it('validateAgentPlanSpec still accepts an orchestrated PlanSpec (the extra `steps` key is not rejected)', () => {
      const spec = buildAgentPlanSpec(agent({ orchestration: { steps: ['a', 'b', 'c'] } }));
      expect(validateAgentPlanSpec(spec).ok).toBe(true);
    });

    // api-call (v1): a step's apiCall config must serialize into
    // steps.list[i].apiCall exactly like normalizeSteps() independently
    // computes it — buildAgentPlanSpec must not re-derive or drop it.
    it('serializes a step-carried apiCall config into steps.list[i].apiCall', () => {
      const orchestration = {
        steps: [
          {
            instruction: 'search for sources',
            apiCall: { host: 'api.perplexity.ai', method: 'GET' as const, path: '/v1/search?q={{result}}' },
          },
          'summarize and post the digest',
        ],
      };
      const spec = buildAgentPlanSpec(agent({ orchestration }));
      expect(spec.steps).toBeDefined();
      expect(spec.steps!.list).toEqual(normalizeSteps(orchestration));
      expect(spec.steps!.list[0].apiCall).toEqual({
        host: 'api.perplexity.ai',
        method: 'GET',
        path: '/v1/search?q={{result}}',
      });
      expect(spec.steps!.list[0].tool).toBeUndefined();
      expect(validateAgentPlanSpec(spec).ok).toBe(true);
    });
  });
});
