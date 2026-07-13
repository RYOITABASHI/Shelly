// MEMORY-001 memory layer — semantic similarity (optional embedding re-rank).
//
// Pure. Used only when an EmbeddingPort is injected (semantic/hybrid mode). Kept
// separate from the full-text ranking so the default path pulls in no vector math.

// Cosine similarity in [-1, 1]; 0 when either vector is empty/zero-norm or the
// dimensions differ (defensive — a mismatched embedding never throws here).
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
