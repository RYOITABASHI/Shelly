// EVENT-001 event.queue — in-memory storage adapter.
//
// The default backend for host tests and any ephemeral use. Pure: a Map with a
// defensive copy on every boundary so callers cannot alias internal state.

import { QueueRecord, QueueStorageAdapter } from './types';

function clone(record: QueueRecord): QueueRecord {
  return JSON.parse(JSON.stringify(record)) as QueueRecord;
}

export class InMemoryQueueStorage implements QueueStorageAdapter {
  private store = new Map<string, QueueRecord>();

  async loadAll(): Promise<QueueRecord[]> {
    return [...this.store.values()].map(clone);
  }

  async put(record: QueueRecord): Promise<void> {
    this.store.set(record.id, clone(record));
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }
}
