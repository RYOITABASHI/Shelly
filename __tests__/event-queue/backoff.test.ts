import { computeBackoffMs, nextVisibleAt } from '@/lib/event-queue/backoff';
import { RetryPolicy } from '@/lib/event-queue/types';

const policy: RetryPolicy = { baseMs: 1000, factor: 2, maxMs: 10000, jitter: false };

describe('computeBackoffMs', () => {
  it('is exponential from the first retry and caps at maxMs', () => {
    expect(computeBackoffMs(1, policy)).toBe(1000);
    expect(computeBackoffMs(2, policy)).toBe(2000);
    expect(computeBackoffMs(3, policy)).toBe(4000);
    expect(computeBackoffMs(4, policy)).toBe(8000);
    expect(computeBackoffMs(5, policy)).toBe(10000); // capped
    expect(computeBackoffMs(50, policy)).toBe(10000);
  });

  it('treats attempts<=1 as the base delay', () => {
    expect(computeBackoffMs(0, policy)).toBe(1000);
    expect(computeBackoffMs(1, policy)).toBe(1000);
  });

  it('applies deterministic jitter only when enabled and rng provided', () => {
    const jittered: RetryPolicy = { ...policy, jitter: true };
    // rng=1 → +50% of the raw delay (here raw==base, below the cap)
    expect(computeBackoffMs(1, jittered, () => 1)).toBe(1500);
    // no rng → no jitter even if the policy asks for it
    expect(computeBackoffMs(1, jittered)).toBe(1000);
    // jitter never applied when policy.jitter is false
    expect(computeBackoffMs(1, policy, () => 1)).toBe(1000);
  });

  it('keeps maxMs a hard ceiling even with jitter (cap applied after jitter)', () => {
    const jittered: RetryPolicy = { ...policy, jitter: true };
    // attempts=5 → raw 16000, jittered ×1.5 = 24000, but must clamp to maxMs.
    expect(computeBackoffMs(5, jittered, () => 1)).toBe(policy.maxMs);
    expect(computeBackoffMs(50, jittered, () => 1)).toBe(policy.maxMs);
  });
});

describe('nextVisibleAt', () => {
  it('adds the backoff to now', () => {
    expect(nextVisibleAt(5000, 2, policy)).toBe(5000 + 2000);
  });
});
