import {
  consecutiveFailures,
  shouldTripCircuitBreaker,
  DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
} from '@/lib/agent-circuit-breaker';
import { AgentRunLog } from '@/store/types';

const log = (status: AgentRunLog['status'], t = 0): AgentRunLog => ({
  agentId: 'a',
  timestamp: t,
  status,
  outputPreview: '',
  durationMs: 0,
  toolUsed: 'x',
});

describe('agent circuit breaker', () => {
  it('counts trailing consecutive errors', () => {
    expect(consecutiveFailures([log('error'), log('error'), log('error')])).toBe(3);
    expect(consecutiveFailures([log('success'), log('error'), log('error')])).toBe(2);
  });

  it("a 'success' breaks the streak (counts from the end)", () => {
    expect(consecutiveFailures([log('error'), log('error'), log('success')])).toBe(0);
    expect(consecutiveFailures([log('error'), log('success'), log('error')])).toBe(1);
  });

  it("a 'skipped' (cli declined) is NOT a failure and resets the streak", () => {
    // cli fail-closed 'skipped' must not trip the breaker.
    expect(consecutiveFailures([log('error'), log('error'), log('skipped')])).toBe(0);
    expect(shouldTripCircuitBreaker([log('error'), log('error'), log('skipped')])).toBe(false);
  });

  it('trips at exactly the threshold (default 3)', () => {
    expect(DEFAULT_CIRCUIT_BREAKER_THRESHOLD).toBe(3);
    expect(shouldTripCircuitBreaker([log('error'), log('error')])).toBe(false);
    expect(shouldTripCircuitBreaker([log('error'), log('error'), log('error')])).toBe(true);
    expect(shouldTripCircuitBreaker([log('error'), log('error'), log('error'), log('error')])).toBe(true);
  });

  it('respects a custom threshold', () => {
    expect(shouldTripCircuitBreaker([log('error'), log('error')], 2)).toBe(true);
    expect(shouldTripCircuitBreaker([log('error')], 2)).toBe(false);
  });

  it('does not trip on empty / undefined / too-few logs', () => {
    expect(shouldTripCircuitBreaker([])).toBe(false);
    expect(shouldTripCircuitBreaker(undefined)).toBe(false);
    expect(shouldTripCircuitBreaker([log('error')])).toBe(false);
  });

  it('a long healthy history with a recent error burst trips only on 3 trailing', () => {
    const history = [
      log('success'), log('success'), log('skipped'),
      log('error'), log('error'), log('error'),
    ];
    expect(shouldTripCircuitBreaker(history)).toBe(true);
    // but if the last run recovered, it must NOT trip
    expect(shouldTripCircuitBreaker([...history, log('success')])).toBe(false);
  });
});
