/**
 * store/settings-store.ts — App settings extracted from terminal-store.
 * Single source of truth for AppSettings + TermuxSettings.
 */
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppSettings, TermuxSettings } from './types';
import { saveApiKey, loadApiKeys, isApiKeyField, stripApiKeys } from '@/lib/secure-store';
import { useSoundStore } from '@/lib/sounds';

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS: AppSettings = {
  fontSize: 14,
  lineHeight: 1.4,
  themeVariant: 'black',
  cursorShape: 'block',
  hapticFeedback: true,
  autoScroll: true,
  soundEffects: true,
  soundVolume: 0.6,
  snippetRunMode: 'insertAndRun',
  snippetAutoReturn: true,
  highContrastOutput: true,
  localLlmEnabled: false,
  localLlmUrl: 'http://127.0.0.1:8080',
  localLlmModel: 'Qwen2.5-3B-Instruct-Q4_K_M',
  groqModel: 'llama-3.3-70b-versatile',
  backgroundOpacity: 1.0,
  blurIntensity: 0,
  teamMembers: {
    claude: true,
    gemini: true,
    codex: false,
    perplexity: true,
    local: true,
  },
  teamFacilitatorPriority: ['local', 'claude', 'gemini', 'codex', 'perplexity'],
  enableCommandSafety: true,
  safetyConfirmLevel: 'HIGH' as const,
  experienceMode: 'learning' as const,
  enableObsidianRag: false,
  obsidianVaultPath: '/storage/emulated/0/ObsidianVault',
  ragMaxChunks: 5,
  ragTargetMentions: ['claude', 'gemini', 'local'] as Array<'claude' | 'gemini' | 'local' | 'perplexity' | 'team'>,
  autoApproveLevel: 'safe' as const,
  defaultAgent: 'gemini-cli' as const,
  realtimeTranslateEnabled: false,
  llmInterpreterEnabled: false,
  externalKeyboardShortcuts: false,
};

export const DEFAULT_TERMUX_SETTINGS: TermuxSettings = {
  wsUrl: 'ws://127.0.0.1:8765',
  autoReconnect: true,
  timeoutSeconds: 30,
};

// ─── Store ───────────────────────────────────────────────────────────────────

interface SettingsState {
  settings: AppSettings;
  termuxSettings: TermuxSettings;
  isSettingsLoaded: boolean;

  loadSettings: () => Promise<void>;
  updateSettings: (partial: Partial<AppSettings>) => void;
  resetSettings: () => void;
  updateTermuxSettings: (partial: Partial<TermuxSettings>) => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  termuxSettings: DEFAULT_TERMUX_SETTINGS,
  isSettingsLoaded: false,

  loadSettings: async () => {
    try {
      const [settingsRaw, termuxRaw, secureKeys] = await Promise.all([
        AsyncStorage.getItem('shelly_settings'),
        AsyncStorage.getItem('shelly_termux_settings'),
        loadApiKeys(),
      ]);
      const settings = {
        ...DEFAULT_SETTINGS,
        ...(settingsRaw ? JSON.parse(settingsRaw) : {}),
        ...secureKeys,
      };
      const termuxSettings = termuxRaw
        ? { ...DEFAULT_TERMUX_SETTINGS, ...JSON.parse(termuxRaw) }
        : DEFAULT_TERMUX_SETTINGS;
      // Sync sound store on load
      useSoundStore.getState().setEnabled(settings.soundEffects ?? true);
      useSoundStore.getState().setVolume(settings.soundVolume ?? 0.6);
      set({ settings, termuxSettings, isSettingsLoaded: true });
    } catch (err) {
      console.error('[Settings] loadSettings failed, using defaults:', err);
      set({ settings: DEFAULT_SETTINGS, termuxSettings: DEFAULT_TERMUX_SETTINGS, isSettingsLoaded: true });
    }
  },

  updateSettings: (newSettings: Partial<AppSettings>) => {
    set((state) => {
      const updated = { ...state.settings, ...newSettings };
      // Save API keys to SecureStore, strip them from AsyncStorage
      for (const [key, value] of Object.entries(newSettings)) {
        if (isApiKeyField(key) && typeof value === 'string') {
          saveApiKey(key, value);
        }
      }
      // Sync sound store with settings
      if ('soundEffects' in newSettings) {
        useSoundStore.getState().setEnabled(newSettings.soundEffects ?? true);
      }
      if ('soundVolume' in newSettings) {
        useSoundStore.getState().setVolume(newSettings.soundVolume ?? 0.6);
      }
      const forStorage = stripApiKeys(updated);
      AsyncStorage.setItem('shelly_settings', JSON.stringify(forStorage)).catch((e) => {
        console.error('[Settings] persist failed — settings may be lost on restart:', e);
      });
      return { settings: updated };
    });
  },

  resetSettings: () => {
    set({ settings: DEFAULT_SETTINGS });
    AsyncStorage.setItem('shelly_settings', JSON.stringify(DEFAULT_SETTINGS)).catch(() => {});
  },

  updateTermuxSettings: (s: Partial<TermuxSettings>) => {
    set((state) => {
      const updated = { ...state.termuxSettings, ...s };
      if (updated.wsUrl && !/^wss?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(updated.wsUrl)) {
        console.warn('[Security] Non-local WebSocket URL detected:', updated.wsUrl);
      }
      AsyncStorage.setItem('shelly_termux_settings', JSON.stringify(updated)).catch((e) => {
        console.warn('[TermuxSettings] persist failed:', e);
      });
      return { termuxSettings: updated };
    });
  },
}));
