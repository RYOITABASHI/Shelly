// MEMORY-001 memory layer — public surface.
//
// Dormant Phase 1 primitive: a thin namespaced get/put/query memory store over
// FS-001 scoped.fs, reproducing G2's recall ranking. Flag-OFF (see wiring.ts);
// no production path imports it yet. The deferred sqlite-FTS5 and llama
// embedding adapters are intentionally NOT re-exported until the flag-ON cutover.

export * from './types';
export { deriveKey, tokenize, scoreRecord, rankHits } from './ranking';
export { cosineSimilarity } from './ranking-semantic';
export { MemoryStore } from './memory-store';
export type { MemoryStoreOptions, PutInput } from './memory-store';
export { InMemoryMemoryStorage } from './storage-memory';
export { JsonFileMemoryStorage, assertWithinRoot } from './storage-json';
export type { JsonFileMemoryStorageOptions } from './storage-json';
export {
  MEMORY_ENABLED,
  MEMORY_EMBEDDING_ENABLED,
  agentNamespace,
  g2NoteToRecord,
  recordsToRecallContext,
} from './wiring';
// Track C (MEMORY-001, see DEFERRED.md): pure PII/taint classifier, same
// shape as lib/secret-guard.ts. Kept separate from that module on purpose.
export { scanForPii } from './pii-guard';
export type { PiiGuardKind, PiiGuardResult } from './pii-guard';
// Track B (MEMORY-001, see DEFERRED.md): dev-machine plaintext cleanup.
export { cleanupStalePlaintextMemoryFiles, isPreEncryptionRecordFile } from './dev-data-cleanup';
export type { CleanupResult } from './dev-data-cleanup';
