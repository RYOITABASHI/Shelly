// MEMORY-001 memory layer — bundled-sqlite FTS5 storage adapter (DEFERRED).
//
// Interface-conformant skeleton only. The bundled-sqlite native binding is not
// loadable in the jest node env, so this adapter is host-UNtestable; the memory
// contract is proven on the pure in-memory + JSON-file path (which reproduces
// FTS ordering via the shared rankHits). This file pulls NO native dependency at
// module load — the sqlite handle is opened lazily inside methods, only on
// device and only behind MEMORY_ENABLED. It is intentionally NOT re-exported
// from index.ts until the flag-ON cutover.
//
// FTS5 mapping (to implement at cutover): one row per record in an
// `fts5(text, tags, content=...)` virtual table; query() = `... MATCH ?
// ORDER BY bm25(...)`, whose ordering MUST match lib/memory/ranking.ts rankHits
// (tag-weighted overlap, recency tiebreak) so recall parity holds across the
// JSON<->sqlite choice. put() = upsert by (namespace, key); delete()/list()
// scoped by namespace column.

import {
  MemoryHit,
  MemoryRecord,
  MemoryStorageAdapter,
  ResolvedQuery,
} from './types';

const NOT_WIRED =
  'SqliteFtsMemoryStorage is deferred until the MEMORY-001 flag-ON cutover';

export interface SqliteFtsMemoryStorageOptions {
  // Path to the bundled-sqlite database file (device-only, scoped.fs jailed).
  dbPath: string;
}

export class SqliteFtsMemoryStorage implements MemoryStorageAdapter {
  private readonly dbPath: string;

  constructor(opts: SqliteFtsMemoryStorageOptions) {
    // No native binding opened here — construction is cheap and dep-free.
    this.dbPath = opts.dbPath;
  }

  async put(_record: MemoryRecord): Promise<void> {
    throw new Error(NOT_WIRED);
  }

  async get(_namespace: string, _key: string): Promise<MemoryRecord | null> {
    throw new Error(NOT_WIRED);
  }

  async query(_namespace: string, _q: ResolvedQuery): Promise<MemoryHit[]> {
    throw new Error(NOT_WIRED);
  }

  async delete(_namespace: string, _key: string): Promise<void> {
    throw new Error(NOT_WIRED);
  }

  async list(_namespace: string): Promise<MemoryRecord[]> {
    throw new Error(NOT_WIRED);
  }
}
