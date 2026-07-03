// MEMORY-001 memory layer — dormant wiring seam + G2 migration helpers.
//
// Documents the future cutover from G2 (lib/agent-memory.ts) WITHOUT enabling
// it. Memory is implemented (pure core + adapters + tests) but wired into no
// production path: MEMORY_ENABLED stays false, G2 remains the live memory path
// and its on-disk .md notes stay authoritative and byte-preserved.
// "実装されるが有効化はされない."
//
// MIGRATION (deferred, flag-ON step, out of scope until the floor is verified):
//   1. Flip MEMORY_ENABLED. One-time importer: readMemoryNotes(agentId) ->
//      g2NoteToRecord -> MemoryStore.put; G2 .md files left untouched (reversible
//      dual-copy).
//   2. agent-manager swaps readMemoryNotes/recallMemoryNotes/writeMemoryNote for
//      MemoryStore.query/put + recordsToRecallContext; Sidebar count -> list().length.
//   3. Choose device backend (JSON vs sqlite-FTS5) and per-agent vs per-skill
//      namespace granularity at cutover.
//   Ranking parity is the safety net: MemoryStore's full-text ranking reuses the
//   exact G2 scoring, so recall ordering is preserved across the cutover.

import type { MemoryNote } from '@/lib/agent-memory';
import { MemoryHit, MemoryRecord, MEMORY_SCHEMA_VERSION } from './types';

// Master dormancy switch. Never flipped by this work — flipping it is the
// separate "enable" decision, gated on a device-verified floor.
export const MEMORY_ENABLED = false;

// Optional semantic re-rank via localhost llama-server, broker-mediated only.
// Off by default and independent of MEMORY_ENABLED.
export const MEMORY_EMBEDDING_ENABLED = false;

// Per-agent namespace today (documents the per-agent-now / per-skill-later
// generalization noted in the spec). Deterministic and stable.
export function agentNamespace(agentId: string): string {
  return agentId;
}

// Map a live G2 note onto a MemoryRecord. id->key, agentId->namespace,
// type->kind, ISO created -> epoch ms (createdAt==updatedAt at import), tags/text
// preserved. A bad ISO timestamp falls back to 0 so the import never throws.
export function g2NoteToRecord(note: MemoryNote): MemoryRecord {
  const parsed = Date.parse(note.created);
  const createdAt = Number.isNaN(parsed) ? 0 : parsed;
  return {
    namespace: agentNamespace(note.agentId),
    key: note.id,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    kind: note.type,
    text: note.text,
    tags: note.tags,
    createdAt,
    updatedAt: createdAt,
  };
}

// Reproduce G2 buildRecallContext's format from ranked records, so a recalled
// block still flows through the same secret-guard scan as the G2 path.
export function recordsToRecallContext(hits: MemoryHit[]): string {
  if (hits.length === 0) return '';
  const MAX_RECALL_NOTE_CHARS = 400;
  const lines = hits.map((h) => {
    const text = h.record.text.replace(/\s+/g, ' ').slice(0, MAX_RECALL_NOTE_CHARS);
    return `- [${h.record.kind}] ${text}`;
  });
  return [
    '# Remembered context (on-device memory)',
    'These facts were saved from earlier runs or by the user. Use them if relevant.',
    ...lines,
  ].join('\n');
}
