// MEMORY-001 memory layer — full-text ranking (the FTS5 emulation contract).
//
// This is the exact G2 recall scoring (lib/agent-memory.ts recallMemoryNotes):
// tag overlap ×2 + token overlap ×1, recency (createdAt desc) tiebreak, using
// the shared offline tokenizer. The bundled-sqlite FTS5 adapter (deferred) must
// reproduce this ordering (MATCH + bm25); host tests prove the contract on this
// pure ranking so the two stay in parity across the eventual cutover.

import { tokenizeForMatch } from '@/lib/agent-text-match';
import { MemoryHit, MemoryRecord, ResolvedQuery } from './types';

export const tokenize = tokenizeForMatch;

// Stable, collision-resistant-enough short id (djb2 → base36), byte-identical to
// G2's shortHash. Deterministic key = idempotent overwrite of the same content.
function shortHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

// NUL field delimiter, byte-identical to G2 memoryNoteId: it hashes
// `agentId \0 type \0 text.trim()`. NUL can't appear in normal text, so it keeps
// the field boundaries injective (no "ab|c" vs "a|bc" collision).
const KEY_FIELD_SEP = '\u0000';

// Mirrors G2 memoryNoteId(agentId,type,text) exactly (same djb2 shortHash, same
// NUL-delimited field order, same `${kind}-` prefix) with namespace in the
// agentId slot, so a per-agent namespace reproduces the SAME key across the G2
// migration — a re-remembered fact collapses onto its migrated record.
export function deriveKey(namespace: string, kind: string, text: string): string {
  return `${kind}-${shortHash(`${namespace}${KEY_FIELD_SEP}${kind}${KEY_FIELD_SEP}${text.trim()}`)}`;
}

// G2-identical overlap score: +2 per matching tag, +1 per matching text/tag
// token. taskTokens = tokenize(query text).
export function scoreRecord(record: MemoryRecord, taskTokens: Set<string>): number {
  const noteTokens = tokenize(`${record.text} ${record.tags.join(' ')}`);
  let overlap = 0;
  for (const tag of record.tags) if (taskTokens.has(tag)) overlap += 2;
  for (const tok of noteTokens) if (taskTokens.has(tok)) overlap += 1;
  return overlap;
}

// Shared kind/tag filter, applied by every query mode (fulltext ranking AND the
// semantic candidate set) so filters behave identically across modes.
export function matchesFilter(record: MemoryRecord, q: ResolvedQuery): boolean {
  if (q.kind !== undefined && record.kind !== q.kind) return false;
  if (q.tags.length > 0 && !q.tags.every((t) => record.tags.includes(t))) return false;
  return true;
}

// Deterministic ordering shared by fulltext and the semantic re-rank: score desc,
// then recency (createdAt desc), then key asc as a final stable tiebreak.
// NOTE: for records with an identical (score, createdAt), G2 recallMemoryNotes
// breaks ties by directory-read order; that order is not reproducible from the
// adapter's unordered set, so we use key asc — deterministic on both sides, and
// only observably different when two notes share the exact same ms timestamp.
export function compareHits(a: MemoryHit, b: MemoryHit): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.record.createdAt !== a.record.createdAt) {
    return b.record.createdAt - a.record.createdAt;
  }
  return a.record.key < b.record.key ? -1 : a.record.key > b.record.key ? 1 : 0;
}

// Rank records for a resolved query. Applies kind/tag filters, scores full-text
// overlap, and orders by compareHits.
export function rankHits(records: MemoryRecord[], q: ResolvedQuery): MemoryHit[] {
  const filtered = records.filter((r) => matchesFilter(r, q));

  const taskTokens = q.text ? tokenize(q.text) : new Set<string>();
  const scored = filtered.map((record) => ({
    record,
    // Empty query => pure recency listing (score 0 for all).
    score: q.text ? scoreRecord(record, taskTokens) : 0,
  }));

  scored.sort(compareHits);

  return scored.slice(0, q.limit);
}
