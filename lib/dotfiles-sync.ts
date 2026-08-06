/**
 * lib/dotfiles-sync.ts — Dotfiles sync via GitHub Gist
 *
 * Syncs Shelly settings, snippets, keybindings, and themes
 * to/from a GitHub Gist for cross-device portability.
 *
 * Optionally (opt-in, `includeAgentData`) also backs up/restores agent
 * definitions, skill recipes, and memory notes — see AGENT_DATA_CATEGORIES
 * below. Those live as real filesystem files under ~/.shelly/agents (not
 * AsyncStorage), so they use lib/agent-data-sync.ts's bundle/restore helpers
 * instead of the plain AsyncStorage.getItem/setItem loop SYNCABLE_FILES uses.
 * Off by default: memory notes and agent prompts can carry personal facts,
 * so uploading them to a Gist must be an explicit choice, not a side effect
 * of the (unrelated) settings/snippets/theme sync this store already did.
 */
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { getHomePath } from '@/lib/home-path';
import { collectFlatBundle, collectNestedBundle, restoreBundle, SyncFsPort } from '@/lib/agent-data-sync';
import { createAgentDataSyncFsPort } from '@/lib/agent-data-sync-fs-expo';

// ── Types ────────────────────────────────────────────────────────────────────

interface DotfileEntry {
  filename: string;
  storageKey: string;
  description: string;
}

/** Files to sync */
const SYNCABLE_FILES: DotfileEntry[] = [
  { filename: 'shelly-settings.json', storageKey: 'shelly_settings', description: 'Terminal settings' },
  { filename: 'shelly-snippets.json', storageKey: '@shelly/snippets', description: 'Saved snippets' },
  { filename: 'shelly-keybindings.json', storageKey: '@shelly/keybindings', description: 'Custom keybindings' },
  { filename: 'shelly-theme.json', storageKey: '@shelly/theme', description: 'Theme selection' },
  { filename: 'shelly-custom-themes.json', storageKey: '@shelly/custom_themes', description: 'Custom themes' },
  { filename: 'shelly-locale.json', storageKey: '@shelly/locale', description: 'Language preference' },
  { filename: 'shelly-workflows.json', storageKey: '@shelly/workflows', description: 'Workflows' },
];

// ~/.shelly/agents/*.json is NOT exclusively agent metadata — dm-pairings.json
// and policy.json live flat in that same directory too (2026-08-06 Codex
// review finding; the exact same shape guard lib/agent-manager.ts's
// isAgentMetadata already uses to solve this identical problem for the
// Sidebar's own agent list). Deliberately duplicated here in miniature
// rather than importing isAgentMetadata from agent-manager.ts: that file
// pulls in expo-file-system at module scope, which the plain-node "unit"
// Jest project (this store's own tests) cannot load.
const SAFE_AGENT_ID_RE = /^[A-Za-z0-9_-]+$/;
// `filename` param (2026-08-06 Codex review finding, sixth pass): a
// content-only check can't tell a genuine agent-1.json apart from a
// TAMPERED bundle entry keyed "policy.json" whose value was forged to also
// parse as {id, name, prompt} — restoreBundle would then happily overwrite
// the real policy.json with attacker-controlled "agent" content. Requiring
// filename === `${id}.json` means a forged entry can only ever land on ITS
// OWN id's file, never someone else's — the same "id must match its own
// filename" invariant lib/agent-manager.ts's real writers already maintain
// (agentsDir()/${agent.id}.json, never a caller-chosen filename).
function looksLikeAgentMetadataJson(content: string, filename: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const record = parsed as { id?: unknown; name?: unknown; prompt?: unknown };
  return (
    typeof record.id === 'string' &&
    SAFE_AGENT_ID_RE.test(record.id) &&
    typeof record.name === 'string' &&
    typeof record.prompt === 'string' &&
    filename === `${record.id}.json`
  );
}

/** Gist filenames + on-device (dir, extensions, nested?) for the opt-in
 *  agent-data categories. `nested: true` = collectNestedBundle/memory's
 *  `<agentId>/<file>` shape; `nested: false` = collectFlatBundle/agents'
 *  and skills' plain `<file>` shape. Each bundle is JSON.stringify'd as a
 *  SINGLE gist file (not one gist file per agent/skill/note) so the gist's
 *  own file COUNT stays static regardless of how many agents/skills/notes
 *  exist — mirrors why SYNCABLE_FILES above is also a fixed list.
 */
const AGENT_DATA_CATEGORIES = [
  {
    gistFilename: 'shelly-agents-bundle.json',
    dir: () => `${getHomePath()}/.shelly/agents`,
    extensions: ['.json'],
    nested: false,
    isValid: looksLikeAgentMetadataJson,
  },
  { gistFilename: 'shelly-skills-bundle.json', dir: () => `${getHomePath()}/.shelly/agents/skills`, extensions: ['.md'], nested: false, isValid: undefined },
  { gistFilename: 'shelly-memory-bundle.json', dir: () => `${getHomePath()}/.shelly/agents/memory`, extensions: ['.md'], nested: true, isValid: undefined },
] as const;

// lib/agent-manager.ts's deleteAgent() marks a deleted agent by writing
// ~/.shelly/agents/.deleted/<agentId> (a plain timestamp file) rather than
// only removing <agentId>.json — loadAgentsFromDisk hides any agent with a
// matching marker even if its metadata file exists. 2026-08-06 Codex review
// finding: restoring an agents bundle wrote the JSON back but never cleared
// this marker, so an agent deleted on device A, then re-synced FROM a Gist
// that still has it (e.g. device B never deleted it, or the Gist predates
// the deletion), silently stayed hidden on the restoring device — the
// restore looked like it worked (the file was there) but the agent never
// actually came back. Deliberately duplicated as a bare literal ('.deleted')
// rather than importing DELETED_AGENT_MARKER_DIR from lib/agent-manager.ts:
// that file imports expo-file-system at module scope, which the plain-node
// "unit" Jest project (this store's own tests) cannot load — same reasoning
// as looksLikeAgentMetadataJson below.
const DELETED_AGENT_MARKER_DIR = '.deleted';

async function clearDeletedAgentMarkers(fs: SyncFsPort, writtenKeys: string[]): Promise<void> {
  const agentsDir = `${getHomePath()}/.shelly/agents`;
  for (const key of writtenKeys) {
    if (!key.endsWith('.json')) continue;
    const agentId = key.slice(0, -'.json'.length);
    await fs.deleteFile(`${agentsDir}/${DELETED_AGENT_MARKER_DIR}/${agentId}`);
  }
}

// Codex review finding, seventh pass: the mirror-delete half of restore also
// needs the marker system's participation, not just the write half above.
// HomeInitializer.kt's installAgentIfMissing() recreates a handful of
// built-in/seeded agents (x-trend-source-collector, etc.) on every launch
// whenever their JSON file is absent — UNLESS a .deleted marker says the
// user removed it on purpose. restoreBundle(mirror:true) deletes an agent's
// JSON when the incoming Gist bundle no longer has it (a deletion made on
// another device), but without also writing the marker, that same seeded
// agent would simply reappear the next time the app launches, silently
// undoing a deletion that was supposed to have synced.
async function writeDeletedAgentMarkers(fs: SyncFsPort, mirrorDeletedKeys: string[]): Promise<void> {
  const jsonKeys = mirrorDeletedKeys.filter((key) => key.endsWith('.json'));
  if (jsonKeys.length === 0) return;
  const agentsDir = `${getHomePath()}/.shelly/agents`;
  const markerDir = `${agentsDir}/${DELETED_AGENT_MARKER_DIR}`;
  await fs.ensureDir(markerDir);
  for (const key of jsonKeys) {
    const agentId = key.slice(0, -'.json'.length);
    await fs.writeFile(`${markerDir}/${agentId}`, new Date().toISOString());
  }
}

const SECURE_KEY_PAT = 'shelly_dotfiles_pat';
const STORAGE_KEY_GIST = '@shelly/gist_id';
const STORAGE_KEY_LAST_SYNC = '@shelly/last_sync';
const STORAGE_KEY_INCLUDE_AGENT_DATA = '@shelly/dotfiles_include_agent_data';

// ── Store ────────────────────────────────────────────────────────────────────

type SyncState = {
  pat: string;
  gistId: string;
  lastSync: number | null;
  isSyncing: boolean;
  error: string | null;
  /** Opt-in: also back up/restore agent definitions, skill recipes, and
   *  memory notes through the same Gist. Off by default. */
  includeAgentData: boolean;

  loadConfig: () => Promise<void>;
  setPat: (pat: string) => void;
  setIncludeAgentData: (value: boolean) => void;
  syncToGist: () => Promise<boolean>;
  syncFromGist: () => Promise<boolean>;
};

export const useDotfilesStore = create<SyncState>((set, get) => ({
  pat: '',
  gistId: '',
  lastSync: null,
  isSyncing: false,
  error: null,
  includeAgentData: false,

  loadConfig: async () => {
    const [pat, gistId, lastSync, includeAgentDataRaw] = await Promise.all([
      SecureStore.getItemAsync(SECURE_KEY_PAT),
      AsyncStorage.getItem(STORAGE_KEY_GIST),
      AsyncStorage.getItem(STORAGE_KEY_LAST_SYNC),
      AsyncStorage.getItem(STORAGE_KEY_INCLUDE_AGENT_DATA),
    ]);
    const includeAgentData = includeAgentDataRaw === '1';
    // Migrate from legacy AsyncStorage if present
    if (!pat) {
      const legacyPat = await AsyncStorage.getItem('@shelly/github_pat');
      if (legacyPat) {
        await SecureStore.setItemAsync(SECURE_KEY_PAT, legacyPat);
        await AsyncStorage.removeItem('@shelly/github_pat');
        set({ pat: legacyPat, gistId: gistId || '', lastSync: lastSync ? parseInt(lastSync, 10) : null, includeAgentData });
        return;
      }
    }
    set({
      pat: pat || '',
      gistId: gistId || '',
      lastSync: lastSync ? parseInt(lastSync, 10) : null,
      includeAgentData,
    });
  },

  setPat: (pat) => {
    set({ pat });
    SecureStore.setItemAsync(SECURE_KEY_PAT, pat);
  },

  setIncludeAgentData: (value) => {
    set({ includeAgentData: value });
    AsyncStorage.setItem(STORAGE_KEY_INCLUDE_AGENT_DATA, value ? '1' : '0');
  },

  syncToGist: async () => {
    const { pat, gistId, includeAgentData, isSyncing } = get();
    if (isSyncing) {
      // Codex review finding (2026-08-06, round 10): syncToGist and
      // syncFromGist read the on-disk agent/skill/memory state at call time
      // and, for syncFromGist, mirror-DELETE local files that fall outside
      // the incoming bundle. Two overlapping calls (e.g. a user double-
      // tapping Upload/Download, or tapping both) previously ran with no
      // mutual exclusion at all — `isSyncing` was tracked in state but never
      // read — so a syncFromGist mirror-delete could remove a local agent
      // between the moment a concurrent syncToGist call collected its
      // upload bundle and the moment that PATCH request actually reached
      // GitHub, uploading the deletion and losing the agent both locally and
      // in the Gist.
      return false;
    }
    if (!pat) {
      set({ error: 'GitHub PAT required' });
      return false;
    }

    set({ isSyncing: true, error: null });

    try {
      // Collect all syncable data
      const files: Record<string, { content: string } | null> = {};
      for (const entry of SYNCABLE_FILES) {
        const data = await AsyncStorage.getItem(entry.storageKey);
        if (data) {
          files[entry.filename] = { content: data };
        }
      }

      if (includeAgentData) {
        const fs = createAgentDataSyncFsPort();
        for (const category of AGENT_DATA_CATEGORIES) {
          const bundle = category.nested
            ? await collectNestedBundle(fs, category.dir(), category.extensions)
            : await collectFlatBundle(fs, category.dir(), category.extensions, category.isValid);
          if (Object.keys(bundle).length > 0) {
            files[category.gistFilename] = { content: JSON.stringify(bundle) };
          } else {
            // Codex review finding, second pass: uploading `null` (file
            // DELETE) for a category that's merely now-empty made "this gist
            // file doesn't exist" ambiguous between two very different
            // states syncFromGist needs to tell apart — "this Gist predates
            // includeAgentData / was last synced with it off" (must NOT
            // mirror-delete anything; the very first P1 finding this round)
            // vs "every note/agent/skill in this category was deliberately
            // deleted since the last sync" (MUST mirror-delete; the original
            // P2 finding). An explicitly-empty `{}` object, not a deleted
            // file, is what lets syncFromGist distinguish "absent" (skip)
            // from "present but empty" (mirror-clear) — see its own comment.
            // Codex review finding, third pass: this must upload EVEN on a
            // BRAND-NEW gist (no `gistId` guard) — the very first sync from a
            // device with zero local agents/skills/notes still needs to
            // encode "empty, on purpose" so a SECOND device downloading this
            // gist mirrors that emptiness instead of keeping its own stale
            // local files (which it would, if this category were omitted
            // entirely and syncFromGist's "absent -> skip" rule applied).
            files[category.gistFilename] = { content: '{}' };
          }
        }
      } else if (gistId) {
        // Codex review finding: turning includeAgentData OFF must actively
        // remove any agent/skill/memory bundle a PRIOR sync already uploaded
        // to this existing gist — GitHub's Gist PATCH only touches files
        // explicitly present in the request body, so simply omitting these
        // three (as the old code did) left personal agent prompts and memory
        // notes sitting in the gist indefinitely after the user opted back
        // out. `null` is GitHub's documented "delete this file" value; a
        // null for a file that was never there is a harmless no-op. Only
        // meaningful on the PATCH (existing-gist) path below — a brand-new
        // gist has nothing to delete.
        for (const category of AGENT_DATA_CATEGORIES) {
          files[category.gistFilename] = null;
        }
      }

      if (Object.keys(files).length === 0) {
        set({ isSyncing: false, error: 'No data to sync' });
        return false;
      }

      let resultGistId = gistId;

      if (gistId) {
        // Update existing gist
        const res = await fetch(`https://api.github.com/gists/${gistId}`, {
          method: 'PATCH',
          headers: {
            Authorization: `token ${pat}`,
            'Content-Type': 'application/json',
            Accept: 'application/vnd.github.v3+json',
          },
          body: JSON.stringify({
            description: 'Shelly Terminal Settings (auto-synced)',
            files,
          }),
        });

        if (!res.ok) {
          if (res.status === 404) {
            // Gist was deleted, create new
            resultGistId = '';
          } else {
            throw new Error(`GitHub API error: ${res.status}`);
          }
        }
      }

      if (!resultGistId) {
        // Create new gist. `null` file values (the agent-data delete-if-present
        // markers above) are only meaningful when editing an EXISTING gist —
        // there is nothing to delete in a brand-new one, and GitHub's create
        // endpoint isn't documented to accept null file values at all, so
        // strip them rather than risk a 400. Reachable when the PATCH above
        // 404'd (gist deleted server-side) while includeAgentData was off.
        const createFiles: Record<string, { content: string }> = {};
        for (const [name, value] of Object.entries(files)) {
          if (value !== null) createFiles[name] = value;
        }
        const res = await fetch('https://api.github.com/gists', {
          method: 'POST',
          headers: {
            Authorization: `token ${pat}`,
            'Content-Type': 'application/json',
            Accept: 'application/vnd.github.v3+json',
          },
          body: JSON.stringify({
            description: 'Shelly Terminal Settings (auto-synced)',
            public: false,
            files: createFiles,
          }),
        });

        if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
        const data = await res.json();
        resultGistId = data.id;
        await AsyncStorage.setItem(STORAGE_KEY_GIST, resultGistId);
      }

      const now = Date.now();
      await AsyncStorage.setItem(STORAGE_KEY_LAST_SYNC, String(now));
      set({ gistId: resultGistId, lastSync: now, isSyncing: false });
      return true;
    } catch (err) {
      set({ isSyncing: false, error: String(err) });
      return false;
    }
  },

  syncFromGist: async () => {
    const { pat, gistId, includeAgentData, isSyncing } = get();
    // See syncToGist's matching guard (Codex review finding, round 10): the
    // same mutual-exclusion gap applies in this direction too — an in-flight
    // syncToGist's upload bundle would go stale (or an in-flight
    // syncFromGist's mirror-delete would race an overlapping one) without it.
    if (isSyncing) {
      return false;
    }
    if (!pat || !gistId) {
      set({ error: 'PAT and Gist ID required' });
      return false;
    }

    set({ isSyncing: true, error: null });

    try {
      const res = await fetch(`https://api.github.com/gists/${gistId}`, {
        headers: {
          Authorization: `token ${pat}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });

      if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
      const data = await res.json();

      // Restore each file
      for (const entry of SYNCABLE_FILES) {
        const file = data.files?.[entry.filename];
        if (file?.content) {
          await AsyncStorage.setItem(entry.storageKey, file.content);
        }
      }

      if (includeAgentData) {
        const fs = createAgentDataSyncFsPort();
        for (const category of AGENT_DATA_CATEGORIES) {
          const file = data.files?.[category.gistFilename];
          // Codex review finding (third pass): a MISSING gist file must be
          // left alone (skip — no write, no mirror-delete), not treated as
          // "this category is empty." A Gist that predates includeAgentData,
          // or was last synced with it off, simply has no
          // shelly-*-bundle.json file at all — that is NOT the same claim as
          // "the category was emptied," and conflating the two let turning
          // includeAgentData on and tapping "Download" against an ordinary
          // settings-only Gist wipe every local agent/skill/memory file.
          // syncToGist's own empty-category branch (see its comment) now
          // uploads an EXPLICIT `{}` rather than deleting the file for
          // exactly this reason — "genuinely emptied" is content `{}`
          // actually present in the Gist, not a missing key in `data.files`.
          if (!file?.content) continue;
          // Codex review finding (second pass): a bundle that parses as an
          // object but fails the string-values check must be treated EXACTLY
          // like a JSON.parse failure — skip this category's sync entirely,
          // never fall through as if it were a genuine empty/delete signal.
          let bundle: Record<string, string> = {};
          let parsedOk = false;
          try {
            const parsed: unknown = JSON.parse(file.content);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              const candidate = parsed as Record<string, unknown>;
              const allStrings = Object.values(candidate).every((v) => typeof v === 'string');
              if (allStrings) {
                bundle = candidate as Record<string, string>;
                parsedOk = true;
              }
            }
          } catch {
            // fall through — parsedOk stays false, handled below
          }
          if (!parsedOk) continue; // corrupt/foreign gist file content — skip this category, never throw
          // mirror: true — "Sync from Gist" is an explicit, user-initiated
          // "make this device match the Gist" action (2026-08-06 Codex
          // review finding: without it, a note/agent/skill deleted on
          // another device and synced would never actually disappear here).
          // shape scopes cleanup to exactly this category's own files (never
          // a sibling category's subdirectory or an unrelated flat file like
          // policy.json/dm-pairings.json — a SEPARATE 2026-08-06 Codex review
          // finding). allowEmptyMirror is safe here BECAUSE the gist file was
          // confirmed present and well-formed above — an explicit `{}` from
          // the Gist really does mean "this category was deliberately
          // emptied," per syncToGist's own matching comment.
          const { writtenKeys, mirrorDeletedKeys } = await restoreBundle(fs, category.dir(), bundle, {
            mirror: true,
            allowEmptyMirror: true,
            shape: { nested: category.nested, extensions: category.extensions, isValid: category.isValid },
          });
          if (category.gistFilename === 'shelly-agents-bundle.json') {
            // Codex review finding (fourth pass): MUST use restoreBundle's
            // own safe/shape-filtered return values here, never the raw
            // `Object.keys(bundle)` or a caller-side diff — an untrusted/
            // tampered Gist could carry a `../../some-file.json`-shaped key
            // that restoreBundle's own write/delete paths already safely
            // skip, but re-deriving either list from raw/untrusted data
            // would reconstruct that same traversal path for a filesystem
            // write or delete instead.
            await clearDeletedAgentMarkers(fs, writtenKeys);
            // Codex review finding (seventh pass): an agent mirror-deleted
            // here (present locally, absent from the incoming Gist bundle —
            // a deletion made on another device) needs its OWN .deleted
            // marker written, or HomeInitializer.kt's installAgentIfMissing()
            // silently recreates it (if it's one of the seeded/built-in
            // agents) on the next app launch, undoing the synced deletion.
            await writeDeletedAgentMarkers(fs, mirrorDeletedKeys);
          }
        }
      }

      const now = Date.now();
      await AsyncStorage.setItem(STORAGE_KEY_LAST_SYNC, String(now));
      set({ lastSync: now, isSyncing: false });
      return true;
    } catch (err) {
      set({ isSyncing: false, error: String(err) });
      return false;
    }
  },
}));
