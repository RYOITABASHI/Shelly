// EVENT-001 event.queue — deterministic retry backoff.
//
// Pure: no clock, no randomness unless an rng is explicitly injected (and only
// consulted when the policy enables jitter). Exponential with a hard cap.

import { RetryPolicy } from './types';

// Fraction of the base delay that jitter may add (0..jitterFraction).
const JITTER_FRACTION = 0.5;

// attempts is the number of deliveries so far (>=1 when a record is being
// requeued after its first failed attempt). The first retry uses baseMs.
export function computeBackoffMs(
  attempts: number,
  policy: RetryPolicy,
  rng?: () => number,
): number {
  const exponent = Math.max(0, attempts - 1);
  const raw = policy.baseMs * Math.pow(policy.factor, exponent);
  let delay = raw;
  if (policy.jitter && rng) {
    delay = delay * (1 + rng() * JITTER_FRACTION);
  }
  // Cap AFTER jitter so maxMs is a true hard ceiling — jitter must not push the
  // delay past the stated bound.
  return Math.round(Math.min(policy.maxMs, delay));
}

// Convenience: the absolute epoch-ms visibility time for the next retry.
export function nextVisibleAt(
  now: number,
  attempts: number,
  policy: RetryPolicy,
  rng?: () => number,
): number {
  return now + computeBackoffMs(attempts, policy, rng);
}
