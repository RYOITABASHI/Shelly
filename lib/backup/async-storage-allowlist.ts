/**
 * lib/backup/async-storage-allowlist.ts — which AsyncStorage keys a restore
 * may write. Restore is ALLOWLIST-based: anything not listed here is skipped
 * and reported. __tests__/backup-async-storage-drift.test.ts greps the source
 * tree for AsyncStorage keys / zustand persist names and fails when a key is
 * in none of the three lists below, so every new key gets an explicit
 * decision.
 *
 * (Backup itself still captures every AsyncStorage pair into the encrypted
 * bundle; only the restore side filters.)
 */

/** User preferences / content that are safe to bring to the new install. */
export const ASYNC_STORAGE_RESTORE_ALLOWLIST: readonly string[] = Object.freeze([
  // settings + stores (store/*)
  'shelly_settings', // API keys are stripped before this is written (stripApiKeys)
  'shelly_social_connectors', // connector metadata only; secrets live in SecureStore
  'shelly_cosmetics',
  'shelly_bookmarks',
  'shelly_browser_last_url',
  'shelly_ssh_profiles',
  'shelly_ai_pane_conversations',
  'shelly_agent_chat_dismissed_sessions',
  'shelly_agent_chat_session_titles',
  '@shelly/mcp-servers',
  '@shelly/snippets',
  '@shelly/snippets_sort',
  // zustand persist names
  'pane-store-v1',
  'sidebar-store-v1',
  'shelly-worktrees',
  'multi-pane-state-v1',
  // lib/*
  'shelly_user_profile',
  'shelly_hints_seen',
  'shelly_suggestions_seen',
  'shelly_pro_unlocked',
  '@shelly/a11y',
  '@shelly/chat_onboarding_step',
  '@shelly/chat_onboarding_done',
  '@shelly/decision-log',
  '@shelly/gist_id',
  '@shelly/last_sync',
  '@shelly/dotfiles_include_agent_data',
  '@shelly/setup_wizard_complete', // permission prompts are re-checked every launch anyway
  '@shelly/locale',
  '@shelly/plugins', // enabled/disabled flags only, never handler code
  '@shelly/custom-context',
  '@shelly/theme',
  '@shelly/custom_themes',
  '@shelly/keybindings', // dotfiles-sync storageKey
  '@shelly/workflows', // dotfiles-sync storageKey
  // components/*
  'shelly:lastUnfoldedPreset',
  'shelly:coverPresetActive',
  'firstmate_completed',
]);

/** Approval-like grants: restored ONLY when the user opts in to re-trusting
 *  approvals in the restore UI (see service.ts applyRestore). */
export const ASYNC_STORAGE_APPROVAL_KEYS: readonly string[] = Object.freeze([
  'shelly_dm_pairings', // authorises replying into a paired DM thread
]);

/** Never restored (install-specific or legacy plaintext secrets). */
export const ASYNC_STORAGE_RESTORE_DENYLIST: readonly string[] = Object.freeze([
  'shelly_android_update_download', // old install's in-flight DownloadManager id / APK path
  'shelly.signingMigration.explained.v1', // per-install migration notice state
  'shelly_terminal_sessions', // PTY session ids of the old process
  '@shelly/github_pat', // legacy PLAINTEXT PAT (migrated to SecureStore on launch)
]);

export type AsyncKeyDecision = 'restore' | 'approval' | 'deny' | 'unknown';

export function asyncKeyDecision(key: string): AsyncKeyDecision {
  if (ASYNC_STORAGE_RESTORE_ALLOWLIST.includes(key)) return 'restore';
  if (ASYNC_STORAGE_APPROVAL_KEYS.includes(key)) return 'approval';
  if (ASYNC_STORAGE_RESTORE_DENYLIST.includes(key)) return 'deny';
  return 'unknown';
}
