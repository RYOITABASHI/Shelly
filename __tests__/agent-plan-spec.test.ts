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
      // before this increment, plus nothing new — `toolLadder` (additive,
      // DEFERRED.md "PlanSpec executor 経由の無人発火は...エスカレーションラダーへ
      // 進まない") is now always present too (possibly empty), and
      // `toolLadderExhaustedNote` is present for this fixture specifically
      // because a plain pinned-local attended agent's ladder still climbs to
      // Codex (see the toolLadder describe block below for the exact rules).
      expect(Object.keys(spec).sort()).toEqual(
        ['action', 'agent', 'generatedAt', 'kind', 'limits', 'output', 'paths', 'policy', 'prompt', 'routeDecision', 'schemaVersion', 'tool', 'toolLadder', 'toolLadderExhaustedNote'].sort(),
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

  // Phase 7 (2026-08-03): per-step credential resolution. Before this, a
  // step's `.tool` pin was written into the PlanSpec JSON completely
  // unvetted — an unattended agent with NO Autonomous Cloud consent could
  // carry a step pinned to an api-key-class tool (Perplexity/Gemini), and
  // scripts/shelly-plan-executor.js would previously have ignored it
  // entirely anyway (see that file's own comment). Now every step.tool goes
  // through the SAME resolveForAutonomous() gate the agent-level tool
  // already used, at this exact plan-build chokepoint, so the on-device
  // executor never has to make (or could get wrong) that credential
  // decision itself.
  describe('per-step credential resolution (Phase 7)', () => {
    it('strips an api-key-class step tool pin (Perplexity) on an autonomous agent with no consent', () => {
      const orchestration = {
        steps: [
          { instruction: 'search for sources', tool: { type: 'perplexity' as const, model: 'sonar-deep-research' } },
          'summarize and save it',
        ],
      };
      const spec = buildAgentPlanSpec(agent({ autonomous: true, orchestration }));
      expect(spec.steps!.list[0].tool).toBeUndefined();
      // Non-destructive to the rest of the step — instruction survives.
      expect(spec.steps!.list[0].instruction).toBe('search for sources');
    });

    it('strips an api-key-class step tool pin (Gemini) the same way', () => {
      const orchestration = {
        steps: [
          { instruction: 'look it up', tool: { type: 'gemini-api' as const } },
          'write it up',
        ],
      };
      const spec = buildAgentPlanSpec(agent({ autonomous: true, orchestration }));
      expect(spec.steps!.list[0].tool).toBeUndefined();
    });

    it('keeps a non-api-key step tool pin (local) unchanged on an autonomous agent', () => {
      const orchestration = {
        steps: [
          { instruction: 'summarize locally', tool: { type: 'local' as const } },
          'save the result',
        ],
      };
      const spec = buildAgentPlanSpec(agent({ autonomous: true, orchestration }));
      expect(spec.steps!.list[0].tool).toEqual({ type: 'local' });
    });

    it('keeps a step tool pin (cli:codex) unchanged too — codex is not api-key class, even though the JS executor cannot dispatch it', () => {
      const orchestration = {
        steps: [
          { instruction: 'review it with Codex', tool: { type: 'cli' as const, cli: 'codex' as const } },
          'post the result',
        ],
      };
      const spec = buildAgentPlanSpec(agent({ autonomous: true, orchestration }));
      expect(spec.steps!.list[0].tool).toEqual({ type: 'cli', cli: 'codex' });
    });

    it('never touches step.tool on a non-autonomous (attended-only) agent — that path already honors it directly, unvetted, at run time', () => {
      const orchestration = {
        steps: [
          { instruction: 'search for sources', tool: { type: 'perplexity' as const, model: 'sonar-deep-research' } },
          'summarize and save it',
        ],
      };
      const spec = buildAgentPlanSpec(agent({ autonomous: false, orchestration }));
      expect(spec.steps!.list[0].tool).toEqual({ type: 'perplexity', model: 'sonar-deep-research' });
    });

    it('honors the SAME web-consent exception the agent-level tool gets: an autonomous agent WITH Autonomous Cloud consent + a needs-web prompt keeps a Perplexity step pin', () => {
      const orchestration = {
        steps: [
          { instruction: 'search for sources', tool: { type: 'perplexity' as const, model: 'sonar-deep-research' } },
          'summarize and save it',
        ],
      };
      const spec = buildAgentPlanSpec(
        agent({ autonomous: true, prompt: 'ニュースを集めて', tool: { type: 'perplexity' }, orchestration }),
        { autonomousCloudConsent: true },
      );
      // Sanity: this prompt/options combo is what exempts the AGENT-level
      // tool too — confirms the fixture actually triggers the exception path
      // this test means to exercise, not just asserting the step behavior in
      // isolation against an unverified premise.
      expect(spec.tool.type).toBe('perplexity');
      expect(spec.steps!.list[0].tool).toEqual({ type: 'perplexity', model: 'sonar-deep-research' });
    });

    it('does NOT bypass consent for a step tool the agent-level exception does not cover (agent-level tool is local, not web-needing)', () => {
      const orchestration = {
        steps: [
          { instruction: 'search for sources', tool: { type: 'perplexity' as const, model: 'sonar-deep-research' } },
          'summarize and save it',
        ],
      };
      // autonomousCloudConsent alone, with no needs-web prompt, does not
      // exempt anything — consentWebTool requires promptSignals.needsWeb too.
      const spec = buildAgentPlanSpec(
        agent({ autonomous: true, prompt: 'say hello', orchestration }),
        { autonomousCloudConsent: true },
      );
      expect(spec.steps!.list[0].tool).toBeUndefined();
    });

    it('FAN-OUT (2026-08-13): a parallelGroup marker never weakens the vetting — an api-key step pin inside a group is still stripped on an autonomous agent, and the group id itself survives into steps.list', () => {
      const orchestration = {
        steps: [
          'collect the base data',
          { instruction: 'research angle A', tool: { type: 'perplexity' as const }, parallelGroup: 'research' },
          { instruction: 'research angle B', tool: { type: 'local' as const }, parallelGroup: 'research' },
          'aggregate everything',
        ],
      };
      const spec = buildAgentPlanSpec(agent({ autonomous: true, orchestration }));
      // Branch A: perplexity is api-key class -> pin stripped (inherits the
      // agent's unattended credential boundary exactly like a serial step);
      // the group marker is untouched by the strip.
      expect(spec.steps!.list[1].tool).toBeUndefined();
      expect(spec.steps!.list[1].parallelGroup).toBe('research');
      // Branch B: local is allowed unattended -> pin kept, marker kept.
      expect(spec.steps!.list[2].tool).toEqual({ type: 'local' });
      expect(spec.steps!.list[2].parallelGroup).toBe('research');
      // Serial neighbors carry no marker.
      expect(spec.steps!.list[0].parallelGroup).toBeUndefined();
      expect(spec.steps!.list[3].parallelGroup).toBeUndefined();
    });
  });
});

describe('buildAgentPlanSpec — toolLadder (DEFERRED.md "PlanSpec executor 経由の無人発火は...エスカレーションラダーへ進まない")', () => {
  it('bakes the attended-ladder retry candidates (minus the primary tool, minus non-HTTP-dispatchable entries) for an autonomous transform task', () => {
    // Deliberately NOT tool:{type:'auto'} — resolveAgentRoute special-cases
    // `agent.autonomous && agent.tool.type==='auto'` by leaving it unresolved
    // (so resolveForAutonomous alone decides, which maps bare 'auto' straight
    // to Codex — a real, separate policy edge case, not this test's concern).
    // A concretely-pinned 'local' resolves the way a scored 'auto' pick would
    // for this same transform prompt, without tripping that edge case.
    const spec = buildAgentPlanSpec(
      agent({ autonomous: true, prompt: '要約して箇条書きにして', tool: { type: 'local' } }),
      { hasCerebrasKey: true, hasGroqKey: true },
    );
    // Autonomous ladder for a non-web transform task is [local, codex] — see
    // resolveEscalationLadder's own doc comment (autonomous api-key backends
    // are dropped). Primary is local; codex is not HTTP-dispatchable by this
    // executor, so toolLadder is empty, but a note explains why.
    expect(spec.tool.type).toBe('local');
    expect(spec.toolLadder ?? []).toEqual([]);
    expect(spec.toolLadderExhaustedNote).toContain('Codex');
  });

  it('bakes Cerebras/Groq as HTTP-retry candidates for an autonomous cloud-consented web task', () => {
    // Explicitly pinned to gemini-api (not 'auto') so resolveAgentRoute's
    // configured-tool branch resolves it BEFORE buildAgentPlanSpec's own
    // consentWebTool check — that check only exempts an already-concrete
    // gemini-api/perplexity pin from resolveForAutonomous, mirroring how a
    // real N1-consented agent is actually configured (see
    // lib/agent-tool-router.ts's `agent.autonomous && agent.tool.type==='auto'`
    // early-return, which deliberately leaves bare 'auto' for
    // resolveForAutonomous to map straight to Codex instead).
    const spec = buildAgentPlanSpec(
      agent({ autonomous: true, prompt: 'ニュースを集めて', tool: { type: 'gemini-api' } }),
      { autonomousCloudConsent: true, hasCerebrasKey: true, hasGroqKey: true },
    );
    // N1 web-consent ladder is [gemini-api, codex] (see the N1 tests in
    // agent-escalation-ladder.test.ts) — primary is gemini-api, codex is
    // filtered, so toolLadder is empty with the same exhausted note.
    expect(spec.tool.type).toBe('gemini-api');
    expect(spec.toolLadder ?? []).toEqual([]);
    expect(spec.toolLadderExhaustedNote).toContain('Codex');
  });

  it('omits Cerebras/Groq from the ladder when their keys are absent (no wasted retry hop)', () => {
    const spec = buildAgentPlanSpec(
      agent({ autonomous: false, prompt: '要約して', tool: { type: 'auto' } }),
      { hasCerebrasKey: false, hasGroqKey: false },
    );
    expect(spec.tool.type).toBe('local');
    expect((spec.toolLadder ?? []).map((t) => t.type)).toEqual([]);
  });

  it('bakes real HTTP-dispatchable retry candidates for an attended (non-autonomous) transform task with both free-cloud keys present', () => {
    const spec = buildAgentPlanSpec(
      agent({ autonomous: false, prompt: '要約して', tool: { type: 'auto' } }),
      { hasCerebrasKey: true, hasGroqKey: true },
    );
    expect(spec.tool.type).toBe('local');
    expect((spec.toolLadder ?? []).map((t) => t.type)).toEqual(['cerebras', 'groq']);
    // Every rung is a full PlanSpec tool object (usable directly as plan.tool
    // for a retry attempt), not a bare type string.
    expect(spec.toolLadder![0]).toMatchObject({ type: 'cerebras', authRef: 'cerebras' });
  });

  it('defaults hasCerebrasKey/hasGroqKey to true when the caller does not pass them (fail-open to "try it", matching ladderEnvFromDisk\'s own read-failure default)', () => {
    const spec = buildAgentPlanSpec(agent({ autonomous: false, prompt: '要約して', tool: { type: 'auto' } }));
    expect((spec.toolLadder ?? []).map((t) => t.type)).toEqual(['cerebras', 'groq']);
  });
});
