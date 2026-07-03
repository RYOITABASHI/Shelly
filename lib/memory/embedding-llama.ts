// MEMORY-001 memory layer — llama-server embedding port (DEFERRED).
//
// Interface-conformant skeleton only. Semantic/hybrid recall is optional; the
// core and all host tests pass with NO embedding port. When wired (behind
// MEMORY_EMBEDDING_ENABLED), embeddings come ONLY from the localhost
// llama-server (127.0.0.1:8080 /embedding) via the HTTP-001 capability broker —
// never a cloud embedder, no unmediated egress. Memory text is local-sensitive,
// so it must never leave the device for a third-party embedder.
//
// This file pulls NO network dependency at module load and is NOT re-exported
// from index.ts until the flag-ON cutover.

import { EmbeddingPort } from './types';

const NOT_WIRED =
  'LlamaEmbeddingPort is deferred until the MEMORY-001 embedding flag-ON cutover';

export interface LlamaEmbeddingPortOptions {
  // Localhost llama-server embedding endpoint, reached through the HTTP broker.
  endpoint: string; // e.g. 'http://127.0.0.1:8080/embedding'
}

export class LlamaEmbeddingPort implements EmbeddingPort {
  private readonly endpoint: string;

  constructor(opts: LlamaEmbeddingPortOptions) {
    this.endpoint = opts.endpoint;
  }

  async embed(_texts: string[]): Promise<number[][]> {
    throw new Error(NOT_WIRED);
  }
}
