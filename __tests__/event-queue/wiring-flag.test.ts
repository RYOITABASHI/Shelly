import {
  AGENT_RUN_TOPIC,
  buildScheduledFireEnqueue,
  EVENT_QUEUE_ENABLED,
} from '@/lib/event-queue/wiring';

describe('EVENT-001 dormancy + wiring seam', () => {
  it('ships disabled — the queue is implemented but not enabled', () => {
    expect(EVENT_QUEUE_ENABLED).toBe(false);
  });

  it('buildScheduledFireEnqueue produces a well-formed schedule input without touching production', () => {
    const input = buildScheduledFireEnqueue('agent-42', 3600000, '0 * * * *');
    expect(input.topic).toBe(AGENT_RUN_TOPIC);
    expect(input.source).toBe('schedule');
    expect(input.payload).toEqual({
      agentId: 'agent-42',
      intervalMs: 3600000,
      cron: '0 * * * *',
    });
    // One pending scheduled fire per agent — re-arm collapses onto the same key.
    expect(input.dedupKey).toBe('agent.run:agent-42');
  });

  it('accepts a null cron (interval-only schedule)', () => {
    const input = buildScheduledFireEnqueue('agent-1', 60000, null);
    expect(input.payload.cron).toBeNull();
  });
});
