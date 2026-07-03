// MEMORY-001 memory layer — Step 2 shadow-read seam (dormant, flag-OFF).
//
// Called from agent-manager's applyMemoryAndSkills behind MEMORY_ENABLED. While
// the flag is false (today, always) shadowMemoryRecall returns before touching
// any state, so live behavior stays byte-identical to G2-only. When the flag is
// eventually flipped, this module: (a) mirrors the agent's G2 notes into the
// NEW memory-v2 store (a sibling dir — G2's .md files are never read or
// written by the store, so deleting memory-v2/ reverts everything), (b) replays
// the exact recall query G2 ran, and (c) logs order/content divergence between
// the two results. G2's recall remains the ONLY thing injected into the prompt;
// the shadow result is observability, not behavior. Strangler convention:
// additive, reversible, "実装されるが有効化はされない."

import { logInfo, logWarn } from '@/lib/debug-logger';
import { getHomePath } from '@/lib/home-path';
import {
  buildRecallContext,
  recallMemoryNotes,
  type MemoryNote,
} from '@/lib/agent-memory';
import { MemoryStore } from './memory-store';
import { JsonFileMemoryStorage } from './storage-json';
import { createExpoFsPort, systemClock } from './fs-expo';
import {
  DEFAULT_RECALL_LIMIT,
  MemoryHit,
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
let sharedDeps: ShadowDeps | null = null;

function getShadowDeps(): ShadowDeps {
  if (!sharedDeps) {
    const adapter = new JsonFileMemoryStorage(createExpoFsPort(), {
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

// The unconditional import→query→compare pipeline, separated from the flag
// gate so host tests can exercise it with an injected in-memory store while
// MEMORY_ENABLED stays false. `notes` is the same newest-first list
// applyMemoryAndSkills already read via readMemoryNotes (no double disk read).
export async function runShadowComparison(
  agent: { id: string; name: string; prompt: string },
  notes: MemoryNote[],
  deps: ShadowDeps
): Promise<ShadowComparison> {
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
  const shadowHits = await deps.store.query(namespace, {
    text: taskText,
    limit: DEFAULT_RECALL_LIMIT,
  });

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
