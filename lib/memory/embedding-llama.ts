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
// CONSTRAINT VERIFIED 2026-08-04 (read scripts/shelly-local-llm-ensure.sh —
// the bundled autostart helper every on-device local-LLM caller, including
// this one, relies on to bring the server up): the autostart command line
// passes only `--model/--alias/--host/--port/--ctx-size/--threads
// /--log-disable` — no `--embedding`. llama.cpp's server only serves
// /v1/embeddings (and the legacy /embedding) once started WITH `--embedding`
// (it switches the model's pooling mode); an ordinary chat-mode
// llama-server answers this path with an HTTP error. Net effect: **on the
// currently-shipped autostart config, embed() below will normally fail, and
// every caller in this codebase treats that failure as "embedding
// unavailable" and falls back to its non-embedding behavior** — this is the
// expected common case today, not a bug in this file, and matches the
// flag-OFF/dormant convention of the rest of this module (MEMORY_ENABLED /
// MEMORY_EMBEDDING_ENABLED in ./wiring.ts). Making it actually serve
// embeddings on-device needs one of: (a) adding `--embedding` to the
// autostart command — first verify chat completion still works from the
// SAME llama-server process afterwards, since several llama.cpp builds
// disable /completion while `--embedding` is active, which would break the
// primary chat use of local-llm.ts sharing this exact process/port; or
// (b) running a second, embedding-only llama-server on a different port.
// Neither is done here — doing so is a local-LLM-runtime change, out of
// scope for what is meant to stay an additive, never-hard-dependency skill
// matcher.
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
 * /v1/embeddings endpoint. See the file header for the on-device constraint
 * (no `--embedding` flag in the current autostart config) that makes embed()
 * normally reject today, and for why that is treated as an ordinary,
 * silently-handled "unavailable" by every caller rather than an error to
 * surface to the user.
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
        // The expected shape when the server is running WITHOUT --embedding
        // (see file header) — a plain thrown error so every caller's
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
