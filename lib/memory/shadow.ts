// MEMORY-001 memory layer — Step 2 shadow-read seam + Step 3 activated recall
// + Step 4 activated write. LIVE since MEMORY_ENABLED flipped true on
// 2026-08-05 (see lib/memory/wiring.ts) — no longer dormant.
//
// Called from agent-manager's applyMemoryAndSkills / persistRememberFact /
// captureRunMemory, all behind MEMORY_ENABLED. Now that the flag is true,
// shadowMemoryRecall runs on every recall (still observability-only — it only
// logs order/content divergence, it never changes what reaches the prompt),
// and activateMemoryRecall / activateMemoryWrite run inside agent-manager's
// `if (MEMORY_ENABLED)` branches as the PRIMARY recall/write path, with G2
// used only as the fallback when either returns null/false (any internal
// MEMORY-001 failure) — never as a silent loss of the agent's memory. This
// module: (a) mirrors the agent's G2 notes into the NEW memory-v2 store (a
// sibling dir — G2's .md files are never read or written by the store, so
// deleting memory-v2/ reverts everything) lazily, the first time that agent's
// (or `_global`'s) namespace is touched in a given app session — there is no
// batch/one-shot migration of every existing G2 note at flip time, (b) replays
// the exact recall query G2 ran, and (c) either logs order/content divergence
// (shadowMemoryRecall, observability-only), actually renders the MEMORY-001
// result into the recall context that reaches the prompt (activateMemoryRecall,
// Step 3), or writes a new fact/result straight into the MEMORY-001 store
// instead of a G2 .md file (activateMemoryWrite, Step 4).
// Strangler convention: additive, reversible — G2's .md files stay on disk,
// untouched and authoritative-on-failure, even though MEMORY-001 is now the
// primary path. "実装され、有効化もされた（が G2 は退役していない）."

import { logInfo, logWarn } from '@/lib/debug-logger';
import { getHomePath } from '@/lib/home-path';
import {
  buildRecallContext,
  deleteMemoryNoteFile,
  makeMemoryNote,
  readMemoryNotes,
  recallMemoryNotes,
  type MemoryNote,
  type MemoryNoteType,
} from '@/lib/agent-memory';
import { MemoryStore } from './memory-store';
import { JsonFileMemoryStorage } from './storage-json';
import { createExpoFsPort, systemClock } from './fs-expo';
import { cleanupStalePlaintextMemoryFiles } from './dev-data-cleanup';
import { scanForPii } from './pii-guard';
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

// Lazy singleton: the expo FsPort + store are only constructed the first time
// one of this module's exported functions actually calls getShadowDeps() —
// not at module import. Now that MEMORY_ENABLED=true, that first call happens
// in production on an agent's first recall/write/list of a given app session
// (this is no longer a permanently-dormant path); the laziness now mainly
// matters for host tests, which import this module unconditionally (it's
// imported by lib/agent-manager.ts, which dozens of unrelated test files
// import) but only construct the expo port if a test actually exercises a
// MEMORY-001 entry point.
//
// crypto-expo.ts is require()'d HERE (not statically imported at module top)
// deliberately: it pulls in @noble/ciphers, which ships pure ESM with no CJS
// build. Jest's default config never transforms node_modules, so any test
// file that merely IMPORTS this module (shadow.ts is imported unconditionally
// by lib/agent-manager.ts, which dozens of unrelated test files import) would
// fail to parse if crypto-expo were a static import — regardless of whether
// MEMORY_ENABLED is true, since a static import is evaluated at module-load
// time, before any flag check runs. A lazy require() means the ESM-only
// dependency graph is only touched when a test/build actually calls
// getShadowDeps() (now routine in production, since MEMORY_ENABLED=true means
// every recall/write/list call site reaches this line) — a test that merely
// imports shadow.ts transitively, without exercising one of its exported
// functions, still never constructs the port.
let sharedDeps: ShadowDeps | null = null;

function getShadowDeps(): ShadowDeps {
  if (!sharedDeps) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createExpoEncryptionPort } = require('./crypto-expo') as { createExpoEncryptionPort: () => EncryptionPort };
    const fsPort = createExpoFsPort();
    const root = shadowRootDir();
    const adapter = new JsonFileMemoryStorage(fsPort, createExpoEncryptionPort(), { root });
    sharedDeps = {
      adapter,
      store: new MemoryStore({ adapter, clock: systemClock }),
      importedAgents: new Set<string>(),
    };
    // Track B (MEMORY-001, see DEFERRED.md): one-time, non-blocking sweep for
    // stale pre-encryption plaintext files a developer machine may still have
    // on disk from before Track A's envelope encryption landed. This is the
    // first point ANY code touches the memory-v2 store on a given app launch —
    // getShadowDeps() is only reached from MEMORY_ENABLED-gated call sites,
    // and the flag is true since 2026-08-05 so this now runs in production —
    // so it doubles as the "startup" detection hook the design calls for.
    // Fire-and-forget: a cleanup failure must never block or break the live
    // memory read/write path that's about to use `adapter`.
    cleanupStalePlaintextMemoryFiles(fsPort, root)
      .then((result) => {
        if (result.removed.length > 0) {
          logInfo(
            LOG_MODULE,
            `dev-data cleanup removed ${result.removed.length} stale plaintext memory file(s)`
          );
        }
      })
      .catch((error) => {
        logWarn(
          LOG_MODULE,
          'dev-data cleanup failed (live memory path unaffected)',
          error instanceof Error ? error.message : String(error)
        );
      });
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
// gate (MEMORY_ENABLED, now true — see wiring.ts) so host tests can exercise
// it directly with an injected in-memory store, without needing to flip a
// real flag or reach an actual MEMORY_ENABLED-gated call site. `notes` is the
// same newest-first list applyMemoryAndSkills already read via
// readMemoryNotes (no double disk read).
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
 * Shadow a G2 memory recall. MEMORY_ENABLED has been true since 2026-08-05, so
 * this now runs (and logs a parity/divergence finding) on every recall; it is
 * only a no-op if the flag were ever flipped back off. Never throws and never
 * changes what gets injected into the prompt — a shadow failure is logged and
 * swallowed so it cannot break the live run.
 */
export async function shadowMemoryRecall(
  agent: { id: string; name: string; prompt: string },
  notes: MemoryNote[]
): Promise<void> {
  // Master enable/kill switch (wiring.ts): everything below only goes dead
  // again if MEMORY_ENABLED is flipped back to false.
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
 * inside `if (MEMORY_ENABLED)`; the flag has been true since 2026-08-05, so
 * this runs on every applyMemoryAndSkills call and is now the PRIMARY recall
 * path — G2's own recallMemoryNotes only runs as the fallback below when this
 * returns `null`.
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
 * persistRememberFact / captureRunMemory inside `if (MEMORY_ENABLED)`; the
 * flag has been true since 2026-08-05, so this is now the PRIMARY write path
 * for both callers — G2's own writeMemoryNote only runs as the fallback when
 * this returns `false`. (writeGlobalMemoryNote in lib/agent-manager.ts is a
 * separate, still-G2-only write path that never calls this function at all —
 * see that function's comment for why.)
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
    // Track C (MEMORY-001, see DEFERRED.md): write-boundary PII/taint scan.
    // Pure rule-based (lib/memory/pii-guard.ts), same shape as secret-guard.ts.
    // The result is stored as opaque metadata (kinds only, never the matched
    // text — pii-guard.ts's own contract) so a future recall/routing
    // consumer can see "this record was flagged" without this write path
    // itself deciding what to do about it (fail-closed policy enforcement is
    // explicitly out of scope for Track C — see the recall-boundary wiring in
    // lib/model-router/wiring.ts's touchesPii for where the signal is
    // actually surfaced for a future routing decision).
    const pii = scanForPii(record.text);
    await deps.store.put({
      namespace: record.namespace,
      key: record.key,
      kind: record.kind,
      text: record.text,
      tags: record.tags,
      metadata: pii.hasPii ? { piiTaint: 'true', piiKinds: pii.kinds.join(',') } : undefined,
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

// Convert a MemoryRecord back onto G2's MemoryNote shape (inverse of
// g2NoteToRecord) so activateMemoryList's caller can reuse Sidebar's existing
// MemoryNote-shaped renderer unchanged.
function recordToNote(agentId: string, record: MemoryRecord): MemoryNote {
  return {
    id: record.key,
    agentId,
    type: (record.kind as MemoryNoteType) ?? 'fact',
    created: new Date(record.createdAt).toISOString(),
    tags: record.tags,
    text: record.text,
  };
}

/**
 * MEMORY-001 Step 5 — activated list, for the Sidebar's per-agent memory
 * detail popup (the "Sidebar count -> list().length" strangler item from the
 * 2026-07-16 design that Steps 3/4 never covered — implemented 2026-08-05 as
 * a prerequisite for flipping the flag, since without it the popup would have
 * frozen on stale G2 reads once Step 4 started writing new notes to
 * MEMORY-001 instead of G2). Only ever called from Sidebar.tsx (and
 * MemoryWorkbenchPane.tsx) inside `if (MEMORY_ENABLED)`; the flag has been
 * true since 2026-08-05, so this is now the PRIMARY list path — G2's own
 * readMemoryNotes only runs as the fallback when this returns `null`.
 *
 * A detail popup can be opened for an agent that has never gone through
 * activateMemoryRecall/activateMemoryWrite yet (e.g. right after the flag is
 * flipped, before that agent's next run), so this does its own one-time
 * mirror-import from G2 rather than assuming importedAgents already has the
 * agent — same idempotent adapter.put upsert import as importAndQuery, kept
 * separate here so a display-only popup never has to fabricate the
 * `notes`/`name`/`prompt` fields importAndQuery expects from a live run.
 *
 * Returns null (not []) on ANY internal failure so the caller falls back to
 * G2's readMemoryNotes, exactly like activateMemoryRecall/activateMemoryWrite
 * — G2 stays the safety net, never a silently-empty popup. Never throws.
 */
/**
 * 2026-08-07 on-device QA finding (docs/superpowers/DEFERRED.md): Memory
 * Workbench's GLOBAL_MEMORY_SCOPE section stayed permanently empty even
 * right after writing a brand-new global note and pressing Reload — and
 * even a pre-existing note from weeks earlier never showed either. Root
 * cause: `ensureAgentImported`'s one-time-per-session mirror-import is a
 * permanent skip once `importedAgents` has the id (by design, for the hot
 * agent-recall path's "avoid re-writing every note on every run" perf
 * reason documented on ShadowDeps above) — but G2-only writes
 * (writeGlobalMemoryNote / persistRememberFact in lib/agent-manager.ts)
 * never update the MEMORY-001 store OR clear that flag, so the FIRST
 * activateMemoryList call for a given id/session poisons every later call
 * for the rest of the app's lifetime: the store keeps returning whatever
 * it saw at that first import (often `[]`, since `_global` had no notes
 * yet the first time anything touched it), and `[] ?? G2fallback` never
 * triggers the G2 fallback because `[]` is not nullish. Call this right
 * after ANY G2 write path finishes, and from Memory Workbench's Reload
 * button (reload should always mean "re-read from source"), so the next
 * list/recall call re-syncs instead of trusting stale cached emptiness.
 */
export function invalidateMemoryImportCache(agentId: string, deps?: ShadowDeps): void {
  // Deliberately never throws — this is best-effort cache maintenance, not a
  // correctness-critical write, and a failure here must never surface as a
  // failure of whatever G2 write this was called after. `deps` is a plain
  // parameter (not a `= getShadowDeps()` default) so a caller that DOES pass
  // its own deps (host tests, matching every other export in this file)
  // never eagerly constructs the lazy Expo-backed singleton at all.
  try {
    (deps ?? getShadowDeps()).importedAgents.delete(agentId);
  } catch (error) {
    logWarn(
      LOG_MODULE,
      'invalidateMemoryImportCache failed (live write unaffected, next read may stay stale)',
      error instanceof Error ? error.message : String(error)
    );
  }
}

export async function activateMemoryList(
  agentId: string,
  deps: ShadowDeps = getShadowDeps()
): Promise<MemoryNote[] | null> {
  try {
    const namespace = agentNamespace(agentId);
    await ensureAgentImported(agentId, deps);
    const records = await deps.store.list(namespace);
    return records
      .map((record) => recordToNote(agentId, record))
      .sort((a, b) => b.created.localeCompare(a.created));
  } catch (error) {
    logWarn(
      LOG_MODULE,
      'activated list failed, caller should fall back to G2 (live run unaffected)',
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}

// One-time-per-session G2 mirror-import for callers (list/delete/update) that
// can be reached before the agent's next live run — same idempotent
// adapter.put upsert as importAndQuery, without needing a live run's
// notes/name/prompt. Extracted from activateMemoryList so the Workbench CRUD
// entry points below can never operate on a store that has not yet seen the
// agent's pre-flip G2 notes (deleting/editing only the store copy of a note
// that still exists as a G2 .md would let it resurrect on the next import).
async function ensureAgentImported(agentId: string, deps: ShadowDeps): Promise<void> {
  if (deps.importedAgents.has(agentId)) return;
  const g2Notes = await readMemoryNotes(agentId);
  for (const note of g2Notes) {
    await deps.adapter.put(g2NoteToRecord(note));
  }
  deps.importedAgents.add(agentId);
}

/**
 * Memory Workbench — delete one note by id (works for both a real agent's
 * namespace and GLOBAL_MEMORY_SCOPE). Removes the record from the MEMORY-001
 * store AND best-effort removes the G2 .md source file: without the latter,
 * the per-session mirror-import (ensureAgentImported) would resurrect the
 * note on the next app launch, which is the worst possible outcome for a
 * user-facing delete. Both removals must succeed for a `true` result.
 *
 * Matches the module's fallback contract: returns false (never throws) on any
 * internal failure so the caller can surface an error instead of crashing.
 */
export async function deleteMemoryNoteById(
  agentId: string,
  noteId: string,
  deps: ShadowDeps = getShadowDeps()
): Promise<boolean> {
  try {
    const namespace = agentNamespace(agentId);
    // Import first so a note that today exists only as a G2 .md file is
    // tracked (and removed) instead of surviving in G2 unnoticed.
    await ensureAgentImported(agentId, deps);
    await deps.store.delete(namespace, noteId);
    const g2Removed = await deleteMemoryNoteFile(agentId, noteId);
    if (!g2Removed) {
      logWarn(
        LOG_MODULE,
        `delete of note ${noteId} (agent ${agentId}) removed the store record but the G2 file removal failed — the note may resurrect on next launch`
      );
      return false;
    }
    return true;
  } catch (error) {
    logWarn(
      LOG_MODULE,
      'note delete failed (live run unaffected)',
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}

/**
 * Memory Workbench — edit one note's text and/or tags by id. Reuses G2's OWN
 * makeMemoryNote (same trim, MAX_NOTE_CHARS truncation, tag normalization and
 * deterministic id derivation) exactly like activateMemoryWrite, so an edited
 * note is normalized identically to a freshly-written one. Because the id is
 * content-derived, an edited TEXT re-derives the id: the record is re-keyed,
 * the stale key deleted, and `created` is preserved from the existing record
 * (an edit is not a new fact). The G2 .md file for the OLD id is removed
 * best-effort for the same resurrect-on-import reason as
 * deleteMemoryNoteById; the edited content lives in the MEMORY-001 store
 * only, exactly like an activateMemoryWrite write.
 *
 * Returns the updated MemoryNote (with the possibly-new id) on success, or
 * null (never throws) on any internal failure / unknown id / empty text.
 */
export async function updateMemoryNoteById(
  params: { agentId: string; id: string; text: string; tags?: string[] },
  deps: ShadowDeps = getShadowDeps()
): Promise<MemoryNote | null> {
  try {
    const namespace = agentNamespace(params.agentId);
    await ensureAgentImported(params.agentId, deps);
    const existing = await deps.store.get(namespace, params.id);
    if (!existing) {
      logWarn(LOG_MODULE, `note update failed — id ${params.id} not found for agent ${params.agentId}`);
      return null;
    }
    const note = makeMemoryNote({
      agentId: params.agentId,
      type: (existing.kind as MemoryNoteType) ?? 'fact',
      text: params.text,
      tags: params.tags ?? existing.tags,
      // ISO round-trips exactly through g2NoteToRecord's Date.parse, so the
      // original creation time survives the edit.
      created: new Date(existing.createdAt).toISOString(),
    });
    if (!note.text) {
      logWarn(LOG_MODULE, `note update refused — empty replacement text for ${params.id}`);
      return null;
    }
    // Same write-boundary PII/taint scan as activateMemoryWrite (Track C):
    // an edit can introduce PII just as easily as a fresh write.
    const pii = scanForPii(note.text);
    const record: MemoryRecord = {
      ...g2NoteToRecord(note),
      updatedAt: Date.now(),
      metadata: pii.hasPii ? { piiTaint: 'true', piiKinds: pii.kinds.join(',') } : undefined,
    };
    // adapter.put (not store.put): preserves the G2 created timestamp the
    // record above already carries, same reasoning as the mirror-import.
    await deps.adapter.put(record);
    if (note.id !== params.id) {
      await deps.store.delete(namespace, params.id);
    }
    const g2Removed = await deleteMemoryNoteFile(params.agentId, params.id);
    if (!g2Removed) {
      logWarn(
        LOG_MODULE,
        `update of note ${params.id} (agent ${params.agentId}) wrote the store record but the stale G2 file removal failed — the pre-edit note may resurrect on next launch`
      );
      return null;
    }
    return note;
  } catch (error) {
    logWarn(
      LOG_MODULE,
      'note update failed (live run unaffected)',
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}
