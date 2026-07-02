// EVENT-001 event.queue — dormant wiring seam.
//
// This file documents the future migration WITHOUT enabling it. The queue is
// implemented (pure core + adapters + tests) but not wired into any production
// dispatch path: EVENT_QUEUE_ENABLED stays false, and no native/scheduler code
// imports this. "実装されるが有効化はされない."
//
// MIGRATION (deferred, flag-ON step, out of scope until the floor is verified):
//   1. Native alarm → trigger. TerminalSessionService.ACTION_RUN_AGENT and
//      AgentAlarmScheduler.scheduleNext stop calling runAgentInBackground
//      directly and instead enqueue the shape produced by
//      buildScheduledFireEnqueue below; a single consumer lease()s → dispatches.
//      Until that step the alarm path is byte-preserved.
//   2. G4 router / G5 inbound / pollers become producers (enqueue) + consumers
//      (lease→dispatch→ack/nack).
//   3. Consumer loop owner (TS foreground vs native FGS) — a design fork to
//      decide before flag-ON; it also determines whether
//      EVENT_QUEUE_SCHEMA_VERSION needs a native/script mirror (see types.ts).

import { EnqueueInput, QueueSource } from './types';

// Master dormancy switch. Never flipped by this /goal — flipping it is the
// separate "enable" decision, gated on a device-verified floor.
export const EVENT_QUEUE_ENABLED = false;

export interface ScheduledFirePayload {
  agentId: string;
  intervalMs: number;
  cron: string | null;
}

export const AGENT_RUN_TOPIC = 'agent.run';

// Documents the native-alarm → enqueue mapping without invoking any production
// path. When the alarm path is migrated (step 1 above), the fire produces
// exactly this input.
export function buildScheduledFireEnqueue(
  agentId: string,
  intervalMs: number,
  cron: string | null,
): EnqueueInput<ScheduledFirePayload> {
  const source: QueueSource = 'schedule';
  return {
    topic: AGENT_RUN_TOPIC,
    source,
    payload: { agentId, intervalMs, cron },
    // One pending scheduled fire per agent at a time — a re-arm that lands
    // before the prior fire is consumed collapses onto the same record.
    dedupKey: `${AGENT_RUN_TOPIC}:${agentId}`,
  };
}
