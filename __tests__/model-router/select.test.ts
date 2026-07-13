import { selectModel } from '@/lib/model-router/select';
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

const base: RunRequirements = { taskKind: 'general', needsWeb: false, touchesSecrets: false, unattended: false };

describe('MODEL-001 selectModel', () => {
  it('returns the top-ranked eligible candidate on the happy path', () => {
    const registry = [
      candidate({ id: 'local', isLocal: true, credentialClass: 'local', cost: 'medium' }),
      candidate({ id: 'cheap', cost: 'free', latency: 'instant' }),
    ];
    const res = selectModel(base, registry);
    expect(res.chosen?.id).toBe('cheap'); // free/instant wins on cost/latency
    expect(res.rejected).toHaveLength(0);
  });

  it('DENIES (chosen:null) when nothing is eligible — never a silent cloud fallback', () => {
    const registry = [
      candidate({ id: 'cloud-a', isLocal: false }),
      candidate({ id: 'cloud-b', isLocal: false, credentialClass: 'oauth' }),
    ];
    const res = selectModel({ ...base, touchesSecrets: true }, registry);
    expect(res.chosen).toBeNull();
    expect(res.eligible).toHaveLength(0);
    expect(res.rejected.map((r) => r.reason)).toEqual(['secret-requires-local', 'secret-requires-local']);
  });

  it('eligibility runs before ranking: a secret run cannot pick the cheapest/most-preferred cloud model', () => {
    const registry = [
      candidate({ id: 'best-cloud', isLocal: false, cost: 'free', latency: 'instant', preference: 999 }),
      candidate({ id: 'local', isLocal: true, credentialClass: 'local', cost: 'high', latency: 'slow', preference: 1 }),
    ];
    const res = selectModel({ ...base, touchesSecrets: true }, registry);
    expect(res.chosen?.id).toBe('local'); // ranking never sees best-cloud
    expect(res.rejected).toEqual([{ id: 'best-cloud', reason: 'secret-requires-local' }]);
  });

  it('is deterministic for unattended runs (same + shuffled registry → identical result)', () => {
    const registry = [
      candidate({ id: 'local', isLocal: true, credentialClass: 'local', cost: 'low' }),
      candidate({ id: 'codex', toolType: 'cli', credentialClass: 'oauth', cost: 'low' }),
      candidate({ id: 'groq', credentialClass: 'api-key', cost: 'free' }), // barred: unattended api-key
    ];
    const reqs: RunRequirements = { ...base, unattended: true };
    const a = selectModel(reqs, registry);
    const b = selectModel(reqs, [...registry].reverse());
    expect(a.chosen?.id).toBe(b.chosen?.id);
    expect(a.eligible.map((c) => c.id)).toEqual(b.eligible.map((c) => c.id));
    expect(a.rejected).toEqual([{ id: 'groq', reason: 'unattended-credential' }]);
  });
});
