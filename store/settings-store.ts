/**
 * store/settings-store.ts — App settings extracted from terminal-store.
 * Single source of truth for AppSettings.
 */
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppSettings, SocialConnectorMeta } from './types';
import {
  saveApiKey,
  loadApiKeys,
  isApiKeyField,
  stripApiKeys,
  deleteLegacySecrets,
  saveConnectorSecret,
  deleteAllConnectorSecrets,
} from '@/lib/secure-store';
import {
  SOCIAL_ALL_FIELDS,
  isSafeConnectorId,
  isSafeConnectorField,
  isSocialPlatform,
  isValidConnectorHost,
  socialConnectorEnvPrefix,
  socialConnectorEnvVar,
  socialConnectorMetaEnvValue,
} from '@/lib/social-connectors';
import { useSoundStore } from '@/lib/sounds';
import { useAgentStore } from '@/store/agent-store';
import { logInfo, logError } from '@/lib/debug-logger';
import { normalizeWebhookHostAllowlist } from '@/lib/webhook-host-allowlist';

// ─── Defaults ────────────────────────────────────────────────────────────────

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function dotenvValue(value: string): string {
  const normalized = value.trim().replace(/[\r\n]/g, '');
  return `'${normalized.replace(/'/g, "'\\''")}'`;
}

const SOCIAL_CONNECTORS_STORAGE_KEY = 'shelly_social_connectors';

/** Build the same replace-lines-in-.env shell command updateSettings uses.
 *  `removeKeys` additionally strips exact `KEY=` lines (connector removal).
 *  Exact keys, NOT an open-ended prefix sweep: `^SOCIAL_CONNECTOR_MASTODON_`
 *  would also match a sibling connector id "mastodon-2"
 *  (SOCIAL_CONNECTOR_MASTODON_2_*), silently wiping its secrets — found in
 *  the 2026-07-22 pre-merge review of this feature. */
function buildEnvSyncCommand(envUpdates: Array<[string, string]>, removeKeys: string[] = []): string {
  const patterns = [
    ...envUpdates.map(([key]) => `^${key}=`),
    ...removeKeys.map((key) => `^${key}=`),
  ];
  const grepPattern = patterns.join('|');
  const lines = envUpdates
    .map(([key, value]) => `printf '%s\\n' ${shQuote(`${key}=${dotenvValue(value)}`)}`)
    .join('; ');
  const emit = lines ? `; ${lines}` : '';
  return `mkdir -p ~/.shelly/agents && (grep -Ev '${grepPattern}' ~/.shelly/agents/.env 2>/dev/null || true${emit}) > ~/.shelly/agents/.env.tmp && mv ~/.shelly/agents/.env.tmp ~/.shelly/agents/.env && chmod 600 ~/.shelly/agents/.env`;
}

/** Queue an .env sync without clobbering an undrained pending one (the
 *  pendingEnvSync slot is last-write-wins; chaining preserves both). */
function queueEnvSync(cmd: string): void {
  const agentStore = useAgentStore.getState();
  const prev = agentStore.pendingEnvSync;
  agentStore.setPendingEnvSync(prev ? `${prev}\n${cmd}` : cmd);
}

function persistSocialConnectors(connectors: SocialConnectorMeta[]): void {
  AsyncStorage.setItem(SOCIAL_CONNECTORS_STORAGE_KEY, JSON.stringify(connectors)).catch((e) => {
    console.error('[Settings] social-connector persist failed:', e);
  });
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
  // N1: autonomous cloud opt-in — default OFF (fail-closed); on free-tier 429,
  // escalate to Codex by default.
  autonomousCloudConsent: false,
  autonomousCloudOnExhaustion: 'escalate' as const,
  webhookHostAllowlist: [],
  socialHostAllowlist: [],
  // Agent output: default to a clean, findable local folder. Switch to 'obsidian'
  // (with a Vault path) or 'custom' to unify saved drafts elsewhere.
  agentOutputTarget: 'local' as const,
  agentVaultPath: '',
  agentTopicFolder: '',
  agentCustomPath: '',
  realtimeTranslateEnabled: false,
  llmInterpreterEnabled: false,
  externalKeyboardShortcuts: false,
  terminalTheme: 'blue',
  gpuRendering: false,
  terminalWallpaperTransparency: true,
  uiFont: 'blue',
  showVimKeyBar: false,
  // 2026-07-24 reversal of the 2026-07-14 directive, specifically for
  // REGISTRATION confirm (not the separate defaultRequireActionApproval
  // below, which is about per-run dispatch approval and is unchanged):
  // the no-confirm auto-register fast path for draft/notify shipped its own
  // "quick correction" safety net (justRegisteredAgent, a 4-minute
  // post-registration undo window) specifically because registering without
  // review meant mistakes were caught AFTER the fact — that safety net was
  // itself the source of 3 separate on-device bugs in one night (message
  // overwrite on a scrolled-away bubble, editingAgentId loss creating a
  // duplicate agent, confusing "Register"-worded footer during a Sidebar
  // edit). Direct project-owner call: plain natural-language chat confirm
  // ("これでいいですか？") before registering is simpler and equally
  // low-friction, so default this back on — still a toggleable setting, not
  // a hard-coded requirement, preserving the "任意で確認" (confirmation is a
  // choice) framing from the original directive. justRegisteredAgent's
  // quick-correct mechanism is NOT removed — it still activates correctly
  // for anyone who flips this back off.
  agentRegistrationRequireConfirm: true,
  defaultRequireActionApproval: false,
  scheduleReadinessNudgeShown: false,
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
  /** Ephemeral, non-persisted UI trigger: set by `shelly skill approve <name>`
   *  to open the quarantine-review dialog for that skill. Approval itself only
   *  happens from a human tap in that dialog — never from this field alone. */
  pendingSkillApprovalName: string | null;
  /** Registered social auto-post connectors — METADATA ONLY, no secret values
   *  (secrets live in SecureStore, one entry per field, and are synced to
   *  ~/.shelly/agents/.env for headless dispatch). Persisted under its own
   *  AsyncStorage key, loaded in loadSettings. */
  socialConnectors: SocialConnectorMeta[];

  loadSettings: () => Promise<void>;
  updateSettings: (partial: Partial<AppSettings>) => void;
  resetSettings: () => void;
  setShowConfigTUI: (show: boolean) => void;
  setShowVoiceMode: (show: boolean) => void;
  setShowScouterDetail: (show: boolean) => void;
  setPendingSkillApprovalName: (name: string | null) => void;
  /** Registers a connector: writes each secret field to SecureStore, syncs the
   *  secrets + non-secret HOST/META entries to .env (same mechanism as the API
   *  keys above), then appends the metadata. Throws on invalid id/platform/
   *  host/fields — the UI surfaces the message. */
  addSocialConnector: (meta: Omit<SocialConnectorMeta, 'createdAt'>, secrets: Record<string, string>) => Promise<void>;
  /** Deletes every SecureStore secret for the connector, strips its
   *  SOCIAL_CONNECTOR_<ID>_* lines from .env, then removes the metadata. */
  removeSocialConnector: (id: string) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  isSettingsLoaded: false,
  showConfigTUI: false,
  showVoiceMode: false,
  showScouterDetail: false,
  pendingSkillApprovalName: null,
  socialConnectors: [],

  loadSettings: async () => {
    try {
      const [settingsRaw, secureKeys, socialConnectorsRaw] = await Promise.all([
        AsyncStorage.getItem('shelly_settings'),
        loadApiKeys(),
        AsyncStorage.getItem(SOCIAL_CONNECTORS_STORAGE_KEY),
      ]);
      let socialConnectors: SocialConnectorMeta[] = [];
      try {
        const parsed = socialConnectorsRaw ? JSON.parse(socialConnectorsRaw) : [];
        if (Array.isArray(parsed)) {
          socialConnectors = parsed.filter(
            (c): c is SocialConnectorMeta =>
              !!c && typeof c === 'object' && typeof c.id === 'string' && isSafeConnectorId(c.id),
          );
        }
      } catch (err) {
        logError('Settings', 'Failed to parse social connectors', err);
      }
      deleteLegacySecrets().catch((err) => {
        logError('Settings', 'Failed to delete legacy OAuth secrets', err);
      });
      const settings = {
        ...DEFAULT_SETTINGS,
        ...(settingsRaw ? JSON.parse(settingsRaw) : {}),
        ...secureKeys,
      };
      settings.webhookHostAllowlist = normalizeWebhookHostAllowlist(
        Array.isArray(settings.webhookHostAllowlist) ? settings.webhookHostAllowlist : [],
      );
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
      set({ settings: sanitized.settings, isSettingsLoaded: true, socialConnectors });
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
      if ('autonomousCloudConsent' in newSettings) {
        envUpdates.push(['SHELLY_AUTONOMOUS_CLOUD', newSettings.autonomousCloudConsent ? '1' : '0']);
      }
      if ('autonomousCloudOnExhaustion' in newSettings) {
        envUpdates.push(['SHELLY_AUTONOMOUS_CLOUD_STOP', newSettings.autonomousCloudOnExhaustion === 'stop' ? '1' : '0']);
      }
      // Global runtime-approval default (project owner directive 2026-07-14).
      // Synced to .env so the PlanSpec (Node) executor's parseConfigEnv sees it;
      // the legacy .sh executor instead bakes the per-agent-resolved value
      // directly into ACTION_APPROVAL_MODE at script-generation time (see
      // generateRunScript in lib/agent-executor.ts) since that script has
      // direct access to the live Agent object and settings snapshot already.
      if ('defaultRequireActionApproval' in newSettings) {
        envUpdates.push(['SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL', newSettings.defaultRequireActionApproval ? '1' : '0']);
      }
      if ('webhookHostAllowlist' in newSettings && Array.isArray(newSettings.webhookHostAllowlist)) {
        const normalizedHosts = normalizeWebhookHostAllowlist(newSettings.webhookHostAllowlist);
        updated.webhookHostAllowlist = normalizedHosts;
        envUpdates.push(['SHELLY_WEBHOOK_HOST_ALLOWLIST', normalizedHosts.join(',')]);
      }
      // social-post (2026-07-22): same normalizer, separate env key — this list
      // is LOAD-BEARING (silent unattended dispatch opt-in), see
      // AppSettings.socialHostAllowlist's doc comment.
      if ('socialHostAllowlist' in newSettings && Array.isArray(newSettings.socialHostAllowlist)) {
        const normalizedSocialHosts = normalizeWebhookHostAllowlist(newSettings.socialHostAllowlist);
        updated.socialHostAllowlist = normalizedSocialHosts;
        envUpdates.push(['SHELLY_SOCIAL_HOST_ALLOWLIST', normalizedSocialHosts.join(',')]);
      }
      if ('agentOutputTarget' in newSettings && typeof newSettings.agentOutputTarget === 'string') {
        envUpdates.push(['SHELLY_AGENT_OUTPUT_TARGET', newSettings.agentOutputTarget]);
      }
      if ('agentVaultPath' in newSettings && typeof newSettings.agentVaultPath === 'string') {
        // Reuse OBSIDIAN_VAULT_PATH so the content-studio mirror benefits too.
        envUpdates.push(['OBSIDIAN_VAULT_PATH', newSettings.agentVaultPath]);
      }
      if ('agentTopicFolder' in newSettings && typeof newSettings.agentTopicFolder === 'string') {
        envUpdates.push(['SHELLY_AGENT_TOPIC_FOLDER', newSettings.agentTopicFolder]);
      }
      if ('agentCustomPath' in newSettings && typeof newSettings.agentCustomPath === 'string') {
        envUpdates.push(['SHELLY_AGENT_CUSTOM_PATH', newSettings.agentCustomPath]);
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
    const cmd = `mkdir -p ~/.shelly/agents && (grep -Ev '^SHELLY_WEBHOOK_HOST_ALLOWLIST=' ~/.shelly/agents/.env 2>/dev/null || true; printf '%s\\n' ${shQuote(`SHELLY_WEBHOOK_HOST_ALLOWLIST=${dotenvValue('')}`)}) > ~/.shelly/agents/.env.tmp && mv ~/.shelly/agents/.env.tmp ~/.shelly/agents/.env && chmod 600 ~/.shelly/agents/.env`;
    useAgentStore.getState().setPendingEnvSync(cmd);
  },

  setShowConfigTUI: (show: boolean) => set({ showConfigTUI: show }),
  setShowVoiceMode: (show: boolean) => set({ showVoiceMode: show }),
  setPendingSkillApprovalName: (name: string | null) => set({ pendingSkillApprovalName: name }),
  setShowScouterDetail: (show: boolean) => set({ showScouterDetail: show }),

  addSocialConnector: async (meta, secrets) => {
    const { id, platform, label, host, fields } = meta;
    if (!isSafeConnectorId(id)) {
      throw new Error(`Connector id must be alphanumeric/hyphen only: ${id}`);
    }
    if (!isSocialPlatform(platform)) {
      throw new Error(`Unknown social platform: ${platform}`);
    }
    if (!isValidConnectorHost(host)) {
      throw new Error(`Connector host must be a bare hostname (no scheme/path/port): ${host}`);
    }
    if (!Array.isArray(fields) || fields.length === 0 || !fields.every((f) => isSafeConnectorField(f))) {
      throw new Error('Connector field names must be alphanumeric.');
    }
    if (get().socialConnectors.some((c) => c.id === id)) {
      throw new Error(`A connector with id "${id}" already exists. Remove it first.`);
    }
    // 1. Secrets → SecureStore (one entry per field; never in metadata/AsyncStorage).
    for (const field of fields) {
      const value = secrets[field];
      if (typeof value === 'string' && value.length > 0) {
        await saveConnectorSecret(id, field, value);
      }
    }
    // 2. Secrets + non-secret HOST/META → ~/.shelly/agents/.env so headless/
    //    background runs (the generated .sh and the PlanSpec executor) can
    //    dispatch without RN alive — the exact PERPLEXITY_API_KEY pattern.
    const prefix = socialConnectorEnvPrefix(id);
    const envUpdates: Array<[string, string]> = [
      [`${prefix}_HOST`, host],
      [`${prefix}_META`, socialConnectorMetaEnvValue({ platform, host, fields })],
    ];
    for (const field of fields) {
      const value = secrets[field];
      if (typeof value === 'string' && value.length > 0) {
        envUpdates.push([socialConnectorEnvVar(id, field), value]);
      }
    }
    queueEnvSync(buildEnvSyncCommand(envUpdates));
    // 3. Metadata (no secrets) → store + AsyncStorage.
    const record: SocialConnectorMeta = { id, platform, label, host, fields: [...fields], createdAt: Date.now() };
    const next = [...get().socialConnectors, record];
    set({ socialConnectors: next });
    persistSocialConnectors(next);
    logInfo('Settings', `Social connector added: ${id} (${platform} @ ${host})`);
  },

  removeSocialConnector: async (id: string) => {
    if (!isSafeConnectorId(id)) return;
    const existing = get().socialConnectors.find((c) => c.id === id);
    // 1. Delete every secret field from SecureStore (declared fields + the
    //    full known-field union as belt-and-braces).
    await deleteAllConnectorSecrets(id, existing?.fields ?? []);
    // 2. Strip this connector's .env lines: HOST + META + every candidate
    //    secret field (declared fields ∪ SOCIAL_ALL_FIELDS). Exact keys only —
    //    see buildEnvSyncCommand's doc comment for why a bare prefix sweep
    //    would clobber a hyphen-suffixed sibling connector's entries.
    const prefix = socialConnectorEnvPrefix(id);
    const fieldUnion = new Set<string>([...(existing?.fields ?? []), ...SOCIAL_ALL_FIELDS]);
    const removeKeys = [
      `${prefix}_HOST`,
      `${prefix}_META`,
      ...[...fieldUnion].filter((f) => isSafeConnectorField(f)).map((f) => socialConnectorEnvVar(id, f)),
    ];
    queueEnvSync(buildEnvSyncCommand([], removeKeys));
    // 3. Remove the metadata.
    const next = get().socialConnectors.filter((c) => c.id !== id);
    set({ socialConnectors: next });
    persistSocialConnectors(next);
    logInfo('Settings', `Social connector removed: ${id}`);
  },
}));
