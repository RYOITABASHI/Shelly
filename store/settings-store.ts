/**
 * store/settings-store.ts — App settings extracted from terminal-store.
 * Single source of truth for AppSettings.
 */
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppSettings } from './types';
import { saveApiKey, loadApiKeys, isApiKeyField, stripApiKeys } from '@/lib/secure-store';
import { useSoundStore } from '@/lib/sounds';
import { useAgentStore } from '@/store/agent-store';
import { logInfo, logError } from '@/lib/debug-logger';

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
  localLlmModel: 'qwen2.5-1.5b-instruct-q4_k_m',
  groqModel: 'llama-3.3-70b-versatile',
  perplexityApiKey: '',
  teamMembers: {
    claude: true,
    gemini: true,
    codex: false,
    cerebras: true,
    groq: true,
    perplexity: true,
    local: true,
  },
  teamFacilitatorPriority: ['local', 'claude', 'gemini', 'codex', 'perplexity'],
  enableCommandSafety: true,
  safetyConfirmLevel: 'HIGH' as const,
  experienceMode: 'learning' as const,
  autoApproveLevel: 'safe' as const,
  defaultAgent: 'gemini-cli' as const,
  realtimeTranslateEnabled: false,
  llmInterpreterEnabled: false,
  externalKeyboardShortcuts: false,
  terminalTheme: 'shelly',
  gpuRendering: false,
  uiFont: 'pixel',
};

// ─── Store ───────────────────────────────────────────────────────────────────

interface SettingsState {
  settings: AppSettings;
  isSettingsLoaded: boolean;
  showConfigTUI: boolean;
  showVoiceMode: boolean;

  loadSettings: () => Promise<void>;
  updateSettings: (partial: Partial<AppSettings>) => void;
  resetSettings: () => void;
  setShowConfigTUI: (show: boolean) => void;
  setShowVoiceMode: (show: boolean) => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  isSettingsLoaded: false,
  showConfigTUI: false,
  showVoiceMode: false,

  loadSettings: async () => {
    try {
      const [settingsRaw, secureKeys] = await Promise.all([
        AsyncStorage.getItem('shelly_settings'),
        loadApiKeys(),
      ]);
      const settings = {
        ...DEFAULT_SETTINGS,
        ...(settingsRaw ? JSON.parse(settingsRaw) : {}),
        ...secureKeys,
      };
      // Sync sound store on load
      useSoundStore.getState().setEnabled(settings.soundEffects ?? true);
      useSoundStore.getState().setVolume(settings.soundVolume ?? 0.6);
      logInfo('Settings', 'Settings loaded');
      set({ settings, isSettingsLoaded: true });
    } catch (err) {
      logError('Settings', 'Failed to load settings', err);
      console.error('[Settings] loadSettings failed, using defaults:', err);
      set({ settings: DEFAULT_SETTINGS, isSettingsLoaded: true });
    }
  },

  updateSettings: (newSettings: Partial<AppSettings>) => {
    logInfo('Settings', 'Updated: ' + Object.keys(newSettings).join(', '));
    set((state) => {
      const updated = { ...state.settings, ...newSettings };
      // Save API keys to SecureStore, strip them from AsyncStorage
      for (const [key, value] of Object.entries(newSettings)) {
        if (isApiKeyField(key) && typeof value === 'string') {
          saveApiKey(key, value);
        }
      }
      // Sync Perplexity API key to .env for headless agent execution
      if ('perplexityApiKey' in newSettings && typeof newSettings.perplexityApiKey === 'string') {
        const envKey = 'PERPLEXITY_API_KEY';
        const value = newSettings.perplexityApiKey;
        const cmd = `mkdir -p ~/.shelly/agents && (grep -v "^${envKey}=" ~/.shelly/agents/.env 2>/dev/null || true; echo "${envKey}=${value}") > ~/.shelly/agents/.env.tmp && mv ~/.shelly/agents/.env.tmp ~/.shelly/agents/.env && chmod 600 ~/.shelly/agents/.env`;
        useAgentStore.getState().setPendingEnvSync(cmd);
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

  setShowConfigTUI: (show: boolean) => set({ showConfigTUI: show }),
  setShowVoiceMode: (show: boolean) => set({ showVoiceMode: show }),
}));
