// MEMORY-001 memory layer — activated wiring seam + G2 mirror-import helpers.
//
// Documents the cutover from G2 (lib/agent-memory.ts) to the MEMORY-001 store.
// MEMORY_ENABLED flipped true on 2026-08-05 (see the flag's own comment below
// for the "why now"), so the cutover this file documents is LIVE, not just
// planned. G2 has NOT been decommissioned and is not merely a fallback stub:
// its .md notes remain on disk, untouched and byte-preserved, and every
// activated call site (agent-manager.ts's applyMemoryAndSkills /
// persistRememberFact / captureRunMemory, Sidebar.tsx's / MemoryWorkbenchPane's
// detail reads) falls back to a G2 read/write on ANY internal MEMORY-001
// failure. This is a strangler pattern mid-strangle, not a completed
// migration: read lib/memory/shadow.ts's importAndQuery/ensureAgentImported
// before assuming "migrated" means "G2 is gone" — it does not, here.
// "実装され、有効化もされた（が G2 は退役していない）."
//
// STATE OF THE CUTOVER (verified against current code, not the original plan):
//   1. NOT a one-time batch importer. There is no migration script that mirrors
//      every existing G2 note into MemoryStore at flip time. Instead, each
//      namespace (an agent's id, or `_global`) is mirrored LAZILY the first
//      time anything touches it in a given app session — shadow.ts's
//      importAndQuery (hot recall/write path) and ensureAgentImported (Sidebar
//      / Memory Workbench CRUD path) both do
//      `readMemoryNotes(agentId) -> g2NoteToRecord -> adapter.put`, gated by a
//      session-scoped `importedAgents` Set so it only runs once per namespace
//      per app launch. A namespace nothing has touched yet this session still
//      exists ONLY as G2 .md files until its next lazy import.
//   2. DONE for per-agent recall/write/list: agent-manager.ts's
//      applyMemoryAndSkills / persistRememberFact / captureRunMemory, and
//      Sidebar.tsx's / MemoryWorkbenchPane.tsx's detail reads, all call
//      activateMemoryRecall/activateMemoryWrite/activateMemoryList as the
//      PRIMARY path now, falling back to G2's own
//      readMemoryNotes/recallMemoryNotes/writeMemoryNote only when the
//      MEMORY-001 call reports an internal failure (null/false return).
//      NOT done for the `_global` scope's writes specifically:
//      writeGlobalMemoryNote (lib/agent-manager.ts) still writes G2 only and
//      never attempts activateMemoryWrite — see that function's own comment
//      for the gap.
//   3. Device backend is JSON (JsonFileMemoryStorage over Expo FS, at-rest
//      encrypted — see crypto-expo.ts); the sqlite-FTS5 alternative from the
//      original design was never built. Namespace granularity is per-agent
//      (agentNamespace() below returns agentId as-is); per-skill namespacing
//      was never implemented either.
//   Ranking parity remains the safety net: MemoryStore's full-text ranking
//   reuses the exact G2 scoring, so recall ordering matches G2 wherever the
//   two are directly compared (shadow.ts's compareShadowRecall /
//   shadowMemoryRecall).

import type { MemoryNote } from '@/lib/agent-memory';
import { MemoryHit, MemoryRecord, MEMORY_SCHEMA_VERSION } from './types';

// Master dormancy switch. Flipped 2026-08-05: Track A (at-rest encryption,
// commit 690785cd4) and Track B/C (dev-data cleanup + PII guard, commit
// e43894d59) landed weeks before this flip and were simply never wired to it
// — DEFERRED.md's MEMORY-001 entry was stale (see the entry's 2026-08-05
// correction). Steps 3/4 (agent-manager's activated recall/write) and the new
// Step 5 (Sidebar's activateMemoryList) all fall back to G2 on any internal
// failure, so a live bug here degrades to pre-flip behavior rather than
// losing an agent's memory outright.
export const MEMORY_ENABLED = true;

// Optional semantic re-rank via localhost llama-server (loopback-only by
// construction — see lib/memory/embedding-llama.ts). Flipped 2026-08-05, the
// same pass that added `--embedding --pooling mean` to every llama-server
// launch site (scripts/shelly-local-llm-ensure.sh + its asset mirror,
// lib/agent-executor.ts's inline copy, lib/llamacpp-setup.ts's
// buildServerStartCommand): without those flags the shipped autostart never
// exposed /v1/embeddings, so this flag guarded a feature that was dead in
// the on-device config. Still independent of MEMORY_ENABLED, and still
// additive-only: every caller treats any embed() failure (a server started
// by a pre-flip script, cold model, 300ms timeout) as "embedding
// unavailable" and silently falls back to bigram-only ranking, so a live
// problem degrades to pre-flip behavior rather than breaking skill matching.
export const MEMORY_EMBEDDING_ENABLED = true;

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
