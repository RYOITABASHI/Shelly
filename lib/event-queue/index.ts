// EVENT-001 event.queue — public surface.
//
// Dormant Phase 1 primitive: a durable at-least-once queue that unifies
// schedule/inbound/poller/retry/lease origins. Flag-OFF (see wiring.ts); no
// production dispatch path imports it yet.

export * from './types';
export { computeBackoffMs, nextVisibleAt } from './backoff';
export { EventQueue } from './event-queue';
export type { EventQueueOptions } from './event-queue';
export { InMemoryQueueStorage } from './storage-memory';
export { JsonFileQueueStorage } from './storage-json';
export {
  EVENT_QUEUE_ENABLED,
  AGENT_RUN_TOPIC,
  buildScheduledFireEnqueue,
} from './wiring';
export type { ScheduledFirePayload } from './wiring';
