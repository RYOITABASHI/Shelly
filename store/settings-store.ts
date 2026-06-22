/**
 * store/settings-store.ts — App settings extracted from terminal-store.
 * Single source of truth for AppSettings.
 */
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppSettings } from './types';
import { saveApiKey, loadApiKeys, isApiKeyField, stripApiKeys, deleteLegacySecrets } from '@/lib/secure-store';
import { useSoundStore } from '@/lib/sounds';
import { useAgentStore } from '@/store/agent-store';
import { logInfo, logError } from '@/lib/debug-logger';

// ─── Defaults ────────────────────────────────────────────────────────────────

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function dotenvValue(value: string): string {
  const normalized = value.trim().replace(/[\r\n]/g, '');
  return `'${normalized.replace(/'/g, "'\\''")}'`;
}

export const DEFAULT_LOCAL_LLM_MODEL = 'Qwen3.5-0.8B-Q4_K_M';

const LEGACY_LOCAL_LLM_MODELS = new Set([
  'Qwen3.5-9B-Q4_K_M',
  'Qwen3-4B-Instruct-2507-Q4_K_M',
  'Qwen3-8B-Q4_K_M',
]);

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
  localLlmModel: DEFAULT_LOCAL_LLM_MODEL,
  localLlmModelPath: '',
  groqModel: 'llama-3.3-70b-versatile',
  telegramInboundEnabled: false,
  telegramBotToken: '',
  telegramAuthorizedChatId: '',
  perplexityApiKey: '',
  teamMembers: {
    gemini: true,
    codex: true,
    cerebras: true,
    groq: true,
    perplexity: true,
    local: true,
  },
  teamFacilitatorPriority: ['gemini', 'cerebras', 'groq', 'codex', 'perplexity', 'local'],
  enableCommandSafety: true,
  safetyConfirmLevel: 'HIGH' as const,
  experienceMode: 'learning' as const,
  autoApproveLevel: 'safe' as const,
  defaultAgent: 'codex' as const,
  realtimeTranslateEnabled: false,
  llmInterpreterEnabled: false,
  externalKeyboardShortcuts: false,
  terminalTheme: 'blue',
  gpuRendering: false,
  uiFont: 'blue',
  showVimKeyBar: false,
};

const ACTIVE_TEAM_PRIORITY: AppSettings['teamFacilitatorPriority'] = ['gemini', 'cerebras', 'groq', 'codex', 'perplexity', 'local'];

type LegacySettings = Omit<AppSettings, 'defaultAgent' | 'teamMembers' | 'teamFacilitatorPriority'> & {
  defaultAgent?: AppSettings['defaultAgent'] | 'claude-code' | 'gemini-cli';
  teamMembers?: Partial<AppSettings['teamMembers']> & { claude?: boolean; gemini?: boolean };
  teamFacilitatorPriority?: Array<AppSettings['teamFacilitatorPriority'][number] | 'claude' | 'gemini'>;
  claudeAuthToken?: unknown;
  geminiAuthToken?: unknown;
};

function sanitizeRemovedAgents(settings: AppSettings): { settings: AppSettings; changed: boolean } {
  let changed = false;
  const legacy = settings as LegacySettings;
  const {
    claudeAuthToken: oldClaudeAuthToken,
    geminiAuthToken: oldGeminiAuthToken,
    ...cleanedSettings
  } = legacy;
  if (oldClaudeAuthToken !== undefined || oldGeminiAuthToken !== undefined) {
    changed = true;
  }
  const defaultAgent =
    legacy.defaultAgent === 'claude-code' || legacy.defaultAgent === 'gemini-cli'
      ? 'codex'
      : (legacy.defaultAgent ?? DEFAULT_SETTINGS.defaultAgent);
  if (defaultAgent !== legacy.defaultAgent) {
    changed = true;
  }
  if (legacy.teamMembers?.claude !== undefined) {
    changed = true;
  }
  if (legacy.teamFacilitatorPriority?.some((agent) => agent === 'claude')) {
    changed = true;
  }

  const next: AppSettings = {
    ...(cleanedSettings as AppSettings),
    defaultAgent,
    teamMembers: {
      gemini: legacy.teamMembers?.gemini ?? DEFAULT_SETTINGS.teamMembers.gemini,
      codex: legacy.teamMembers?.codex ?? DEFAULT_SETTINGS.teamMembers.codex,
      cerebras: legacy.teamMembers?.cerebras ?? DEFAULT_SETTINGS.teamMembers.cerebras,
      groq: legacy.teamMembers?.groq ?? DEFAULT_SETTINGS.teamMembers.groq,
      perplexity: legacy.teamMembers?.perplexity ?? DEFAULT_SETTINGS.teamMembers.perplexity,
      local: legacy.teamMembers?.local ?? DEFAULT_SETTINGS.teamMembers.local,
    },
    teamFacilitatorPriority: Array.isArray(legacy.teamFacilitatorPriority)
      ? legacy.teamFacilitatorPriority.filter((agent): agent is AppSettings['teamFacilitatorPriority'][number] =>
          agent === 'gemini' || agent === 'cerebras' || agent === 'groq' || agent === 'codex' || agent === 'perplexity' || agent === 'local',
        )
      : [...ACTIVE_TEAM_PRIORITY],
  };

  const normalizedPriority = next.teamFacilitatorPriority.length > 0
    ? next.teamFacilitatorPriority
    : ACTIVE_TEAM_PRIORITY;
  if (normalizedPriority.join('|') !== next.teamFacilitatorPriority.join('|')) {
    next.teamFacilitatorPriority = normalizedPriority;
    changed = true;
  }

  return { settings: next, changed };
}

// ─── Store ───────────────────────────────────────────────────────────────────

interface SettingsState {
  settings: AppSettings;
  isSettingsLoaded: boolean;
  showConfigTUI: boolean;
  showVoiceMode: boolean;
  showScouterDetail: boolean;

  loadSettings: () => Promise<void>;
  updateSettings: (partial: Partial<AppSettings>) => void;
  resetSettings: () => void;
  setShowConfigTUI: (show: boolean) => void;
  setShowVoiceMode: (show: boolean) => void;
  setShowScouterDetail: (show: boolean) => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  isSettingsLoaded: false,
  showConfigTUI: false,
  showVoiceMode: false,
  showScouterDetail: false,

  loadSettings: async () => {
    try {
      const [settingsRaw, secureKeys] = await Promise.all([
        AsyncStorage.getItem('shelly_settings'),
        loadApiKeys(),
      ]);
      deleteLegacySecrets().catch((err) => {
        logError('Settings', 'Failed to delete legacy OAuth secrets', err);
      });
      const settings = {
        ...DEFAULT_SETTINGS,
        ...(settingsRaw ? JSON.parse(settingsRaw) : {}),
        ...secureKeys,
      };
      let shouldPersist = false;
      if (LEGACY_LOCAL_LLM_MODELS.has(settings.localLlmModel)) {
        settings.localLlmModel = DEFAULT_LOCAL_LLM_MODEL;
        settings.localLlmModelPath = '';
        shouldPersist = true;
      }
      const sanitized = sanitizeRemovedAgents(settings);
      shouldPersist = shouldPersist || sanitized.changed;
      if (shouldPersist) {
        AsyncStorage.setItem('shelly_settings', JSON.stringify(stripApiKeys(sanitized.settings))).catch(() => {});
      }
      // Sync sound store on load
      useSoundStore.getState().setEnabled(sanitized.settings.soundEffects ?? true);
      useSoundStore.getState().setVolume(sanitized.settings.soundVolume ?? 0.6);
      logInfo('Settings', 'Settings loaded');
      set({ settings: sanitized.settings, isSettingsLoaded: true });
    } catch (err) {
      logError('Settings', 'Failed to load settings', err);
      console.error('[Settings] loadSettings failed, using defaults:', err);
      set({ settings: DEFAULT_SETTINGS, isSettingsLoaded: true });
    }
  },

  updateSettings: (newSettings: Partial<AppSettings>) => {
    logInfo('Settings', 'Updated: ' + Object.keys(newSettings).join(', '));
    set((state) => {
      const shouldClearLocalLlmModelPath =
        'localLlmModel' in newSettings && !('localLlmModelPath' in newSettings);
      const updated = {
        ...state.settings,
        ...newSettings,
        ...(shouldClearLocalLlmModelPath ? { localLlmModelPath: '' } : {}),
      };
      // Save API keys to SecureStore, strip them from AsyncStorage
      for (const [key, value] of Object.entries(newSettings)) {
        if (isApiKeyField(key) && typeof value === 'string') {
          saveApiKey(key, value);
        }
      }
      // Sync API settings to .env for headless/background agent execution.
      const envUpdates: Array<[string, string]> = [];
      if ('perplexityApiKey' in newSettings && typeof newSettings.perplexityApiKey === 'string') {
        envUpdates.push(['PERPLEXITY_API_KEY', newSettings.perplexityApiKey]);
      }
      if ('geminiApiKey' in newSettings && typeof newSettings.geminiApiKey === 'string') {
        envUpdates.push(['GEMINI_API_KEY', newSettings.geminiApiKey]);
      }
      if ('geminiModel' in newSettings && typeof newSettings.geminiModel === 'string') {
        envUpdates.push(['GEMINI_MODEL', newSettings.geminiModel]);
      }
      if ('cerebrasApiKey' in newSettings && typeof newSettings.cerebrasApiKey === 'string') {
        envUpdates.push(['CEREBRAS_API_KEY', newSettings.cerebrasApiKey]);
      }
      if ('cerebrasModel' in newSettings && typeof newSettings.cerebrasModel === 'string') {
        envUpdates.push(['CEREBRAS_MODEL', newSettings.cerebrasModel]);
      }
      if ('groqApiKey' in newSettings && typeof newSettings.groqApiKey === 'string') {
        envUpdates.push(['GROQ_API_KEY', newSettings.groqApiKey]);
      }
      if ('groqModel' in newSettings && typeof newSettings.groqModel === 'string') {
        envUpdates.push(['GROQ_MODEL', newSettings.groqModel]);
      }
      if ('localLlmUrl' in newSettings && typeof newSettings.localLlmUrl === 'string') {
        envUpdates.push(['LOCAL_LLM_URL', newSettings.localLlmUrl]);
      }
      if ('localLlmModel' in newSettings && typeof newSettings.localLlmModel === 'string') {
        envUpdates.push(['LOCAL_LLM_MODEL', newSettings.localLlmModel]);
      }
      if (shouldClearLocalLlmModelPath) {
        envUpdates.push(['LOCAL_LLM_MODEL_PATH', '']);
      } else if ('localLlmModelPath' in newSettings && typeof newSettings.localLlmModelPath === 'string') {
        envUpdates.push(['LOCAL_LLM_MODEL_PATH', newSettings.localLlmModelPath]);
      }
      if (envUpdates.length > 0) {
        const keys = envUpdates.map(([key]) => key);
        const grepPattern = keys.map((key) => `^${key}=`).join('|');
        const lines = envUpdates
          .map(([key, value]) => `printf '%s\\n' ${shQuote(`${key}=${dotenvValue(value)}`)}`)
          .join('; ');
        const cmd = `mkdir -p ~/.shelly/agents && (grep -Ev '${grepPattern}' ~/.shelly/agents/.env 2>/dev/null || true; ${lines}) > ~/.shelly/agents/.env.tmp && mv ~/.shelly/agents/.env.tmp ~/.shelly/agents/.env && chmod 600 ~/.shelly/agents/.env`;
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
  setShowScouterDetail: (show: boolean) => set({ showScouterDetail: show }),
}));
