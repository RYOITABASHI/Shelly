/**
 * Boot-time theme gate (2026-10-06, product-owner bug: "立ち上がったときに
 * デフォルトじゃないテーマで立ち上がってからデフォルトになる").
 *
 * Root cause: theme.config.ts seeds the live `colors` object with the
 * built-in Shelly (blue/dark) palette at module load, and the persisted
 * preset (settings.uiFont, e.g. 'case-file') is only applied by
 * applyThemePreset() AFTER settings hydrate from AsyncStorage. RootLayout
 * rendered the whole UI immediately, so every cold start painted the blue
 * palette first. On-device (build 2467) the gap was ~14.6s: settings
 * hydration waited on loadApiKeys(), which reads every API key from
 * SecureStore sequentially, before the (fast) AsyncStorage blob was applied.
 *
 * Fix: settings-store now publishes the non-secret AsyncStorage blob first
 * (isBaseSettingsLoaded) and merges SecureStore keys afterwards; RootLayout
 * keeps the native splash up and renders nothing until this gate reports
 * ready — i.e. the persisted preset has been applied to the live palette —
 * or a safety timeout fires (falls back to the old "render now, swap
 * later" behavior so a stuck storage read can never hang startup).
 */

export const BOOT_THEME_GATE_TIMEOUT_MS = 1500;

export type BootThemeGateReadyReason = 'hydrated' | 'timeout';

export interface BootThemeGateDeps {
  /** True once the persisted (non-secret) settings blob is in the store. */
  isBaseSettingsLoaded: () => boolean;
  /** Subscribe to settings-store changes; returns an unsubscribe fn. */
  subscribe: (listener: () => void) => () => void;
  /** Apply the persisted theme preset to the live palette (synchronous). */
  applyPersistedTheme: () => void;
  /** Called exactly once: when the theme is applied, or on timeout. */
  onReady: (reason: BootThemeGateReadyReason) => void;
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Starts the gate. Returns a disposer (cancels the timer + subscription). */
export function startBootThemeGate(deps: BootThemeGateDeps): () => void {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let done = false;
  let unsubscribe: (() => void) | null = null;
  let timer: unknown = null;

  const finish = (reason: BootThemeGateReadyReason) => {
    if (done) return;
    done = true;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (reason === 'hydrated') {
      try {
        deps.applyPersistedTheme();
      } catch {
        // Never block startup on a theme-apply failure; RootLayout's
        // theme effect retries on the next settings/font change.
      }
    }
    deps.onReady(reason);
  };

  if (deps.isBaseSettingsLoaded()) {
    finish('hydrated');
    return () => {};
  }
  unsubscribe = deps.subscribe(() => {
    if (deps.isBaseSettingsLoaded()) finish('hydrated');
  });
  // Re-check: hydration may have landed between the first check and subscribe.
  if (!done && deps.isBaseSettingsLoaded()) {
    finish('hydrated');
    return () => {};
  }
  if (!done) {
    timer = setTimer(() => finish('timeout'), deps.timeoutMs ?? BOOT_THEME_GATE_TIMEOUT_MS);
  }
  return () => {
    done = true;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (timer !== null) { clearTimer(timer); timer = null; }
  };
}

// ── De-duplicated preset apply ─────────────────────────────────────────
// Shared by the gate (first apply, before the tree mounts) and RootLayout's
// theme effect (later uiFont / appFontFamily / fontsLoaded changes), so the
// gate's apply isn't immediately repeated by the effect — every apply bumps
// theme-version-store, which remounts the whole ShellLayout tree.
let lastAppliedKey: string | null = null;

export interface ThemeApplyFns {
  applyThemePreset: (id: string) => void;
  applyUiFont: (fontFamily: string) => void;
}

export function applyThemeFromSettings(
  uiFont: string,
  appFontFamily: string,
  fontsLoaded: boolean,
  fns?: ThemeApplyFns,
): boolean {
  const key = `${uiFont}|${appFontFamily}|${fontsLoaded ? 1 : 0}`;
  if (key === lastAppliedKey) return false;
  lastAppliedKey = key;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const impl: ThemeApplyFns = fns ?? require('@/lib/theme-presets');
  impl.applyThemePreset(uiFont);
  // Font override applies AFTER the preset so it always wins over whichever
  // font the preset itself declares (settings.appFontFamily vs uiFont).
  if (appFontFamily === 'dotgothic16') {
    impl.applyUiFont('DotGothic16_400Regular');
  }
  return true;
}

/** Test-only. */
export function __resetBootThemeGateForTests(): void {
  lastAppliedKey = null;
}
