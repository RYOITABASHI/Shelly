// MEMORY-001 memory layer — shared types and ports.
//
// Pure, dependency-free contract for the Phase 1 memory primitive: a thin
// get/put/query store, namespaced per skill/agent, over an injected storage
// adapter. Imports nothing at runtime — the core (memory-store.ts) and every
// adapter depend only on these types plus injected ports, so the whole
// primitive is host-testable and free of Date.now / fs / expo.
//
// Dormant: nothing here is wired into a production path yet (see wiring.ts,
// MEMORY_ENABLED). The live memory path is still G2 (lib/agent-memory.ts),
// which is byte-preserved. "実装されるが有効化はされない."

// Bump only alongside a persisted-record shape change. FUTURE LOCKSTEP POINT:
// once the bundled-sqlite adapter or a native/script consumer reads persisted
// records, mirror this exactly like PLAN_SPEC_SCHEMA_VERSION (TS constant +
// script asset + AgentRuntime.CURRENT_* + a parity test). No mirror is required
// while memory is a dormant TS-only library. See wiring.ts §migration.
export const MEMORY_SCHEMA_VERSION = 1;

// Open string union: 'fact' | 'preference' | 'result' mirror G2's MemoryNoteType
// (byte-preserved), but callers may namespace other kinds. Default is 'fact'.
export type MemoryKind = 'fact' | 'preference' | 'result' | (string & {});

export interface MemoryRecord {
  // Per-skill (per-agent today — see wiring.ts §migration) isolation boundary.
  namespace: string;
  // Stable id within the namespace (deterministic from content, or caller-supplied).
  key: string;
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  kind: MemoryKind;
  // Searchable body.
  text: string;
  tags: string[];
  // Epoch ms (injected Clock — no Date.now in the core).
  createdAt: number;
  updatedAt: number;
  // Small opaque kv; never interpreted by the query.
  metadata?: Record<string, string>;
  // Present only when an EmbeddingPort produced it (semantic/hybrid mode).
  embedding?: number[];
}

export type MemoryMode = 'fulltext' | 'semantic' | 'hybrid';

export interface MemoryQuery {
  // Full-text query. Empty/undefined => recency listing.
  text?: string;
  // Optional AND filter on tags.
  tags?: string[];
  // Optional filter on kind.
  kind?: MemoryKind;
  limit?: number;
  // Default 'fulltext'. 'semantic'/'hybrid' require an EmbeddingPort; without
  // one they silently degrade to 'fulltext'.
  mode?: MemoryMode;
}

export interface ResolvedQuery {
  text: string;
  tags: string[];
  kind?: MemoryKind;
  limit: number;
  mode: MemoryMode;
}

export interface MemoryHit {
  record: MemoryRecord;
  score: number;
}

// The single storage boundary. One JSON file per record (host/device) or one
// FTS5 row (deferred, flag-gated). Scoped to a namespace on every call.
export interface MemoryStorageAdapter {
  put(record: MemoryRecord): Promise<void>; // upsert by (namespace, key)
  get(namespace: string, key: string): Promise<MemoryRecord | null>;
  query(namespace: string, q: ResolvedQuery): Promise<MemoryHit[]>; // ranked, ns-scoped
  delete(namespace: string, key: string): Promise<void>;
  list(namespace: string): Promise<MemoryRecord[]>; // inspection / migration
}

// Injected, OPTIONAL. Never required by the core or host tests. Implementations
// must stay local (llama-server) and broker-mediated — never a cloud embedder.
export interface EmbeddingPort {
  embed(texts: string[]): Promise<number[][]>;
}

// Injected clock — the core never reads wall-clock time directly.
export interface Clock {
  now(): number;
}

// Adapter boundary port for file-backed storage. Mirrors EVENT-001's FsPort so
// the same node-fs / expo-file-system implementations satisfy both by shape.
export interface FsPort {
  readFile(path: string): Promise<string | null>;
  writeFileAtomic(path: string, data: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  listFiles(dir: string): Promise<string[]>;
  ensureDir(dir: string): Promise<void>;
}

export const DEFAULT_RECALL_LIMIT = 5;
