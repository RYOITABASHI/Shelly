// MEMORY-001 memory layer — the pure get/put/query core.
//
// Depends only on ./types, ./ranking, and injected ports (adapter/clock/
// optional embedding). No FS, no Date.now, no expo. Namespace routing,
// deterministic keys, injected-clock timestamps, and optional embedding re-rank
// live here; all persistence goes through the MemoryStorageAdapter boundary.

import { cosineSimilarity } from './ranking-semantic';
import { compareHits, deriveKey, matchesFilter } from './ranking';
import {
  Clock,
  DEFAULT_RECALL_LIMIT,
  EmbeddingPort,
  MemoryHit,
  MemoryKind,
  MemoryQuery,
  MemoryRecord,
  MemoryStorageAdapter,
  MEMORY_SCHEMA_VERSION,
  ResolvedQuery,
} from './types';

export interface MemoryStoreOptions {
  adapter: MemoryStorageAdapter;
  clock: Clock;
  // Absent => 'fulltext' only; 'semantic'/'hybrid' degrade to 'fulltext'.
  embedding?: EmbeddingPort;
}

export interface PutInput {
  namespace: string;
  text: string;
  // Default deriveKey(namespace, kind, text) — idempotent overwrite.
  key?: string;
  kind?: MemoryKind;
  tags?: string[];
  metadata?: Record<string, string>;
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

export class MemoryStore {
  private readonly adapter: MemoryStorageAdapter;
  private readonly clock: Clock;
  private readonly embedding?: EmbeddingPort;

  constructor(opts: MemoryStoreOptions) {
    this.adapter = opts.adapter;
    this.clock = opts.clock;
    this.embedding = opts.embedding;
  }

  // Upsert. On overwrite, createdAt is preserved and updatedAt advances.
  async put(input: PutInput): Promise<MemoryRecord> {
    const now = this.clock.now();
    const kind: MemoryKind = input.kind ?? 'fact';
    const text = input.text.trim();
    const key = input.key ?? deriveKey(input.namespace, kind, text);
    const existing = await this.adapter.get(input.namespace, key);

    const record: MemoryRecord = {
      namespace: input.namespace,
      key,
      schemaVersion: MEMORY_SCHEMA_VERSION,
      kind,
      text,
      tags: normalizeTags(input.tags),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      metadata: input.metadata,
    };
    await this.adapter.put(record);
    return record;
  }

  async get(namespace: string, key: string): Promise<MemoryRecord | null> {
    return this.adapter.get(namespace, key);
  }

  async delete(namespace: string, key: string): Promise<void> {
    return this.adapter.delete(namespace, key);
  }

  private resolve(q: MemoryQuery | undefined): ResolvedQuery {
    const requested = q?.mode ?? 'fulltext';
    // Degrade to fulltext when no embedding port is available.
    const mode = requested === 'fulltext' || this.embedding ? requested : 'fulltext';
    return {
      text: q?.text ?? '',
      tags: q?.tags ?? [],
      kind: q?.kind,
      limit: q?.limit ?? DEFAULT_RECALL_LIMIT,
      mode,
    };
  }

  async query(namespace: string, q?: MemoryQuery): Promise<MemoryHit[]> {
    const resolved = this.resolve(q);

    // Full-text (default): the adapter ranks (FTS5 emulation / MATCH+bm25).
    if (resolved.mode === 'fulltext' || !this.embedding || !resolved.text) {
      return this.adapter.query(namespace, { ...resolved, mode: 'fulltext' });
    }

    // Semantic / hybrid: embed the query, re-rank by cosine similarity. Hybrid
    // prefilters with the full-text ranking (a wider candidate window) before
    // the embedding re-rank; semantic scores the whole namespace.
    const [queryEmbedding] = await this.embedding.embed([resolved.text]);
    const candidates =
      resolved.mode === 'hybrid'
        ? // hybrid: full-text prefilter (already kind/tag-filtered) then re-rank.
          (
            await this.adapter.query(namespace, {
              ...resolved,
              mode: 'fulltext',
              limit: Math.max(resolved.limit * 4, resolved.limit),
            })
          ).map((h) => h.record)
        : // semantic: whole namespace, but apply the SAME kind/tag filter so the
          // filters behave identically across modes (list() is unfiltered).
          (await this.adapter.list(namespace)).filter((r) => matchesFilter(r, resolved));

    const reranked: MemoryHit[] = candidates.map((record) => ({
      record,
      score: record.embedding
        ? cosineSimilarity(queryEmbedding, record.embedding)
        : 0,
    }));
    // compareHits gives a deterministic (score desc, createdAt desc, key asc)
    // order, so embedding-less records (e.g. migrated G2 records, all score 0)
    // fall back to recency instead of unstable adapter/fs order.
    reranked.sort(compareHits);
    return reranked.slice(0, resolved.limit);
  }
}
