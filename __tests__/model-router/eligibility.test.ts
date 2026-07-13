import { computeEligible } from '@/lib/model-router/eligibility';
import { ModelCandidate, RunRequirements } from '@/lib/model-router';

function candidate(over: Partial<ModelCandidate> & { id: string }): ModelCandidate {
  return {
    id: over.id,
    toolType: over.toolType ?? 'local',
    isLocal: over.isLocal ?? false,
    credentialClass: over.credentialClass ?? 'api-key',
    capabilities: over.capabilities ?? { web: false, taskKinds: ['general', 'code', 'research', 'prose', 'transform'] },
    cost: over.cost ?? 'low',
    latency: over.latency ?? 'fast',
    preference: over.preference ?? 10,
  };
}

const base: RunRequirements = {
  taskKind: 'general',
  needsWeb: false,
  touchesSecrets: false,
  unattended: false,
};

describe('MODEL-001 eligibility', () => {
  it('bars EVERY non-local candidate when the run touches secrets, even a cheaper/preferred cloud one', () => {
    const registry = [
      candidate({ id: 'local', isLocal: true, credentialClass: 'local', cost: 'high', preference: 1 }),
      candidate({ id: 'cheap-cloud', isLocal: false, cost: 'free', preference: 999 }),
      candidate({ id: 'oauth-cloud', isLocal: false, credentialClass: 'oauth', cost: 'free' }),
    ];
    const { eligible, rejected } = computeEligible({ ...base, touchesSecrets: true }, registry);
    expect(eligible.map((c) => c.id)).toEqual(['local']);
    expect(rejected).toEqual(
      expect.arrayContaining([
        { id: 'cheap-cloud', reason: 'secret-requires-local' },
        { id: 'oauth-cloud', reason: 'secret-requires-local' },
      ]),
    );
  });

  it('bars codex (OAuth, non-local) under secrets — isLocal, not credentialClass, is the secret axis', () => {
    const registry = [candidate({ id: 'codex', toolType: 'cli', isLocal: false, credentialClass: 'oauth' })];
    const { eligible, rejected } = computeEligible({ ...base, touchesSecrets: true }, registry);
    expect(eligible).toHaveLength(0);
    expect(rejected).toEqual([{ id: 'codex', reason: 'secret-requires-local' }]);
  });

  it('bars an isLocal-but-cloud-credential entry under secrets (both signals required)', () => {
    // Defense in depth: a mislabeled `isLocal:true` on an egressing backend must
    // NOT pass the secret bar — credentialClass must also be 'local'.
    const registry = [
      candidate({ id: 'mislabeled', isLocal: true, credentialClass: 'api-key', toolType: 'gemini-api' }),
      candidate({ id: 'honest-local', isLocal: true, credentialClass: 'local', toolType: 'local' }),
    ];
    const { eligible, rejected } = computeEligible({ ...base, touchesSecrets: true }, registry);
    expect(eligible.map((c) => c.id)).toEqual(['honest-local']);
    expect(rejected).toEqual([{ id: 'mislabeled', reason: 'secret-requires-local' }]);
  });

  it('rejects non-web candidates when the run needs web', () => {
    const registry = [
      candidate({ id: 'web', capabilities: { web: true, taskKinds: ['general'] } }),
      candidate({ id: 'noweb', capabilities: { web: false, taskKinds: ['general'] } }),
    ];
    const { eligible } = computeEligible({ ...base, needsWeb: true }, registry);
    expect(eligible.map((c) => c.id)).toEqual(['web']);
  });

  it('rejects api-key backends for unattended runs', () => {
    const registry = [
      candidate({ id: 'key', credentialClass: 'api-key' }),
      candidate({ id: 'oauth', credentialClass: 'oauth' }),
      candidate({ id: 'local', isLocal: true, credentialClass: 'local' }),
    ];
    const { eligible, rejected } = computeEligible({ ...base, unattended: true }, registry);
    expect(eligible.map((c) => c.id).sort()).toEqual(['local', 'oauth']);
    expect(rejected).toEqual([{ id: 'key', reason: 'unattended-credential' }]);
  });

  it('rejects over-budget cost and latency with the right reason', () => {
    const registry = [
      candidate({ id: 'pricey', cost: 'high' }),
      candidate({ id: 'slow', latency: 'slow' }),
      candidate({ id: 'ok', cost: 'low', latency: 'fast' }),
    ];
    const { eligible, rejected } = computeEligible(
      { ...base, budget: { maxCostTier: 'medium', maxLatencyTier: 'fast' } },
      registry,
    );
    expect(eligible.map((c) => c.id)).toEqual(['ok']);
    expect(rejected).toEqual(
      expect.arrayContaining([
        { id: 'pricey', reason: 'over-budget-cost' },
        { id: 'slow', reason: 'over-budget-latency' },
      ]),
    );
  });

  it('rejects task-kind-unsupported candidates', () => {
    const registry = [candidate({ id: 'codeonly', capabilities: { web: false, taskKinds: ['code'] } })];
    const { rejected } = computeEligible({ ...base, taskKind: 'prose' }, registry);
    expect(rejected).toEqual([{ id: 'codeonly', reason: 'task-kind-unsupported' }]);
  });

  it('evaluates the secret bar FIRST when a candidate fails multiple predicates', () => {
    // cloud + no web, run touches secrets AND needs web: secret reason wins (order).
    const registry = [candidate({ id: 'x', isLocal: false, capabilities: { web: false, taskKinds: ['general'] } })];
    const { rejected } = computeEligible({ ...base, touchesSecrets: true, needsWeb: true }, registry);
    expect(rejected).toEqual([{ id: 'x', reason: 'secret-requires-local' }]);
  });
});
