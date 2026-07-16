// MEMORY-001 memory layer — Step 2 shadow-read seam + Step 3 activated recall
// + Step 4 activated write (dormant, flag-OFF).
//
// Called from agent-manager's applyMemoryAndSkills / persistRememberFact /
// captureRunMemory, all behind MEMORY_ENABLED. While the flag is false (today,
// always) shadowMemoryRecall, activateMemoryRecall, and activateMemoryWrite are
// all unreachable (agent-manager only calls the latter two inside
// `if (MEMORY_ENABLED)`), so live behavior stays byte-identical to G2-only.
// When the flag is eventually flipped, this module: (a) mirrors the agent's G2
// notes into the NEW memory-v2 store (a sibling dir — G2's .md files are never
// read or written by the store, so deleting memory-v2/ reverts everything),
// (b) replays the exact recall query G2 ran, and (c) either logs order/content
// divergence (shadowMemoryRecall, observability-only), actually renders the
// MEMORY-001 result into the recall context that reaches the prompt
// (activateMemoryRecall, Step 3), or writes a new fact/result straight into the
// MEMORY-001 store instead of a G2 .md file (activateMemoryWrite, Step 4).
// Strangler convention: additive, reversible, "実装されるが有効化はされない."

import { logInfo, logWarn } from '@/lib/debug-logger';
import { getHomePath } from '@/lib/home-path';
import {
  buildRecallContext,
  makeMemoryNote,
  recallMemoryNotes,
  type MemoryNote,
  type MemoryNoteType,
} from '@/lib/agent-memory';
import { MemoryStore } from './memory-store';
import { JsonFileMemoryStorage } from './storage-json';
import { createExpoFsPort, systemClock } from './fs-expo';
import type { EncryptionPort } from './types';
import {
  DEFAULT_RECALL_LIMIT,
  MemoryHit,
  MemoryRecord,
  MemoryStorageAdapter,
} from './types';
import {
  MEMORY_ENABLED,
  agentNamespace,
  g2NoteToRecord,
  recordsToRecallContext,
} from './wiring';

const LOG_MODULE = 'MemoryShadow';

// NEW dir, sibling of G2's `.shelly/agents/memory/` — the shadow store must
// never touch G2's on-disk notes (they stay authoritative and byte-preserved).
function shadowRootDir(): string {
  return `${getHomePath()}/.shelly/agents/memory-v2`;
}

export interface ShadowDeps {
  adapter: MemoryStorageAdapter;
  store: MemoryStore;
  // Session-scoped "already mirrored" set: the import is idempotent anyway
  // (upsert by key), this just avoids re-writing every note on every run.
  importedAgents: Set<string>;
}

// Lazy singleton: the expo FsPort + store are only constructed the first time a
// flag-ON shadow pass actually runs, so the dormant (flag-OFF) app pays zero
// cost and host tests never construct the expo port.
//
// crypto-expo.ts is require()'d HERE (not statically imported at module top)
// deliberately: it pulls in @noble/ciphers, which ships pure ESM with no CJS
// build. Jest's default config never transforms node_modules, so any test
// file that merely IMPORTS this module (shadow.ts is imported unconditionally
// by lib/agent-manager.ts, which dozens of unrelated test files import) would
// fail to parse — even though MEMORY_ENABLED gates every call site so the
// port is never actually constructed. A lazy require() means the ESM-only
// dependency graph is only touched by a test/build that actually reaches this
// line, matching the "dormant, zero cost while off" contract the rest of this
// file already documents.
let sharedDeps: ShadowDeps | null = null;

function getShadowDeps(): ShadowDeps {
  if (!sharedDeps) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createExpoEncryptionPort } = require('./crypto-expo') as { createExpoEncryptionPort: () => EncryptionPort };
    const adapter = new JsonFileMemoryStorage(createExpoFsPort(), createExpoEncryptionPort(), {
      root: shadowRootDir(),
    });
    sharedDeps = {
      adapter,
      store: new MemoryStore({ adapter, clock: systemClock }),
      importedAgents: new Set<string>(),
    };
  }
  return sharedDeps;
}

export interface ShadowComparison {
  liveKeys: string[];
  shadowKeys: string[];
  // Same records in the same order (G2 note id === shadow record key).
  orderMatches: boolean;
  // The rendered recall block is identical (what WOULD reach the prompt).
  contextMatches: boolean;
}

// Pure comparator — exported so the divergence logic is host-testable without
// any store or fs. Live G2 recall vs shadow hits: order by id/key, content by
// the exact recall-context string each side would inject.
export function compareShadowRecall(
  liveRecalled: MemoryNote[],
  shadowHits: MemoryHit[]
): ShadowComparison {
  const liveKeys = liveRecalled.map((n) => n.id);
  const shadowKeys = shadowHits.map((h) => h.record.key);
  const orderMatches =
    liveKeys.length === shadowKeys.length &&
    liveKeys.every((key, i) => key === shadowKeys[i]);
  const contextMatches =
    buildRecallContext(liveRecalled) === recordsToRecallContext(shadowHits);
  return { liveKeys, shadowKeys, orderMatches, contextMatches };
}

// Shared import→query step used by both the Step 2 shadow comparator and the
// Step 3 activated recall path below: one-time-per-agent mirror import of the
// G2 notes, then the exact query G2's recallMemoryNotes would run. Kept in one
// place so activation can never drift from what the shadow comparator has
// already verified byte-for-byte against G2.
async function importAndQuery(
  agent: { id: string; name: string; prompt: string },
  notes: MemoryNote[],
  deps: ShadowDeps
): Promise<{ namespace: string; taskText: string; hits: MemoryHit[] }> {
  const namespace = agentNamespace(agent.id);

  // (b) One-time-per-agent mirror import. adapter.put (NOT store.put) on
  // purpose: store.put would stamp createdAt=now for new records, and the
  // ranking's recency tiebreak would then reflect import time instead of the
  // G2 note's created timestamp — a guaranteed false divergence. The full
  // g2NoteToRecord record preserves createdAt, and adapter.put is the same
  // upsert-by-(namespace,key) so re-imports are idempotent.
  if (!deps.importedAgents.has(agent.id)) {
    for (const note of notes) {
      await deps.adapter.put(g2NoteToRecord(note));
    }
    deps.importedAgents.add(agent.id);
  }

  // (c) Replay the exact query G2 runs in applyMemoryAndSkills: same task text,
  // same limit (DEFAULT_RECALL_LIMIT on both sides).
  const taskText = `${agent.name}\n${agent.prompt}`;
  const hits = await deps.store.query(namespace, {
    text: taskText,
    limit: DEFAULT_RECALL_LIMIT,
  });
  return { namespace, taskText, hits };
}

// The unconditional import→query→compare pipeline, separated from the flag
// gate so host tests can exercise it with an injected in-memory store while
// MEMORY_ENABLED stays false. `notes` is the same newest-first list
// applyMemoryAndSkills already read via readMemoryNotes (no double disk read).
export async function runShadowComparison(
  agent: { id: string; name: string; prompt: string },
  notes: MemoryNote[],
  deps: ShadowDeps
): Promise<ShadowComparison> {
  const { taskText, hits: shadowHits } = await importAndQuery(agent, notes, deps);

  // (d) Compare against the live G2 recall (recomputed with the same pure
  // function agent-manager uses — identical input, identical result).
  const liveRecalled = recallMemoryNotes(notes, taskText);
  return compareShadowRecall(liveRecalled, shadowHits);
}

/**
 * Shadow a G2 memory recall. No-op while MEMORY_ENABLED is false. Never throws
 * and never changes what gets injected into the prompt — a shadow failure is
 * logged and swallowed so it cannot break the live run.
 */
export async function shadowMemoryRecall(
  agent: { id: string; name: string; prompt: string },
  notes: MemoryNote[]
): Promise<void> {
  // Master dormancy gate (wiring.ts). Everything below is dead code until the
  // separate, device-verified "enable" decision flips the flag.
  if (!MEMORY_ENABLED) return;
  try {
    const cmp = await runShadowComparison(agent, notes, getShadowDeps());
    if (cmp.orderMatches && cmp.contextMatches) {
      logInfo(
        LOG_MODULE,
        `shadow recall parity for agent ${agent.id}: ${cmp.shadowKeys.length} hits match G2`
      );
    } else {
      // Divergence is a finding, not a failure: G2 stays authoritative either way.
      logWarn(LOG_MODULE, `shadow recall DIVERGED for agent ${agent.id}`, {
        liveKeys: cmp.liveKeys,
        shadowKeys: cmp.shadowKeys,
        orderMatches: cmp.orderMatches,
        contextMatches: cmp.contextMatches,
      });
    }
  } catch (error) {
    logWarn(
      LOG_MODULE,
      'shadow recall failed (live run unaffected)',
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * MEMORY-001 Step 3 — activated recall. Only ever called from agent-manager
 * inside `if (MEMORY_ENABLED)`, so it is unreachable dead code while the flag
 * stays false; nothing here changes today's byte-identical G2 behavior.
 *
 * Runs the same import→query pipeline as shadowMemoryRecall but returns the
 * MEMORY-001 store's rendered recall context instead of only comparing it.
 * Returns `null` (not `''`) on ANY internal failure so the caller can tell
 * "activation broke" apart from "activation succeeded, nothing to recall" and
 * fall back to the G2 result — G2 is the proven, on-device-verified path, so
 * falling back to ITS result is strictly safer than falling back to no recall
 * at all (a fresh MEMORY-001 bug should degrade to "today's behavior", not to
 * "the agent silently loses its memory"). Never throws.
 *
 * `deps` defaults to the lazy device singleton; agent-manager always omits it.
 * Host tests pass an injected in-memory ShadowDeps so the success path is
 * exercisable without expo-file-system.
 */
export async function activateMemoryRecall(
  agent: { id: string; name: string; prompt: string },
  notes: MemoryNote[],
  deps: ShadowDeps = getShadowDeps()
): Promise<string | null> {
  try {
    const { hits } = await importAndQuery(agent, notes, deps);
    return recordsToRecallContext(hits);
  } catch (error) {
    logWarn(
      LOG_MODULE,
      'activated recall failed, caller should fall back to G2 (live run unaffected)',
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}

/**
 * MEMORY-001 Step 4 — activated write. Only ever called from agent-manager's
 * persistRememberFact / captureRunMemory inside `if (MEMORY_ENABLED)`, so it is
 * unreachable dead code while the flag stays false.
 *
 * Builds the record through G2's OWN makeMemoryNote (same trim, MAX_NOTE_CHARS
 * truncation, tag normalization, and deterministic id derivation G2 applies to
 * every write) and converts it with g2NoteToRecord, so the MEMORY-001 write
 * path is bound to reuse G2's normalization rather than re-implement (and
 * risk drifting from) it. store.put (NOT adapter.put) is deliberate here,
 * unlike the migration importer: this is a brand-new fact being recorded now,
 * so it should get a fresh createdAt from the injected clock, exactly like a
 * new G2 note gets `new Date().toISOString()` at write time.
 *
 * NOTE (gap, not fixed here): G2's write path has no secret-redaction step of
 * its own — writeMemoryNote persists whatever text makeMemoryNote produces,
 * and the ONLY secret-guard scan happens later, at recall-injection time, when
 * resolveAgentRoute scans the EFFECTIVE agent.prompt (which by then includes
 * any recalled note). Because activateMemoryWrite reuses makeMemoryNote
 * verbatim, it inherits exactly this behavior — no better, no worse than G2.
 * Returns false (not throw) on any internal failure so the caller can fall
 * back to G2's writeMemoryNote; never throws.
 *
 * `deps` defaults to the lazy device singleton; agent-manager always omits it.
 * Host tests pass an injected in-memory ShadowDeps so the success path is
 * exercisable without expo-file-system.
 */
export async function activateMemoryWrite(
  params: {
    agentId: string;
    type: MemoryNoteType;
    text: string;
    tags?: string[];
  },
  deps: ShadowDeps = getShadowDeps()
): Promise<boolean> {
  try {
    const note = makeMemoryNote({
      agentId: params.agentId,
      type: params.type,
      text: params.text,
      tags: params.tags,
    });
    const record: MemoryRecord = g2NoteToRecord(note);
    await deps.store.put({
      namespace: record.namespace,
      key: record.key,
      kind: record.kind,
      text: record.text,
      tags: record.tags,
    });
    return true;
  } catch (error) {
    logWarn(
      LOG_MODULE,
      'activated write failed, caller should fall back to G2 (live run unaffected)',
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}
