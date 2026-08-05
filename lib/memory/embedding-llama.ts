// MEMORY-001 memory layer — llama-server embedding port.
//
// Real implementation (2026-08-04, wired for lib/agent-skills.ts's hybrid
// skill matcher — see that file's matchSkillRecipesHybrid). Calls the SAME
// localhost llama-server every other local-LLM caller talks to
// (lib/local-llm.ts, port 8080, OpenAI-compatible surface — see
// detectApiType() there), using its OpenAI-compatible /v1/embeddings
// endpoint. Never a cloud embedder: embed() structurally refuses any
// endpoint whose host isn't 127.0.0.1/localhost (isLoopbackEmbeddingEndpoint
// below), independent of whatever endpoint string a future caller passes in.
// That loopback-only construction IS the "broker-mediated" story for this
// call: lib/capability-envelope.ts's HTTP-001 egress classifier
// (classifyEgress) treats loopback+plaintext as unconditionally `allow` —
// the approval gate the broker exists to enforce only ever fires for
// non-loopback hosts, which this port cannot reach even if asked to.
//
// CONSTRAINT RESOLVED 2026-08-05 (was: "CONSTRAINT VERIFIED 2026-08-04" —
// the shipped autostart passed no `--embedding`, so /v1/embeddings always
// answered with an HTTP error and embed() below could never succeed on
// device). Option (a) from that note is now implemented: every llama-server
// launch site (scripts/shelly-local-llm-ensure.sh + its APK asset mirror,
// lib/agent-executor.ts's inline copy of ensure_local_llm_server, and
// lib/llamacpp-setup.ts's buildServerStartCommand for the in-app Start)
// passes `--embedding --pooling mean`, and MEMORY_EMBEDDING_ENABLED in
// ./wiring.ts was flipped on in the same pass. `--pooling mean` is required
// with `--embedding` because the OAI-compatible /v1/embeddings endpoint
// rejects the pooling type 'none' that causal chat models (Qwen) default to;
// pooling only affects the embedding-output path, so chat completion from
// the SAME process/port is unaffected (the old llama.cpp behavior where
// embeddings mode disabled /completion was removed upstream in 2024, and
// every install path in this repo fetches releases/latest). embed() can
// STILL fail routinely — a server started by a pre-flip script or an old
// on-disk agent script, a cold/loading model, the 300ms timeout below — and
// every caller keeps treating that as an ordinary "embedding unavailable"
// fallback to non-embedding behavior, never an error to surface.
//
// This file pulls no network dependency at module load (only `embed()`
// touches `fetch`) and is NOT re-exported from index.ts (see that file's
// header) — callers reach it via a direct import, same as before.

import { EmbeddingPort } from './types';

export interface LlamaEmbeddingPortOptions {
  /** OpenAI-compatible embeddings endpoint, e.g.
   *  'http://127.0.0.1:8080/v1/embeddings' — see
   *  llamaEmbeddingEndpointFromBaseUrl() to derive this from the same
   *  LOCAL_LLM_URL / settings.localLlmUrl every other local-LLM caller uses. */
  endpoint: string;
  /** Hard cap on the round trip. Kept short and non-configurable-by-default
   *  on purpose: a caller on a synchronous-feeling UI path (skill matching
   *  during agent registration) must never feel slower because the local
   *  LLM happens to be busy or loading a model — a timeout is just another
   *  form of "embedding unavailable", not a slow error. */
  timeoutMs?: number;
}

/** 300ms: comfortably under human-perceptible added latency for the skill
 *  matching call site (lib/agent-skills.ts's matchSkillRecipesHybrid), while
 *  still enough for a warm, already-running loopback llama-server to answer
 *  a short embeddings request. A cold/loading server will not make this
 *  window — which is correct: the caller should treat "still loading" the
 *  same as "not running" and fall back immediately, not block the UI. */
const DEFAULT_EMBEDDING_TIMEOUT_MS = 300;

interface OpenAIEmbeddingRow {
  embedding: number[];
  index: number;
}

interface OpenAIEmbeddingResponse {
  data?: OpenAIEmbeddingRow[];
}

/** Derive the OpenAI-compatible embeddings endpoint from a local-LLM base
 *  URL (e.g. settings.localLlmUrl, default 'http://127.0.0.1:8080' — see
 *  store/settings-store.ts). Pure string handling only; does not touch the
 *  network or validate reachability. */
export function llamaEmbeddingEndpointFromBaseUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/embeddings`;
}

/** Mirrors lib/local-llm.ts's isLoopbackLlamaServer intent (loopback-only),
 *  kept as its own small copy rather than a shared import so this dormant
 *  module keeps pulling in nothing beyond ./types at module load (see file
 *  header) — lib/local-llm.ts is a much larger module with its own runtime
 *  footprint (XHR streaming, SSE parsing, etc.) this file has no need for. */
function isLoopbackEmbeddingEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost';
  } catch {
    return false;
  }
}

/**
 * EmbeddingPort backed by a local llama-server's OpenAI-compatible
 * /v1/embeddings endpoint. The current autostart/start commands pass
 * `--embedding --pooling mean` (see the file header), so a freshly-started
 * on-device server serves this path; embed() still rejects against servers
 * started by older scripts or while the model is cold, and every caller
 * treats that as an ordinary, silently-handled "unavailable" rather than an
 * error to surface to the user.
 */
export class LlamaEmbeddingPort implements EmbeddingPort {
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(opts: LlamaEmbeddingPortOptions) {
    this.endpoint = opts.endpoint;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    // Structural loopback-only guard (see file header) — refuse rather than
    // trust every future caller to only ever construct a loopback endpoint.
    if (!isLoopbackEmbeddingEndpoint(this.endpoint)) {
      throw new Error(`LlamaEmbeddingPort refuses a non-loopback endpoint: ${this.endpoint}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: texts }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // The expected shape when the server is running WITHOUT
        // --embedding/--pooling (e.g. started by a pre-2026-08-05 script —
        // see file header) — a plain thrown error so every caller's
        // existing try/catch-and-fall-back handles it the same as a network
        // failure or a timeout, with no special-casing needed.
        throw new Error(`embedding endpoint HTTP ${res.status}`);
      }
      const data = (await res.json()) as OpenAIEmbeddingResponse;
      const rows = data.data;
      if (!Array.isArray(rows) || rows.length !== texts.length) {
        throw new Error('embedding endpoint returned an unexpected shape');
      }
      // The OpenAI embeddings contract does not guarantee row order matches
      // input order; `index` is the authoritative position.
      return rows
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((row) => row.embedding);
    } finally {
      clearTimeout(timer);
    }
  }
}
