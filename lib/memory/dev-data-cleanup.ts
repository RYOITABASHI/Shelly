// MEMORY-001 Track B — dev-machine plaintext cleanup (see DEFERRED.md
// MEMORY-001, 2026-07-16 plan, Track B).
//
// MEMORY_ENABLED stays false and no production setter exists (wiring.ts), so
// no real user has ever written through this store — but a developer machine
// that exercised the memory-v2 shadow store BEFORE Track A's envelope
// encryption landed may still have plaintext MemoryRecord JSON files on disk
// under memory-v2/<namespace>/<key>.json.
//
// This is deliberately a DELETE, not a migrate: the design doc is explicit
// that migration is unnecessary (there is no real data worth preserving), so
// detection here always removes the stale file rather than re-encrypting it
// in place. Detection is POSITIVE, not "unknown so delete it": a file must
// parse as JSON and match the exact pre-Track-A plaintext MemoryRecord shape
// (and NOT the Track-A EncryptedEnvelope shape) before it is touched.
// Anything else — corrupt JSON, an envelope, or an unrecognized shape — is
// left alone, mirroring storage-json.ts's own conservative "can't identify
// it, don't destroy it" read-path behavior.

import { FsPort } from './types';

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

// True when `raw` parses as a pre-Track-A plaintext MemoryRecord (bare
// namespace/key/kind/text/tags/createdAt/updatedAt object) and NOT as a
// Track-A EncryptedEnvelope (v/iv/ciphertext). Pure and host-testable with a
// bare string — mirrors storage-json.ts's private isWellFormed /
// isWellFormedEnvelope guards, but lives here (not exported from
// storage-json.ts) so this module stays a leaf that doesn't need to import
// the adapter class.
export function isPreEncryptionRecordFile(raw: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const looksLikeEnvelope =
    typeof v.v === 'number' && typeof v.iv === 'string' && typeof v.ciphertext === 'string';
  if (looksLikeEnvelope) return false;
  return (
    typeof v.namespace === 'string' &&
    typeof v.key === 'string' &&
    typeof v.kind === 'string' &&
    typeof v.text === 'string' &&
    Array.isArray(v.tags) &&
    typeof v.createdAt === 'number' &&
    typeof v.updatedAt === 'number'
  );
}

export interface CleanupResult {
  scanned: number;
  removed: string[]; // file paths that were deleted
}

// One-time-per-launch sweep of a memory-v2 root: walks each namespace
// subdirectory (root/<namespace>/<key>.json, the exact layout
// JsonFileMemoryStorage writes/reads) and deletes any file that positively
// matches the pre-encryption plaintext shape. Never throws — any I/O failure
// at the root, a namespace dir, or an individual file degrades to "skip it"
// so a single unreadable entry can never abort the sweep or brick a
// legitimate namespace.
export async function cleanupStalePlaintextMemoryFiles(
  fs: FsPort,
  root: string
): Promise<CleanupResult> {
  const result: CleanupResult = { scanned: 0, removed: [] };
  let namespaceDirs: string[];
  try {
    namespaceDirs = await fs.listFiles(root);
  } catch {
    return result; // root doesn't exist yet / unreadable — nothing to clean
  }
  for (const nsEntry of namespaceDirs) {
    const nsDir = joinPath(root, nsEntry);
    let files: string[];
    try {
      files = await fs.listFiles(nsDir);
    } catch {
      continue; // nsEntry wasn't a readable directory (e.g. a stray file) — skip
    }
    for (const name of files) {
      if (!name.endsWith('.json')) continue;
      const file = joinPath(nsDir, name);
      result.scanned += 1;
      let raw: string | null;
      try {
        raw = await fs.readFile(file);
      } catch {
        continue;
      }
      if (raw === null) continue;
      if (isPreEncryptionRecordFile(raw)) {
        await fs.deleteFile(file);
        result.removed.push(file);
      }
    }
  }
  return result;
}
