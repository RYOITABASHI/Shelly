import {
  MODEL_ROUTER_ENABLED,
  toRunRequirements,
  candidateToToolChoice,
  selectModel,
  MODEL_REGISTRY,
} from '@/lib/model-router';
import { scanForSecrets } from '@/lib/secret-guard';

describe('MODEL-001 dormancy + cutover mappers', () => {
  it('ships disabled', () => {
    expect(MODEL_ROUTER_ENABLED).toBe(false);
  });

  it('toRunRequirements derives touchesSecrets from the secret-guard result (booleans only reach the router)', () => {
    const clean = toRunRequirements({
      taskKind: 'general',
      needsWeb: false,
      secret: scanForSecrets('just a normal task about gardening'),
      unattended: false,
    });
    expect(clean.touchesSecrets).toBe(false);

    const secret = toRunRequirements({
      taskKind: 'code',
      needsWeb: true,
      secret: scanForSecrets('deploy with api_key=sk-abcdef0123456789ghjklmno'),
      unattended: true,
    });
    expect(secret.touchesSecrets).toBe(true);
    // No prompt/secret text field exists on the router boundary.
    expect(Object.values(secret).some((v) => typeof v === 'string' && v.includes('sk-'))).toBe(false);
  });

  it('a secret-bearing run selects on-device over the full shipped registry (cutover parity net)', () => {
    const reqs = toRunRequirements({
      taskKind: 'general',
      needsWeb: false,
      secret: scanForSecrets('token is api_key=sk-abcdef0123456789ghjklmno'),
      unattended: false,
    });
    const res = selectModel(reqs, MODEL_REGISTRY);
    expect(res.chosen?.isLocal).toBe(true);
    // every non-local shipped candidate is barred for the secret run
    expect(res.rejected.every((r) => r.reason === 'secret-requires-local')).toBe(true);
  });

  it('candidateToToolChoice round-trips each toolType to a valid ToolChoice', () => {
    for (const c of MODEL_REGISTRY) {
      const tc = candidateToToolChoice(c);
      expect(tc.type).toBe(c.toolType);
    }
    expect(candidateToToolChoice({ ...MODEL_REGISTRY[0], toolType: 'cli' })).toEqual({ type: 'cli', cli: 'codex' });
  });
});
