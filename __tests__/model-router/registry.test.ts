import { MODEL_REGISTRY } from '@/lib/model-router/registry';
import { candidateToToolChoice } from '@/lib/model-router/wiring';
import { credentialClass } from '@/lib/agent-credential-policy';

describe('MODEL-001 registry parity with the cloud/local source of truth', () => {
  it('isLocal is true iff credentialClass is local', () => {
    for (const c of MODEL_REGISTRY) {
      expect(c.isLocal).toBe(c.credentialClass === 'local');
    }
  });

  it("each entry's credentialClass matches agent-credential-policy for its ToolChoice", () => {
    for (const c of MODEL_REGISTRY) {
      expect(c.credentialClass).toBe(credentialClass(candidateToToolChoice(c)));
    }
  });

  it('has exactly one on-device (isLocal) candidate', () => {
    expect(MODEL_REGISTRY.filter((c) => c.isLocal)).toHaveLength(1);
  });

  it('has stable unique ids', () => {
    const ids = MODEL_REGISTRY.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('web-capable set mirrors the live escalation ladder (Gemini grounded + Perplexity)', () => {
    // agent-escalation-ladder.ts web primaries: general → Gemini (grounded),
    // academic → Perplexity. Both must be web-capable here or a flag-ON would
    // mis-route general web tasks to the paid deep-research tier (or deny).
    const web = MODEL_REGISTRY.filter((c) => c.capabilities.web).map((c) => c.id).sort();
    expect(web).toEqual(['gemini-api', 'perplexity']);
  });
});
