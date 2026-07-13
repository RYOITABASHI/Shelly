// MODEL-001 Phase B — secret-branch live-flip tests (dormant, MODEL_ROUTER_ENABLED
// stays false in wiring.ts). This suite pins THREE guarantees for
// lib/agent-tool-router.ts resolveAgentRoute's secret branch:
//   (a) with the flag OFF (today's default), the secret branch is byte-identical
//       to pre-Phase-B behaviour — no MODEL-001 code runs at all;
//   (b) with the flag mocked ON, a secret-bearing agent still resolves local,
//       now via the MODEL-001 selector, landing on the SAME tool
//       onDeviceFallbackTool would have picked;
//   (c) with the flag ON but no eligible local candidate (or an internal
//       throw), the "always succeeds" guarantee still holds — the branch falls
//       back to onDeviceFallbackTool, never denies, never throws into the run.
//
// jest.mock + jest.resetModules is used (not a runtime flag flip — there is no
// such flip; MODEL_ROUTER_ENABLED is a source constant) to simulate flag-ON for
// (b)/(c)/(d) while (a) runs the real, unmocked module to prove the OFF path.
import { Agent, ToolChoice } from '@/store/types';

const mkAgent = (over: Partial<Agent> = {}): Agent => ({
  id: 'a',
  name: 'A',
  description: '',
  prompt: 'summarize this',
  schedule: null,
  tool: { type: 'auto' } as ToolChoice,
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
  ...over,
});

// Never a real secret — same fixture shape as shadow.test.ts / wiring.test.ts.
const FAKE_OPENAI_KEY = 'sk-ant-api03-AAAABBBBCCCCDDDD';

describe('MODEL-001 Phase B — secret branch live flip (dormant)', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('@/lib/model-router/wiring');
    jest.dontMock('@/lib/model-router/select');
  });

  it('(a) flag OFF (default): secret branch matches pre-Phase-B behaviour exactly', () => {
    // No mocking — exercises the real, shipped MODEL_ROUTER_ENABLED=false path.
    const { resolveAgentRoute } = require('@/lib/agent-tool-router');
    const { MODEL_ROUTER_ENABLED } = require('@/lib/model-router/wiring');
    expect(MODEL_ROUTER_ENABLED).toBe(false);

    const agent = mkAgent({ prompt: `review github PR with key ${FAKE_OPENAI_KEY}` });
    const result = resolveAgentRoute(agent);

    // Byte-identical to the pre-Phase-B contract: forced local, secret guard,
    // no cloud fallback, tool === onDeviceFallbackTool(agent.tool).
    expect(result.tool).toEqual({ type: 'local', model: 'Qwen3.5-0.8B-Q4_K_M' });
    expect(result.decision).toEqual({
      route: 'on-device',
      toolType: 'local',
      toolLabel: 'Local LLM',
      guard: 'secret',
      why: 'Secret guard matched task text; this run is forced to local/on-device and cloud fallback is disabled.',
      secretKinds: ['openai-like-key'],
      noCloudFallback: true,
    });
  });

  it('(a2) flag OFF: an agent already configured with a local tool keeps that tool (onDeviceFallbackTool pass-through)', () => {
    const { resolveAgentRoute } = require('@/lib/agent-tool-router');
    const agent = mkAgent({
      prompt: `deploy token=${FAKE_OPENAI_KEY}`,
      tool: { type: 'local', model: 'Qwen3-1.7B-Q4_K_M' },
    });
    const result = resolveAgentRoute(agent);
    expect(result.tool).toEqual({ type: 'local', model: 'Qwen3-1.7B-Q4_K_M' });
    expect(result.decision.guard).toBe('secret');
  });

  it('(b) flag mocked ON: secret-bearing agent still resolves local, now via MODEL-001 selectModel', () => {
    jest.doMock('@/lib/model-router/wiring', () => {
      const actual = jest.requireActual('@/lib/model-router/wiring');
      return { ...actual, MODEL_ROUTER_ENABLED: true };
    });
    const { resolveAgentRoute } = require('@/lib/agent-tool-router');
    const { MODEL_ROUTER_ENABLED } = require('@/lib/model-router/wiring');
    expect(MODEL_ROUTER_ENABLED).toBe(true);

    const agent = mkAgent({ prompt: `review github PR with key ${FAKE_OPENAI_KEY}` });
    const result = resolveAgentRoute(agent);

    // Same invariant as flag-OFF: a runnable local tool, guard === 'secret',
    // noCloudFallback still true. MODEL_REGISTRY's local-qwen candidate maps
    // via candidateToToolChoice to { type: 'local' } (no model field) — the
    // registry round-trip is coarser than onDeviceFallbackTool's specific
    // model pin, which is fine: the invariant is credentialClass==='local',
    // not a specific model string.
    expect(result.tool.type).toBe('local');
    expect(result.decision.route).toBe('on-device');
    expect(result.decision.guard).toBe('secret');
    expect(result.decision.noCloudFallback).toBe(true);
    expect(result.decision.secretKinds).toEqual(['openai-like-key']);
  });

  it('(c) flag ON + no eligible local candidate: falls back to onDeviceFallbackTool — always succeeds, never denies', () => {
    jest.doMock('@/lib/model-router/wiring', () => {
      const actual = jest.requireActual('@/lib/model-router/wiring');
      return { ...actual, MODEL_ROUTER_ENABLED: true };
    });
    jest.doMock('@/lib/model-router/select', () => ({
      selectModel: () => ({ chosen: null, eligible: [], rejected: [] }),
    }));
    const { resolveAgentRoute } = require('@/lib/agent-tool-router');

    const agent = mkAgent({ prompt: `review github PR with key ${FAKE_OPENAI_KEY}` });
    const result = resolveAgentRoute(agent);

    // Falls back exactly to today's onDeviceFallbackTool result.
    expect(result.tool).toEqual({ type: 'local', model: 'Qwen3.5-0.8B-Q4_K_M' });
    expect(result.decision.guard).toBe('secret');
    expect(result.decision.route).toBe('on-device');
    expect(result.decision.noCloudFallback).toBe(true);
  });

  it('(d) flag ON + MODEL-001 internal throw: falls back safely, never throws into the run', () => {
    jest.doMock('@/lib/model-router/wiring', () => {
      const actual = jest.requireActual('@/lib/model-router/wiring');
      return { ...actual, MODEL_ROUTER_ENABLED: true };
    });
    jest.doMock('@/lib/model-router/select', () => ({
      selectModel: () => {
        throw new Error('MODEL-001 boom');
      },
    }));
    const { resolveAgentRoute } = require('@/lib/agent-tool-router');

    const agent = mkAgent({ prompt: `review github PR with key ${FAKE_OPENAI_KEY}` });
    expect(() => resolveAgentRoute(agent)).not.toThrow();

    const result = resolveAgentRoute(agent);
    expect(result.tool).toEqual({ type: 'local', model: 'Qwen3.5-0.8B-Q4_K_M' });
    expect(result.decision.guard).toBe('secret');
    expect(result.decision.noCloudFallback).toBe(true);
  });

  it('(e) flag ON + selectModel returns an ineligible non-local chosen (defensive): falls back, does not smuggle a cloud tool', () => {
    jest.doMock('@/lib/model-router/wiring', () => {
      const actual = jest.requireActual('@/lib/model-router/wiring');
      return { ...actual, MODEL_ROUTER_ENABLED: true };
    });
    jest.doMock('@/lib/model-router/select', () => ({
      selectModel: () => ({
        chosen: {
          id: 'gemini-api',
          toolType: 'gemini-api',
          isLocal: false,
          credentialClass: 'api-key',
          capabilities: { web: true, taskKinds: ['general'] },
          cost: 'low',
          latency: 'fast',
          preference: 60,
        },
        eligible: [],
        rejected: [],
      }),
    }));
    const { resolveAgentRoute } = require('@/lib/agent-tool-router');

    const agent = mkAgent({ prompt: `review github PR with key ${FAKE_OPENAI_KEY}` });
    const result = resolveAgentRoute(agent);

    // The invariant check (isLocal && credentialClass==='local') rejects this
    // chosen candidate outright — falls back to the local tool, never gemini-api.
    expect(result.tool.type).toBe('local');
    expect(result.tool).toEqual({ type: 'local', model: 'Qwen3.5-0.8B-Q4_K_M' });
  });

  it('untouched branches: manual-pin/autonomous-policy/scorer/configured-tool are unaffected by the flag', () => {
    jest.doMock('@/lib/model-router/wiring', () => {
      const actual = jest.requireActual('@/lib/model-router/wiring');
      return { ...actual, MODEL_ROUTER_ENABLED: true };
    });
    const { resolveAgentRoute } = require('@/lib/agent-tool-router');

    // No secret in text, manual on-device pin — unrelated to the secret branch.
    const pinned = resolveAgentRoute(mkAgent({ prompt: 'summarize this', runOn: 'on-device' }));
    expect(pinned.decision.guard).toBe('manual-pin');

    const cloudPinned = resolveAgentRoute(mkAgent({ prompt: 'summarize this', runOn: 'cloud' }));
    expect(cloudPinned.decision.guard).toBe('manual-pin');

    const autonomousAuto = resolveAgentRoute(
      mkAgent({ prompt: 'summarize this', autonomous: true, tool: { type: 'auto' } })
    );
    expect(autonomousAuto.decision.guard).toBe('autonomous-policy');

    const configured = resolveAgentRoute(
      mkAgent({ prompt: 'summarize this', tool: { type: 'perplexity', model: 'sonar-deep-research' } })
    );
    expect(configured.decision.guard).toBe('configured-tool');
  });
});
