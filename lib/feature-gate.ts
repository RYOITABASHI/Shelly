/**
 * Feature Gate — Central registry for Free/Pro feature boundaries.
 *
 * During the launch phase (active users < 200), all features are unlocked.
 * When monetization activates, `isProUnlocked()` will check license state
 * and this gate will control access to Pro features.
 *
 * Usage:
 *   import { isFeatureAvailable, ProFeature } from '@/lib/feature-gate';
 *   if (!isFeatureAvailable('crossPane')) { showProUpsell(); return; }
 */

// ── Feature catalog ──────────────────────────────────────────────────────────

export type ProFeature =
  // Split view / cross-pane
  | 'multiPane'
  | 'crossPane'
  | 'actionBlock'
  // Chat / AI (unlimited)
  | 'naturalLanguageUnlimited'
  | 'multiAgentRouting'
  | 'mentionRouting'
  | 'voiceChain'
  | 'atTeam'
  | 'atArena'
  | 'atPlan'
  | 'atActions'
  // IDE
  | 'approvalProxy'
  | 'cliCoPilot'
  | 'errorSummary'
  | 'autoSavepoint'
  | 'preCommitScan'
  | 'clickToEdit'
  | 'templateGalleryFull'
  | 'githubIntegration'
  // Themes
  | 'allThemes';

// ── Free-tier limits ─────────────────────────────────────────────────────────

/** Daily natural-language execution limit for free users */
export const FREE_NL_DAILY_LIMIT = 20;

/** Number of themes available for free */
export const FREE_THEME_COUNT = 4;

/** Number of templates available for free */
export const FREE_TEMPLATE_COUNT = 2;

/** Free theme IDs */
export const FREE_THEME_IDS = ['blue', 'orange', 'purple', 'scouter-green'] as const;

// ── Gate logic ───────────────────────────────────────────────────────────────

/**
 * Launch phase flag.
 * Set to `false` when active users exceed 200 and monetization begins.
 * This will eventually be replaced by a remote config or user count check.
 */
const LAUNCH_PHASE = true;

/**
 * Check if the user has Pro access.
 * During launch phase, everyone is Pro.
 */
export function isProUnlocked(): boolean {
  if (LAUNCH_PHASE) return true;
  // TODO: Check license key / purchase state from AsyncStorage / SecureStore
  return false;
}

/**
 * Check if a specific Pro feature is available to the current user.
 */
export function isFeatureAvailable(feature: ProFeature): boolean {
  return isProUnlocked();
}

/**
 * Check if a theme is available (free users get FREE_THEME_IDS only).
 */
export function isThemeAvailable(themeId: string): boolean {
  if (isProUnlocked()) return true;
  return (FREE_THEME_IDS as readonly string[]).includes(themeId);
}
