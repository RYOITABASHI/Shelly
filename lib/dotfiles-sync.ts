/**
 * lib/dotfiles-sync.ts — Dotfiles sync via GitHub Gist
 *
 * Syncs Shelly settings, snippets, keybindings, and themes
 * to/from a GitHub Gist for cross-device portability.
 */
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

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

const SECURE_KEY_PAT = 'shelly_dotfiles_pat';
const STORAGE_KEY_GIST = '@shelly/gist_id';
const STORAGE_KEY_LAST_SYNC = '@shelly/last_sync';

// ── Store ────────────────────────────────────────────────────────────────────

type SyncState = {
  pat: string;
  gistId: string;
  lastSync: number | null;
  isSyncing: boolean;
  error: string | null;

  loadConfig: () => Promise<void>;
  setPat: (pat: string) => void;
  syncToGist: () => Promise<boolean>;
  syncFromGist: () => Promise<boolean>;
};

export const useDotfilesStore = create<SyncState>((set, get) => ({
  pat: '',
  gistId: '',
  lastSync: null,
  isSyncing: false,
  error: null,

  loadConfig: async () => {
    const [pat, gistId, lastSync] = await Promise.all([
      SecureStore.getItemAsync(SECURE_KEY_PAT),
      AsyncStorage.getItem(STORAGE_KEY_GIST),
      AsyncStorage.getItem(STORAGE_KEY_LAST_SYNC),
    ]);
    // Migrate from legacy AsyncStorage if present
    if (!pat) {
      const legacyPat = await AsyncStorage.getItem('@shelly/github_pat');
      if (legacyPat) {
        await SecureStore.setItemAsync(SECURE_KEY_PAT, legacyPat);
        await AsyncStorage.removeItem('@shelly/github_pat');
        set({ pat: legacyPat, gistId: gistId || '', lastSync: lastSync ? parseInt(lastSync, 10) : null });
        return;
      }
    }
    set({
      pat: pat || '',
      gistId: gistId || '',
      lastSync: lastSync ? parseInt(lastSync, 10) : null,
    });
  },

  setPat: (pat) => {
    set({ pat });
    SecureStore.setItemAsync(SECURE_KEY_PAT, pat);
  },

  syncToGist: async () => {
    const { pat, gistId } = get();
    if (!pat) {
      set({ error: 'GitHub PAT required' });
      return false;
    }

    set({ isSyncing: true, error: null });

    try {
      // Collect all syncable data
      const files: Record<string, { content: string }> = {};
      for (const entry of SYNCABLE_FILES) {
        const data = await AsyncStorage.getItem(entry.storageKey);
        if (data) {
          files[entry.filename] = { content: data };
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
        // Create new gist
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
            files,
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
    const { pat, gistId } = get();
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
