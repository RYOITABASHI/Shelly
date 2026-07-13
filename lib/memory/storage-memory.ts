// MEMORY-001 memory layer — in-memory storage adapter.
//
// Default backend for host tests. Pure: a nested Map (namespace -> key ->
// record) with a defensive copy on every boundary. query() ranks via the shared
// rankHits so it matches the file/sqlite adapters.

import { rankHits } from './ranking';
import {
  MemoryHit,
  MemoryRecord,
  MemoryStorageAdapter,
  ResolvedQuery,
} from './types';

function clone(record: MemoryRecord): MemoryRecord {
  return JSON.parse(JSON.stringify(record)) as MemoryRecord;
}

export class InMemoryMemoryStorage implements MemoryStorageAdapter {
  private store = new Map<string, Map<string, MemoryRecord>>();

  private ns(namespace: string): Map<string, MemoryRecord> {
    let m = this.store.get(namespace);
    if (!m) {
      m = new Map();
      this.store.set(namespace, m);
    }
    return m;
  }

  async put(record: MemoryRecord): Promise<void> {
    this.ns(record.namespace).set(record.key, clone(record));
  }

  async get(namespace: string, key: string): Promise<MemoryRecord | null> {
    const r = this.store.get(namespace)?.get(key);
    return r ? clone(r) : null;
  }

  async query(namespace: string, q: ResolvedQuery): Promise<MemoryHit[]> {
    const records = [...(this.store.get(namespace)?.values() ?? [])].map(clone);
    return rankHits(records, q);
  }

  async delete(namespace: string, key: string): Promise<void> {
    this.store.get(namespace)?.delete(key);
  }

  async list(namespace: string): Promise<MemoryRecord[]> {
    return [...(this.store.get(namespace)?.values() ?? [])].map(clone);
  }
}
