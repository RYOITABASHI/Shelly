/**
 * store/settings-store.ts — App settings extracted from terminal-store.
 * Single source of truth for AppSettings.
 */
import { create } from 'zustand';
import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppSettings as BaseAppSettings, SocialConnectorMeta } from './types';
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
import { GROQ_DEFAULT_MODEL } from '@/lib/groq';

// ─── Defaults ────────────────────────────────────────────────────────────────

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function dotenvValue(value: string): string {
  const normalized = value.trim().replace(/[\r\n]/g, '');
  return `'${normalized.replace(/'/g, "'\\''")}'`;
}

const SOCIAL_CONNECTORS_STORAGE_KEY = 'shelly_social_connectors';

export type AppSettings = BaseAppSettings & {
  /** LLM-led multi-turn agent registration (Tier 3). Default ON since
   *  2026-08-03 — on-device-verified (build 1570-class gate), fail-closed to
   *  Tier 2 fixed-template questions when no LLM (cloud or local) is
   *  reachable (runConversationalRegistrationTurnLocal returns
   *  `{success:false}`, never throws). The only user-visible effect of that
   *  fallback is the existing, benign `agentplan.llm_conversation_fallback_notice`
   *  ("Switching to simple step-by-step questions.") — not a new failure mode.
   *  High-risk (webhook/cli) authoring stays a SEPARATE opt-in below. */
  agentConversationalRegistrationEnabled?: boolean;
  /** LLM-proposed webhook/cli actions — opt-in, default OFF. Independent of
   *  the flag above: verbatim-substring-gated (requireVerbatimSubstringMatch)
   *  but still a materially higher blast radius, so it stays a deliberate
   *  separate opt-in rather than inheriting Tier 3's default. */
  agentConversationalHighRiskActionsEnabled?: boolean;
};

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
  const rewrite = `(grep -Ev '${grepPattern}' ~/.shelly/agents/.env 2>/dev/null || true${emit}) > ~/.shelly/agents/.env.tmp && mv ~/.shelly/agents/.env.tmp ~/.shelly/agents/.env && chmod 600 ~/.shelly/agents/.env`;
  return `mkdir -p ~/.shelly/agents/locks && (env_lock=~/.shelly/agents/locks/env.lock; env_lock_acquired=0; env_lock_attempt=0; while [ "$env_lock_attempt" -lt 20 ]; do if mkdir "$env_lock" 2>/dev/null; then env_lock_acquired=1; break; fi; env_lock_attempt=$((env_lock_attempt + 1)); sleep 0.05; done; cleanup_env_lock() { if [ "$env_lock_acquired" -eq 1 ]; then rmdir "$env_lock" 2>/dev/null || true; fi; }; trap cleanup_env_lock EXIT; trap 'exit 130' INT; trap 'exit 143' TERM; ${rewrite})`;
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
  groqModel: GROQ_DEFAULT_MODEL,
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
  profileLearningEnabled: true,
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
  // low-friction, so default this back on — intended as a toggleable
  // setting, not a hard-coded requirement, preserving the "任意で確認"
  // (confirmation is a choice) framing from the original directive.
  // justRegisteredAgent's quick-correct mechanism is NOT removed — it still
  // activates correctly for anyone who flips this back off.
  // CORRECTION (2026-07-30): no Settings UI actually writes this field today
  // (grepped ConfigTUI.tsx / SettingsDropdown.tsx — neither references it),
  // so in practice it is currently hard-enforced true: loadSettings() below
  // migrates any persisted `false` (leftover from before this reversal, or
  // any other source) back to `true` on every load. If a real UI toggle is
  // ever added, that migration line must be removed or scoped to only
  // pre-2026-07-24 values, or the new toggle would be silently overwritten.
  agentRegistrationRequireConfirm: true,
  // Widget-ASK-only confirm bypass — opt-in, default OFF (2026-07-29). OFF =
  // widget `@agent` commands confirm exactly like AI-Pane ones (the
  // 2026-07-24 confirm-by-default reversal above stays the default
  // everywhere). See AppSettings.widgetAgentRegistrationNoConfirm.
  widgetAgentRegistrationNoConfirm: false,
  // LLM-led multi-turn agent registration (Tier 3) — default ON since
  // 2026-08-03. Fail-closed to Tier 2 fixed-template questions whenever no
  // LLM (cloud or local) is reachable; see the AppSettings doc comment above
  // for why that fallback is not a regression. Still a real Settings toggle
  // (ConfigTUI "Agents" section), so an existing install that explicitly
  // turned this off is left alone — no forced migration, unlike
  // agentRegistrationRequireConfirm below (which has no UI and so any stored
  // `false` there is definitionally stale, not a deliberate choice).
  agentConversationalRegistrationEnabled: true,
  // High-risk (webhook/cli) authoring stays opt-in, default OFF.
  agentConversationalHighRiskActionsEnabled: false,
  // Fable5 review 2026-08-25 reversed the 2026-07-14 "defaults off" directive:
  // no Settings UI has ever written this field (ConfigTUI.tsx/
  // SettingsDropdown.tsx grepped clean — same "no writer exists" situation
  // agentRegistrationRequireConfirm was in above), and the auto-approve
  // default meant a run whose .env sourcing failed, or a device that never
  // persisted this key, got zero human approval on real-side-effect actions
  // (webhook/cli/dm-reply/notify) by default. See lib/agent-executor.ts's
  // ACTION_APPROVAL_MODE resolution and scripts/shelly-plan-executor.js's
  // requireActionApprovalTap for the matching runtime-side flip.
  defaultRequireActionApproval: true,
  // Opt-in. Off = today's behaviour exactly; see AppSettings' doc comment for
  // why this can only ever cover reversible workspace file writes.
  agentOptimisticWorkspaceWrites: false,
  scheduleReadinessNudgeShown: false,
  agentOnboardingNudgeShown: false,
  companionJournalDormancyNoticeShown: false,
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
  /** Rewrites ONE secret field of an EXISTING connector (SecureStore + .env
   *  sync only — metadata/fields list is untouched). The only current caller
   *  is the X OAuth pending-token-update drain (app/_layout.tsx): X rotates
   *  its refresh_token on every use, so a successful post must persist the
   *  new one or the NEXT refresh fails with invalid_grant. No-ops (resolves)
   *  if the connector id doesn't exist — the drain logs and drops the file
   *  rather than throwing into a poll loop. */
  updateSocialConnectorSecret: (id: string, field: string, value: string) => Promise<void>;
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
      // Migration: any install that ever wrote `agentRegistrationRequireConfirm:
      // false` to AsyncStorage before the 2026-07-24 confirm-by-default reversal
      // (see the DEFAULT_SETTINGS doc comment above) keeps that stale value
      // forever, because loadSettings spreads the stored blob OVER
      // DEFAULT_SETTINGS -- the code-level default change alone never reaches
      // an existing install. There is no Settings UI that can currently write
      // `false` here (grepped ConfigTUI.tsx / SettingsDropdown.tsx -- neither
      // references this key), so any `false` found on disk today is
      // definitionally leftover pre-reversal state, not a recent deliberate
      // choice. Force it back to the real default and persist the correction
      // once, so this device's baseline actually matches what every other
      // install already gets. (Found 2026-07-30 verifying the widget-ASK
      // no-confirm opt-in on a device that still had the stale value.)
      if (settings.agentRegistrationRequireConfirm === false) {
        settings.agentRegistrationRequireConfirm = true;
        shouldPersist = true;
      }
      // Migration: same shape as the agentRegistrationRequireConfirm fix
      // above — defaultRequireActionApproval's default flipped 2026-08-25
      // (Fable5 review) and no Settings UI has ever written this field, so
      // any persisted `false` on disk is definitionally leftover pre-flip
      // state, not a deliberate choice. Force it to the real default once.
      if (settings.defaultRequireActionApproval === false) {
        settings.defaultRequireActionApproval = true;
        shouldPersist = true;
      }
      // Migration: Groq deprecated 'llama-3.3-70b-versatile' 2026-06-17 (free/
      // developer tier), and every real call against it now 404s (found
      // 2026-08-17 during on-device fan-out QA — the escalation ladder
      // silently fell back to the local LLM, masking the failure). Same
      // spread-over-stored-blob problem as the migration above: DEFAULT_SETTINGS
      // moving to GROQ_DEFAULT_MODEL only helps a fresh install, since any
      // install that ever persisted a settings blob keeps the old literal
      // forever. Unlike that boolean case, ConfigTUI's Groq Model field IS a
      // free-text string a user could have deliberately typed this exact value
      // into — but since Groq removed the model, that value is dead either way,
      // so upgrading it is strictly an improvement regardless of intent.
      if (settings.groqModel === 'llama-3.3-70b-versatile') {
        settings.groqModel = GROQ_DEFAULT_MODEL;
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
      // Save API keys to SecureStore, strip them from AsyncStorage.
      // updateSettings() is a synchronous zustand action (50+ call sites
      // across the app expect a plain void return), so this stays
      // fire-and-forget rather than becoming async — but saveApiKey() now
      // re-throws on a SecureStore write failure instead of swallowing it
      // (see lib/secure-store.ts), so a failure here must not disappear as
      // an unhandled rejection. Surface it with an Alert: without this, the
      // UI would keep showing the just-typed key as "saved" while it was
      // never actually persisted (found in a code-quality audit).
      for (const [key, value] of Object.entries(newSettings)) {
        if (isApiKeyField(key) && typeof value === 'string') {
          saveApiKey(key, value).catch((e) => {
            logError('Settings', `Failed to persist API key "${key}" to SecureStore`, e);
            Alert.alert(
              'Failed to save API key',
              `The "${key}" key could not be saved to secure storage and will not be remembered. ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          });
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
      // DEFERRED.md item 8 (2026-08-10 audit): OpenRouter was missing from this
      // headless .env sync — Settings saved the key to SecureStore (for the AI
      // Pane chat client) but never mirrored it to ~/.shelly/agents/.env, so a
      // background/attended agent run (lib/agent-executor.ts's 'openrouter'
      // case, added alongside this) could never read OPENROUTER_API_KEY.
      // Mirrors the cerebras/groq pattern immediately above.
      if ('openrouterApiKey' in newSettings && typeof newSettings.openrouterApiKey === 'string') {
        envUpdates.push(['OPENROUTER_API_KEY', newSettings.openrouterApiKey]);
      }
      if ('openrouterModel' in newSettings && typeof newSettings.openrouterModel === 'string') {
        envUpdates.push(['OPENROUTER_MODEL', newSettings.openrouterModel]);
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
        queueEnvSync(buildEnvSyncCommand(envUpdates));
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
    queueEnvSync(buildEnvSyncCommand([['SHELLY_WEBHOOK_HOST_ALLOWLIST', '']]));
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

  updateSocialConnectorSecret: async (id: string, field: string, value: string) => {
    if (!isSafeConnectorId(id) || !isSafeConnectorField(field) || !value) return;
    const existing = get().socialConnectors.find((c) => c.id === id);
    if (!existing || !existing.fields.includes(field)) return;
    await saveConnectorSecret(id, field, value);
    queueEnvSync(buildEnvSyncCommand([[socialConnectorEnvVar(id, field), value]]));
    logInfo('Settings', `Social connector secret rotated: ${id}.${field}`);
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
