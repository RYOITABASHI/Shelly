/**
 * lib/agent-data-sync.ts — bundle/restore helpers for backing up agent
 * definitions, skill recipes, and memory notes to/from the same GitHub Gist
 * lib/dotfiles-sync.ts already uses for settings/snippets/theme sync.
 *
 * DEFERRED-tracked gap (Fable5/Codex full-codebase review, 2026-08-06):
 * agents (~/.shelly/agents/*.json), skills (~/.shelly/agents/skills/*.md),
 * and memory (~/.shelly/agents/memory/<agentId>/*.md) all live as real
 * filesystem files, not AsyncStorage — the existing dotfiles-sync only ever
 * covered AsyncStorage-backed settings, so "the agent that grew with you"
 * had no backup/restore path at all. Losing or replacing the phone lost it.
 *
 * Deliberately dependency-free (no expo-file-system import, no Zustand) —
 * takes a small `SyncFsPort` so the bundling/restoring LOGIC is unit-testable
 * with an in-memory fake, mirroring lib/memory/types.ts's FsPort split
 * between fs-expo.ts (device) and the test double, but with its own shape:
 * FsPort's listFiles() doesn't distinguish files from directories, which
 * this module needs (memory notes are one level deeper than skills/agents).
 */

export interface SyncFsEntry {
  name: string;
  isDirectory: boolean;
}

export interface SyncFsPort {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, data: string): Promise<void>;
  /** Idempotent — deleting an already-missing file is a no-op, never throws. */
  deleteFile(path: string): Promise<void>;
  /** Empty array for a missing/non-existent directory — never throws. */
  listEntries(dir: string): Promise<SyncFsEntry[]>;
  ensureDir(dir: string): Promise<void>;
}

function hasExtension(name: string, extensions: readonly string[]): boolean {
  return extensions.some((ext) => name.endsWith(ext));
}

/**
 * Bundles every FILE directly inside `dir` matching one of `extensions`.
 * Directories inside `dir` (e.g. agents/memory, agents/skills, agents/locks
 * sitting alongside agents/*.json) are silently skipped — exactly the
 * "flat, one level" shape agents and skills both use.
 *
 * `isValid` (2026-08-06 Codex review finding): ~/.shelly/agents/*.json is
 * NOT exclusively agent metadata — dm-pairings.json and policy.json live
 * flat in that same directory too. Without a content-shape check, "back up
 * my agents" would also upload (and, on restore, silently overwrite) those
 * unrelated files — a real data-loss and DM-pairing-metadata-leak risk.
 * Deliberately a caller-supplied predicate over PARSED content rather than a
 * filename denylist (agent ids are user-chosen and could coincidentally
 * collide with a denied name) — keeps this module's own dependency-free
 * contract (no Agent type import here) while letting the caller reuse its
 * real, already-tested type guard (lib/agent-manager.ts's isAgentMetadata).
 * Absent = no filtering, preserving collectFlatBundle's original behavior
 * for the skills category, which has no such ambiguity.
 */
export async function collectFlatBundle(
  fs: SyncFsPort,
  dir: string,
  extensions: readonly string[],
  isValid?: (content: string, filename: string) => boolean,
): Promise<Record<string, string>> {
  const bundle: Record<string, string> = {};
  const entries = await fs.listEntries(dir);
  for (const entry of entries) {
    if (entry.isDirectory || !hasExtension(entry.name, extensions)) continue;
    const content = await fs.readFile(`${dir}/${entry.name}`);
    if (content === null) continue;
    if (isValid && !isValid(content, entry.name)) continue;
    bundle[entry.name] = content;
  }
  return bundle;
}

/**
 * Bundles every FILE one level below `dir` — i.e. `dir`'s immediate
 * subdirectories' own files matching `extensions` — keyed as
 * `"<subdir>/<filename>"`. Matches memory's `memory/<agentId>/*.md` shape
 * (including a global namespace directory, which is just another subdirectory
 * name to this function — no special-casing needed).
 */
export async function collectNestedBundle(
  fs: SyncFsPort,
  dir: string,
  extensions: readonly string[],
): Promise<Record<string, string>> {
  const bundle: Record<string, string> = {};
  const subdirs = await fs.listEntries(dir);
  for (const subdir of subdirs) {
    if (!subdir.isDirectory) continue;
    const subPath = `${dir}/${subdir.name}`;
    const files = await fs.listEntries(subPath);
    for (const file of files) {
      if (file.isDirectory || !hasExtension(file.name, extensions)) continue;
      const content = await fs.readFile(`${subPath}/${file.name}`);
      if (content !== null) bundle[`${subdir.name}/${file.name}`] = content;
    }
  }
  return bundle;
}

/**
 * Describes the bundle's own collection shape (mirrors the arguments
 * collectFlatBundle/collectNestedBundle were called with) — REQUIRED
 * whenever `mirror` is requested, so cleanup can be scoped to exactly the
 * files this category owns. Without it, "delete what's not in the bundle"
 * has no way to tell an agents bundle's sibling `skills/` subdirectory (or
 * `.env`, `policy.json`, `dm-pairings.json` sitting flat alongside
 * agents/*.json) apart from its own files — the exact 2026-08-06 Codex
 * review finding this type exists to close.
 */
export interface RestoreBundleShape {
  nested: boolean;
  extensions: readonly string[];
  /** Same predicate collectFlatBundle was filtered with, if any — applied
   *  BOTH to which existing files mirror-delete is allowed to touch AND to
   *  which bundle entries get written at all, so a contaminated/manually-
   *  edited Gist can't smuggle a write to an unrelated file (e.g.
   *  policy.json) back in through the agents bundle either. Takes the
   *  filename too (2026-08-06 Codex review finding, sixth pass): a
   *  content-only check (e.g. "does this parse as {id, name, prompt}")
   *  can't tell a genuine agent-1.json apart from a TAMPERED bundle entry
   *  keyed "policy.json" whose value was forged to also look agent-shaped —
   *  a real caller (looksLikeAgentMetadataJson) cross-checks the filename
   *  against the content's own id (e.g. filename === `${id}.json`) so a
   *  forged entry can only ever land on ITS OWN id's file, never someone
   *  else's. */
  isValid?: (content: string, filename: string) => boolean;
}

/**
 * Inverse of both collect functions above: writes every `key: content` pair
 * back under `dir`, creating one intermediate directory per key that
 * contains a "/" (memory's `<agentId>/<filename>` shape) and none for a flat
 * key (agents/skills' plain `<filename>` shape) — the same function restores
 * both bundle shapes since it only ever needs to ensure the key's own parent
 * exists, however deep that is.
 *
 * A key is REJECTED (skipped, not written, not throwing — a corrupt/hostile
 * Gist must never crash a restore or escape `dir` via `..`) when it contains
 * `..` path segments, is empty, or resolves to something other than exactly
 * `dir/<subdir>/<filename>` or `dir/<filename>`. When `shape` is given, a key
 * is ALSO rejected if its filename doesn't match `shape.extensions`, or its
 * content fails `shape.isValid` — the read-path twin of collectFlatBundle's
 * own filtering, so a contaminated bundle can't write outside its category
 * even without mirror.
 *
 * `mirror` (2026-08-06 Codex review finding): by default this only ADDS/
 * OVERWRITES — a file that existed locally but is absent from `bundle`
 * (deleted on another device, then synced) is left behind, so a deletion on
 * device A never actually reaches device B. Passing `{mirror: true, shape}`
 * also DELETES any existing file under `dir` that (a) matches `shape`'s own
 * extensions/isValid (i.e. is actually one of THIS category's files, never a
 * sibling category's or an unrelated file) and (b) is not present in
 * `bundle`. `mirror` without `shape` throws — silently falling back to
 * "delete everything regardless of shape" is exactly the bug being fixed.
 *
 * A non-empty bundle already implies real work to do; an EMPTY bundle is
 * gated separately by `allowEmptyMirror` (default false) — "the gist has
 * zero entries for this category" is only trustworthy when the CALLER has
 * already ruled out "this is actually a parse failure/network hiccup masquer
 * -ading as empty" (see lib/dotfiles-sync.ts's syncFromGist, which only ever
 * reaches an empty bundle after a successful, well-formed JSON parse).
 *
 * Returns `{writtenKeys, mirrorDeletedKeys}` — 2026-08-06 Codex review
 * finding: a caller that needs to do its own side-effecting work keyed off
 * "which entries did this bundle really contain" or "which local files did
 * mirror actually remove" (lib/dotfiles-sync.ts's clearDeletedAgentMarkers)
 * must use THESE lists, never `Object.keys(bundle)` or its own re-derivation
 * of what got deleted. The raw bundle can carry a hostile
 * `../../etc/passwd`-shaped key that restoreBundle itself safely skips — a
 * caller re-deriving its own "which agent ids were restored/deleted" list
 * from the untrusted raw keys (or by diffing bundle against disk itself)
 * would reintroduce exactly the path traversal / shape-scoping bugs this
 * function's own write and delete paths already guard against.
 */
export interface RestoreBundleResult {
  writtenKeys: string[];
  mirrorDeletedKeys: string[];
}

export async function restoreBundle(
  fs: SyncFsPort,
  dir: string,
  bundle: Record<string, string>,
  opts: { mirror?: boolean; shape?: RestoreBundleShape; allowEmptyMirror?: boolean } = {},
): Promise<RestoreBundleResult> {
  if (opts.mirror && !opts.shape) {
    throw new Error('restoreBundle: mirror requires shape (cannot scope deletion without it)');
  }
  const shape = opts.shape;
  const rawKeyCount = Object.keys(bundle).length;
  const keys = Object.keys(bundle)
    .filter(isSafeRelativeKey)
    // Codex review finding (fifth pass): matching the extension against
    // ONLY the basename let a flat category (agents, skills — shape.nested
    // === false) accept a key like "plans/agent-1.json" as if it were a
    // plain "agent-1.json" — restoreBundle's own write path then takes the
    // slash branch and writes to `${dir}/plans/agent-1.json`, landing inside
    // agents/plans/ (a REAL sibling directory PlanSpec already owns) instead
    // of refusing it. A flat shape must reject any key containing "/" at
    // all; a nested shape must require EXACTLY one "/" (agentId/filename —
    // collectNestedBundle never produces anything deeper, see its own doc
    // comment, so a second "/" is never legitimate either).
    .filter((key) => {
      if (!shape) return true;
      const slashCount = (key.match(/\//g) || []).length;
      return shape.nested ? slashCount === 1 : slashCount === 0;
    })
    .filter((key) => !shape || hasExtension(basename(key), shape.extensions))
    .filter((key) => !shape?.isValid || shape.isValid(bundle[key], basename(key)));

  if (keys.length === 0) {
    // Codex review finding (fifth pass): a NON-empty raw bundle that
    // survived JSON-parsing but had every single entry rejected by the
    // filters above (wrong shape, wrong extension, or fails isValid) is
    // CORRUPT/foreign content, not a deliberate "this category is empty"
    // signal — mirror-deleting the local category on that basis would treat
    // "the Gist is garbage" the same as "the user emptied this category,"
    // wiping real local data over a malformed remote file. Only a bundle
    // that was ALREADY empty before any filtering (`rawKeyCount === 0` —
    // syncToGist's own explicit `{}` for a deliberately-emptied category)
    // is trustworthy enough to mirror-clear.
    if (opts.mirror && opts.allowEmptyMirror && shape && rawKeyCount === 0) {
      await fs.ensureDir(dir);
      const mirrorDeletedKeys = await deleteEntriesNotIn(fs, dir, new Set(), shape);
      return { writtenKeys: [], mirrorDeletedKeys };
    }
    return { writtenKeys: [], mirrorDeletedKeys: [] };
  }
  // A fresh install (or a device that never wrote to this category yet) has
  // no ~/.shelly/agents/skills or /memory directory at all — Codex review
  // finding: writing a flat entry straight to `dir/key` without first
  // ensuring `dir` exists fails closed on Expo (writeAsStringAsync requires
  // an existing parent), turning a perfectly valid backup into a restore
  // that silently drops every flat-bundle category. Nested entries create
  // their OWN subdirectory below regardless, but still need `dir` itself to
  // exist first.
  await fs.ensureDir(dir);
  const keySet = new Set(keys);
  for (const key of keys) {
    const content = bundle[key];
    const slash = key.indexOf('/');
    if (slash === -1) {
      await fs.writeFile(`${dir}/${key}`, content);
    } else {
      const subdirName = key.slice(0, slash);
      const fileName = key.slice(slash + 1);
      const subPath = `${dir}/${subdirName}`;
      await fs.ensureDir(subPath);
      await fs.writeFile(`${subPath}/${fileName}`, content);
    }
  }
  let mirrorDeletedKeys: string[] = [];
  if (opts.mirror && shape) {
    mirrorDeletedKeys = await deleteEntriesNotIn(fs, dir, keySet, shape);
  }
  return { writtenKeys: keys, mirrorDeletedKeys };
}

function basename(key: string): string {
  const slash = key.indexOf('/');
  return slash === -1 ? key : key.slice(slash + 1);
}

/**
 * Deletes existing files under `dir` that belong to `shape`'s category
 * (right extension, and right isValid content when given) but are absent
 * from `keySet`. Deliberately shape-aware rather than "every entry not in
 * keySet": a flat category (agents, skills) NEVER even looks inside a
 * subdirectory (that's some OTHER category's territory — agents/skills,
 * agents/memory, agents/locks, ...), and a nested category (memory) NEVER
 * touches a flat file sitting directly in `dir` — see this function's
 * doc-comment-bearing caller, restoreBundle, for the full incident this
 * scoping exists to prevent.
 */
async function deleteEntriesNotIn(
  fs: SyncFsPort,
  dir: string,
  keySet: ReadonlySet<string>,
  shape: RestoreBundleShape,
): Promise<string[]> {
  const deleted: string[] = [];
  const entries = await fs.listEntries(dir);
  if (!shape.nested) {
    for (const entry of entries) {
      if (entry.isDirectory || !hasExtension(entry.name, shape.extensions) || keySet.has(entry.name)) continue;
      if (shape.isValid) {
        const content = await fs.readFile(`${dir}/${entry.name}`);
        if (content === null || !shape.isValid(content, entry.name)) continue; // not this category's file — never touch it.
      }
      await fs.deleteFile(`${dir}/${entry.name}`);
      deleted.push(entry.name);
    }
    return deleted;
  }
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const subPath = `${dir}/${entry.name}`;
    const subEntries = await fs.listEntries(subPath);
    for (const file of subEntries) {
      if (file.isDirectory || !hasExtension(file.name, shape.extensions)) continue;
      if (!keySet.has(`${entry.name}/${file.name}`)) {
        await fs.deleteFile(`${subPath}/${file.name}`);
        deleted.push(`${entry.name}/${file.name}`);
      }
    }
  }
  return deleted;
}

function isSafeRelativeKey(key: string): boolean {
  if (!key || key.startsWith('/') || key.includes('\\')) return false;
  const segments = key.split('/');
  if (segments.length > 2) return false;
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}
