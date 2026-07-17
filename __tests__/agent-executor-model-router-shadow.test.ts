// MODEL-001 Phase A shadow instrumentation — wiring test for the real call
// site in lib/agent-executor.ts's generateRunScript(). Proves:
//   (a) the live routing decision is byte-identical to pre-instrumentation
//       behavior (no cutover, no behavior change),
//   (b) the dormant shadow comparator IS invoked on every real routing
//       decision (observable side effect: the mocked compareRouteDecision
//       is called with the same Agent),
//   (c) an error thrown inside the shadow path is caught and cannot
//       propagate — the real agent run still completes normally,
//   (d) no secret or prompt text ever reaches whatever gets logged, even for
//       a secret-bearing prompt.
//
// MODEL_ROUTER_ENABLED must stay false throughout — this file never touches
// it and asserts nothing that would require it to flip.

jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

const actualModelRouter = jest.requireActual('@/lib/model-router');
const compareRouteDecisionMock = jest.fn(actualModelRouter.compareRouteDecision);
jest.mock('@/lib/model-router', () => {
  const actual = jest.requireActual('@/lib/model-router');
  return {
    __esModule: true,
    ...actual,
    compareRouteDecision: (...args: unknown[]) => (compareRouteDecisionMock as any)(...args),
  };
});

import { generateRunScript } from '@/lib/agent-executor';
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

// Never a real secret — same fixture pattern as agent-executor-credential.test.ts.
const FAKE_SECRET = 'sk-proj-abcdefghijklmnopqrstuvwxyz1234567890';
const SECRET_PROMPT = `Summarize this config: api_key=${FAKE_SECRET}`;

function routeDecisionBlock(script: string): string {
  const idx = script.indexOf('ROUTE_DECISION_JSON=');
  expect(idx).toBeGreaterThan(-1);
  return script.slice(idx, idx + 500);
}

describe('MODEL-001 Phase A shadow wiring — generateRunScript() call site', () => {
  beforeEach(() => {
    compareRouteDecisionMock.mockClear();
    compareRouteDecisionMock.mockImplementation(actualModelRouter.compareRouteDecision);
  });

  it('(a) live routing decision is unchanged: cli/local/ab-article-eval/auto-local all still route as before', () => {
    expect(routeDecisionBlock(generateRunScript(mkAgent({ tool: { type: 'cli', cli: 'codex' } }))))
      .toContain('"toolType":"cli"');
    expect(routeDecisionBlock(generateRunScript(mkAgent({ tool: { type: 'local' } }))))
      .toContain('"toolType":"local"');
    expect(routeDecisionBlock(generateRunScript(mkAgent({ tool: { type: 'ab-article-eval' } }))))
      .toContain('"toolType":"ab-article-eval"');
    // Layer-2 (G4): a plain transform-ish task routes on-device-first → local.
    expect(routeDecisionBlock(generateRunScript(mkAgent({ tool: { type: 'auto' }, prompt: 'say hi' }))))
      .toContain('"toolType":"local"');
  });

  it('(a2) live routing decision is unchanged: secret-bearing prompt still forces on-device + noCloudFallback', () => {
    const s = generateRunScript(mkAgent({ tool: { type: 'gemini-api' }, prompt: SECRET_PROMPT }));
    const block = routeDecisionBlock(s);
    expect(block).toContain('"guard":"secret"');
    expect(block).toContain('"route":"on-device"');
    expect(block).toContain('"noCloudFallback":true');
    expect(s).toContain('Qwen3.5-0.8B-Q4_K_M');
    expect(s).not.toContain('generativelanguage.googleapis.com');
  });

  it('(a3) live routing decision is unchanged even when the shadow comparator throws', () => {
    // The most important guard: whatever the dormant comparator does, the
    // ACTUAL script generated for a real agent run must be identical.
    const baseline = generateRunScript(mkAgent({ tool: { type: 'cli', cli: 'codex' } }));
    compareRouteDecisionMock.mockImplementation(() => {
      throw new Error('shadow boom — must never affect the live route');
    });
    const withThrowingShadow = generateRunScript(mkAgent({ tool: { type: 'cli', cli: 'codex' } }));
    expect(withThrowingShadow).toBe(baseline);
  });

  it('(b) invokes the shadow comparator on every real routing decision, with the same Agent', () => {
    const agent = mkAgent({ prompt: 'collect the latest news' });
    generateRunScript(agent);
    expect(compareRouteDecisionMock).toHaveBeenCalledTimes(1);
    expect(compareRouteDecisionMock).toHaveBeenCalledWith(expect.objectContaining({ id: agent.id }));
  });

  it('(c) an error thrown inside the shadow path does not propagate out of generateRunScript', () => {
    compareRouteDecisionMock.mockImplementation(() => {
      throw new Error('shadow boom');
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let script = '';
    expect(() => {
      script = generateRunScript(mkAgent({ tool: { type: 'cli', cli: 'codex' } }));
    }).not.toThrow();
    expect(typeof script).toBe('string');
    expect(script.length).toBeGreaterThan(0);
    expect(routeDecisionBlock(script)).toContain('"toolType":"cli"');
    // The swallow is logged (not silently dropped), tagged for logcat filtering.
    const sawSwallowLog = warnSpy.mock.calls.some((call) =>
      call.some((arg) => typeof arg === 'string' && arg.includes('ModelRouterShadow'))
    );
    expect(sawSwallowLog).toBe(true);
    warnSpy.mockRestore();
  });

  it('(d) never logs secret or prompt text, even for a secret-bearing agent', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    generateRunScript(mkAgent({ tool: { type: 'gemini-api' }, prompt: SECRET_PROMPT }));

    const allCalls = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls];
    const modelRouterCalls = allCalls.filter((call) =>
      call.some((arg) => typeof arg === 'string' && arg.includes('ModelRouterShadow'))
    );
    // The shadow path must actually have logged something for this to be a
    // meaningful assertion (a no-op logger would trivially "pass" otherwise).
    expect(modelRouterCalls.length).toBeGreaterThan(0);

    const flattened = modelRouterCalls
      .flat()
      .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join('\n');
    expect(flattened).not.toContain(FAKE_SECRET);
    expect(flattened).not.toContain('Summarize this config');
    expect(flattened).not.toContain(SECRET_PROMPT);

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('(e) stays observational: unexpectedDivergence is surfaced via logWarn, everything else via logInfo', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    compareRouteDecisionMock.mockImplementation(() => ({
      live: { tool: { type: 'cli', cli: 'codex' }, decision: { guard: 'configured-tool', route: 'cloud' } },
      shadow: { chosen: null, eligible: [], rejected: [] },
      requirements: { taskKind: 'general', needsWeb: false, touchesSecrets: false, unattended: false },
      secretInvariantHolds: true,
      knownDivergence: null,
      unexpectedDivergence: 'live=cli shadow=deny (synthetic test divergence)',
    }));

    generateRunScript(mkAgent({ tool: { type: 'cli', cli: 'codex' } }));

    const sawWarn = warnSpy.mock.calls.some((call) =>
      call.some((arg) => typeof arg === 'string' && arg.includes('ModelRouterShadow'))
    );
    expect(sawWarn).toBe(true);

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
