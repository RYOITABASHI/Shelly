import { Platform } from "react-native";

import { colors as liveColors, themeColors } from "@/theme.config";

export type ColorScheme = "light" | "dark";

/** Legacy light/dark token table from theme.config (consumed by tailwind). */
export const ThemeColors = themeColors;

/**
 * The subset of theme.config's `colors` (the live, preset-mutated palette)
 * the runtime palette is derived from.
 */
export type RuntimeThemeSource = {
  bgDeep: string;
  bgSurface: string;
  bgSidebar: string;
  btnSecondaryBg: string;
  text1: string;
  text2: string;
  text3: string;
  border: string;
  accent: string;
  accentGreen: string;
  accentBlue: string;
  accentPurple: string;
  accentCode: string;
  warning: string;
  errorText: string;
};

/**
 * Single mapping from preset tokens (theme.config `colors`: bgDeep / text1 /
 * accent / ...) to the useTheme() palette keys (background / foreground /
 * muted / ...). Used both for the initial palette and for every
 * applyThemePreset() refresh, so the default (pre-preset) palette and every
 * preset — including the light Case File one — resolve through the same
 * key mapping. (Before 2026-10-09 the initial palette came from
 * theme.config's legacy `themeColors` table, which hardcoded several keys —
 * command #93C5FD, link #60A5FA, aiPurple #8B5CF6, keyLabel #B0B8C1,
 * borderHeavy #333333 ... — so the default and the refreshed palettes
 * disagreed on those keys.)
 */
export function mapPaletteToRuntime(palette: RuntimeThemeSource) {
  const base = {
    primary: palette.accent,
    background: palette.bgDeep,
    backgroundDeep: palette.bgDeep,
    surface: palette.bgSurface,
    surfaceHigh: palette.bgSidebar,
    surface2: palette.btnSecondaryBg,
    foreground: palette.text1,
    foregroundDim: palette.text1,
    muted: palette.text2,
    inactive: palette.text3,
    hint: palette.text3,
    border: palette.border,
    borderLight: palette.border,
    borderHeavy: palette.border,
    success: palette.accentGreen,
    warning: palette.warning,
    error: palette.errorText,
    accent: palette.accent,
    prompt: palette.accent,
    command: palette.accentCode,
    tint: palette.accent,
    link: palette.accentBlue,
    aiPurple: palette.accentPurple,
    interpretPurple: palette.accentPurple,
    interpretText: palette.accentPurple,
    keyLabel: palette.text2,
    infoText: palette.text2,
  };
  return {
    ...base,
    text: base.foreground,
    icon: base.muted,
    tabIconDefault: base.muted,
    tabIconSelected: base.primary,
  };
}

export type ThemeColorPalette = ReturnType<typeof mapPaletteToRuntime>;

/**
 * Mutable runtime palette objects. Kept in sync with theme.config's live
 * `colors` by refreshRuntimeThemeColors() (called from applyThemePreset()).
 * Prefer the useTheme() hook (hooks/use-theme) in components: it returns a
 * fresh snapshot whenever theme-version-store bumps, so memoized consumers
 * (useMemo / makeStyles(colors)) recompute on a preset swap.
 */
export const Colors: Record<ColorScheme, ThemeColorPalette> = {
  light: mapPaletteToRuntime(liveColors),
  dark: mapPaletteToRuntime(liveColors),
};

export function refreshRuntimeThemeColors(palette: RuntimeThemeSource) {
  const runtime = mapPaletteToRuntime(palette);
  Object.assign(Colors.light, runtime);
  Object.assign(Colors.dark, runtime);
}

/**
 * Snapshot of the CURRENT palette (new object identity per call), derived
 * straight from theme.config's live `colors` — the single source of truth
 * that applyThemePreset() mutates in place — so it can never lag behind
 * the legacy `Colors` objects above.
 */
export function getLiveThemeColors(): ThemeColorPalette {
  return mapPaletteToRuntime(liveColors);
}

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: "system-ui",
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: "ui-serif",
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: "ui-rounded",
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: "ui-monospace",
  },
  default: {
    sans: "normal",
    serif: "serif",
    rounded: "normal",
    mono: "monospace",
  },
  web: {
    sans: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    rounded: "'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Meiryo, 'MS PGothic', sans-serif",
    mono: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  },
});
