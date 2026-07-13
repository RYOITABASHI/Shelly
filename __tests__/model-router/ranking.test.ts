import { compareCandidates, rankEligible } from '@/lib/model-router/ranking';
import { DEFAULT_ROUTING_POLICY, ModelCandidate } from '@/lib/model-router';

function candidate(over: Partial<ModelCandidate> & { id: string }): ModelCandidate {
  return {
    id: over.id,
    toolType: over.toolType ?? 'local',
    isLocal: over.isLocal ?? false,
    credentialClass: over.credentialClass ?? 'api-key',
    capabilities: over.capabilities ?? { web: false, taskKinds: ['general'] },
    cost: over.cost ?? 'low',
    latency: over.latency ?? 'fast',
    preference: over.preference ?? 10,
  };
}

describe('MODEL-001 ranking', () => {
  it('orders cost asc → latency asc → preference desc → id asc', () => {
    const ranked = rankEligible(
      [
        candidate({ id: 'b', cost: 'low', latency: 'fast', preference: 5 }),
        candidate({ id: 'a', cost: 'low', latency: 'fast', preference: 5 }),
        candidate({ id: 'cheapest', cost: 'free', latency: 'slow', preference: 1 }),
        candidate({ id: 'pref', cost: 'low', latency: 'fast', preference: 50 }),
      ],
      DEFAULT_ROUTING_POLICY,
    );
    // cheapest (free) first; then preference 50; then id-tiebreak a before b.
    expect(ranked.map((c) => c.id)).toEqual(['cheapest', 'pref', 'a', 'b']);
  });

  it('onDeviceFirst breaks an otherwise-exact tie toward the local candidate', () => {
    const local = candidate({ id: 'zzz-local', isLocal: true, cost: 'low', latency: 'fast', preference: 5 });
    const cloud = candidate({ id: 'aaa-cloud', isLocal: false, cost: 'low', latency: 'fast', preference: 5 });
    expect(compareCandidates(local, cloud, { onDeviceFirst: true })).toBeLessThan(0);
    // With onDeviceFirst off, the id tiebreak wins (aaa < zzz).
    expect(compareCandidates(local, cloud, { onDeviceFirst: false })).toBeGreaterThan(0);
  });

  it('is a pure, stable total order (no clock/random)', () => {
    const input = [
      candidate({ id: 'a', cost: 'low' }),
      candidate({ id: 'b', cost: 'free' }),
      candidate({ id: 'c', cost: 'medium' }),
    ];
    const once = rankEligible(input, DEFAULT_ROUTING_POLICY).map((c) => c.id);
    const twice = rankEligible([...input].reverse(), DEFAULT_ROUTING_POLICY).map((c) => c.id);
    expect(once).toEqual(twice);
  });
});
